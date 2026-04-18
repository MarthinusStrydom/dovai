/**
 * Activity ledger — the single source of truth for "what has been done."
 *
 * Append-only JSONL file at .dovai/state/activity.jsonl. Every significant
 * action (email sent, telegram sent, draft executed, task completed) gets
 * one line. Both the server (outbox dispatcher) and Sarah (Claude Code)
 * write to it.
 *
 * Sarah checks this file before any irreversible action to prevent
 * duplicates across wakes.
 */
import fs from "node:fs";
import path from "node:path";
import type { GlobalPaths } from "./global_paths.ts";

export interface LedgerEntry {
  ts: string;
  action: string;
  description: string;
  ref?: string;
  details?: Record<string, unknown>;
}

/**
 * Append a single entry to the activity ledger. Safe to call concurrently
 * (append is atomic on POSIX for lines < PIPE_BUF).
 */
export function appendLedger(gp: GlobalPaths, entry: Omit<LedgerEntry, "ts"> & { ts?: string }): void {
  const file = gp.activityLedger;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const full: LedgerEntry = {
    ...entry,
    ts: entry.ts || new Date().toISOString(),
  };
  fs.appendFileSync(file, JSON.stringify(full) + "\n");
}

/**
 * Read the last N entries from the ledger. Returns newest last.
 */
export function readLedger(gp: GlobalPaths, limit?: number): LedgerEntry[] {
  const file = gp.activityLedger;
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const entries: LedgerEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // skip corrupt lines
    }
  }
  if (limit && entries.length > limit) return entries.slice(-limit);
  return entries;
}

/**
 * Check whether a matching action+ref exists in the last N entries.
 * Used by the server to avoid double-logging and by Sarah to dedup.
 */
export function hasRecentEntry(
  gp: GlobalPaths,
  action: string,
  ref: string,
  lookbackEntries = 50,
): boolean {
  const entries = readLedger(gp, lookbackEntries);
  return entries.some((e) => e.action === action && e.ref === ref);
}
