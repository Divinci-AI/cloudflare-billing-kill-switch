/**
 * The GCP relay's failure isolation.
 *
 * On 2026-08-16T18:41Z the Slack incoming webhook behind this relay stopped
 * working. The relay returned 502 on the failed Slack post *before* reaching
 * the PagerDuty enqueue, so all twelve paging policies pointed at /gcp-page
 * went silent for four days — 54 pages dropped — while GCP logged
 * "Webhook failed with 502 Bad Gateway" and nothing else noticed.
 *
 * These tests exist so that cannot happen again. The load-bearing one is
 * "pages even when Slack is down": mutate the handler to return early on a
 * failed Slack post and it must fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";

const PAGE_TOKEN = "page-token-value";
const ALERT_TOKEN = "alert-token-value";
const SLACK = "https://hooks.slack.com/services/T/B/xxx";
const PD_ENQUEUE = "https://events.pagerduty.com/v2/enqueue";

function env(over: Record<string, unknown> = {}) {
  return {
    GCP_PAGE_TOKEN: PAGE_TOKEN,
    GCP_ALERT_TOKEN: ALERT_TOKEN,
    SLACK_WEBHOOK_URL: SLACK,
    PAGERDUTY_ROUTING_KEY: "routing-key-value",
    ENVIRONMENT: "production",
    ...over,
  } as never;
}

function req(path: string, token: string, incident: Record<string, unknown> = {}) {
  return new Request(`https://relay.example.com${path}`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`gcp:${token}`)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      incident: {
        incident_id: "abc123",
        state: "open",
        policy_name: "Uptime: prod-api-health failing",
        summary: "the API is down",
        documentation: { subject: "[ALERT - CRIT] 🔴 PROD API DOWN" },
        ...incident,
      },
    }),
  });
}

/** Route stubbed fetch by URL; `slackOk` decides whether Slack accepts the post. */
function stubFetch(opts: { slackOk: boolean; pdOk?: boolean }) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.startsWith(SLACK)) {
      return opts.slackOk
        ? new Response("ok", { status: 200 })
        : new Response("no_service", { status: 404 });
    }
    if (url.startsWith(PD_ENQUEUE)) {
      return (opts.pdOk ?? true)
        ? new Response(JSON.stringify({ status: "success" }), { status: 202 })
        : new Response("bad", { status: 400 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.unstubAllGlobals());

describe("/gcp-page — Slack must never suppress the page", () => {
  it("still enqueues to PagerDuty when the Slack post fails", async () => {
    const calls = stubFetch({ slackOk: false });
    const res = await worker.fetch(req("/gcp-page", PAGE_TOKEN), env());

    // THE regression. A Slack outage silenced the pager for four days.
    expect(calls.some((u) => u.startsWith(PD_ENQUEUE))).toBe(true);

    // And GCP must see success, or it retries a page that already fired.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pd).toBe("triggered");
    expect(body.slack).toBe("error_404");
    expect(body.status).toBe("relayed_degraded");
  });

  it("reports 502 when the PagerDuty leg itself fails", async () => {
    stubFetch({ slackOk: true, pdOk: false });
    const res = await worker.fetch(req("/gcp-page", PAGE_TOKEN), env());
    expect(res.status).toBe(502);
    expect((await res.json()).pd).toBe("error_400");
  });

  it("reports 502 when it cannot page at all — a missing routing key is not a success", async () => {
    stubFetch({ slackOk: true });
    const res = await worker.fetch(
      req("/gcp-page", PAGE_TOKEN),
      env({ PAGERDUTY_ROUTING_KEY: undefined }),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).pd).toBe("no_routing_key");
  });

  it("is 200 when both legs succeed", async () => {
    stubFetch({ slackOk: true });
    const res = await worker.fetch(req("/gcp-page", PAGE_TOKEN), env());
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("relayed");
  });
});

describe("/gcp-alert — Slack IS the authoritative leg there", () => {
  it("reports 502 when the Slack post fails, so GCP retries and logs", async () => {
    stubFetch({ slackOk: false });
    const res = await worker.fetch(req("/gcp-alert", ALERT_TOKEN), env());
    expect(res.status).toBe(502);
  });

  it("never pages, even on success", async () => {
    const calls = stubFetch({ slackOk: true });
    const res = await worker.fetch(req("/gcp-alert", ALERT_TOKEN), env());
    expect(res.status).toBe(200);
    expect(calls.some((u) => u.startsWith(PD_ENQUEUE))).toBe(false);
  });
});

describe("the token check still holds", () => {
  it("rejects a wrong token", async () => {
    stubFetch({ slackOk: true });
    const res = await worker.fetch(req("/gcp-page", "wrong-token-value"), env());
    expect(res.status).toBe(401);
  });

  it("does not accept the alert token on the page endpoint", async () => {
    stubFetch({ slackOk: true });
    const res = await worker.fetch(req("/gcp-page", ALERT_TOKEN), env());
    expect(res.status).toBe(401);
  });
});
