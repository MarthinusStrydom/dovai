/**
 * Smart Folders types and zod schemas.
 *
 * Types for the Smart Folders subsystem — structure proposals, file moves,
 * triage verdicts, and the result manifest. Zod schemas validate LLM output
 * at the boundary so we catch malformed JSON before acting on it.
 */
import { z } from "zod";
import type { TriageVerdict } from "../lib/triage.ts";

// ── Zod schemas for LLM output validation ───────────────────────────────

/** Schema for a single file triage verdict returned by the LLM. */
export const triageVerdictSchema = z.object({
  verdict: z.enum(["keep", "skip", "defer"]),
  reason: z.string().optional(),
});

/** Schema for a single file placement decision (structure proposal pass). */
export const filePlacementSchema = z.object({
  /** Current workspace-relative path. */
  from: z.string(),
  /** Proposed new workspace-relative path (same as `from` if no move needed). */
  to: z.string(),
  /** Triage verdict. */
  verdict: z.enum(["keep", "skip", "defer"]),
  /** Short reason for the verdict. */
  reason: z.string().optional(),
});
export type FilePlacement = z.infer<typeof filePlacementSchema>;

/** Schema for the structure proposal response (pass 1). */
export const structureProposalSchema = z.object({
  /** Proposed top-level folder structure (e.g. ["Invoices", "Tax/2023", "Correspondence"]). */
  folders: z.array(z.string()),
  /** Brief rationale for the proposed structure. */
  rationale: z.string().optional(),
});
export type StructureProposal = z.infer<typeof structureProposalSchema>;

/** Schema for a batch placement response (pass 2). */
export const batchPlacementSchema = z.object({
  placements: z.array(filePlacementSchema),
});
export type BatchPlacement = z.infer<typeof batchPlacementSchema>;

// ── Runtime types ────────────────────────────────────────────────────────

/** A single file move as recorded in result.json. */
export interface SmartFoldersMove {
  /** Workspace-relative path BEFORE reorg. */
  from: string;
  /** Workspace-relative path AFTER reorg. */
  to: string;
  /** SHA-256 of the file content at move time (for unwind verification). */
  sha256: string;
  /** Short explanation of why the file was moved. */
  reason: string;
}

/** Progress emitted during a Smart Folders run. */
export interface SmartFoldersProgress {
  phase: "scanning" | "proposing_structure" | "placing_files" | "moving" | "complete" | "errored";
  /** Current batch index (placement pass only). */
  current_batch?: number;
  /** Total batch count (placement pass only). */
  total_batches?: number;
  /** Files processed so far. */
  done_files: number;
  /** Total files being processed. */
  total_files: number;
  /** Set when phase === "errored". */
  error?: string;
}

/** The complete result written to smart_folders/result.json. */
export interface SmartFoldersResult {
  version: 1;
  completed_at: string;
  cli_used: "claude" | "gemini";
  /** Structure proposal from the LLM. */
  proposed_structure: string[];
  /** Every file move, in order. */
  moves: SmartFoldersMove[];
  /** Triage verdicts keyed by CURRENT (post-move) relPath. */
  triage: Record<string, TriageVerdict>;
  summary: {
    files_scanned: number;
    files_moved: number;
    files_kept: number;
    files_deferred: number;
    files_skipped: number;
  };
}

/** User overrides layered on top of result.json triage. */
export interface TriageOverrides {
  version: 1;
  overrides: Record<string, TriageVerdict>;
}

// ── File metadata collected by the batcher ───────────────────────────────

/** Metadata for a single file, gathered during the tree walk. */
export interface FileInfo {
  /** Workspace-relative POSIX path. */
  relPath: string;
  /** File size in bytes. */
  size: number;
  /** Parent folder (workspace-relative). */
  folder: string;
  /** First N bytes of the file if it's text, for context. */
  preview?: string;
}

/** A folder summary used in the structure proposal pass. */
export interface FolderSummary {
  /** Workspace-relative POSIX path. */
  folder: string;
  /** Number of files directly in this folder. */
  file_count: number;
  /** Total bytes of files directly in this folder. */
  total_bytes: number;
  /** Sample file names (up to 20). */
  sample_files: string[];
}

/** A batch of files to send to the LLM for placement + triage. */
export interface FileBatch {
  /** Batch index (0-based). */
  index: number;
  /** Files in this batch. */
  files: FileInfo[];
}
