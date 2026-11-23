// src/index.ts
import { appendFileSync } from "node:fs";

// node_modules/mockcard/dist/errors.js
var MockCardError = class extends Error {
  status;
  code;
  /**
   * @param status - HTTP status (0 for network errors).
   * @param code - MockCard's machine-readable code, e.g. "invalid_api_key".
   * @param message - Human-readable explanation.
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "MockCardError";
  }
};

// node_modules/mockcard/dist/client.js
var MockCard = class {
  apiKey;
  baseUrl;
  fetchImpl;
  /**
   * @param options - API key, base URL and optional fetch implementation.
   * @throws MockCardError when no API key is given or found in MOCKCARD_API_KEY.
   */
  constructor(options = {}) {
    const apiKey = options.apiKey ?? process.env.MOCKCARD_API_KEY ?? "";
    if (!apiKey)
      throw new MockCardError(0, "missing_api_key", "Pass apiKey or set MOCKCARD_API_KEY. Create a key at https://www.mockcard.io/dashboard.");
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? "https://www.mockcard.io").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }
  /**
   * Sends an authenticated request.
   *
   * @param method - HTTP method.
   * @param path - API path, e.g. "/api/v1/runs".
   * @param body - JSON body, if any.
   * @returns The parsed JSON response.
   * @throws MockCardError for non-2xx responses and network failures.
   */
  async request(method, path, body) {
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { "X-Api-Key": this.apiKey, ...body === void 0 ? {} : { "Content-Type": "application/json" }, "User-Agent": "mockcard-node/2.0.0" },
        body: body === void 0 ? void 0 : JSON.stringify(body)
      });
    } catch (error) {
      throw new MockCardError(0, "network_error", error instanceof Error ? error.message : String(error));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new MockCardError(res.status, data.error?.code ?? "http_error", data.error?.message ?? `HTTP ${res.status}`);
    return data;
  }
  /** Projects. */
  projects = {
    /**
     * Lists your projects.
     *
     * @returns The projects.
     */
    list: async () => (await this.request("GET", "/api/v1/projects")).projects,
    /**
     * Creates a project (needs an account-scoped key).
     *
     * @param name - Project name.
     * @param gateway - Event format.
     * @returns The project and its probe secret (shown only now).
     */
    create: (name, gateway = "stripe") => this.request("POST", "/api/v1/projects", { name, gateway })
  };
  /** Runs. */
  runs = {
    /**
     * Creates a run.
     *
     * @param options - Project, mode, scenarios and CI context.
     * @returns The run; pull runs also return the signed deliveries and expectations.
     */
    create: (options) => this.request("POST", "/api/v1/runs", {
      project_id: options.projectId,
      mode: options.mode,
      scenarios: options.scenarios,
      target_url: options.targetUrl,
      time_scale: options.timeScale,
      trigger: options.trigger,
      commit_sha: options.commitSha,
      branch: options.branch
    }),
    /**
     * Reads a run.
     *
     * @param runId - The run.
     * @returns The run with its score and checks.
     */
    get: async (runId) => (await this.request("GET", `/api/v1/runs/${encodeURIComponent(runId)}`)).run,
    /**
     * Reports pull-run results (once per run).
     *
     * @param runId - The run.
     * @param deliveries - What happened to each delivery.
     * @param assertions - Your outcome assertions.
     * @returns The scored run.
     */
    reportResults: async (runId, deliveries, assertions = []) => (await this.request("POST", `/api/v1/runs/${encodeURIComponent(runId)}/results`, { deliveries, assertions })).run
  };
  /**
   * Runs the 5-probe webhook health check against a public URL.
   *
   * @param webhookUrl - Your public https:// webhook URL.
   * @param gateway - Event format.
   * @returns Probe results with score and grade.
   */
  healthCheck(webhookUrl, gateway = "stripe") {
    return this.request("POST", "/api/v1/audit/quick", { webhook_url: webhookUrl, gateway });
  }
};

// node_modules/mockcard/dist/runner.js
async function deliver(target, delivery, timeoutMs, fetchImpl) {
  const started = Date.now();
  try {
    const res = await fetchImpl(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...delivery.headers },
      body: delivery.body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { delivery_id: delivery.id, status_code: res.status, duration_ms: Date.now() - started };
  } catch (error) {
    return { delivery_id: delivery.id, status_code: null, duration_ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}
async function deliverAll(deliveries, target, { timeoutMs = 1e4, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fetch: fetchImpl = fetch } = {}) {
  const batches = /* @__PURE__ */ new Map();
  for (const d of deliveries)
    batches.set(d.at_ms, [...batches.get(d.at_ms) ?? [], d]);
  const results = [];
  let elapsed = 0;
  for (const [at, batch] of [...batches.entries()].sort((a, b) => a[0] - b[0])) {
    if (at > elapsed)
      await sleep(at - elapsed);
    elapsed = at;
    results.push(...await Promise.all(batch.map((d) => deliver(target, d, timeoutMs, fetchImpl))));
  }
  return results;
}
async function runAssertions(expectations, deliveries, results, assertions = {}) {
  const out = [];
  for (const { scenario, expectation } of expectations) {
    const mine = deliveries.map((d, i) => ({ delivery: d, result: results[i] })).filter((x) => x.delivery.scenario === scenario);
    const ctx = { scenario, expectation, deliveries: mine, events: mine.map((x) => JSON.parse(x.delivery.body)) };
    for (const [name, check] of Object.entries(assertions[scenario] ?? {})) {
      try {
        const verdict = await check(ctx);
        out.push(verdict === true ? { scenario, name, passed: true } : { scenario, name, passed: false, message: typeof verdict === "string" ? verdict : "Assertion returned false" });
      } catch (error) {
        out.push({ scenario, name, passed: false, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return out;
}
async function runChaos(client, options) {
  const env = typeof process === "undefined" ? {} : process.env;
  const created = await client.runs.create({
    projectId: options.projectId,
    mode: "pull",
    scenarios: options.scenarios,
    timeScale: options.timeScale,
    trigger: env.CI ? "ci" : "api",
    commitSha: options.commitSha ?? env.GITHUB_SHA,
    branch: options.branch ?? env.GITHUB_HEAD_REF ?? env.GITHUB_REF_NAME
  });
  const deliveries = created.deliveries ?? [];
  const results = await deliverAll(deliveries, options.target, options);
  const assertions = await runAssertions(created.expectations ?? [], deliveries, results, options.assertions);
  return client.runs.reportResults(created.run.id, results, assertions);
}

// src/index.ts
function input(name, required = false) {
  const value = (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
  if (required && !value) throw new Error(`Input "${name}" is required.`);
  return value;
}
function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}
`);
}
function summary(run, minScore) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = (run.results?.checks ?? []).map((c) => `| ${c.passed ? "\u2705" : "\u274C"} | ${c.scenario} | ${c.name} | ${c.detail.replace(/\|/g, "\\|")} |`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `## MockCard chaos run: ${run.score ?? "n/a"}/100 (${run.status})`,
      `Pass threshold: ${minScore}. [Open in MockCard](https://www.mockcard.io/dashboard/runs/${run.id})`,
      "",
      "| | Scenario | Check | Detail |",
      "|---|---|---|---|",
      ...rows,
      ""
    ].join("\n")
  );
}
async function main() {
  try {
    const minScore = Number(input("min-score") || "100");
    const scenarios = input("scenarios") ? input("scenarios").split(",").map((s) => s.trim()).filter(Boolean) : void 0;
    const client = new MockCard({ apiKey: input("api-key", true), baseUrl: process.env.MOCKCARD_BASE_URL });
    const run = await runChaos(client, {
      projectId: input("project-id", true),
      target: input("target", true),
      scenarios,
      timeScale: Number(input("time-scale") || "0.2")
    });
    output("run-id", run.id);
    output("score", String(run.score ?? ""));
    output("status", run.status);
    summary(run, minScore);
    const failed = (run.results?.checks ?? []).filter((c) => !c.passed);
    for (const c of failed) console.log(`::error title=MockCard ${c.scenario}::${c.name}: ${c.detail}`);
    console.log(`MockCard run ${run.id}: ${run.score ?? "n/a"}/100 (${run.status})`);
    if ((run.score ?? 0) < minScore) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof MockCardError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
    console.log(`::error title=MockCard::${message}`);
    process.exitCode = 1;
  }
}
await main();
