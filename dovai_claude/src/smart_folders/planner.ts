/**
 * Smart Folders planner.
 *
 * Two-pass LLM flow:
 *   Pass 1 — Structure proposal: folder summaries → proposed taxonomy.
 *   Pass 2 — File placement:     proposed structure + file batches → per-file moves + triage.
 *
 * The planner calls the CLI bridge for each LLM invocation and validates
 * responses with zod. Progress is reported via a callback.
 */
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";
import type {
  FolderSummary,
  FileBatch,
  FilePlacement,
  SmartFoldersProgress,
} from "./types.ts";
import { structureProposalSchema, batchPlacementSchema } from "./types.ts";
import { systemPrompt, structureProposalPrompt, filePlacementPrompt } from "./prompts.ts";
import { queryLlm } from "./cli_bridge.ts";

/** Max concurrent batch placement calls. */
const PLACEMENT_CONCURRENCY = 2;

export interface PlannerResult {
  /** The proposed folder structure. */
  proposedStructure: string[];
  /** All file placements across all batches. */
  placements: FilePlacement[];
}

/**
 * Run the two-pass planning flow.
 *
 * @param gp         - Global paths (for CLI resolution)
 * @param identity   - identity.md content
 * @param domainCtx  - domain context.md content
 * @param folders    - folder summaries from batcher
 * @param batches    - file batches from batcher
 * @param totalFiles - total files being processed
 * @param onProgress - progress callback
 * @param logger     - logger
 */
export async function runPlanner(
  gp: GlobalPaths,
  identity: string,
  domainCtx: string,
  folders: FolderSummary[],
  batches: FileBatch[],
  totalFiles: number,
  onProgress: (p: SmartFoldersProgress) => void,
  logger: Logger,
): Promise<PlannerResult> {
  const sys = systemPrompt(identity, domainCtx);

  // ── Pass 1: Structure proposal ──────────────────────────────────────
  onProgress({
    phase: "proposing_structure",
    done_files: 0,
    total_files: totalFiles,
  });

  logger.info("smart_folders: requesting structure proposal", {
    folders: folders.length,
  });

  const proposal = await queryLlm(
    gp,
    sys,
    structureProposalPrompt(folders),
    structureProposalSchema,
    logger,
  );

  logger.info("smart_folders: structure proposal received", {
    proposed_folders: proposal.folders.length,
    rationale: proposal.rationale?.slice(0, 100),
  });

  // ── Pass 2: File placement ──────────────────────────────────────────
  const allPlacements: FilePlacement[] = [];
  let doneFiles = 0;

  // Process batches with bounded concurrency
  for (let i = 0; i < batches.length; i += PLACEMENT_CONCURRENCY) {
    const chunk = batches.slice(i, i + PLACEMENT_CONCURRENCY);
    const promises = chunk.map(async (batch) => {
      onProgress({
        phase: "placing_files",
        current_batch: batch.index + 1,
        total_batches: batches.length,
        done_files: doneFiles,
        total_files: totalFiles,
      });

      logger.info("smart_folders: placing batch", {
        batch: batch.index + 1,
        total: batches.length,
        files: batch.files.length,
      });

      const result = await queryLlm(
        gp,
        sys,
        filePlacementPrompt(proposal.folders, batch.files),
        batchPlacementSchema,
        logger,
      );

      return result.placements;
    });

    const results = await Promise.all(promises);
    for (const placements of results) {
      allPlacements.push(...placements);
      doneFiles += placements.length;
    }
  }

  return {
    proposedStructure: proposal.folders,
    placements: allPlacements,
  };
}
