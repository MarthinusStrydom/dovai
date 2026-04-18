/**
 * Smart Folders orchestrator.
 *
 * Entry point: `runSmartFolders(dp, gp, logger)`.
 *
 * Coordinates the full pipeline:
 *   1. Scan → batcher collects file metadata and builds batches.
 *   2. Plan → planner calls the cloud LLM for structure + placement.
 *   3. Move → mover applies file moves, writes result.json.
 *   4. Done → lifecycle updated, progress set to "complete".
 *
 * Progress is published to a shared object that the API can poll.
 * Lifecycle is updated at each stage transition.
 */
import fsp from "node:fs/promises";
import { resolveCliProvider } from "../cli_provider/resolve.ts";
import { loadIdentity, loadDomainContext } from "../lib/config.ts";
import { updateLifecycle } from "../lib/lifecycle.ts";
import type { DomainPaths, GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";
import type { TriageVerdict } from "../lib/triage.ts";
import type { SmartFoldersResult, SmartFoldersProgress } from "./types.ts";
import { batchDomain } from "./batcher.ts";
import { runPlanner } from "./planner.ts";
import { applyMoves } from "./mover.ts";

/** Shared mutable progress — polled by GET /api/domains/:slug/smart-folders/progress. */
const progressMap = new Map<string, SmartFoldersProgress>();

export function getProgress(slug: string): SmartFoldersProgress | null {
  return progressMap.get(slug) ?? null;
}

/**
 * Run Smart Folders for a domain.
 *
 * This is a long-running async operation. It updates lifecycle and publishes
 * progress that the API can poll. The caller (API handler) should fire and
 * forget — this function manages its own error handling.
 */
export async function runSmartFolders(
  dp: DomainPaths,
  gp: GlobalPaths,
  logger: Logger,
): Promise<SmartFoldersResult> {
  const slug = dp.slug;
  const provider = resolveCliProvider(gp);

  function setProgress(p: SmartFoldersProgress): void {
    progressMap.set(slug, p);
  }

  try {
    // ── 1. Scan ─────────────────────────────────────────────────────
    updateLifecycle(dp, (lc) => {
      lc.smart_folders.status = "running";
      lc.smart_folders.ran_at = new Date().toISOString();
      lc.smart_folders.error = undefined;
    });

    setProgress({ phase: "scanning", done_files: 0, total_files: 0 });
    logger.info("smart_folders: scanning domain", { slug });

    const batchResult = await batchDomain(dp);
    const totalFiles = batchResult.allFiles.length;

    logger.info("smart_folders: scan complete", {
      slug,
      total: totalFiles,
      autoSkipped: batchResult.autoSkipped.length,
      autoDeferred: batchResult.autoDeferred.length,
      batches: batchResult.batches.length,
      folders: batchResult.folderSummaries.length,
    });

    setProgress({ phase: "scanning", done_files: totalFiles, total_files: totalFiles });

    // ── 2. Plan ─────────────────────────────────────────────────────
    const identity = loadIdentity(gp);
    const domainCtx = loadDomainContext(dp);

    const planResult = await runPlanner(
      gp,
      identity,
      domainCtx,
      batchResult.folderSummaries,
      batchResult.batches,
      totalFiles,
      setProgress,
      logger,
    );

    logger.info("smart_folders: planning complete", {
      slug,
      proposedFolders: planResult.proposedStructure.length,
      placements: planResult.placements.length,
    });

    // ── 3. Move ─────────────────────────────────────────────────────
    const moveResult = await applyMoves(
      dp,
      planResult.placements,
      totalFiles,
      setProgress,
      logger,
    );

    logger.info("smart_folders: moves applied", {
      slug,
      moved: moveResult.moves.length,
      skipped: moveResult.skippedMoves.length,
    });

    // ── 4. Write result ─────────────────────────────────────────────
    // Build triage map keyed by CURRENT (post-move) path
    const triage: Record<string, TriageVerdict> = {};
    for (const placement of planResult.placements) {
      // Find the actual post-move path (might differ from placement.to if collision)
      const move = moveResult.moves.find((m) => m.from === placement.from);
      const currentPath = move ? move.to : placement.from;
      triage[currentPath] = {
        verdict: placement.verdict,
        reason: placement.reason,
      };
    }

    // Include auto-deferred files
    for (const rel of batchResult.autoDeferred) {
      triage[rel] = { verdict: "defer", reason: "auto-deferred: file exceeds 50 MB" };
    }

    // Count verdicts
    let filesKept = 0;
    let filesSkipped = 0;
    let filesDeferred = 0;
    for (const v of Object.values(triage)) {
      if (v.verdict === "keep") filesKept++;
      else if (v.verdict === "skip") filesSkipped++;
      else if (v.verdict === "defer") filesDeferred++;
    }

    const result: SmartFoldersResult = {
      version: 1,
      completed_at: new Date().toISOString(),
      cli_used: provider.id,
      proposed_structure: planResult.proposedStructure,
      moves: moveResult.moves,
      triage,
      summary: {
        files_scanned: totalFiles,
        files_moved: moveResult.moves.length,
        files_kept: filesKept,
        files_deferred: filesDeferred,
        files_skipped: filesSkipped,
      },
    };

    // Persist result
    await fsp.mkdir(dp.smartFoldersDir, { recursive: true });
    const tmp = dp.smartFoldersResult + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(result, null, 2));
    await fsp.rename(tmp, dp.smartFoldersResult);

    // ── 5. Done ─────────────────────────────────────────────────────
    updateLifecycle(dp, (lc) => {
      lc.smart_folders.status = "complete";
    });

    setProgress({
      phase: "complete",
      done_files: totalFiles,
      total_files: totalFiles,
    });

    logger.info("smart_folders: complete", {
      slug,
      scanned: totalFiles,
      moved: moveResult.moves.length,
      kept: filesKept,
      skipped: filesSkipped,
      deferred: filesDeferred,
    });

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("smart_folders: failed", { slug, error: msg });

    updateLifecycle(dp, (lc) => {
      lc.smart_folders.status = "errored";
      lc.smart_folders.error = msg;
    });

    setProgress({
      phase: "errored",
      done_files: 0,
      total_files: 0,
      error: msg,
    });

    throw err;
  }
}
