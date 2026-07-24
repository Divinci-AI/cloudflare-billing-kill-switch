# Cloudflare & GCP Billing Kill Switch

**Auto-disconnect runaway cloud services before they generate surprise bills.**

Born from an **$80,000 Durable Objects bill**. Monitors both **Cloudflare Workers** and **GCP Cloud Run** services, with centralized reporting to [kill-switch.net](https://kill-switch.net).

## What It Does

Every 6 hours (configurable), this Worker:

1. **Cloudflare**: Queries GraphQL Analytics API for per-worker DO requests, wall-time, and request volume
2. **GCP Cloud Run**: Queries Cloud Monitoring API for request count, instance count, and estimated cost
3. **Checks thresholds**: If any service exceeds limits:
   - **Alerts** you via PagerDuty (phone call), Discord, Slack, or custom webhook
   - **Auto-disconnects** the offending service (reversible):
     - Cloudflare: removes routes and custom domains
     - Cloud Run: sets maxInstances to 0
4. **Reports to kill-switch.net**: Sends unified metrics from both providers for centralized dashboards and rule evaluation

```
Cloudflare:  Worker ← Traffic ← Routes/Domains
Kill switch: Worker    Traffic ✗ Routes removed
                       ↑ Code intact, re-enable anytime

Cloud Run:   Service ← Traffic ← Load Balancer
Kill switch: Service    Traffic ✗ maxInstances=0
                        ↑ Revision intact, scale back up anytime
```

## Quick Start

### 1. Clone and deploy

```bash
git clone https://github.com/AiExpanse/cloudflare-billing-kill-switch.git
cd cloudflare-billing-kill-switch
npm install
wrangler deploy
```

### 2. Set required secrets (Cloudflare)

```bash
# Your Cloudflare account ID (from dashboard URL or API)
wrangler secret put CLOUDFLARE_ACCOUNT_ID

# API token with these permissions:
#   - Account Analytics: Read
#   - Account Workers Scripts: Edit
#   - Account Workers Routes: Edit
wrangler secret put CLOUDFLARE_API_TOKEN
```

### 3. Connect kill-switch.net (centralized monitoring)

```bash
# Agent API key from https://kill-switch.net dashboard
wrangler secret put KILL_SWITCH_AGENT_API_KEY
```

### 4. Connect GCP Cloud Run monitoring (optional)

```bash
# GCP project ID
wrangler secret put GCP_PROJECT_ID
# → Enter: openai-api-4375643 (or your project ID)

# GCP service account JSON (needs monitoring.viewer + run.admin roles)
wrangler secret put GCP_SERVICE_ACCOUNT_JSON
# → Paste the full JSON contents of your service account key
```

### 5. Set up alerting (at least one)

```bash
# PagerDuty (recommended for phone calls until acknowledged)
wrangler secret put PAGERDUTY_ROUTING_KEY
# → Get this from: PagerDuty → Services → Your Service → Integrations → Events API V2

# Discord (free, instant notifications)
wrangler secret put DISCORD_WEBHOOK_URL
# → Get this from: Discord → Channel Settings → Integrations → Webhooks → New Webhook

# Slack (billing kill-switch default; may target #divinci-app)
wrangler secret put SLACK_WEBHOOK_URL

# Slack for GCP Monitoring relay (/gcp-alert + /gcp-page) — prefer #alerts
# so prod pages are not stuck on the kill-switch webhook channel.
wrangler secret put GCP_SLACK_WEBHOOK_URL
# → Slack → #alerts → Integrations → Incoming Webhooks → New Webhook
# Then redeploy (or wait for next deploy) so the Worker picks up the secret.

# Any custom HTTP endpoint
wrangler secret put CUSTOM_WEBHOOK_URL
```

### 4. Test it

```bash
# Verify deployment
curl https://cloudflare-billing-kill-switch.<your-subdomain>.workers.dev/

# View current usage (no alerts)
curl https://cloudflare-billing-kill-switch.<your-subdomain>.workers.dev/usage

# Send a test alert
curl https://cloudflare-billing-kill-switch.<your-subdomain>.workers.dev/test-alert

# Run a full check (will alert if thresholds exceeded)
curl https://cloudflare-billing-kill-switch.<your-subdomain>.workers.dev/check
```

## Configuration

All thresholds are set in `wrangler.toml` under `[vars]`:

### Cloudflare Thresholds

| Variable | Default | Description |
|----------|---------|-------------|
| `DO_REQUEST_THRESHOLD` | `1000000` | Max Durable Object requests per day before alerting |
| `DO_WALLTIME_HOURS_THRESHOLD` | `100` | Max DO wall-time hours per day |
| `WORKER_REQUEST_THRESHOLD` | `10000000` | Max Worker requests per day (catches feedback loops) |

### GCP Cloud Run Thresholds

| Variable | Default | Description |
|----------|---------|-------------|
| `CLOUD_RUN_REQUEST_THRESHOLD` | `5000000` | Max Cloud Run requests per day |
| `CLOUD_RUN_INSTANCE_THRESHOLD` | `50` | Max concurrent instances (50 × 2vCPU ≈ $108/day) |
| `CLOUD_RUN_MONTHLY_COST_THRESHOLD` | `500` | Estimated monthly cost cap in USD |
| `GCP_REGION` | `us-central1` | GCP region to monitor |

### Kill Switch Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_DISCONNECT` | `true` | Auto-disconnect when threshold exceeded (reversible) |
| `AUTO_DELETE` | `false` | Auto-delete CF workers (nuclear, irreversible, CF only) |
| `PROTECTED_WORKERS` | `cloudflare-billing-kill-switch` | Comma-separated workers to never kill |
| `KILL_SWITCH_API_URL` | `https://api.kill-switch.net` | Kill Switch service API URL |

### Cron Schedule

Default: every 6 hours. Change in `wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *"]   # Every 5 minutes (aggressive)
crons = ["0 * * * *"]     # Every hour
crons = ["0 */6 * * *"]   # Every 6 hours (default)
crons = ["0 0 * * *"]     # Once daily
```

### Protected Workers

Workers listed in `PROTECTED_WORKERS` will never be disconnected or deleted, even if they exceed thresholds. They'll still trigger alerts so you can investigate manually.

Always include the kill switch itself:

```toml
PROTECTED_WORKERS = "cloudflare-billing-kill-switch,my-critical-api,my-website"
```

## How Auto-Disconnect Works

When a worker exceeds thresholds, the kill switch:

1. **Disables the workers.dev subdomain** — stops traffic via `*.workers.dev` URLs
2. **Removes custom domains** — detaches any custom domains bound to the worker

The worker script, Durable Objects, and KV data are **not** deleted. To restore service:

1. Re-enable workers.dev: `wrangler deploy` (or via dashboard)
2. Re-add custom domains: `wrangler deploy` (routes in wrangler.toml are re-applied)

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check with current config |
| `/check` | GET | Run usage check now (triggers alerts if needed) |
| `/usage` | GET | View current usage data (no alerts) |
| `/test-alert` | GET | Send test alert to all configured destinations |

## Why This Exists

Cloudflare Workers have **no native spending cap**. Unlike AWS (budget actions) or GCP (billing disable), Cloudflare will happily bill you unlimited amounts with no circuit breaker.

Real incidents from the community:
- **$80,000** Durable Objects bill from runaway containers (us, the authors)
- **$5,000+** from a Worker-Queue feedback loop ([Cloudflare Community](https://community.cloudflare.com/t/worker-queue-feedback-loop-generated-5-000-bill-possibly-20-000/900297))
- **$20,000+** from uncontrolled KV writes ([Hacker News](https://news.ycombinator.com/item?id=47322794))

Cloudflare's only native protection is email-based "usage notifications" that alert you *after* the damage is done. This kill switch actively stops the bleeding.

## Cost

This Worker itself costs nearly nothing:
- 4 cron invocations/day = ~120/month
- Each invocation: 2 GraphQL queries + optional alert webhooks
- Well within the Workers free tier (100K requests/day)

## Required Credentials

### Cloudflare API Token

Create a [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) with:

| Permission | Access | Why |
|------------|--------|-----|
| Account Analytics | Read | Query usage metrics via GraphQL |
| Account Workers Scripts | Edit | Disable workers.dev subdomain |
| Account Workers Routes | Edit | Remove custom domain routes |

If you only want alerting without auto-disconnect, `Account Analytics: Read` is sufficient.

### GCP Service Account (for Cloud Run monitoring)

Create a GCP service account with these roles:

| Role | Why |
|------|-----|
| `roles/monitoring.viewer` | Read Cloud Monitoring metrics (request count, instance count) |
| `roles/run.admin` | Set maxInstances=0 on threshold breach (auto-disconnect) |

If you only want alerting without auto-disconnect, `roles/monitoring.viewer` is sufficient.

### Kill Switch Agent API Key

Get your agent API key from the [kill-switch.net dashboard](https://kill-switch.net). This enables centralized multi-cloud monitoring, rule evaluation, and the analytics dashboard.

## Alert Integrations

### PagerDuty (recommended for critical alerts)

PagerDuty will **phone call** and **SMS** the on-call person repeatedly until someone acknowledges the incident. Best for preventing $80K bills while you sleep.

1. Create a PagerDuty service → Add "Events API V2" integration
2. Copy the **Integration Key** (not the REST API key)
3. `wrangler secret put PAGERDUTY_ROUTING_KEY`

### Discord

Free, instant push notifications via the Discord mobile app.

1. Server Settings → Integrations → Webhooks → New Webhook
2. Copy webhook URL
3. `wrangler secret put DISCORD_WEBHOOK_URL`

### Slack

1. Create an [Incoming Webhook](https://api.slack.com/messaging/webhooks)
2. Copy webhook URL
3. `wrangler secret put SLACK_WEBHOOK_URL`

### Custom Webhook

Any HTTP endpoint that accepts POST with JSON body:

```json
{
  "summary": "Cloudflare cost alert: 1 worker(s) exceeded thresholds",
  "severity": "critical",
  "details": { "violations": [...], "actionsTaken": [...] },
  "timestamp": "2026-03-22T12:00:00Z",
  "source": "cloudflare-billing-kill-switch"
}
```

## Contributing

PRs welcome! Some ideas:

- [ ] R2 storage monitoring (DOs aren't the only expensive thing)
- [ ] KV/D1/Queue usage monitoring
- [ ] Daily cost estimate reports (email/Discord digest)
- [ ] Dashboard UI (Pages site with historical data)
- [ ] Hysteresis (trigger at 90%, recover at 85% to prevent oscillation)
- [x] ~~GCP Cloud Run integration (multi-cloud kill switch)~~ — Done!
- [x] ~~kill-switch.net centralized reporting~~ — Done!
- [ ] AWS Lambda/ECS monitoring

## License

MIT
