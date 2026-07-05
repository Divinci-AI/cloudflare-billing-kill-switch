/**
 * Cloudflare Billing Kill Switch
 *
 * A Cloudflare Worker that monitors usage metrics and automatically disconnects
 * runaway workers before they generate surprise bills. Born from an $80K
 * Durable Objects bill.
 *
 * Features:
 * - Monitors Durable Object requests, wall-time, and Worker request volume
 * - Auto-disconnects offending workers (reversible — removes routes, not code)
 * - Alerts via PagerDuty, Discord, Slack, or custom webhooks
 * - Protected workers list to prevent killing critical infrastructure
 * - Configurable thresholds via environment variables
 * - Manual check endpoint for testing
 *
 * @see https://github.com/AiExpanse/cloudflare-billing-kill-switch
 * @license MIT
 */

interface Env {
  // Required secrets (set via `wrangler secret put`)
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;

  // Kill Switch service (https://kill-switch.net)
  KILL_SWITCH_API_URL?: string;       // Default: https://api.kill-switch.net
  KILL_SWITCH_AGENT_API_KEY?: string; // Agent API key from kill-switch.net dashboard

  // GCP Cloud Run monitoring
  GCP_SERVICE_ACCOUNT_JSON?: string;  // GCP service account JSON for monitoring API
  GCP_PROJECT_ID?: string;            // GCP project ID (e.g., "openai-api-4375643")
  GCP_REGION?: string;                // GCP region (default: "us-central1")
  CLOUD_RUN_REQUEST_THRESHOLD: string;     // Daily Cloud Run requests before alerting
  CLOUD_RUN_INSTANCE_THRESHOLD: string;    // Max concurrent instances before alerting
  CLOUD_RUN_MONTHLY_COST_THRESHOLD: string; // Estimated monthly cost USD before alerting

  // Alert destinations (at least one recommended)
  PAGERDUTY_ROUTING_KEY?: string;  // Events API v2 integration key
  DISCORD_WEBHOOK_URL?: string;    // Discord channel webhook URL
  SLACK_WEBHOOK_URL?: string;      // Slack incoming webhook URL
  CUSTOM_WEBHOOK_URL?: string;     // Any HTTP endpoint that accepts POST JSON

  // Thresholds (configurable via wrangler.toml [vars])
  DO_REQUEST_THRESHOLD: string;           // Daily DO requests before alerting
  DO_WALLTIME_HOURS_THRESHOLD: string;    // Daily DO wall-time hours before alerting
  WORKER_REQUEST_THRESHOLD: string;       // Daily Worker requests before alerting
  R2_OPS_THRESHOLD: string;              // Daily R2 operations (class A + B) before alerting
  D1_ROWS_WRITTEN_THRESHOLD: string;     // Daily D1 rows written before alerting
  D1_ROWS_READ_THRESHOLD: string;        // Daily D1 rows read before alerting
  QUEUE_MESSAGES_THRESHOLD: string;      // Daily Queue messages before alerting

  // SDK Docs monitoring thresholds
  SDK_DOCS_COST_THRESHOLD: string;       // Daily SDK docs cost before alerting ($, default: 5)
  SDK_DOCS_REQUEST_THRESHOLD: string;    // Daily SDK docs requests before alerting (default: 100000)
  SDK_DOCS_ERROR_THRESHOLD: string;      // Daily SDK docs errors before alerting (default: 100)

  // Workers AI (LLM inference) monitoring threshold
  AI_NEURONS_THRESHOLD: string;          // Daily Workers AI Neurons before alerting (default: 500000 ≈ $5.50/day)

  // AI Gateway (external-provider LLM cost) + Vectorize thresholds
  AI_GATEWAY_COST_THRESHOLD: string;     // Daily AI Gateway provider cost ($) before alerting (default: 5)
  VECTORIZE_DIMENSIONS_THRESHOLD: string; // Daily Vectorize queried dimensions before alerting (default: 500000000 ≈ $5)

  // Account-wide catch-all + alert de-dup
  TOTAL_DAILY_SPEND_THRESHOLD: string;   // Total estimated daily CF+GCP spend ($) before alerting (default: 50)
  ALERT_COOLDOWN_HOURS: string;          // Suppress repeat webhook alerts for the same violation set (default: 6)
  ALERT_STATE?: KVNamespace;             // Optional KV binding for alert de-dup state (no-op if unbound)

  // Kill switch behavior
  AUTO_DISCONNECT: string;   // "true" to auto-disconnect routes (reversible)
  AUTO_DELETE: string;       // "true" to auto-delete workers (nuclear, irreversible)
  DISCONNECT_THRESHOLD_MULTIPLIER: string; // Auto-disconnect/delete only above N× the ALERT threshold (default 10). Alerts still fire at 1×.
  PROTECTED_WORKERS: string; // Comma-separated worker names to never kill

  ENVIRONMENT: string;
}

interface DOUsage {
  scriptName: string;
  requests: number;
  wallTimeHours: number;
}

interface WorkerUsage {
  scriptName: string;
  requests: number;
  errors: number;
  cpuTimeMs: number;
}

interface R2Usage {
  bucketName: string;
  classAOps: number;   // Mutating: PUT, POST, DELETE, LIST — $4.50/million
  classBOps: number;   // Read: GET, HEAD — $0.36/million
  storageGB: number;
}

interface D1Usage {
  databaseId: string;
  rowsRead: number;    // $0.001/million after 25B free
  rowsWritten: number; // $1.00/million after 50M free
}

interface QueueUsage {
  queueId: string;
  messagesProduced: number;
  messagesConsumed: number;  // $0.40/million
}

interface CloudRunServiceUsage {
  serviceName: string;
  requests: number;
  activeInstances: number;
  estimatedDailyCostUSD: number;
}

// Workers AI inference usage, grouped per model. Neurons is the native
// billable unit ($0.011 / 1,000 Neurons on the standard plan), so it's
// what we threshold on; cost is derived for human-readable alerts.
interface AiUsage {
  modelId: string;
  requests: number;
  neurons: number;
  inputTokens: number;
  outputTokens: number;
}

// Cloudflare Workers AI pricing: $0.011 per 1,000 Neurons → $0.000011 / Neuron.
const NEURON_COST_USD = 0.011 / 1000;

// Vectorize pricing: $0.01 per 1,000,000 queried vector dimensions.
const VECTORIZE_DIM_COST_USD = 0.01 / 1_000_000;

// AI Gateway inference usage (cost the gateway attributes to the UPSTREAM
// provider — e.g. google-ai-studio / vertex / openai). Complements Workers AI
// Neurons monitoring: gateway `cost` is $0 for the workers-ai provider (Neurons
// bills that), but non-zero for external providers that Neurons can't see.
interface AiGatewayUsage {
  gateway: string;
  provider: string;
  requests: number;
  cost: number;            // USD, as attributed by AI Gateway
  erroredRequests: number;
  cachedRequests: number;
}

// Vectorize query usage. Billed on queried vector dimensions. Near-zero for
// Qdrant-primary setups (Vectorize is only a cache here) — monitored for
// completeness / future-proofing.
interface VectorizeUsage {
  indexId: string;
  queriedDimensions: number;
}

interface CheckResult {
  violations: string[];
  actions: string[];
  doUsage: DOUsage[];
  workerUsage: WorkerUsage[];
  r2Usage: R2Usage[];
  d1Usage: D1Usage[];
  queueUsage: QueueUsage[];
  cloudRunUsage: CloudRunServiceUsage[];
  aiUsage: AiUsage[];
  aiGatewayUsage: AiGatewayUsage[];
  vectorizeUsage: VectorizeUsage[];
}

// ─── Cloudflare GraphQL Analytics ───────────────────────────────────────────

async function queryDOUsage(env: Env): Promise<DOUsage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID}"}) {
        durableObjectsInvocationsAdaptiveGroups(
          limit: 50,
          filter: {date_geq: "${today}"},
          orderBy: [sum_requests_DESC]
        ) {
          dimensions { scriptName }
          sum { requests wallTime }
        }
      }
    }
  }`;

  const data = await cfGraphQL(env, query);
  const groups = data?.data?.viewer?.accounts?.[0]?.durableObjectsInvocationsAdaptiveGroups ?? [];
  return groups.map((g: any) => ({
    scriptName: g.dimensions.scriptName,
    requests: g.sum.requests,
    wallTimeHours: g.sum.wallTime / 1e6 / 3600, // microseconds to hours
  }));
}

async function queryWorkerUsage(env: Env): Promise<WorkerUsage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID}"}) {
        workersInvocationsAdaptive(
          limit: 50,
          filter: {date_geq: "${today}"},
          orderBy: [sum_requests_DESC]
        ) {
          dimensions { scriptName }
          sum { requests errors wallTime }
        }
      }
    }
  }`;

  const data = await cfGraphQL(env, query);
  const groups = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return groups.map((g: any) => ({
    scriptName: g.dimensions.scriptName,
    requests: g.sum.requests,
    errors: g.sum.errors,
    cpuTimeMs: g.sum.wallTime / 1000,
  }));
}

// queryAiInferenceUsage — Workers AI (LLM/embedding/audio) inference usage
// grouped per model for today, via the aiInferenceAdaptiveGroups dataset.
// This is the cost center that drove the 2026-06-15 spike (kimi-k2.7-code:
// 982 reqs / 3.67M Neurons / ~$40 in one day vs a <$0.35/day baseline).
// Uses cfGraphQLSafe so a missing `ai:read` token scope degrades to [] rather
// than blocking the other CF checks.
async function queryAiInferenceUsage(env: Env): Promise<AiUsage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID}"}) {
        aiInferenceAdaptiveGroups(
          limit: 100,
          filter: {date_geq: "${today}"},
          orderBy: [sum_totalNeurons_DESC]
        ) {
          dimensions { modelId }
          count
          sum { totalNeurons totalInputTokens totalOutputTokens }
        }
      }
    }
  }`;

  const data = await cfGraphQLSafe(env, query);
  if (!data) return [];

  // Collapse rows so each model is a single entry (the dataset can return one
  // row per model already at this grouping, but sum defensively in case it
  // splits on hidden dimensions).
  const byModel = new Map<string, AiUsage>();
  const groups = data?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
  for (const g of groups) {
    const modelId = g.dimensions.modelId;
    if (!byModel.has(modelId)) {
      byModel.set(modelId, { modelId, requests: 0, neurons: 0, inputTokens: 0, outputTokens: 0 });
    }
    const entry = byModel.get(modelId)!;
    entry.requests += g.count ?? 0;
    entry.neurons += g.sum?.totalNeurons ?? 0;
    entry.inputTokens += g.sum?.totalInputTokens ?? 0;
    entry.outputTokens += g.sum?.totalOutputTokens ?? 0;
  }
  return [...byModel.values()].sort((a, b) => b.neurons - a.neurons);
}

// queryAiGatewayUsage — AI Gateway request/cost usage grouped by gateway +
// upstream provider for today (aiGatewayRequestsAdaptiveGroups). The `cost`
// sum is what the gateway attributes to the upstream provider, so this catches
// external-provider LLM spend (Gemini/Vertex/OpenAI) that Workers AI Neurons
// monitoring cannot see. Safe-degrades to [] without the analytics scope.
async function queryAiGatewayUsage(env: Env): Promise<AiGatewayUsage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID}"}) {
        aiGatewayRequestsAdaptiveGroups(
          limit: 100,
          filter: {date_geq: "${today}"},
          orderBy: [sum_cost_DESC]
        ) {
          dimensions { gateway provider }
          count
          sum { cost erroredRequests cachedRequests }
        }
      }
    }
  }`;

  const data = await cfGraphQLSafe(env, query);
  if (!data) return [];

  const byKey = new Map<string, AiGatewayUsage>();
  const groups = data?.data?.viewer?.accounts?.[0]?.aiGatewayRequestsAdaptiveGroups ?? [];
  for (const g of groups) {
    const gateway = g.dimensions.gateway ?? "unknown";
    const provider = g.dimensions.provider ?? "unknown";
    const key = `${gateway}|${provider}`;
    if (!byKey.has(key)) {
      byKey.set(key, { gateway, provider, requests: 0, cost: 0, erroredRequests: 0, cachedRequests: 0 });
    }
    const entry = byKey.get(key)!;
    entry.requests += g.count ?? 0;
    entry.cost += g.sum?.cost ?? 0;
    entry.erroredRequests += g.sum?.erroredRequests ?? 0;
    entry.cachedRequests += g.sum?.cachedRequests ?? 0;
  }
  return [...byKey.values()].sort((a, b) => b.cost - a.cost);
}

// queryVectorizeUsage — Vectorize queried-dimensions usage per index for today
// (vectorizeQueriesAdaptiveGroups; note: this dataset has no `count` field).
// Safe-degrades to [] without the analytics scope.
async function queryVectorizeUsage(env: Env): Promise<VectorizeUsage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID}"}) {
        vectorizeQueriesAdaptiveGroups(
          limit: 100,
          filter: {date_geq: "${today}"},
          orderBy: [sum_queriedVectorDimensions_DESC]
        ) {
          dimensions { vectorizeIndexId }
          sum { queriedVectorDimensions }
        }
      }
    }
  }`;

  const data = await cfGraphQLSafe(env, query);
  if (!data) return [];

  const byIndex = new Map<string, VectorizeUsage>();
  const groups = data?.data?.viewer?.accounts?.[0]?.vectorizeQueriesAdaptiveGroups ?? [];
  for (const g of groups) {
    const indexId = g.dimensions.vectorizeIndexId ?? "unknown";
    if (!byIndex.has(indexId)) byIndex.set(indexId, { indexId, queriedDimensions: 0 });
    byIndex.get(indexId)!.queriedDimensions += g.sum?.queriedVectorDimensions ?? 0;
  }
  return [...byIndex.values()].sort((a, b) => b.queriedDimensions - a.queriedDimensions);
}

// cfGraphQLSafe — like cfGraphQL but returns null instead of throwing on errors.
// Used for R2/D1/Queue metrics where the GraphQL dataset names may vary.
async function cfGraphQLSafe(env: Env, query: string): Promise<any | null> {
  try {
    return await cfGraphQL(env, query);
  } catch (e) {
    console.error(`[kill-switch] GraphQL query failed (non-fatal): ${e}`);
    return null;
  }
}

async function queryR2Usage(env: Env): Promise<R2Usage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID}"}) {
        r2OperationsAdaptiveGroups(
          limit: 50,
          filter: {date_geq: "${today}"},
          orderBy: [sum_requests_DESC]
        ) {
          dimensions { bucketName actionType }
          sum { requests }
        }
        r2StorageAdaptiveGroups(
          limit: 50,
          filter: {date_geq: "${today}"}
        ) {
          dimensions { bucketName }
          max { payloadSize }
        }
      }
    }
  }`;

  const data = await cfGraphQLSafe(env, query);
  if (!data) return [];

  const account = data?.data?.viewer?.accounts?.[0];
  const opsGroups = account?.r2OperationsAdaptiveGroups ?? [];
  const storageGroups = account?.r2StorageAdaptiveGroups ?? [];

  const buckets = new Map<string, R2Usage>();
  for (const g of opsGroups) {
    const name = g.dimensions.bucketName;
    if (!buckets.has(name)) {
      buckets.set(name, { bucketName: name, classAOps: 0, classBOps: 0, storageGB: 0 });
    }
    const bucket = buckets.get(name)!;
    const actionType = (g.dimensions.actionType || "").toLowerCase();
    if (actionType.includes("get") || actionType.includes("head")) {
      bucket.classBOps += g.sum.requests;
    } else {
      bucket.classAOps += g.sum.requests;
    }
  }
  for (const g of storageGroups) {
    const name = g.dimensions.bucketName;
    if (!buckets.has(name)) {
      buckets.set(name, { bucketName: name, classAOps: 0, classBOps: 0, storageGB: 0 });
    }
    buckets.get(name)!.storageGB = (g.max?.payloadSize || 0) / (1024 * 1024 * 1024);
  }

  return [...buckets.values()];
}

async function queryD1Usage(env: Env): Promise<D1Usage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID}"}) {
        d1AnalyticsAdaptiveGroups(
          limit: 50,
          filter: {date_geq: "${today}"},
          orderBy: [sum_rowsRead_DESC]
        ) {
          dimensions { databaseId }
          sum { rowsRead rowsWritten }
        }
      }
    }
  }`;

  const data = await cfGraphQLSafe(env, query);
  if (!data) return [];

  const groups = data?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  return groups.map((g: any) => ({
    databaseId: g.dimensions.databaseId,
    rowsRead: g.sum.rowsRead,
    rowsWritten: g.sum.rowsWritten,
  }));
}

async function queryQueueUsage(env: Env): Promise<QueueUsage[]> {
  const today = new Date().toISOString().split("T")[0];
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID}"}) {
        queueConsumerMetricsAdaptiveGroups(
          limit: 50,
          filter: {date_geq: "${today}"},
          orderBy: [sum_messages_DESC]
        ) {
          dimensions { queueId }
          sum { messages }
        }
        queueProducerMetricsAdaptiveGroups(
          limit: 50,
          filter: {date_geq: "${today}"},
          orderBy: [sum_messages_DESC]
        ) {
          dimensions { queueId }
          sum { messages }
        }
      }
    }
  }`;

  const data = await cfGraphQLSafe(env, query);
  if (!data) return [];

  const account = data?.data?.viewer?.accounts?.[0];
  const consumerGroups = account?.queueConsumerMetricsAdaptiveGroups ?? [];
  const producerGroups = account?.queueProducerMetricsAdaptiveGroups ?? [];

  const queues = new Map<string, QueueUsage>();
  for (const g of producerGroups) {
    const id = g.dimensions.queueId;
    if (!queues.has(id)) queues.set(id, { queueId: id, messagesProduced: 0, messagesConsumed: 0 });
    queues.get(id)!.messagesProduced += g.sum.messages;
  }
  for (const g of consumerGroups) {
    const id = g.dimensions.queueId;
    if (!queues.has(id)) queues.set(id, { queueId: id, messagesProduced: 0, messagesConsumed: 0 });
    queues.get(id)!.messagesConsumed += g.sum.messages;
  }

  return [...queues.values()];
}

async function cfGraphQL(env: Env, query: string): Promise<any> {
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`CF GraphQL parse error: ${text.substring(0, 200)}`);
  }

  if (data.errors) {
    throw new Error(`CF GraphQL error: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

// ─── GCP Cloud Run Monitoring ────────────────────────────────────────────────

function toBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getGCPAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson);

  // Build JWT for token exchange (all parts must be base64url-encoded per RFC 7519)
  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64Url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/monitoring.read https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));

  // Import the private key and sign
  const keyData = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const keyBuffer = Uint8Array.from(atob(keyData), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureInput = new TextEncoder().encode(`${header}.${payload}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, signatureInput);
  const sig = toBase64Url(String.fromCharCode(...new Uint8Array(signature)));

  const jwt = `${header}.${payload}.${sig}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenText = await tokenRes.text();
  let tokenData: any;
  try {
    tokenData = JSON.parse(tokenText);
  } catch {
    throw new Error(`GCP token parse error: ${tokenText.substring(0, 200)}`);
  }

  if (!tokenData.access_token) {
    throw new Error(`GCP token error: ${tokenText.substring(0, 200)}`);
  }

  return tokenData.access_token;
}

async function queryCloudRunUsage(env: Env): Promise<CloudRunServiceUsage[]> {
  if (!env.GCP_SERVICE_ACCOUNT_JSON || !env.GCP_PROJECT_ID) {
    console.error("[kill-switch] GCP credentials not configured, skipping Cloud Run monitoring");
    return [];
  }

  const accessToken = await getGCPAccessToken(env.GCP_SERVICE_ACCOUNT_JSON);
  const projectId = env.GCP_PROJECT_ID;
  const region = env.GCP_REGION || "us-central1";
  const results: CloudRunServiceUsage[] = [];

  // Dynamically list ALL Cloud Run services (handles inconsistent naming
  // across environments — some production services lack the "production-" prefix)
  const serviceNames = await listCloudRunServices(accessToken, projectId, region);
  console.error(`[kill-switch] Found ${serviceNames.length} Cloud Run services`);

  for (const serviceName of serviceNames) {
    try {
      // Query Cloud Monitoring for request count and instance count
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const endTime = now.toISOString();

      // Request count metric (cumulative today — ALIGN_SUM is correct)
      const requestCount = await queryCloudMonitoringMetric(
        accessToken, projectId,
        `metric.type="run.googleapis.com/request_count" AND resource.labels.service_name="${serviceName}"`,
        startOfDay, endTime,
        "ALIGN_SUM"
      );

      // Peak concurrent instances today (ALIGN_MAX — not SUM, which would
      // sum every sampled data point into a meaningless cumulative number)
      const peakInstances = await queryCloudMonitoringMetric(
        accessToken, projectId,
        `metric.type="run.googleapis.com/container/instance_count" AND resource.labels.service_name="${serviceName}"`,
        startOfDay, endTime,
        "ALIGN_MAX"
      );

      // Estimate daily cost based on Cloud Run pricing (2nd gen, us-central1):
      // CPU: $0.00002400/vCPU-second, Memory: $0.00000250/GiB-second
      // Request: $0.40/million
      // Assumes 2 vCPU, 2 GiB per instance (matches deploy/config.json defaults)
      const hoursElapsedToday = (now.getTime() - new Date(startOfDay).getTime()) / 3600000;
      const cpuCostPerInstanceHour = 2 * 0.0000240 * 3600;    // 2 vCPU × rate × 3600s
      const memCostPerInstanceHour = 2 * 0.0000025 * 3600;    // 2 GiB × rate × 3600s
      const instanceCostSoFar = peakInstances * (cpuCostPerInstanceHour + memCostPerInstanceHour) * hoursElapsedToday;
      const requestCost = requestCount * 0.0000004;

      // Only extrapolate to full day if we have at least 2 hours of data.
      // Before that, extrapolation amplifies noise wildly (e.g., at 00:01,
      // multiplier is 1,440x — a single request would estimate $960/day).
      let estimatedDailyCost: number;
      if (hoursElapsedToday >= 2) {
        estimatedDailyCost = (instanceCostSoFar + requestCost) * (24 / hoursElapsedToday);
      } else {
        // Use raw accumulated cost — no extrapolation
        estimatedDailyCost = instanceCostSoFar + requestCost;
      }

      results.push({
        serviceName,
        requests: requestCount,
        activeInstances: peakInstances,
        estimatedDailyCostUSD: Math.round(estimatedDailyCost * 100) / 100,
      });
    } catch (e) {
      console.error(`[kill-switch] Error checking Cloud Run service ${serviceName}: ${e}`);
    }
  }

  return results;
}

async function listCloudRunServices(
  accessToken: string,
  projectId: string,
  region: string
): Promise<string[]> {
  const res = await fetch(
    `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services?pageSize=100`,
    { headers: { "Authorization": `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error(`[kill-switch] Failed to list Cloud Run services: ${res.status} ${text.substring(0, 200)}`);
    return [];
  }

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    console.error(`[kill-switch] Failed to parse Cloud Run services list: ${text.substring(0, 200)}`);
    return [];
  }

  // Filter to divinci-* services only (skip unrelated services in the project)
  return (data.services || [])
    .map((s: any) => {
      // name format: "projects/PROJECT/locations/REGION/services/SERVICE_NAME"
      const parts = (s.name as string).split("/");
      return parts[parts.length - 1];
    })
    .filter((name: string) => name.startsWith("divinci-"));
}

async function queryCloudMonitoringMetric(
  accessToken: string,
  projectId: string,
  filter: string,
  startTime: string,
  endTime: string,
  aligner: "ALIGN_SUM" | "ALIGN_MAX" | "ALIGN_MEAN" = "ALIGN_SUM"
): Promise<number> {
  const params = new URLSearchParams({
    filter,
    "interval.startTime": startTime,
    "interval.endTime": endTime,
    "aggregation.alignmentPeriod": "86400s",
    "aggregation.perSeriesAligner": aligner,
  });

  const res = await fetch(
    `https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries?${params}`,
    { headers: { "Authorization": `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error(`[kill-switch] Cloud Monitoring error: ${res.status} ${text.substring(0, 200)}`);
    return 0;
  }

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return 0;
  }

  // Sum up all time series points
  let total = 0;
  for (const ts of data.timeSeries || []) {
    for (const point of ts.points || []) {
      total += Number(point.value?.int64Value || point.value?.doubleValue || 0);
    }
  }
  return total;
}

// ─── Kill Switch Service Reporting ──────────────────────────────────────────

async function reportToKillSwitch(
  env: Env,
  result: CheckResult
): Promise<void> {
  if (!env.KILL_SWITCH_AGENT_API_KEY) {
    console.error("[kill-switch] KILL_SWITCH_AGENT_API_KEY not set, skipping kill-switch.net reporting");
    return;
  }

  const apiUrl = env.KILL_SWITCH_API_URL || "https://api.kill-switch.net";

  // Combine CF workers + GCP Cloud Run into unified service list
  const services = [
    ...result.workerUsage.map((w) => ({
      name: `cf:${w.scriptName}`,
      doRequests: 0,
      workerRequests: w.requests,
      estimatedDailyCostUSD: w.requests * 0.0000003, // $0.30/million after free tier
    })),
    ...result.doUsage.map((d) => ({
      name: `cf:${d.scriptName}`,
      doRequests: d.requests,
      workerRequests: 0,
      estimatedDailyCostUSD: (d.requests * 0.00000015) + (d.wallTimeHours * 12.50 / 1000), // rough DO pricing
    })),
    ...result.cloudRunUsage.map((cr) => ({
      name: `gcp:${cr.serviceName}`,
      doRequests: 0,
      workerRequests: cr.requests,
      estimatedDailyCostUSD: cr.estimatedDailyCostUSD,
    })),
    // Workers AI (Neurons) — the cost center behind the 2026-06-15 spike.
    ...result.aiUsage.map((a) => ({
      name: `cf-ai:${a.modelId}`,
      doRequests: 0,
      workerRequests: 0,
      estimatedDailyCostUSD: a.neurons * NEURON_COST_USD,
    })),
    // AI Gateway upstream-provider cost (Gemini/Vertex/OpenAI) — external spend
    // that Neurons can't see. Skip zero-cost rows (e.g. the workers-ai provider).
    ...result.aiGatewayUsage
      .filter((g) => g.cost > 0)
      .map((g) => ({
        name: `cf-aigw:${g.gateway}/${g.provider}`,
        doRequests: 0,
        workerRequests: 0,
        estimatedDailyCostUSD: g.cost,
      })),
  ];

  const totalCost = services.reduce((sum, s) => sum + s.estimatedDailyCostUSD, 0);

  const payload = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    checkedAt: Date.now(),
    services,
    totalEstimatedDailyCostUSD: Math.round(totalCost * 100) / 100,
    violations: result.violations.map((v) => ({ message: v, severity: "critical" })),
    actionsTaken: result.actions.map((a) => ({ action: a, timestamp: new Date().toISOString() })),
  };

  try {
    const res = await fetch(`${apiUrl}/agent/report`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.KILL_SWITCH_AGENT_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[kill-switch] kill-switch.net report error: ${res.status} ${text.substring(0, 200)}`);
    } else {
      console.error("[kill-switch] Successfully reported to kill-switch.net");
    }
  } catch (e) {
    console.error(`[kill-switch] Failed to report to kill-switch.net: ${e}`);
  }
}

// ─── Worker Kill Switch ─────────────────────────────────────────────────────

async function disconnectWorker(env: Env, scriptName: string): Promise<string[]> {
  const actions: string[] = [];
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  const headers = {
    "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  // 1. Disable workers.dev subdomain
  try {
    const res = await fetch(`${baseUrl}/workers/scripts/${scriptName}/subdomain`, {
      method: "POST",
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    if (res.ok) {
      actions.push(`Disabled workers.dev subdomain for ${scriptName}`);
    } else {
      const text = await res.text();
      actions.push(`Failed to disable subdomain: ${res.status} ${text.substring(0, 100)}`);
    }
  } catch (e) {
    actions.push(`Error disabling subdomain: ${e}`);
  }

  // 2. Get and remove custom domains
  try {
    const res = await fetch(`${baseUrl}/workers/domains?service=${scriptName}`, { headers });
    if (res.ok) {
      const responseText = await res.text();
      let data: any;
      try {
        data = JSON.parse(responseText);
      } catch {
        actions.push(`Failed to parse domains response: ${responseText.substring(0, 100)}`);
        return actions;
      }
      for (const domain of data.result || []) {
        const delRes = await fetch(`${baseUrl}/workers/domains/${domain.id}`, {
          method: "DELETE",
          headers,
        });
        if (delRes.ok) {
          actions.push(`Removed custom domain ${domain.hostname} from ${scriptName}`);
        }
      }
    }
  } catch (e) {
    actions.push(`Error removing domains: ${e}`);
  }

  return actions;
}

async function deleteWorker(env: Env, scriptName: string): Promise<string> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${scriptName}?force=true`,
    {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    }
  );
  if (res.ok) {
    return `DELETED worker ${scriptName}`;
  }
  const text = await res.text();
  return `Failed to delete ${scriptName}: ${res.status} ${text.substring(0, 100)}`;
}

// ─── Alerting ───────────────────────────────────────────────────────────────

// djb2 — tiny stable string hash for de-dup keys (no crypto needed).
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// shouldSuppressWebhookAlerts — edge-triggered alerting for the chatty
// webhook channels (Discord/Slack/custom). The cron runs every 5 min and
// daily-cumulative thresholds (Neurons, requests, rows) stay tripped for the
// rest of the day once crossed — without this, each channel would repeat the
// same alert ~288×/day. PagerDuty is unaffected (it self-dedups via dedup_key).
//
// Keyed by a value-independent signature of the violation set (digits stripped)
// scoped to the day; presence of the KV key within its TTL = inside the cooldown
// window, so we suppress. No KV binding → returns false (current behaviour).
async function shouldSuppressWebhookAlerts(env: Env, violations: string[]): Promise<boolean> {
  if (!env.ALERT_STATE) return false;
  const cooldownHours = parseFloat(env.ALERT_COOLDOWN_HOURS || "6");
  if (cooldownHours <= 0) return false;

  const today = new Date().toISOString().split("T")[0];
  const signature = violations
    .map(v => v.replace(/[\d.,$%]+/g, "#"))
    .sort()
    .join("|");
  const key = `alert:${today}:${djb2(signature)}`;

  try {
    const seen = await env.ALERT_STATE.get(key);
    if (seen) return true; // within cooldown — suppress chatty channels
    await env.ALERT_STATE.put(key, new Date().toISOString(), {
      expirationTtl: Math.max(60, Math.round(cooldownHours * 3600)),
    });
    return false;
  } catch (e) {
    console.error(`[kill-switch] alert de-dup KV error (failing open): ${e}`);
    return false; // never let de-dup state swallow a real alert
  }
}

async function sendAlerts(
  env: Env,
  summary: string,
  severity: "critical" | "error" | "warning" | "info",
  details: Record<string, unknown>,
  dedupSuffix = "",
  suppressWebhooks = false
): Promise<void> {
  const promises: Promise<void>[] = [];

  // PagerDuty always fires — it collapses repeats into a single incident via
  // dedup_key, so it's safe to re-trigger every check (keeps the incident live).
  if (env.PAGERDUTY_ROUTING_KEY) {
    promises.push(alertPagerDuty(env, summary, severity, details, dedupSuffix));
  }
  if (suppressWebhooks) {
    console.error("[kill-switch] Webhook channels suppressed (within alert cooldown); PagerDuty still notified.");
  } else {
    if (env.DISCORD_WEBHOOK_URL) {
      promises.push(alertDiscord(env, summary, severity, details));
    }
    if (env.SLACK_WEBHOOK_URL) {
      promises.push(alertSlack(env, summary, severity, details));
    }
    if (env.CUSTOM_WEBHOOK_URL) {
      promises.push(alertCustomWebhook(env, summary, severity, details));
    }
  }

  if (promises.length === 0 && !suppressWebhooks) {
    console.error("[kill-switch] WARNING: No alert destinations configured. Set at least one of: PAGERDUTY_ROUTING_KEY, DISCORD_WEBHOOK_URL, SLACK_WEBHOOK_URL, CUSTOM_WEBHOOK_URL");
  }

  await Promise.allSettled(promises);
}

// Resolve a secret binding to its string value. Handles BOTH shapes:
// a plain string (secret_text / var) and a Cloudflare Secrets Store binding
// (object exposing async .get()). PAGERDUTY_ROUTING_KEY is declared as a
// [[secrets_store_secrets]] binding in wrangler.toml, so it arrives as an
// object here — reading it as a bare string would serialize "[object Object]".
async function resolveSecret(v: unknown): Promise<string> {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof (v as { get?: unknown }).get === "function") {
    try { return String(await (v as { get: () => Promise<string> }).get() ?? ""); } catch { return ""; }
  }
  return String(v);
}

async function alertPagerDuty(
  env: Env,
  summary: string,
  severity: "critical" | "error" | "warning" | "info",
  details: Record<string, unknown>,
  dedupSuffix = ""
): Promise<void> {
  const dedup = `cf-billing-${new Date().toISOString().split("T")[0]}${dedupSuffix ? `-${dedupSuffix}` : ""}`;

  const res = await fetch("https://events.pagerduty.com/v2/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      routing_key: env.PAGERDUTY_ROUTING_KEY,
      event_action: "trigger",
      dedup_key: dedup,
      payload: {
        summary,
        source: "cloudflare-billing-kill-switch",
        severity,
        component: "cloudflare-workers",
        group: env.ENVIRONMENT || "production",
        class: "billing",
        custom_details: details,
      },
      client: "Cloudflare Billing Kill Switch",
      client_url: "https://dash.cloudflare.com",
    }),
  });

  if (!res.ok) {
    console.error(`[kill-switch] PagerDuty error: ${res.status} ${await res.text()}`);
  }
}

async function alertDiscord(
  env: Env,
  summary: string,
  severity: "critical" | "error" | "warning" | "info",
  details: Record<string, unknown>
): Promise<void> {
  const colorMap = { critical: 0xFF0000, error: 0xFF6600, warning: 0xFFCC00, info: 0x0099FF };

  const res = await fetch(env.DISCORD_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: `Cloudflare Billing Alert [${severity.toUpperCase()}]`,
        description: summary,
        color: colorMap[severity],
        fields: Object.entries(details).slice(0, 10).map(([key, value]) => ({
          name: key,
          value: typeof value === "string" ? value : JSON.stringify(value).substring(0, 200),
          inline: false,
        })),
        timestamp: new Date().toISOString(),
      }],
    }),
  });

  if (!res.ok) {
    console.error(`[kill-switch] Discord error: ${res.status} ${await res.text()}`);
  }
}

async function alertSlack(
  env: Env,
  summary: string,
  severity: "critical" | "error" | "warning" | "info",
  details: Record<string, unknown>
): Promise<void> {
  const emojiMap = { critical: ":rotating_light:", error: ":warning:", warning: ":large_yellow_circle:", info: ":information_source:" };

  const res = await fetch(env.SLACK_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `${emojiMap[severity]} *Cloudflare Billing Alert [${severity.toUpperCase()}]*\n${summary}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `${emojiMap[severity]} *Cloudflare Billing Alert [${severity.toUpperCase()}]*\n${summary}` },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: "```" + JSON.stringify(details, null, 2).substring(0, 2500) + "```" },
        },
      ],
    }),
  });

  if (!res.ok) {
    console.error(`[kill-switch] Slack error: ${res.status} ${await res.text()}`);
  }
}

async function alertCustomWebhook(
  env: Env,
  summary: string,
  severity: "critical" | "error" | "warning" | "info",
  details: Record<string, unknown>
): Promise<void> {
  const res = await fetch(env.CUSTOM_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary, severity, details, timestamp: new Date().toISOString(), source: "cloudflare-billing-kill-switch" }),
  });

  if (!res.ok) {
    console.error(`[kill-switch] Custom webhook error: ${res.status}`);
  }
}

// ─── Main Check ─────────────────────────────────────────────────────────────

async function checkUsage(env: Env): Promise<CheckResult> {
  const doReqThreshold = parseInt(env.DO_REQUEST_THRESHOLD || "1000000");
  const doWallThreshold = parseFloat(env.DO_WALLTIME_HOURS_THRESHOLD || "100");
  const workerReqThreshold = parseInt(env.WORKER_REQUEST_THRESHOLD || "10000000");
  const crReqThreshold = parseInt(env.CLOUD_RUN_REQUEST_THRESHOLD || "5000000");
  const crInstanceThreshold = parseInt(env.CLOUD_RUN_INSTANCE_THRESHOLD || "50");
  const crMonthlyCostThreshold = parseFloat(env.CLOUD_RUN_MONTHLY_COST_THRESHOLD || "500");
  const autoDisconnect = env.AUTO_DISCONNECT === "true";
  const autoDelete = env.AUTO_DELETE === "true";
  // Auto-disconnect/delete only on a genuine runaway — N× the alert threshold.
  // Alerts still fire at 1×; this just keeps the destructive action from tripping
  // on ordinary over-threshold traffic. Guard against a foot-gun value of <1.
  const disconnectMultiplier = Math.max(1, parseFloat(env.DISCONNECT_THRESHOLD_MULTIPLIER || "10"));
  const protectedWorkers = (env.PROTECTED_WORKERS || "").split(",").map(s => s.trim()).filter(Boolean);

  const violations: string[] = [];
  const actions: string[] = [];

  const r2OpsThreshold = parseInt(env.R2_OPS_THRESHOLD || "50000000");
  const d1RowsWrittenThreshold = parseInt(env.D1_ROWS_WRITTEN_THRESHOLD || "10000000");
  const d1RowsReadThreshold = parseInt(env.D1_ROWS_READ_THRESHOLD || "500000000");
  const queueMsgThreshold = parseInt(env.QUEUE_MESSAGES_THRESHOLD || "50000000");
  const aiNeuronsThreshold = parseInt(env.AI_NEURONS_THRESHOLD || "500000");
  const aiGatewayCostThreshold = parseFloat(env.AI_GATEWAY_COST_THRESHOLD || "5");
  const vectorizeDimsThreshold = parseInt(env.VECTORIZE_DIMENSIONS_THRESHOLD || "500000000");
  const totalDailySpendThreshold = parseFloat(env.TOTAL_DAILY_SPEND_THRESHOLD || "50");

  // Check Cloudflare usage (wrapped in try/catch so CF failures
  // don't prevent GCP checks or kill-switch.net reporting)
  let doUsage: DOUsage[] = [];
  let workerUsage: WorkerUsage[] = [];
  let r2Usage: R2Usage[] = [];
  let d1Usage: D1Usage[] = [];
  let queueUsage: QueueUsage[] = [];
  let aiUsage: AiUsage[] = [];
  let aiGatewayUsage: AiGatewayUsage[] = [];
  let vectorizeUsage: VectorizeUsage[] = [];
  try {
    // Check DO usage
    console.error("[kill-switch] Checking Durable Object usage...");
    doUsage = await queryDOUsage(env);

    for (const usage of doUsage) {
      const reqExceeded = usage.requests > doReqThreshold;
      const wallExceeded = usage.wallTimeHours > doWallThreshold;

      if (reqExceeded || wallExceeded) {
        const msg = `DO THRESHOLD EXCEEDED: ${usage.scriptName} - ${usage.requests.toLocaleString()} reqs, ${usage.wallTimeHours.toFixed(0)}h wall-time`;
        violations.push(msg);
        console.error(`[kill-switch] ${msg}`);

        if (protectedWorkers.includes(usage.scriptName)) {
          actions.push(`PROTECTED: ${usage.scriptName} exceeded threshold but is protected`);
          continue;
        }

        // Destructive action only on a genuine runaway (N× the alert threshold).
        const runaway = usage.requests > doReqThreshold * disconnectMultiplier
          || usage.wallTimeHours > doWallThreshold * disconnectMultiplier;
        if (!runaway) {
          console.error(`[kill-switch] ${usage.scriptName}: over alert threshold but below ${disconnectMultiplier}× kill threshold — alert only`);
        } else if (autoDelete) {
          const result = await deleteWorker(env, usage.scriptName);
          actions.push(result);
        } else if (autoDisconnect) {
          const results = await disconnectWorker(env, usage.scriptName);
          actions.push(...results);
        }
      } else {
        console.error(`[kill-switch] ${usage.scriptName}: ${usage.requests.toLocaleString()} reqs - ok`);
      }
    }

    // Check Worker request volume (catch feedback loops)
    console.error("[kill-switch] Checking Worker request volumes...");
    workerUsage = await queryWorkerUsage(env);

    for (const usage of workerUsage) {
      if (usage.requests > workerReqThreshold) {
        const msg = `WORKER REQUEST SPIKE: ${usage.scriptName} - ${usage.requests.toLocaleString()} reqs today`;
        violations.push(msg);
        console.error(`[kill-switch] ${msg}`);

        if (protectedWorkers.includes(usage.scriptName)) {
          actions.push(`PROTECTED: ${usage.scriptName} request spike but is protected`);
          continue;
        }

        // Disconnect only on a genuine runaway (N× the alert threshold).
        if (usage.requests <= workerReqThreshold * disconnectMultiplier) {
          console.error(`[kill-switch] ${usage.scriptName}: over alert threshold but below ${disconnectMultiplier}× kill threshold — alert only`);
        } else if (autoDisconnect) {
          const results = await disconnectWorker(env, usage.scriptName);
          actions.push(...results);
        }
      }
    }
    // Check R2 operations
    console.error("[kill-switch] Checking R2 usage...");
    r2Usage = await queryR2Usage(env);
    for (const usage of r2Usage) {
      const totalOps = usage.classAOps + usage.classBOps;
      if (totalOps > r2OpsThreshold) {
        const cost = (usage.classAOps * 4.50 / 1e6) + (usage.classBOps * 0.36 / 1e6);
        violations.push(`R2 OPS SPIKE: ${usage.bucketName} - ${totalOps.toLocaleString()} ops today (~$${cost.toFixed(2)})`);
      }
    }

    // Check D1 usage
    console.error("[kill-switch] Checking D1 usage...");
    d1Usage = await queryD1Usage(env);
    for (const usage of d1Usage) {
      if (usage.rowsWritten > d1RowsWrittenThreshold) {
        const cost = usage.rowsWritten * 1.00 / 1e6;
        violations.push(`D1 WRITE SPIKE: ${usage.databaseId} - ${usage.rowsWritten.toLocaleString()} rows written (~$${cost.toFixed(2)})`);
      }
      if (usage.rowsRead > d1RowsReadThreshold) {
        violations.push(`D1 READ SPIKE: ${usage.databaseId} - ${usage.rowsRead.toLocaleString()} rows read`);
      }
    }

    // Check Queue usage
    console.error("[kill-switch] Checking Queue usage...");
    queueUsage = await queryQueueUsage(env);
    for (const usage of queueUsage) {
      const totalMsgs = usage.messagesProduced + usage.messagesConsumed;
      if (totalMsgs > queueMsgThreshold) {
        const cost = totalMsgs * 0.40 / 1e6;
        violations.push(`QUEUE SPIKE: ${usage.queueId} - ${totalMsgs.toLocaleString()} messages (~$${cost.toFixed(2)})`);
      }
    }

    // Check Workers AI (LLM/embedding) inference — the cost center behind the
    // 2026-06-15 spike. Thresholds on total daily Neurons across all models;
    // names the top offenders in the alert. NOTE: this is detect-and-alert
    // only — there is no Cloudflare API to throttle a specific model, so the
    // mitigation is in the app (drop the offending model from the fallback
    // chain / unbind Workers AI), not an automatic disconnect here.
    console.error("[kill-switch] Checking Workers AI usage...");
    aiUsage = await queryAiInferenceUsage(env);
    const totalNeurons = aiUsage.reduce((s, a) => s + a.neurons, 0);
    if (totalNeurons > aiNeuronsThreshold) {
      const totalCost = totalNeurons * NEURON_COST_USD;
      const top = aiUsage
        .slice(0, 3)
        .map(a => `${a.modelId} (${Math.round(a.neurons).toLocaleString()}n / $${(a.neurons * NEURON_COST_USD).toFixed(2)})`)
        .join(", ");
      const msg = `WORKERS AI SPIKE: ${Math.round(totalNeurons).toLocaleString()} Neurons today (~$${totalCost.toFixed(2)}) — top: ${top}`;
      violations.push(msg);
      console.error(`[kill-switch] ${msg}`);
    } else {
      console.error(`[kill-switch] Workers AI: ${Math.round(totalNeurons).toLocaleString()} Neurons (~$${(totalNeurons * NEURON_COST_USD).toFixed(2)}) - ok`);
    }

    // Check AI Gateway — external-provider LLM cost (Gemini/Vertex/OpenAI)
    // routed through the gateway, which Workers AI Neurons monitoring can't see.
    console.error("[kill-switch] Checking AI Gateway usage...");
    aiGatewayUsage = await queryAiGatewayUsage(env);
    const totalGatewayCost = aiGatewayUsage.reduce((s, g) => s + g.cost, 0);
    if (totalGatewayCost > aiGatewayCostThreshold) {
      const top = aiGatewayUsage
        .filter(g => g.cost > 0)
        .slice(0, 3)
        .map(g => `${g.gateway}/${g.provider} ($${g.cost.toFixed(2)})`)
        .join(", ");
      const msg = `AI GATEWAY SPIKE: ~$${totalGatewayCost.toFixed(2)} provider cost today — top: ${top}`;
      violations.push(msg);
      console.error(`[kill-switch] ${msg}`);
    } else {
      console.error(`[kill-switch] AI Gateway: ~$${totalGatewayCost.toFixed(2)} provider cost - ok`);
    }

    // Check Vectorize — queried vector dimensions (billable unit). Near-zero
    // for Qdrant-primary setups; monitored for completeness.
    console.error("[kill-switch] Checking Vectorize usage...");
    vectorizeUsage = await queryVectorizeUsage(env);
    const totalQueriedDims = vectorizeUsage.reduce((s, v) => s + v.queriedDimensions, 0);
    if (totalQueriedDims > vectorizeDimsThreshold) {
      const cost = totalQueriedDims * VECTORIZE_DIM_COST_USD;
      const top = vectorizeUsage.slice(0, 3).map(v => `${v.indexId} (${v.queriedDimensions.toLocaleString()})`).join(", ");
      const msg = `VECTORIZE SPIKE: ${totalQueriedDims.toLocaleString()} queried dimensions today (~$${cost.toFixed(2)}) — top: ${top}`;
      violations.push(msg);
      console.error(`[kill-switch] ${msg}`);
    } else {
      console.error(`[kill-switch] Vectorize: ${totalQueriedDims.toLocaleString()} queried dimensions - ok`);
    }
  } catch (e) {
    console.error(`[kill-switch] Cloudflare check failed (GCP checks unaffected): ${e}`);
    violations.push(`CF MONITORING ERROR: ${e}`);
  }

  // Check GCP Cloud Run usage (wrapped in try/catch so GCP failures
  // don't prevent Cloudflare violations from being alerted)
  let cloudRunUsage: CloudRunServiceUsage[] = [];
  try {
    console.error("[kill-switch] Checking GCP Cloud Run usage...");
    cloudRunUsage = await queryCloudRunUsage(env);

    for (const usage of cloudRunUsage) {
      const reqExceeded = usage.requests > crReqThreshold;
      const instanceExceeded = usage.activeInstances > crInstanceThreshold;
      const costExceeded = (usage.estimatedDailyCostUSD * 30) > crMonthlyCostThreshold;

      if (reqExceeded || instanceExceeded || costExceeded) {
        const reasons: string[] = [];
        if (reqExceeded) reasons.push(`${usage.requests.toLocaleString()} reqs`);
        if (instanceExceeded) reasons.push(`${usage.activeInstances} active instances`);
        if (costExceeded) reasons.push(`$${(usage.estimatedDailyCostUSD * 30).toFixed(0)}/mo estimated`);

        const msg = `CLOUD RUN THRESHOLD EXCEEDED: ${usage.serviceName} - ${reasons.join(", ")}`;
        violations.push(msg);
        console.error(`[kill-switch] ${msg}`);

        // Scale-to-zero only on a genuine runaway (N× the alert threshold).
        const runaway = usage.requests > crReqThreshold * disconnectMultiplier
          || usage.activeInstances > crInstanceThreshold * disconnectMultiplier
          || (usage.estimatedDailyCostUSD * 30) > crMonthlyCostThreshold * disconnectMultiplier;

        // Cloud Run auto-disconnect: set min/max instances to 0 via Cloud Run Admin API
        // This is less destructive than deleting — just stops new instances from spinning up
        // Never auto-disconnect protected Cloud Run services (prod API/live/webhook).
        // PROTECTED_WORKERS doubles as the protected list for Cloud Run names here;
        // the GCP-side kill switch has its own PROTECTED_SERVICES.
        const protectedCloudRun = (env.PROTECTED_WORKERS || "").split(",").map(s=>s.trim()).filter(Boolean);
        if (!runaway) {
          console.error(`[kill-switch] ${usage.serviceName}: over alert threshold but below ${disconnectMultiplier}× kill threshold — alert only`);
        } else if (protectedCloudRun.includes(usage.serviceName)) {
          actions.push(`PROTECTED: ${usage.serviceName} exceeded ${disconnectMultiplier}× kill threshold but is protected — alert only`);
          console.error(`[kill-switch] ${usage.serviceName}: runaway but PROTECTED — not disconnecting`);
        } else if (autoDisconnect && env.GCP_SERVICE_ACCOUNT_JSON && env.GCP_PROJECT_ID) {
          const action = await disableCloudRunService(env, usage.serviceName);
          actions.push(action);
        }
      } else {
        console.error(`[kill-switch] ${usage.serviceName}: ${usage.requests.toLocaleString()} reqs, ${usage.activeInstances} instances - ok`);
      }
    }
  } catch (e) {
    console.error(`[kill-switch] GCP Cloud Run check failed (CF alerts unaffected): ${e}`);
    violations.push(`GCP MONITORING ERROR: ${e}`);
  }

  // ── SDK Docs Specific Monitoring ─────────────────────────────────
  // Check SDK docs workers against dedicated thresholds (cost, traffic,
  // error rate). These are granular alerts complementing the general
  // WORKER_REQUEST_THRESHOLD — SDK docs has its own budget because it's
  // a static-asset site with predictable traffic patterns.
  const sdkDocsCostThreshold = parseFloat(env.SDK_DOCS_COST_THRESHOLD || "5");
  const sdkDocsReqThreshold = parseInt(env.SDK_DOCS_REQUEST_THRESHOLD || "100000");
  const sdkDocsErrThreshold = parseInt(env.SDK_DOCS_ERROR_THRESHOLD || "100");

  const sdkDocsWorkers = workerUsage.filter(w =>
    w.scriptName.includes("divinci-sdk-docs")
  );

  for (const w of sdkDocsWorkers) {
    const dailyCost = Math.round(w.requests * 0.0000003 * 100) / 100;
    const reasons: string[] = [];

    if (dailyCost > sdkDocsCostThreshold) reasons.push(`$${dailyCost.toFixed(2)} cost`);
    if (w.requests > sdkDocsReqThreshold) reasons.push(`${w.requests.toLocaleString()} reqs`);
    if (w.errors > sdkDocsErrThreshold) reasons.push(`${w.errors} errors`);

    if (reasons.length > 0) {
      const msg = `SDK DOCS ALERT: ${w.scriptName} - ${reasons.join(", ")}`;
      violations.push(msg);
      console.error(`[kill-switch] ${msg}`);
    } else {
      console.error(`[kill-switch] ${w.scriptName}: $${dailyCost.toFixed(2)} cost, ${w.requests.toLocaleString()} reqs - ok`);
    }
  }

  // ── Account-wide catch-all ───────────────────────────────────────
  // Sum the main billable CF surfaces + Workers AI + GCP Cloud Run and alert
  // if the day's total crosses TOTAL_DAILY_SPEND_THRESHOLD. This is the safety
  // net for cost in a service we DON'T have a dedicated threshold for (Images,
  // Stream, KV, a brand-new worker, etc.). Mirrors the /spend total; AI Gateway
  // external-provider cost is excluded here (billed off-CF, has its own check).
  const totalEstDailySpend =
    doUsage.reduce((s, d) => s + (d.requests * 0.00000015) + (d.wallTimeHours * 12.50 / 1000), 0) +
    workerUsage.reduce((s, w) => s + w.requests * 0.0000003, 0) +
    r2Usage.reduce((s, r) => s + (r.classAOps * 4.50 / 1e6) + (r.classBOps * 0.36 / 1e6), 0) +
    aiUsage.reduce((s, a) => s + a.neurons * NEURON_COST_USD, 0) +
    cloudRunUsage.reduce((s, cr) => s + cr.estimatedDailyCostUSD, 0);
  if (totalEstDailySpend > totalDailySpendThreshold) {
    const msg = `TOTAL DAILY SPEND: ~$${totalEstDailySpend.toFixed(2)} estimated today (threshold $${totalDailySpendThreshold})`;
    violations.push(msg);
    console.error(`[kill-switch] ${msg}`);
  } else {
    console.error(`[kill-switch] Total estimated daily spend: ~$${totalEstDailySpend.toFixed(2)} (threshold $${totalDailySpendThreshold}) - ok`);
  }

  // Send alerts if any violations
  if (violations.length > 0) {
    const providers = new Set<string>();
    if (doUsage.length > 0 || workerUsage.length > 0) providers.add("Cloudflare");
    if (cloudRunUsage.length > 0) providers.add("GCP");

    // Edge-trigger the chatty webhook channels so a day-long tripped threshold
    // doesn't repeat ~288×/day. PagerDuty still fires (self-dedups).
    const suppressWebhooks = await shouldSuppressWebhookAlerts(env, violations);

    await sendAlerts(
      env,
      `Cost alert [${[...providers].join("+")}]: ${violations.length} service(s) exceeded thresholds`,
      "critical",
      {
        violations,
        actionsTaken: actions,
        autoDisconnect,
        autoDelete,
        totalEstimatedDailySpendUSD: Math.round(totalEstDailySpend * 100) / 100,
        thresholds: {
          doReqThreshold, doWallThreshold, workerReqThreshold,
          crReqThreshold, crInstanceThreshold, crMonthlyCostThreshold,
          totalDailySpendThreshold,
        },
        disconnectThresholdMultiplier: disconnectMultiplier,
        checkedAt: new Date().toISOString(),
      },
      "",
      suppressWebhooks
    );
  } else {
    console.error("[kill-switch] All usage within thresholds.");
  }

  const result: CheckResult = { violations, actions, doUsage, workerUsage, r2Usage, d1Usage, queueUsage, cloudRunUsage, aiUsage, aiGatewayUsage, vectorizeUsage };

  // Report to kill-switch.net
  await reportToKillSwitch(env, result);

  return result;
}

async function disableCloudRunService(env: Env, serviceName: string): Promise<string> {
  try {
    const accessToken = await getGCPAccessToken(env.GCP_SERVICE_ACCOUNT_JSON!);
    const projectId = env.GCP_PROJECT_ID!;
    const region = env.GCP_REGION || "us-central1";

    // Set max instances to 0 to stop new traffic (reversible via console or gcloud)
    const res = await fetch(
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}?updateMask=template.scaling.maxInstanceCount`,
      {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          template: {
            scaling: { maxInstanceCount: 0 },
          },
        }),
      }
    );

    if (res.ok) {
      return `DISABLED Cloud Run service ${serviceName} (set maxInstances=0)`;
    }
    const text = await res.text();
    return `Failed to disable Cloud Run ${serviceName}: ${res.status} ${text.substring(0, 100)}`;
  } catch (e) {
    return `Error disabling Cloud Run ${serviceName}: ${e}`;
  }
}

// ─── Worker Entry Points ────────────────────────────────────────────────────

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await checkUsage(env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GCP Monitoring → Slack relay. Token-gated via ?token=, isolated to Slack
    // forwarding only — it cannot reach checkUsage/kill-switch logic. Lets GCP
    // alert policies notify Slack without GCP's native (OAuth-only) Slack channel,
    // reusing the SLACK_WEBHOOK_URL this worker already binds. (Added 2026-06-28.)
    if (url.pathname === "/gcp-alert" || url.pathname === "/gcp-page") {
      // /gcp-alert → Slack only (existing GCP_ALERT_TOKEN, untouched).
      // /gcp-page  → Slack + clean PagerDuty page (separate GCP_PAGE_TOKEN so
      //   crit policies can page without rotating the Slack-relay token).
      const wantPd = url.pathname === "/gcp-page";
      const gcpToken = (wantPd ? (env as any).GCP_PAGE_TOKEN : (env as any).GCP_ALERT_TOKEN) as string | undefined;
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      // Prefer the token in the Authorization header (Basic or Bearer) so it does
      // NOT travel in the URL/query (which lands in edge/access logs + channel
      // config). Fall back to ?token= for compatibility. Compared in constant time.
      const authz = request.headers.get("Authorization") || "";
      let provided = "";
      if (authz.startsWith("Basic ")) {
        try { const dec = atob(authz.slice(6)); provided = dec.includes(":") ? dec.slice(dec.indexOf(":") + 1) : dec; } catch { /* malformed */ }
      } else if (authz.startsWith("Bearer ")) {
        provided = authz.slice(7);
      } else {
        provided = url.searchParams.get("token") || "";
      }
      const tokenOk = (() => {
        if (!gcpToken || provided.length !== gcpToken.length) return false;
        let mismatch = 0;
        for (let i = 0; i < gcpToken.length; i++) mismatch |= provided.charCodeAt(i) ^ gcpToken.charCodeAt(i);
        return mismatch === 0;
      })();
      if (!tokenOk) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      let payload: any = {};
      try { payload = await request.json(); } catch { /* tolerate non-JSON */ }
      const inc = payload?.incident ?? {};
      const resolved = inc.state === "closed";
      const emoji = resolved ? ":white_check_mark:" : ":rotating_light:";
      const stateLabel = resolved ? "RESOLVED" : "FIRING";
      // Escape Slack mrkdwn control chars (& < >) in alert-sourced text so a
      // crafted payload can't inject markup / fake links / @here mentions.
      const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 1000);
      const title = esc(inc.policy_name || inc.condition_name || "GCP Monitoring alert");
      const summary = esc(inc.summary || "(no summary provided)");
      // Only render a link if it's a real https Google Cloud URL; otherwise drop it.
      let linkSuffix = "";
      try {
        const u = new URL(String(inc.url || ""));
        if (u.protocol === "https:" && /(^|\.)(google\.com|googleapis\.com)$/.test(u.hostname)) {
          linkSuffix = `\n<${u.toString()}|View incident>`;
        }
      } catch { /* no/invalid url → no link */ }
      const text = `${emoji} *GCP Alert [${stateLabel}]* — ${title}\n${summary}${linkSuffix}`;
      if (env.SLACK_WEBHOOK_URL) {
        const res = await fetch(env.SLACK_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] }),
        });
        if (!res.ok) {
          console.error(`[gcp-relay] Slack post failed: ${res.status}`);
          return Response.json({ error: "slack post failed" }, { status: 502 });
        }
      }
      // Optional PagerDuty paging. CRIT-tier GCP policies point here with ?pd=1
      // so on-call gets a CLEAN incident title — GCP's native PD channel dumps
      // the raw condition text ("An uptime check on openai-api-... labels {..}").
      // We build the title from the policy's documentation.subject (GCP ships it
      // in the webhook), strip GCP's "[ALERT - ...] " prefix, and dedup by the
      // GCP incident_id so open→trigger / closed→resolve collapse to one incident.
      let pdStatus: string | undefined;
      if (wantPd) {
        const routingKey = await resolveSecret(env.PAGERDUTY_ROUTING_KEY);
        if (!routingKey) {
          console.error("[gcp-relay] pd=1 requested but PAGERDUTY_ROUTING_KEY unavailable");
          pdStatus = "no_routing_key";
        } else {
          const rawSubject = String(inc.documentation?.subject ?? "");
          const cleanSubject = rawSubject.replace(/^\[[^\]]*\]\s*/, "").trim();
          const pdSummary = (cleanSubject || String(inc.policy_name || inc.condition_name || "GCP prod alert")).slice(0, 1024);
          const dedupKey = `gcp-${String(inc.incident_id || inc.condition_name || pdSummary)}`.slice(0, 255);
          // 🔴 (red circle) subjects are page-worthy criticals; 🟠 are warnings.
          const sev: "critical" | "warning" = rawSubject.includes("🔴") ? "critical" : "warning";
          const pdRes = await fetch("https://events.pagerduty.com/v2/enqueue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              routing_key: routingKey,
              event_action: resolved ? "resolve" : "trigger",
              dedup_key: dedupKey,
              payload: {
                summary: pdSummary,
                source: String(inc.resource_name || inc.policy_name || "gcp-monitoring").slice(0, 255),
                severity: sev,
                component: "gcp-cloud-run",
                group: env.ENVIRONMENT || "production",
                class: "prod-health",
                custom_details: {
                  policy_name: inc.policy_name,
                  condition_name: inc.condition_name,
                  state: inc.state,
                  documentation: inc.documentation?.content,
                  console_url: inc.url,
                },
              },
              client: "GCP Monitoring (via billing-monitor relay)",
              client_url: typeof inc.url === "string" ? inc.url : undefined,
            }),
          });
          if (!pdRes.ok) {
            console.error(`[gcp-relay] PagerDuty enqueue failed: ${pdRes.status}`);
            pdStatus = `error_${pdRes.status}`;
          } else {
            pdStatus = resolved ? "resolved" : "triggered";
          }
        }
      }
      return Response.json({ status: "relayed", state: resolved ? "resolved" : "firing", pd: pdStatus });
    }

    // Auth: require ADMIN_SECRET for all non-health endpoints
    const adminSecret = (env as any).ADMIN_SECRET;
    if (adminSecret && url.pathname !== "/") {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== `Bearer ${adminSecret}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // Manual check trigger
    if (url.pathname === "/check") {
      const result = await checkUsage(env);
      return Response.json({ status: "checked", ...result, timestamp: new Date().toISOString() });
    }

    // Test alert integrations
    if (url.pathname === "/test-alert") {
      await sendAlerts(env, "Test alert from Cloudflare Billing Kill Switch", "info", {
        test: true,
        timestamp: new Date().toISOString(),
        message: "If you received this, your alert integration is working correctly.",
      }, "test");
      return Response.json({ status: "test alert sent" });
    }

    if (url.pathname === "/spend") {
      const protectedWorkers = (env.PROTECTED_WORKERS || "").split(",").map(s => s.trim()).filter(Boolean);

      let doUsage: DOUsage[] = [];
      let workerUsage: WorkerUsage[] = [];
      let r2Usage: R2Usage[] = [];
      let d1Usage: D1Usage[] = [];
      let queueUsage: QueueUsage[] = [];
      let cloudRunUsage: CloudRunServiceUsage[] = [];
      let aiUsage: AiUsage[] = [];
      let aiGatewayUsage: AiGatewayUsage[] = [];
      let vectorizeUsage: VectorizeUsage[] = [];
      const errors: string[] = [];

      try { doUsage = await queryDOUsage(env); } catch (e) { errors.push(`do:${e}`); }
      try { workerUsage = await queryWorkerUsage(env); } catch (e) { errors.push(`workers:${e}`); }
      try { r2Usage = await queryR2Usage(env); } catch (e) { errors.push(`r2:${e}`); }
      try { d1Usage = await queryD1Usage(env); } catch (e) { errors.push(`d1:${e}`); }
      try { queueUsage = await queryQueueUsage(env); } catch (e) { errors.push(`queues:${e}`); }
      try { cloudRunUsage = await queryCloudRunUsage(env); } catch (e) { errors.push(`cloudrun:${e}`); }
      try { aiUsage = await queryAiInferenceUsage(env); } catch (e) { errors.push(`ai:${e}`); }
      try { aiGatewayUsage = await queryAiGatewayUsage(env); } catch (e) { errors.push(`aigateway:${e}`); }
      try { vectorizeUsage = await queryVectorizeUsage(env); } catch (e) { errors.push(`vectorize:${e}`); }

      const doCosts = doUsage.map(d => ({
        scriptName: d.scriptName,
        requests: d.requests,
        wallTimeHours: d.wallTimeHours,
        estimatedDailyCostUSD: Math.round(
          (d.requests * 0.00000015) +       // DO reqs: $0.15/million
          (d.wallTimeHours * 12.50 / 1000)  // DO duration: $12.50/million GB-s (~1GB per DO)
        * 100) / 100,
        protected: protectedWorkers.includes(d.scriptName),
      }));

      const workerCosts = workerUsage.map(w => ({
        scriptName: w.scriptName,
        requests: w.requests,
        errors: w.errors,
        cpuTimeMs: w.cpuTimeMs,
        estimatedDailyCostUSD: Math.round(w.requests * 0.0000003 * 100) / 100,  // $0.30/million
        protected: protectedWorkers.includes(w.scriptName),
      }));

      const cloudRunCosts = cloudRunUsage.map(cr => ({
        serviceName: cr.serviceName,
        requests: cr.requests,
        activeInstances: cr.activeInstances,
        estimatedDailyCostUSD: cr.estimatedDailyCostUSD,
      }));

      const r2Costs = r2Usage.map(r => ({
        bucketName: r.bucketName,
        classAOps: r.classAOps,
        classBOps: r.classBOps,
        storageGB: r.storageGB,
        estimatedDailyCostUSD: Math.round(
          (r.classAOps * 4.50 / 1e6) +    // Class A: $4.50/million
          (r.classBOps * 0.36 / 1e6)       // Class B: $0.36/million
        * 100) / 100,
      }));

      const aiCosts = aiUsage.map(a => ({
        modelId: a.modelId,
        requests: a.requests,
        neurons: Math.round(a.neurons),
        inputTokens: Math.round(a.inputTokens),
        outputTokens: Math.round(a.outputTokens),
        estimatedDailyCostUSD: Math.round(a.neurons * NEURON_COST_USD * 100) / 100,
      }));

      const aiGatewayCosts = aiGatewayUsage.map(g => ({
        gateway: g.gateway,
        provider: g.provider,
        requests: g.requests,
        erroredRequests: g.erroredRequests,
        cachedRequests: g.cachedRequests,
        estimatedDailyCostUSD: Math.round(g.cost * 100) / 100,
      }));

      const vectorizeCosts = vectorizeUsage.map(v => ({
        indexId: v.indexId,
        queriedDimensions: v.queriedDimensions,
        estimatedDailyCostUSD: Math.round(v.queriedDimensions * VECTORIZE_DIM_COST_USD * 100) / 100,
      }));

      const totalDOSpend = doCosts.reduce((s, d) => s + d.estimatedDailyCostUSD, 0);
      const totalWorkerSpend = workerCosts.reduce((s, w) => s + w.estimatedDailyCostUSD, 0);
      const totalCloudRunSpend = cloudRunCosts.reduce((s, cr) => s + cr.estimatedDailyCostUSD, 0);
      const totalR2Spend = r2Costs.reduce((s, r) => s + r.estimatedDailyCostUSD, 0);
      const totalAiSpend = Math.round(aiUsage.reduce((s, a) => s + a.neurons, 0) * NEURON_COST_USD * 100) / 100;
      const totalAiGatewaySpend = Math.round(aiGatewayUsage.reduce((s, g) => s + g.cost, 0) * 100) / 100;
      const totalVectorizeSpend = Math.round(vectorizeUsage.reduce((s, v) => s + v.queriedDimensions, 0) * VECTORIZE_DIM_COST_USD * 100) / 100;
      // Headline total = CF-billable + Cloud Run. AI Gateway cost is billed by
      // the upstream provider (off-CF), so it's surfaced separately, not summed.
      const totalDailySpend = Math.round((totalDOSpend + totalWorkerSpend + totalCloudRunSpend + totalR2Spend + totalAiSpend + totalVectorizeSpend) * 100) / 100;

      const sdkDocsWorkers = workerCosts.filter(w =>
        w.scriptName.includes("divinci-sdk-docs")
      );
      const sdkDocsEstimatedDaily = sdkDocsWorkers.reduce((s, w) => s + w.estimatedDailyCostUSD, 0);

      return Response.json({
        estimatedDailyCostUSD: {
          total: totalDailySpend,
          byProvider: {
            cloudflare: {
              durableObjects: totalDOSpend,
              workers: totalWorkerSpend,
              r2: totalR2Spend,
              workersAI: totalAiSpend,
              vectorize: totalVectorizeSpend,
            },
            gcp: {
              cloudRun: totalCloudRunSpend,
            },
            external: {
              // Billed by upstream LLM providers (off the CF bill), tracked via AI Gateway.
              aiGatewayProviders: totalAiGatewaySpend,
            },
          },
        },
        services: {
          durableObjects: doCosts,
          workers: workerCosts,
          r2: r2Costs,
          d1: d1Usage.map(d => ({
            databaseId: d.databaseId,
            rowsRead: d.rowsRead,
            rowsWritten: d.rowsWritten,
            estimatedDailyCostUSD: Math.round(d.rowsWritten * 1.00 / 1e6 * 100) / 100,
          })),
          queues: queueUsage.map(q => ({
            queueId: q.queueId,
            messagesProduced: q.messagesProduced,
            messagesConsumed: q.messagesConsumed,
            estimatedDailyCostUSD: Math.round((q.messagesProduced + q.messagesConsumed) * 0.40 / 1e6 * 100) / 100,
          })),
          cloudRun: cloudRunCosts,
          workersAI: aiCosts,
          aiGateway: aiGatewayCosts,
          vectorize: vectorizeCosts,
        },
        workersAI: {
          models: aiCosts,
          totalNeurons: Math.round(aiUsage.reduce((s, a) => s + a.neurons, 0)),
          estimatedDailyCostUSD: totalAiSpend,
          neuronCostUSD: NEURON_COST_USD,
          threshold: {
            neurons: parseInt(env.AI_NEURONS_THRESHOLD || "500000"),
            approxUSD: Math.round(parseInt(env.AI_NEURONS_THRESHOLD || "500000") * NEURON_COST_USD * 100) / 100,
          },
        },
        aiGateway: {
          providers: aiGatewayCosts,
          estimatedDailyCostUSD: totalAiGatewaySpend,
          note: "Upstream-provider LLM cost (Gemini/Vertex/OpenAI). $0 for the workers-ai provider — Neurons bills that separately.",
          threshold: { cost: parseFloat(env.AI_GATEWAY_COST_THRESHOLD || "5") },
        },
        vectorize: {
          indexes: vectorizeCosts,
          totalQueriedDimensions: vectorizeUsage.reduce((s, v) => s + v.queriedDimensions, 0),
          estimatedDailyCostUSD: totalVectorizeSpend,
          threshold: { queriedDimensions: parseInt(env.VECTORIZE_DIMENSIONS_THRESHOLD || "500000000") },
        },
        sdkDocs: {
          workers: sdkDocsWorkers,
          estimatedDailyCostUSD: sdkDocsEstimatedDaily,
          protected: protectedWorkers.some(w => w.includes("divinci-sdk-docs")),
          thresholds: {
            cost: parseFloat(env.SDK_DOCS_COST_THRESHOLD || "5"),
            requests: parseInt(env.SDK_DOCS_REQUEST_THRESHOLD || "100000"),
            errors: parseInt(env.SDK_DOCS_ERROR_THRESHOLD || "100"),
          },
        },
        thresholds: {
          doRequests: parseInt(env.DO_REQUEST_THRESHOLD || "1000000"),
          doWalltimeHours: parseFloat(env.DO_WALLTIME_HOURS_THRESHOLD || "100"),
          workerRequests: parseInt(env.WORKER_REQUEST_THRESHOLD || "10000000"),
          r2Ops: parseInt(env.R2_OPS_THRESHOLD || "50000000"),
          cloudRunRequests: parseInt(env.CLOUD_RUN_REQUEST_THRESHOLD || "5000000"),
          cloudRunInstances: parseInt(env.CLOUD_RUN_INSTANCE_THRESHOLD || "100"),
          cloudRunMonthlyCost: parseFloat(env.CLOUD_RUN_MONTHLY_COST_THRESHOLD || "8000"),
          aiNeurons: parseInt(env.AI_NEURONS_THRESHOLD || "500000"),
          aiGatewayCost: parseFloat(env.AI_GATEWAY_COST_THRESHOLD || "5"),
          vectorizeDimensions: parseInt(env.VECTORIZE_DIMENSIONS_THRESHOLD || "500000000"),
          totalDailySpend: parseFloat(env.TOTAL_DAILY_SPEND_THRESHOLD || "50"),
        },
        errors: errors.length > 0 ? errors : undefined,
        autoDisconnect: env.AUTO_DISCONNECT === "true",
        autoDelete: env.AUTO_DELETE === "true",
        timestamp: new Date().toISOString(),
      });
    }

    // Usage report (no alerts, just data)
    if (url.pathname === "/usage") {
      const doUsage = await queryDOUsage(env);
      const workerUsage = await queryWorkerUsage(env);
      const r2Usage = await queryR2Usage(env);
      const d1Usage = await queryD1Usage(env);
      const queueUsage = await queryQueueUsage(env);
      const cloudRunUsage = await queryCloudRunUsage(env);
      const aiUsage = await queryAiInferenceUsage(env);
      const aiGatewayUsage = await queryAiGatewayUsage(env);
      const vectorizeUsage = await queryVectorizeUsage(env);
      return Response.json({
        doUsage,
        workerUsage: workerUsage.slice(0, 20), // top 20 by requests
        r2Usage,
        d1Usage,
        queueUsage,
        cloudRunUsage,
        aiUsage,
        aiGatewayUsage,
        vectorizeUsage,
        thresholds: {
          doRequests: parseInt(env.DO_REQUEST_THRESHOLD || "1000000"),
          doWalltimeHours: parseFloat(env.DO_WALLTIME_HOURS_THRESHOLD || "100"),
          workerRequests: parseInt(env.WORKER_REQUEST_THRESHOLD || "10000000"),
          r2Ops: parseInt(env.R2_OPS_THRESHOLD || "50000000"),
          d1RowsWritten: parseInt(env.D1_ROWS_WRITTEN_THRESHOLD || "10000000"),
          d1RowsRead: parseInt(env.D1_ROWS_READ_THRESHOLD || "500000000"),
          queueMessages: parseInt(env.QUEUE_MESSAGES_THRESHOLD || "50000000"),
          cloudRunRequests: parseInt(env.CLOUD_RUN_REQUEST_THRESHOLD || "5000000"),
          cloudRunInstances: parseInt(env.CLOUD_RUN_INSTANCE_THRESHOLD || "100"),
          cloudRunMonthlyCost: parseFloat(env.CLOUD_RUN_MONTHLY_COST_THRESHOLD || "8000"),
          aiNeurons: parseInt(env.AI_NEURONS_THRESHOLD || "500000"),
          aiGatewayCost: parseFloat(env.AI_GATEWAY_COST_THRESHOLD || "5"),
          vectorizeDimensions: parseInt(env.VECTORIZE_DIMENSIONS_THRESHOLD || "500000000"),
          totalDailySpend: parseFloat(env.TOTAL_DAILY_SPEND_THRESHOLD || "50"),
        },
        killSwitchNet: {
          connected: !!env.KILL_SWITCH_AGENT_API_KEY,
          apiUrl: env.KILL_SWITCH_API_URL || "https://api.kill-switch.net",
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Health check
    return Response.json({
      service: "cloudflare-billing-kill-switch",
      status: "healthy",
      schedule: "every 5 minutes",
      providers: {
        cloudflare: {
          connected: true,
          thresholds: {
            doRequests: parseInt(env.DO_REQUEST_THRESHOLD || "1000000"),
            doWalltimeHours: parseFloat(env.DO_WALLTIME_HOURS_THRESHOLD || "100"),
            workerRequests: parseInt(env.WORKER_REQUEST_THRESHOLD || "10000000"),
            aiNeurons: parseInt(env.AI_NEURONS_THRESHOLD || "500000"),
            aiGatewayCost: parseFloat(env.AI_GATEWAY_COST_THRESHOLD || "5"),
            vectorizeDimensions: parseInt(env.VECTORIZE_DIMENSIONS_THRESHOLD || "500000000"),
            totalDailySpend: parseFloat(env.TOTAL_DAILY_SPEND_THRESHOLD || "50"),
          },
        },
        gcp: {
          connected: !!(env.GCP_SERVICE_ACCOUNT_JSON && env.GCP_PROJECT_ID),
          projectId: env.GCP_PROJECT_ID || null,
          region: env.GCP_REGION || "us-central1",
          thresholds: {
            cloudRunRequests: parseInt(env.CLOUD_RUN_REQUEST_THRESHOLD || "5000000"),
            cloudRunInstances: parseInt(env.CLOUD_RUN_INSTANCE_THRESHOLD || "50"),
            cloudRunMonthlyCost: parseFloat(env.CLOUD_RUN_MONTHLY_COST_THRESHOLD || "500"),
          },
        },
      },
      killSwitchNet: {
        connected: !!env.KILL_SWITCH_AGENT_API_KEY,
        apiUrl: env.KILL_SWITCH_API_URL || "https://api.kill-switch.net",
      },
      autoDisconnect: env.AUTO_DISCONNECT === "true",
      autoDelete: env.AUTO_DELETE === "true",
      disconnectThresholdMultiplier: Math.max(1, parseFloat(env.DISCONNECT_THRESHOLD_MULTIPLIER || "10")),
      disconnectNote: "Alerts fire at 1× the thresholds; auto-disconnect/delete only triggers above this multiple of them (genuine runaway).",
      protectedWorkers: (env.PROTECTED_WORKERS || "").split(",").filter(Boolean),
      alertDestinations: {
        pagerduty: !!env.PAGERDUTY_ROUTING_KEY,
        discord: !!env.DISCORD_WEBHOOK_URL,
        slack: !!env.SLACK_WEBHOOK_URL,
        customWebhook: !!env.CUSTOM_WEBHOOK_URL,
      },
      sdkDocs: {
        monitoring: true,
        costThreshold: parseFloat(env.SDK_DOCS_COST_THRESHOLD || "5"),
        requestThreshold: parseInt(env.SDK_DOCS_REQUEST_THRESHOLD || "100000"),
        errorThreshold: parseInt(env.SDK_DOCS_ERROR_THRESHOLD || "100"),
        protectedWorkers: (env.PROTECTED_WORKERS || "").split(",").filter(w => w.includes("divinci-sdk-docs")),
      },
      workersAI: {
        monitoring: true,
        neuronThreshold: parseInt(env.AI_NEURONS_THRESHOLD || "500000"),
        approxCostThresholdUSD: Math.round(parseInt(env.AI_NEURONS_THRESHOLD || "500000") * NEURON_COST_USD * 100) / 100,
        note: "Detect-and-alert only: no CF API throttles Workers AI per-model. Mitigate in-app (drop offending model from the fallback chain).",
      },
      aiGateway: {
        monitoring: true,
        costThresholdUSD: parseFloat(env.AI_GATEWAY_COST_THRESHOLD || "5"),
        note: "Tracks upstream-provider LLM cost (Gemini/Vertex/OpenAI) routed through AI Gateway — external spend Workers AI Neurons can't see.",
      },
      vectorize: {
        monitoring: true,
        queriedDimensionsThreshold: parseInt(env.VECTORIZE_DIMENSIONS_THRESHOLD || "500000000"),
      },
      totalDailySpend: {
        thresholdUSD: parseFloat(env.TOTAL_DAILY_SPEND_THRESHOLD || "50"),
        note: "Account-wide catch-all across CF-billable surfaces + Cloud Run — fires on cost in services without a dedicated threshold.",
      },
      alertDedup: {
        enabled: !!env.ALERT_STATE,
        cooldownHours: parseFloat(env.ALERT_COOLDOWN_HOURS || "6"),
        note: "Edge-triggers Discord/Slack/custom so a day-long tripped threshold doesn't repeat every 5 min. PagerDuty self-dedups and always fires.",
      },
      endpoints: {
        "/": "Health check (this page)",
        "/check": "Run usage check now (triggers alerts if thresholds exceeded)",
        "/spend": "Estimated daily cost breakdown by service/provider (no alerts)",
        "/usage": "View current usage data (no alerts)",
        "/test-alert": "Send a test alert to all configured destinations",
      },
    });
  },
};
