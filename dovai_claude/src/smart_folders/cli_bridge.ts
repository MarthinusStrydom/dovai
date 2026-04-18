/**
 * CLI bridge for Smart Folders.
 *
 * Spawns the active CLI (Claude Code or Gemini CLI) in headless mode with a
 * prompt, waits for the result, and extracts structured JSON from the response.
 *
 * This is a simpler version of the wake dispatcher's CLI invocation — we don't
 * need lock management, tool tracing, or cost tracking. We just need:
 *   prompt in → JSON out.
 *
 * Re-ask protocol: if the response fails zod validation, we retry with a
 * tighter prompt. After MAX_RETRIES, we bail.
 */
import { spawn } from "node:child_process";
import { z } from "zod";
import { resolveCliProvider } from "../cli_provider/resolve.ts";
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";

const MAX_RETRIES = 2;
const CLI_TIMEOUT_MS = 5 * 60_000; // 5 minutes per invocation

/**
 * Model used for Smart Folders LLM calls. Sonnet is fast and cheap enough
 * for batch file classification — no need for Opus here.
 */
const SMART_FOLDERS_MODEL = "claude-sonnet-4-6";

interface CliBridgeResult {
  text: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Send a prompt to the active CLI and return the result text.
 */
async function invokeHeadless(
  gp: GlobalPaths,
  prompt: string,
  logger: Logger,
): Promise<CliBridgeResult> {
  const provider = resolveCliProvider(gp);
  const cmd = process.env[provider.binaryEnvVar] || provider.binary;
  const model = provider.id === "claude" ? SMART_FOLDERS_MODEL : undefined;
  const args = provider.headlessArgs(prompt, model);

  logger.info("smart_folders: invoking CLI", { cli: provider.id, model: model ?? "default", promptLen: prompt.length });

  // Strip CLI-specific env vars to avoid nested-CLI issues
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (provider.stripEnvPrefixes.some((p) => k === p || k.startsWith(p))) continue;
    childEnv[k] = v;
  }

  const child = spawn(cmd, args, {
    cwd: gp.dovaiHome,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });

  let rawStdout = "";
  let stderr = "";
  let resultText = "";
  let costUsd: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  child.stdout?.on("data", (d) => {
    rawStdout += d.toString();
    const lines = rawStdout.split("\n");
    rawStdout = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const event = provider.parseLine(msg);
        if (event?.kind === "result") {
          resultText = event.text;
          costUsd = event.costUsd;
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
        }
      } catch {
        // malformed NDJSON line — ignore
      }
    }
  });
  child.stderr?.on("data", (d) => (stderr += d.toString()));

  const result = await new Promise<{ code: number | null }>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: -1 });
    }, CLI_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code });
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      logger.error("smart_folders: CLI spawn error", { error: err.message });
      resolve({ code: -1 });
    });
  });

  // Flush any remaining partial line
  if (rawStdout.trim()) {
    try {
      const msg = JSON.parse(rawStdout);
      const event = provider.parseLine(msg);
      if (event?.kind === "result") {
        resultText = event.text;
        costUsd = event.costUsd;
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
      }
    } catch {
      /* ignore */
    }
  }

  if (result.code !== 0) {
    const errSnippet = stderr.slice(-500).trim();
    throw new Error(`CLI exited with code ${result.code}: ${errSnippet || "no stderr"}`);
  }

  if (!resultText) {
    throw new Error("CLI returned no result text");
  }

  return { text: resultText, costUsd, inputTokens, outputTokens };
}

/**
 * Extract JSON from CLI result text. The LLM may wrap JSON in markdown fences
 * or include commentary — we try to extract the actual JSON.
 */
function extractJson(text: string): string {
  // Try markdown code fences first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try to find raw JSON object
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }

  // Return as-is and let the caller deal with parse errors
  return text.trim();
}

/**
 * Invoke the CLI with a prompt, parse the result as JSON, and validate
 * against a zod schema. Retries with a re-ask prompt on failure.
 */
export async function queryLlm<T>(
  gp: GlobalPaths,
  systemMsg: string,
  userMsg: string,
  schema: z.ZodType<T>,
  logger: Logger,
): Promise<T> {
  // Combine system + user into a single prompt (headless mode is single-turn)
  const fullPrompt = `${systemMsg}\n\n---\n\n${userMsg}`;

  let lastError = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const prompt = attempt === 0
      ? fullPrompt
      : `${fullPrompt}\n\nYOUR PREVIOUS RESPONSE WAS INVALID: ${lastError}\nPlease respond with valid JSON matching the exact schema requested. No markdown fences, no commentary — JSON only.`;

    try {
      const result = await invokeHeadless(gp, prompt, logger);
      const jsonStr = extractJson(result.text);
      const parsed = JSON.parse(jsonStr);
      const validated = schema.parse(parsed);
      logger.info("smart_folders: LLM response validated", {
        attempt,
        tokens: result.inputTokens,
        cost: result.costUsd,
      });
      return validated;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn("smart_folders: LLM response validation failed", {
        attempt,
        error: lastError,
      });
      if (attempt === MAX_RETRIES) {
        throw new Error(`LLM failed to produce valid JSON after ${MAX_RETRIES + 1} attempts: ${lastError}`);
      }
    }
  }

  // unreachable, but TypeScript needs it
  throw new Error("unreachable");
}
