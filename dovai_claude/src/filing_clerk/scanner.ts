/**
 * Scanner: walks the workspace, computes the authoritative current file set,
 * and diffs it against the stored compile state.
 *
 * Output of a scan:
 *   - added[]   — files that exist on disk but not in state → need compile
 *   - changed[] — files whose hash/mtime differs from state → need recompile
 *   - removed[] — files that were in state but no longer on disk → remove from index
 *
 * This is what gives us the "server stopped for a week and restarted" guarantee:
 * a full scan always re-establishes truth, no matter how long we were down.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { DomainPaths } from "../lib/global_paths.ts";
import type { CompileEntry, CompileState } from "../lib/compile_state.ts";
import type { Compiler } from "./compiler.ts";
import type { Logger } from "../lib/logger.ts";

export interface RenamedFile {
  /** Previous relative path (was in state). */
  from: string;
  /** Current relative path (found on disk). */
  to: string;
  /** Content hash (matched both). */
  sha256: string;
}

export interface ScanResult {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
  /**
   * Purely advisory: files whose content hash matches a previously-indexed
   * file at a different path. These paths ALSO appear in `added` (new path)
   * and `removed` (old path) so that callers unaware of move detection behave
   * exactly as before. Callers that want to handle moves as renames should
   * process `renamed` first and filter the listed paths out of `added` /
   * `removed` to avoid re-summarisation.
   */
  renamed: RenamedFile[];
}

const IGNORED_DIRS = new Set([".dovai", ".dovai.bak", ".git", "node_modules", ".DS_Store", ".Trash"]);
const IGNORED_FILE_PREFIXES = [".DS_Store", "._", "~$"];
const IGNORED_FILE_SUFFIXES = [".tmp", ".part", ".crdownload", ".eml"];

/**
 * `dovai_files/` contains the inbox + outbox folders for email and telegram.
 * We want to index incoming messages (so Sarah can search them like any other
 * workspace file), but NOT the outbox/sent — those are ephemeral JSON queue
 * files. Only these subpaths under `dovai_files/` are walked:
 */
const DOVAI_FILES_ALLOWED_PREFIXES = [
  "dovai_files/email/inbox",
  "dovai_files/telegram/inbox",
];

function isIgnoredEntry(entry: string, isDir: boolean): boolean {
  if (isDir && IGNORED_DIRS.has(entry)) return true;
  if (!isDir) {
    for (const pre of IGNORED_FILE_PREFIXES) if (entry.startsWith(pre)) return true;
    for (const suf of IGNORED_FILE_SUFFIXES) if (entry.endsWith(suf)) return true;
  }
  return false;
}

/**
 * Decide whether to descend into a directory whose workspace-relative path
 * is `relPath`. Only `dovai_files/` has a non-trivial rule — its inbox
 * children are walkable, everything else under it is not.
 */
function shouldDescend(relPath: string): boolean {
  if (relPath === "dovai_files") return true; // descend to find email/ and telegram/
  if (relPath.startsWith("dovai_files/")) {
    // Walk only if the path is an allowed prefix or lives inside one.
    for (const allowed of DOVAI_FILES_ALLOWED_PREFIXES) {
      if (relPath === allowed) return true;
      if (relPath.startsWith(allowed + "/")) return true;
      if (allowed.startsWith(relPath + "/")) return true; // ancestor of an allowed path
    }
    return false;
  }
  return true;
}

/**
 * Decide whether a file whose workspace-relative path is `relPath` should
 * be indexed. The walker may descend into intermediate directories under
 * `dovai_files/` (e.g. `dovai_files/email/`) to reach the inbox, and might
 * encounter stray files at those levels (`.last_uid`, etc.) — those must
 * not be indexed even though the directory was descended into.
 */
function shouldIncludeFile(relPath: string): boolean {
  if (!relPath.startsWith("dovai_files/")) return true;
  for (const allowed of DOVAI_FILES_ALLOWED_PREFIXES) {
    if (relPath === allowed) return true;
    if (relPath.startsWith(allowed + "/")) return true;
  }
  return false;
}

/**
 * Walk a domain's file directory and return a list of relative file paths (POSIX-style).
 */
export async function walkDomain(dp: DomainPaths): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (isIgnoredEntry(e.name, e.isDirectory())) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(dp.domainRoot, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (!shouldDescend(rel)) continue;
        await walk(abs);
      } else if (e.isFile()) {
        if (!shouldIncludeFile(rel)) continue;
        out.push(rel);
      }
    }
  }
  await walk(dp.domainRoot);
  return out;
}

/**
 * Diff the current filesystem against stored state. Returns what to add, change, remove.
 *
 * For efficiency, we use a cheap mtime+size check first. Only if mtime or size
 * differs do we re-hash (which is expensive on big files). This matches how git
 * handles the staging area.
 */
/**
 * Minimum ratio of files on disk vs in state before we trust removal results.
 * If the filesystem returns drastically fewer files than we have indexed
 * (e.g. Google Drive unmounted, network drive offline), we refuse to process
 * removals — that would wipe the entire index.
 *
 * Threshold: if on-disk count drops below 10% of indexed count, something
 * is catastrophically wrong. We still process adds and changes (safe),
 * but removals are suppressed.
 */
const CATASTROPHIC_REMOVAL_THRESHOLD = 0.1;

export async function diffScan(
  dp: DomainPaths,
  state: CompileState,
  compiler: Compiler,
  logger: Logger,
): Promise<ScanResult> {
  const onDisk = await walkDomain(dp);
  const onDiskSet = new Set(onDisk);
  const added: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const rel of onDisk) {
    const existing = state.files[rel];
    if (!existing) {
      added.push(rel);
      continue;
    }
    try {
      const absPath = path.join(dp.domainRoot, rel);
      const stat = await fs.stat(absPath);
      if (stat.size !== existing.size || Math.abs(stat.mtimeMs - existing.mtime_ms) > 1) {
        // Changed on disk surface — confirm with a rehash to avoid false positives
        const newHash = await compiler.hashFile(absPath);
        if (newHash !== existing.sha256) {
          changed.push(rel);
        } else {
          // Touched but content unchanged; update mtime in state silently
          existing.mtime_ms = stat.mtimeMs;
          unchanged.push(rel);
        }
      } else {
        unchanged.push(rel);
      }
    } catch (err) {
      logger.warn("stat failed during scan", {
        file: rel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const stateFileCount = Object.keys(state.files).length;
  let removed = Object.keys(state.files).filter((rel) => !onDiskSet.has(rel));

  // Safety: if the domain root appears to have vanished or is mostly empty
  // compared to what we have indexed, suppress removals. This protects
  // against Google Drive going offline, unmounted volumes, etc.
  if (removed.length > 0 && stateFileCount > 0) {
    const onDiskRatio = onDisk.length / stateFileCount;
    if (onDiskRatio < CATASTROPHIC_REMOVAL_THRESHOLD) {
      logger.error("SAFETY: domain root appears unreachable or mostly empty — suppressing all removals", {
        domain: dp.slug,
        onDiskFiles: onDisk.length,
        indexedFiles: stateFileCount,
        wouldRemove: removed.length,
        ratio: onDiskRatio.toFixed(3),
      });
      removed = [];
    }
  }

  // Move detection hint: surface files whose content hash matches a
  // previously-indexed file at a different path. Purely advisory —
  // `added` and `removed` are left untouched so existing consumers behave
  // identically. A future consumer (the domain clerk, once updated) can use
  // this to transfer an index entry instead of re-summarising.
  //
  // Only run when both lists are non-empty: no added files means nothing to
  // match, no removed files means nothing to match against.
  const renamed: RenamedFile[] = [];
  if (added.length > 0 && removed.length > 0) {
    const removedByHash = new Map<string, string>();
    for (const rel of removed) {
      const entry = state.files[rel];
      if (entry?.sha256) removedByHash.set(entry.sha256, rel);
    }

    if (removedByHash.size > 0) {
      const matchedRemoved = new Set<string>();
      for (const rel of added) {
        try {
          const absPath = path.join(dp.domainRoot, rel);
          const hash = await compiler.hashFile(absPath);
          const from = removedByHash.get(hash);
          if (from && !matchedRemoved.has(from)) {
            renamed.push({ from, to: rel, sha256: hash });
            matchedRemoved.add(from);
          }
        } catch (err) {
          logger.warn("hash failed during move detection", {
            file: rel,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return { added, changed, removed, unchanged, renamed };
}
