/**
 * Compile state tracks which files have been processed by the filing clerk,
 * their content hash, mtime, status, and where their summary lives.
 *
 * Design goals:
 *   - Resumable across server restarts. If dovai is stopped for a week and
 *     restarted, the scanner walks the workspace and uses this file to know
 *     what is new, changed, or deleted since last run.
 *   - Inspectable. It's a plain JSON file; open in any editor to debug.
 *   - Atomic writes via write-then-rename to avoid corruption on crash.
 */
import fs from "node:fs";
import path from "node:path";
import type { DomainPaths } from "./global_paths.ts";
import type { TriageVerdict } from "./triage.ts";

export type CompileStatus = "pending" | "compiling" | "compiled" | "failed" | "skipped";

/** Structured entities extracted from a compiled document by LM Studio. */
export interface ExtractedEntities {
  people: string[];
  organisations: string[];
  dates: string[];
  amounts: string[];
  topics: string[];
  /** References to other documents/files mentioned in this file */
  references: string[];
}

export interface CompileEntry {
  /** Path relative to workspace root, using forward slashes */
  rel_path: string;
  size: number;
  mtime_ms: number;
  sha256: string;
  status: CompileStatus;
  /** ISO timestamp of last compile attempt */
  last_attempt_at?: string;
  /** ISO timestamp when successfully compiled */
  compiled_at?: string;
  /** Path (relative to workspace root) to the summary file in .dovai/index/ */
  summary_path?: string;
  /** Error message if status=failed */
  error?: string;
  /** True if the failure was transient (LM Studio down, timeout) vs permanent (bad file, context exceeded) */
  error_transient?: boolean;
  /** How many times we've tried and failed — used to give up on a bad file */
  failure_count?: number;
  /** Structured entities extracted from the document */
  entities?: ExtractedEntities;
  /** True if a referenced file has changed since this file was compiled */
  stale?: boolean;
  /** Why this summary is considered stale */
  stale_reason?: string;
  /**
   * Triage verdict from Smart Folders (or a user override). When set to
   * `skip`, the filing clerk will not compile this file; when `defer`, only
   * metadata is indexed, not content. Absent → treat as `keep` (current
   * behaviour, honouring mechanical filters only).
   */
  triage?: TriageVerdict;
  /**
   * Previous relative path of this file, set when the scanner detected a
   * move (content hash matched a removed entry). Purely informational —
   * useful for audit and UI display.
   */
  renamed_from?: string;
}

export interface CompileState {
  version: 1;
  workspace_path: string;
  initial_compile_completed: boolean;
  initial_compile_completed_at?: string;
  /** Map of rel_path → entry */
  files: Record<string, CompileEntry>;
}

function defaultState(workspacePath: string): CompileState {
  return {
    version: 1,
    workspace_path: workspacePath,
    initial_compile_completed: false,
    files: {},
  };
}

export function loadCompileState(dp: DomainPaths): CompileState {
  try {
    const raw = fs.readFileSync(dp.compileJson, "utf8");
    const parsed = JSON.parse(raw) as CompileState;
    if (parsed.version === 1 && parsed.files) {
      return parsed;
    }
  } catch {
    // missing or corrupt → fresh state
  }
  return defaultState(dp.domainRoot);
}

export function saveCompileState(dp: DomainPaths, state: CompileState): void {
  fs.mkdirSync(path.dirname(dp.compileJson), { recursive: true });
  const tmp = dp.compileJson + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, dp.compileJson);
}

export interface CompileProgress {
  total: number;
  compiled: number;
  pending: number;
  failed: number;
  percent: number;
  initial_compile_completed: boolean;
}

export function computeProgress(state: CompileState): CompileProgress {
  const entries = Object.values(state.files);
  const total = entries.length;
  const compiled = entries.filter((e) => e.status === "compiled" || e.status === "skipped").length;
  const pending = entries.filter((e) => e.status === "pending" || e.status === "compiling").length;
  const failed = entries.filter((e) => e.status === "failed").length;
  const percent = total === 0 ? 100 : Math.round((compiled / total) * 100);
  return {
    total,
    compiled,
    pending,
    failed,
    percent,
    initial_compile_completed: state.initial_compile_completed,
  };
}
