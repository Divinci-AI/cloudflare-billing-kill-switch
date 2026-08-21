/**
 * The kill-switch's OWN alerts must always have a Slack destination.
 *
 * gap: kill-switch-own-alerts-use-the-dead-webhook
 *
 * `sendAlerts` — cost thresholds, and the alert emitted when the switch applies
 * maxInstances=0 to production — read SLACK_WEBHOOK_URL and nothing else. When
 * the #divinci-app webhook died on 2026-08-16 those alerts went nowhere, and
 * fixing the GCP relay did not fix it: only the relay handler consulted
 * GCP_SLACK_WEBHOOK_URL.
 */
import { describe, it, expect } from "vitest";
import { killSwitchSlackWebhook } from "../src/index";

const OWN = "https://hooks.slack.com/services/T/B/own";
const GCP = "https://hooks.slack.com/services/T/B/gcp";

describe("killSwitchSlackWebhook", () => {
  it("prefers the kill-switch's own channel when it is configured", () => {
    // Not "whichever is set" — if an operator points SLACK_WEBHOOK_URL at a
    // channel, cost alerts belong there, not wherever GCP alerts happen to go.
    expect(killSwitchSlackWebhook({ SLACK_WEBHOOK_URL: OWN, GCP_SLACK_WEBHOOK_URL: GCP } as never)).toBe(OWN);
  });

  it("falls back to the GCP relay's webhook when its own is unset", () => {
    // THE regression. Without this, deleting the dead secret leaves the switch
    // with no Slack destination at all.
    expect(killSwitchSlackWebhook({ GCP_SLACK_WEBHOOK_URL: GCP } as never)).toBe(GCP);
  });

  it("is undefined when neither is set, so the caller can warn", () => {
    expect(killSwitchSlackWebhook({} as never)).toBeUndefined();
  });

  it("treats an empty string as unset — a blanked secret is not a destination", () => {
    // `wrangler secret put` with swallowed stdin stores "", which is how a
    // binding can exist while being useless.
    expect(killSwitchSlackWebhook({ SLACK_WEBHOOK_URL: "", GCP_SLACK_WEBHOOK_URL: GCP } as never)).toBe(GCP);
  });
});

describe("the PagerDuty/Slack ordering in sendAlerts", () => {
  it("runs PagerDuty BEFORE Slack, so a Slack outage cannot suppress a page", async () => {
    // The inverse ordering in the GCP relay handler took the pager down for
    // four days (2026-08-16 -> 2026-08-20). Pinning it here so nobody
    // "simplifies" the two paths into one helper that posts Slack first.
    const src = await import("node:fs").then(fs =>
      fs.promises.readFile(new URL("../src/index.ts", import.meta.url), "utf8"));
    const body = src.slice(src.indexOf("async function sendAlerts("));
    const pd = body.indexOf("PAGERDUTY_ROUTING_KEY");
    const slack = body.indexOf("killSwitchSlackWebhook(env)");
    expect(pd).toBeGreaterThan(-1);
    expect(slack).toBeGreaterThan(-1);
    expect(pd).toBeLessThan(slack);
  });
});
