/**
 * File-event wake suppressions.
 *
 * Problem we are solving: when Claude files a document (e.g. copies an
 * email attachment from `dovai_files/email/inbox/...` into
 * `Financial Reports/Mar 2026/statement.pdf`), the filing clerk's chokidar
 * watcher sees a new file, compiles it, and would normally fire a wake
 * event. Claude would then be woken for a file she herself just created —
 * an obvious loop.
 *
 * Solution: before Claude copies a file into its new home, she drops a
 * "suppression marker" into `.dovai/state/file_suppressions/`. Each
 * marker is a one-line text file whose body is the workspace-relative
 * path that should NOT fire a wake next time the filing clerk sees it.
 * The filing clerk reads the suppression directory, matches the path,
 * deletes the marker, and skips the wake. The file is still indexed —
 * searches still find it — we just don't wake Claude about it.
 *
 * Design notes:
 *
 * - Markers are one-shot: the first compile/remove event for that path
 *   consumes the marker. If the same path is filed again later, Sarah
 *   must drop a new marker.
 * - Stale markers (older than TTL_MS) are swept on every check so the
 *   directory doesn't grow without bound if Sarah drops a marker but
 *   the copy never happens.
 * - A single marker can contain multiple paths, one per line, though
 *   Sarah is expected to write one marker per copy for clarity.
 * - This is filesystem-only — no in-memory state — so it survives
 *   server restarts cleanly.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { GlobalPaths } from "./global_paths.ts";

/** Markers older than this are assumed stale and purged. */
const TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Write a suppression marker for one or more workspace-relative paths.
 * Safe to call from anywhere. Callers should write the marker BEFORE
 * performing the file operation that would otherwise fire a wake, so
 * that by the time chokidar sees the event the marker is already on disk.
 */
export async function suppressFileWake(
  gp: GlobalPaths,
  relPaths: string | string[],
  reason = "",
): Promise<string> {
  const list = Array.isArray(relPaths) ? relPaths : [relPaths];
  await fs.mkdir(gp.fileSuppressions, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  const file = path.join(gp.fileSuppressions, `${stamp}_${rand}.txt`);
  const body = list
    .map((p) => normalisePath(p))
    .filter((p) => p.length > 0)
    .join("\n");
  const header = reason ? `# ${reason}\n` : "";
  await fs.writeFile(file, header + body + "\n");
  return file;
}

/**
 * Check whether `relPath` is currently suppressed. If it is, the matching
 * marker is deleted (one-shot) and `true` is returned. Stale markers
 * (older than TTL_MS) are cleaned up opportunistically during the scan.
 */
export async function consumeFileWakeSuppression(
  gp: GlobalPaths,
  relPath: string,
): Promise<boolean> {
  const target = normalisePath(relPath);
  let entries: string[];
  try {
    entries = await fs.readdir(gp.fileSuppressions);
  } catch {
    return false;
  }
  const now = Date.now();
  let consumed = false;
  for (const name of entries) {
    if (!name.endsWith(".txt")) continue;
    const file = path.join(gp.fileSuppressions, name);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    // TTL sweep — stale markers are purged whether or not they match.
    if (now - stat.mtimeMs > TTL_MS) {
      await fs.rm(file, { force: true }).catch(() => undefined);
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map(normalisePath);
    if (lines.includes(target)) {
      // Consume the whole marker. If it had multiple paths and this is
      // only one of them, that's fine — Sarah should drop one marker per
      // copy anyway, and consuming the whole file is a simpler contract
      // than selectively rewriting it.
      await fs.rm(file, { force: true }).catch(() => undefined);
      consumed = true;
    }
  }
  return consumed;
}

/** Normalise separators so markers work regardless of OS. */
function normalisePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
