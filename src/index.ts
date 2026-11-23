/**
 * MockCard chaos run as a GitHub Action: creates a pull run, delivers the signed events to the app
 * running in the job, reports results, writes a summary table and fails the job below `min-score`.
 * Reads inputs from INPUT_* env vars and writes outputs/summary to the files GitHub provides, so it
 * needs no dependency besides the MockCard SDK.
 *
 * Author: Arixeva Labs <hello@arixevalabs.com>
 */
import { appendFileSync } from "node:fs";
import { MockCard, MockCardError, runChaos, type Run, type RunScenario } from "mockcard";

/**
 * Reads an action input.
 *
 * @param name - Input name as written in action.yml.
 * @param required - Throw when missing.
 * @returns The trimmed value ("" when optional and missing).
 * @throws Error when a required input is missing.
 */
function input(name: string, required = false): string {
  const value = (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
  if (required && !value) throw new Error(`Input "${name}" is required.`);
  return value;
}

/**
 * Sets an action output.
 *
 * @param name - Output name.
 * @param value - Output value.
 * @returns Nothing.
 */
function output(name: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/**
 * Writes the run as a Markdown table to the job summary.
 *
 * @param run - The scored run.
 * @param minScore - The pass threshold.
 * @returns Nothing.
 */
function summary(run: Run, minScore: number): void {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = (run.results?.checks ?? []).map((c) => `| ${c.passed ? "✅" : "❌"} | ${c.scenario} | ${c.name} | ${c.detail.replace(/\|/g, "\\|")} |`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `## MockCard chaos run: ${run.score ?? "n/a"}/100 (${run.status})`,
      `Pass threshold: ${minScore}. [Open in MockCard](https://www.mockcard.io/dashboard/runs/${run.id})`,
      "",
      "| | Scenario | Check | Detail |",
      "|---|---|---|---|",
      ...rows,
      "",
    ].join("\n"),
  );
}

/**
 * Runs the action.
 *
 * @returns Resolves when done; sets process.exitCode to 1 on failure.
 */
async function main(): Promise<void> {
  try {
    const minScore = Number(input("min-score") || "100");
    const scenarios = input("scenarios") ? (input("scenarios").split(",").map((s) => s.trim()).filter(Boolean) as RunScenario[]) : undefined;
    const client = new MockCard({ apiKey: input("api-key", true), baseUrl: process.env.MOCKCARD_BASE_URL });
    const run = await runChaos(client, {
      projectId: input("project-id", true),
      target: input("target", true),
      scenarios,
      timeScale: Number(input("time-scale") || "0.2"),
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
