/**
 * Session crystallisation.
 *
 * After each `claude -p` wake session exits, we capture what happened and
 * write a session record to `.dovai/index/_sessions/<timestamp>.md`.
 *
 * Over time this builds institutional memory: a log of what Sarah decided,
 * what actions she took, and what she learned — persisting across wake
 * sessions so future sessions can reference past decisions.
 *
 * The record includes a full tool trace (every Read, Write, Bash, Grep, etc.)
 * so we can audit exactly what path she took to reach an answer.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";

export interface ToolStep {
  /** Tool name: Read, Write, Edit, Bash, Grep, Glob, Agent, etc. */
  tool: string;
  /** Concise summary of the input (file path, command, pattern, etc.) */
  input_summary: string;
}

export interface SessionRecord {
  /** ISO timestamp when session started */
  started_at: string;
  /** ISO timestamp when session ended */
  ended_at: string;
  /** Number of wake events that triggered this session */
  event_count: number;
  /** Claude's exit code */
  exit_code: number | null;
  /** Duration in milliseconds */
  duration_ms: number;
  /** Final result text from Claude (from the result message) */
  result_text: string;
  /** Any errors (first 500 chars of stderr) */
  stderr_preview: string;
  /** Ordered list of every tool call Claude made during the session */
  tool_trace: ToolStep[];
  /** Total cost in USD (from Claude's result message) */
  cost_usd?: number;
  /** Total input tokens consumed */
  input_tokens?: number;
  /** Total output tokens generated */
  output_tokens?: number;
}

/** How many days of session files to keep. */
const PRUNE_KEEP_DAYS = 7;

/**
 * Write a session crystallisation record after a claude -p wake finishes.
 */
export async function crystalliseSession(
  gp: GlobalPaths,
  record: SessionRecord,
  logger: Logger,
): Promise<string> {
  await fs.mkdir(gp.sessions, { recursive: true });

  const ts = record.ended_at.replace(/[:.]/g, "-");
  const filename = `session_${ts}.md`;
  const filepath = path.join(gp.sessions, filename);

  const durationStr = formatDuration(record.duration_ms);
  const exitStatus = record.exit_code === 0 ? "success" : `exit ${record.exit_code}`;

  // Build frontmatter
  const frontmatter = [
    "---",
    `started_at: ${record.started_at}`,
    `ended_at: ${record.ended_at}`,
    `duration: ${durationStr}`,
    `events_processed: ${record.event_count}`,
    `exit_code: ${record.exit_code}`,
    `status: ${exitStatus}`,
    `tool_calls: ${record.tool_trace.length}`,
  ];
  if (record.cost_usd != null) frontmatter.push(`cost_usd: ${record.cost_usd.toFixed(4)}`);
  if (record.input_tokens != null) frontmatter.push(`input_tokens: ${record.input_tokens}`);
  if (record.output_tokens != null) frontmatter.push(`output_tokens: ${record.output_tokens}`);
  frontmatter.push("---");

  // Build heading
  const heading =
    `# Wake session — ${new Date(record.started_at).toLocaleDateString("en-ZA")} ` +
    `${new Date(record.started_at).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}`;

  // Stats line
  const statsLine = [
    `**Duration:** ${durationStr}`,
    `**Events:** ${record.event_count}`,
    `**Status:** ${exitStatus}`,
    `**Tool calls:** ${record.tool_trace.length}`,
  ];
  if (record.cost_usd != null) statsLine.push(`**Cost:** $${record.cost_usd.toFixed(4)}`);
  if (record.input_tokens != null && record.output_tokens != null) {
    statsLine.push(`**Tokens:** ${record.input_tokens.toLocaleString()} in / ${record.output_tokens.toLocaleString()} out`);
  }

  // Tool trace section
  let traceSection = "";
  if (record.tool_trace.length > 0) {
    const lines = record.tool_trace.map((step, i) => {
      const summary = step.input_summary
        ? ` \`${step.input_summary}\``
        : "";
      return `${i + 1}. **${step.tool}**${summary}`;
    });
    traceSection = `## Tool trace (${record.tool_trace.length} calls)\n\n${lines.join("\n")}\n\n`;
  }

  // Session output
  const outputSection = record.result_text.trim()
    ? `## Session output\n\n${record.result_text.trim()}\n\n`
    : `## Session output\n\n_(no output captured)_\n\n`;

  // Errors
  const errorSection = record.stderr_preview.trim()
    ? `## Errors\n\n\`\`\`\n${record.stderr_preview.trim()}\n\`\`\`\n`
    : "";

  const content =
    frontmatter.join("\n") + "\n\n" +
    heading + "\n\n" +
    statsLine.join(" | ") + "\n\n" +
    traceSection +
    outputSection +
    errorSection;

  await fs.writeFile(filepath, content);

  logger.info("session crystallised", {
    file: filename,
    duration: durationStr,
    events: record.event_count,
    tool_calls: record.tool_trace.length,
    exit_code: record.exit_code,
    cost_usd: record.cost_usd,
  });

  // Prune old session files (keep last 7 days)
  await pruneSessionFiles(gp, logger);

  return filepath;
}

/**
 * Remove session files older than PRUNE_KEEP_DAYS.
 */
async function pruneSessionFiles(
  gp: GlobalPaths,
  logger: Logger,
): Promise<void> {
  try {
    const entries = await fs.readdir(gp.sessions);
    const sessionFiles = entries
      .filter((e) => e.startsWith("session_") && e.endsWith(".md"))
      .sort();

    const cutoff = Date.now() - PRUNE_KEEP_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const f of sessionFiles) {
      // Extract timestamp from filename: session_2026-04-14T11-51-35-486Z.md
      const tsMatch = f.match(/^session_(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.md$/);
      if (!tsMatch?.[1]) continue;
      // Restore colons/dots: 2026-04-14T11-51-35-486Z → 2026-04-14T11:51:35.486Z
      const isoStr = tsMatch[1]
        .replace(/(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z");
      const fileTime = new Date(isoStr).getTime();
      if (Number.isNaN(fileTime)) continue;

      if (fileTime < cutoff) {
        await fs.rm(path.join(gp.sessions, f), { force: true });
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug("pruned old session files", { removed, keep_days: PRUNE_KEEP_DAYS });
    }
  } catch {
    // ignore
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}
