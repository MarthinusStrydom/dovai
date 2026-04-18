/**
 * Smart Folders mover.
 *
 * Applies file moves proposed by the planner. Moves are applied one at a
 * time and result.json is written incrementally after each successful move,
 * so we can resume from interruption.
 *
 * Safety:
 *   - Never deletes files. Moves only.
 *   - Target directories are created on demand.
 *   - Path collisions get a suffix (_1, _2, etc.).
 *   - SHA-256 is recorded per move for unwind verification.
 */
import fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DomainPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";
import type { SmartFoldersMove, FilePlacement, SmartFoldersProgress } from "./types.ts";

/**
 * Hash a file's contents (SHA-256, hex).
 */
async function hashFile(absPath: string): Promise<string> {
  const content = await fsp.readFile(absPath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Find a non-colliding target path. If `target` already exists, try
 * appending _1, _2, etc. before the extension.
 */
function resolveCollision(target: string): string {
  if (!existsSync(target)) return target;
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}_${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`too many collisions for target: ${target}`);
}

export interface MoverResult {
  moves: SmartFoldersMove[];
  skippedMoves: Array<{ from: string; to: string; reason: string }>;
}

/**
 * Apply proposed file moves. Writes each move to result incrementally.
 *
 * @param dp          - Domain paths
 * @param placements  - Placement decisions from the planner (only moves where from !== to)
 * @param totalFiles  - Total files (for progress reporting)
 * @param onProgress  - Progress callback
 * @param logger      - Logger
 */
export async function applyMoves(
  dp: DomainPaths,
  placements: FilePlacement[],
  totalFiles: number,
  onProgress: (p: SmartFoldersProgress) => void,
  logger: Logger,
): Promise<MoverResult> {
  // Filter to actual moves (from !== to)
  const movePlacements = placements.filter((p) => p.from !== p.to);

  const moves: SmartFoldersMove[] = [];
  const skippedMoves: Array<{ from: string; to: string; reason: string }> = [];

  for (let i = 0; i < movePlacements.length; i++) {
    const placement = movePlacements[i];
    const srcAbs = path.join(dp.domainRoot, placement.from);
    const rawTargetAbs = path.join(dp.domainRoot, placement.to);

    onProgress({
      phase: "moving",
      done_files: i,
      total_files: totalFiles,
    });

    // Source must still exist
    if (!existsSync(srcAbs)) {
      skippedMoves.push({ from: placement.from, to: placement.to, reason: "source file disappeared" });
      logger.warn("smart_folders: source gone, skipping move", { from: placement.from });
      continue;
    }

    // Don't move if source and target resolve to the same path
    if (path.resolve(srcAbs) === path.resolve(rawTargetAbs)) {
      continue;
    }

    try {
      // Hash before moving (for unwind verification)
      const sha256 = await hashFile(srcAbs);

      // Resolve collision
      const targetAbs = resolveCollision(rawTargetAbs);
      const actualTo = path.relative(dp.domainRoot, targetAbs).split(path.sep).join("/");

      // Create target directory
      await fsp.mkdir(path.dirname(targetAbs), { recursive: true });

      // Move the file
      await fsp.rename(srcAbs, targetAbs);

      const move: SmartFoldersMove = {
        from: placement.from,
        to: actualTo,
        sha256,
        reason: placement.reason || "",
      };
      moves.push(move);

      logger.info("smart_folders: moved file", { from: placement.from, to: actualTo });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skippedMoves.push({ from: placement.from, to: placement.to, reason: msg });
      logger.warn("smart_folders: move failed, skipping", {
        from: placement.from,
        to: placement.to,
        error: msg,
      });
    }
  }

  return { moves, skippedMoves };
}
