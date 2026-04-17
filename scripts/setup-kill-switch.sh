#!/usr/bin/env bash
#
# Setup script for kill-switch.net integration + wrangler secrets.
#
# Usage:
#   ./scripts/setup-kill-switch.sh
#
# This script:
#   1. Sets wrangler secrets for Cloudflare, GCP, and kill-switch.net
#   2. Applies rule presets (cost-runaway, error-storm) via the API
#   3. Tests the full integration
#
# Prerequisites:
#   - wrangler CLI installed and authenticated
#   - kill-switch.net account with an agent API key
#   - GCP service account JSON file (optional, for Cloud Run monitoring)
#

set -euo pipefail

KILL_SWITCH_API="${KILL_SWITCH_API_URL:-https://api.kill-switch.net}"
WORKER_NAME="cloudflare-billing-kill-switch"

echo "═══════════════════════════════════════════════════════════════════"
echo "  Kill Switch Integration Setup"
echo "  API: ${KILL_SWITCH_API}"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# ── Step 1: Wrangler Secrets ─────────────────────────────────────────────────

echo "Step 1: Configure wrangler secrets"
echo "──────────────────────────────────"

# Cloudflare (required)
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo ""
  echo "→ CLOUDFLARE_ACCOUNT_ID (required)"
  echo "  Find at: https://dash.cloudflare.com → Account ID in sidebar"
  wrangler secret put CLOUDFLARE_ACCOUNT_ID --name "$WORKER_NAME"
else
  echo "$CLOUDFLARE_ACCOUNT_ID" | wrangler secret put CLOUDFLARE_ACCOUNT_ID --name "$WORKER_NAME"
  echo "✓ CLOUDFLARE_ACCOUNT_ID set from environment"
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo ""
  echo "→ CLOUDFLARE_API_TOKEN (required)"
  echo "  Create at: https://dash.cloudflare.com/profile/api-tokens"
  echo "  Permissions: Account Analytics (Read), Workers Scripts (Edit), Workers Routes (Edit)"
  wrangler secret put CLOUDFLARE_API_TOKEN --name "$WORKER_NAME"
else
  echo "$CLOUDFLARE_API_TOKEN" | wrangler secret put CLOUDFLARE_API_TOKEN --name "$WORKER_NAME"
  echo "✓ CLOUDFLARE_API_TOKEN set from environment"
fi

# Kill Switch agent key
if [ -z "${KILL_SWITCH_AGENT_API_KEY:-}" ]; then
  echo ""
  echo "→ KILL_SWITCH_AGENT_API_KEY"
  echo "  Get from: https://kill-switch.net → Dashboard → Agent API Keys"
  wrangler secret put KILL_SWITCH_AGENT_API_KEY --name "$WORKER_NAME"
else
  echo "$KILL_SWITCH_AGENT_API_KEY" | wrangler secret put KILL_SWITCH_AGENT_API_KEY --name "$WORKER_NAME"
  echo "✓ KILL_SWITCH_AGENT_API_KEY set from environment"
fi

# GCP (optional)
echo ""
read -p "Configure GCP Cloud Run monitoring? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  if [ -z "${GCP_PROJECT_ID:-}" ]; then
    echo ""
    echo "→ GCP_PROJECT_ID"
    wrangler secret put GCP_PROJECT_ID --name "$WORKER_NAME"
  else
    echo "$GCP_PROJECT_ID" | wrangler secret put GCP_PROJECT_ID --name "$WORKER_NAME"
    echo "✓ GCP_PROJECT_ID set from environment"
  fi

  if [ -n "${GCP_SA_KEY_FILE:-}" ] && [ -f "$GCP_SA_KEY_FILE" ]; then
    cat "$GCP_SA_KEY_FILE" | wrangler secret put GCP_SERVICE_ACCOUNT_JSON --name "$WORKER_NAME"
    echo "✓ GCP_SERVICE_ACCOUNT_JSON set from file: $GCP_SA_KEY_FILE"
  else
    echo ""
    echo "→ GCP_SERVICE_ACCOUNT_JSON"
    echo "  Paste the full JSON contents of your service account key file."
    echo "  Needs roles: monitoring.viewer, run.admin"
    wrangler secret put GCP_SERVICE_ACCOUNT_JSON --name "$WORKER_NAME"
  fi
fi

# Alerting (optional)
echo ""
echo "Step 2: Configure alert channels (optional, at least one recommended)"
echo "─────────────────────────────────────────────────────────────────────"

read -p "Configure PagerDuty? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  wrangler secret put PAGERDUTY_ROUTING_KEY --name "$WORKER_NAME"
fi

read -p "Configure Discord webhook? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  wrangler secret put DISCORD_WEBHOOK_URL --name "$WORKER_NAME"
fi

read -p "Configure Slack webhook? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  wrangler secret put SLACK_WEBHOOK_URL --name "$WORKER_NAME"
fi

# ── Step 2: Apply Rule Presets ───────────────────────────────────────────────

echo ""
echo "Step 3: Apply kill-switch.net rule presets"
echo "──────────────────────────────────────────"

if [ -n "${KILL_SWITCH_AUTH_TOKEN:-}" ]; then
  for preset in "cost-runaway" "error-storm"; do
    echo "→ Applying preset: ${preset}"
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "${KILL_SWITCH_API}/rules/presets/${preset}" \
      -H "Authorization: Bearer ${KILL_SWITCH_AUTH_TOKEN}" \
      -H "Content-Type: application/json")

    if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
      echo "  ✓ ${preset} preset applied"
    elif [ "$HTTP_CODE" = "409" ]; then
      echo "  ⊘ ${preset} preset already active"
    else
      echo "  ✗ Failed to apply ${preset} (HTTP ${HTTP_CODE})"
    fi
  done
else
  echo "  Skipped — set KILL_SWITCH_AUTH_TOKEN to apply presets via API."
  echo "  Or apply manually at: https://kill-switch.net → Rules → Presets"
  echo "  Recommended presets: cost-runaway, error-storm"
fi

# ── Step 3: Deploy & Test ────────────────────────────────────────────────────

echo ""
echo "Step 4: Deploy and test"
echo "───────────────────────"

echo "→ Deploying worker..."
wrangler deploy

echo ""
echo "→ Running health check..."
HEALTH_URL=$(wrangler whoami 2>/dev/null | grep -oP 'https://[^ ]+' || echo "")
if [ -z "$HEALTH_URL" ]; then
  HEALTH_URL="https://${WORKER_NAME}.divinci.workers.dev"
fi

echo "  Checking: ${HEALTH_URL}/"
curl -s "${HEALTH_URL}/" | python3 -m json.tool 2>/dev/null || curl -s "${HEALTH_URL}/"

echo ""
echo "→ Sending test alert..."
curl -s "${HEALTH_URL}/test-alert" | python3 -m json.tool 2>/dev/null || echo "Test alert sent"

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "    1. Check your alert channels for the test alert"
echo "    2. Visit https://kill-switch.net to verify agent is reporting"
echo "    3. Run a manual check: curl ${HEALTH_URL}/check"
echo "    4. View usage: curl ${HEALTH_URL}/usage"
echo "═══════════════════════════════════════════════════════════════════"
