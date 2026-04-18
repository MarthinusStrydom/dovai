/**
 * Per-domain lifecycle state.
 *
 * Tracks which of the three stages of domain preparation have run:
 *   1. Pre-Dovai backup — snapshot of user's files before Dovai touched them.
 *   2. Smart Folders   — optional, one-shot reorganisation + triage.
 *   3. Indexing         — filing clerk extract + summarise + entities.
 *
 * The Web UI's per-domain page is a state machine driven entirely by this
 * file. No inference from filesystem side-effects: one file, one truth.
 *
 * Stored at ~/.dovai/domains/<slug>/lifecycle.json.
 */
import fs from "node:fs";
import path from "node:path";
import type { DomainPaths } from "./global_paths.ts";

export type BackupStatus = "pending" | "complete" | "declined";
export type SmartFoldersStatus = "not_started" | "running" | "complete" | "skipped" | "errored";
export type IndexingStatus = "not_started" | "running" | "complete";

export interface DomainLifecycle {
  version: 1;
  backup: {
    status: BackupStatus;
    /** Absolute path to the backup directory (only when status === "complete"). */
    ref?: string;
    /** ISO timestamp of backup creation. */
    created_at?: string;
  };
  smart_folders: {
    status: SmartFoldersStatus;
    ran_at?: string;
    /** Populated when status === "errored". */
    error?: string;
  };
  indexing: {
    status: IndexingStatus;
    started_at?: string;
    completed_at?: string;
  };
}

export function initialLifecycle(): DomainLifecycle {
  return {
    version: 1,
    backup: { status: "pending" },
    smart_folders: { status: "not_started" },
    indexing: { status: "not_started" },
  };
}

export function loadLifecycle(dp: DomainPaths): DomainLifecycle {
  try {
    const raw = fs.readFileSync(dp.lifecycleJson, "utf8");
    const parsed = JSON.parse(raw) as DomainLifecycle;
    if (parsed.version === 1) return parsed;
  } catch {
    // missing or corrupt → fresh state
  }
  return initialLifecycle();
}

export function saveLifecycle(dp: DomainPaths, state: DomainLifecycle): void {
  fs.mkdirSync(path.dirname(dp.lifecycleJson), { recursive: true });
  const tmp = dp.lifecycleJson + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, dp.lifecycleJson);
}

/**
 * Read-modify-write helper. Call with a mutator that updates the state in
 * place; returns the new state after saving.
 */
export function updateLifecycle(
  dp: DomainPaths,
  mutate: (state: DomainLifecycle) => void,
): DomainLifecycle {
  const state = loadLifecycle(dp);
  mutate(state);
  saveLifecycle(dp, state);
  return state;
}
