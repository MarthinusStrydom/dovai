/**
 * Smart Folders unwind.
 *
 * Reverses every move recorded in result.json, restoring the domain to its
 * pre-Smart-Folders file layout. Files added AFTER Smart Folders ran are
 * left in place — we only reverse moves, we never delete.
 *
 * Unwind verifies SHA-256 before each reverse-move. If a file has been
 * modified since the move, it is skipped (with a warning) so we don't
 * accidentally overwrite user edits.
 */
import fsp from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DomainPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";
import type { SmartFoldersResult, SmartFoldersMove } from "./types.ts";

async function hashFile(absPath: string): Promise<string> {
  const content = await fsp.readFile(absPath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export interface UnwindResult {
  reversed: number;
  skipped: Array<{ from: string; to: string; reason: string }>;
}

/**
 * Load the Smart Folders result from disk. Returns null if missing/corrupt.
 */
export function loadSmartFoldersResult(dp: DomainPaths): SmartFoldersResult | null {
  try {
    const raw = readFileSync(dp.smartFoldersResult, "utf8");
    const parsed = JSON.parse(raw) as SmartFoldersResult;
    if (parsed.version === 1) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Reverse all moves from a Smart Folders result.
 *
 * Moves are reversed in LIFO order (last move undone first) so that
 * directory renames compose correctly.
 */
export async function unwindSmartFolders(
  dp: DomainPaths,
  logger: Logger,
): Promise<UnwindResult> {
  const result = loadSmartFoldersResult(dp);
  if (!result) {
    throw new Error("no Smart Folders result found — nothing to unwind");
  }

  // Reverse in LIFO order
  const moves = [...result.moves].reverse();
  let reversed = 0;
  const skipped: Array<{ from: string; to: string; reason: string }> = [];

  for (const move of moves) {
    const currentAbs = path.join(dp.domainRoot, move.to);
    const originalAbs = path.join(dp.domainRoot, move.from);

    // Current file must exist at the moved-to location
    if (!existsSync(currentAbs)) {
      skipped.push({ from: move.from, to: move.to, reason: "file no longer at moved-to location" });
      logger.warn("smart_folders unwind: file missing at moved-to path", { to: move.to });
      continue;
    }

    // Verify hash — don't reverse if the file has been modified
    try {
      const currentHash = await hashFile(currentAbs);
      if (currentHash !== move.sha256) {
        skipped.push({
          from: move.from,
          to: move.to,
          reason: "file has been modified since Smart Folders ran — skipping to preserve edits",
        });
        logger.warn("smart_folders unwind: hash mismatch, skipping", { to: move.to });
        continue;
      }
    } catch (err) {
      skipped.push({ from: move.from, to: move.to, reason: `hash check failed: ${err}` });
      continue;
    }

    // Don't overwrite something already at the original location
    if (existsSync(originalAbs)) {
      skipped.push({
        from: move.from,
        to: move.to,
        reason: "a file already exists at the original path — skipping to avoid overwrite",
      });
      logger.warn("smart_folders unwind: original path occupied", { from: move.from });
      continue;
    }

    try {
      // Create parent directory for original path
      await fsp.mkdir(path.dirname(originalAbs), { recursive: true });
      // Reverse the move
      await fsp.rename(currentAbs, originalAbs);
      reversed++;
      logger.info("smart_folders unwind: reversed", { from: move.to, to: move.from });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({ from: move.from, to: move.to, reason: msg });
      logger.warn("smart_folders unwind: reverse failed", { from: move.from, error: msg });
    }
  }

  // Clean up empty directories left behind by reversed moves
  await cleanupEmptyDirs(dp.domainRoot, logger);

  return { reversed, skipped };
}

/**
 * Remove empty directories left behind after unwind. Only removes directories
 * that are truly empty (no files, no subdirs). Never removes the domain root.
 */
async function cleanupEmptyDirs(root: string, logger: Logger): Promise<void> {
  async function sweep(dir: string): Promise<boolean> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let isEmpty = true;
    for (const e of entries) {
      if (e.isDirectory()) {
        const abs = path.join(dir, e.name);
        const childEmpty = await sweep(abs);
        if (!childEmpty) isEmpty = false;
      } else {
        isEmpty = false;
      }
    }
    if (isEmpty && dir !== root) {
      try {
        await fsp.rmdir(dir);
      } catch {
        // non-empty or permission error — ignore
        isEmpty = false;
      }
    }
    return isEmpty;
  }
  await sweep(root);
}
