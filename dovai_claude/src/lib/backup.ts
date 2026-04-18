/**
 * Pre-Dovai backup.
 *
 * Snapshots the user's domain root BEFORE Dovai touches it, so the user can
 * restore the whole domain to its pre-Dovai state if things go wrong. This
 * exists as a trust-building escape hatch; it is not specific to Smart
 * Folders. Every new domain gets a backup at registration time.
 *
 * Storage strategy:
 *   - On macOS (APFS): `cp -Rc` creates file clones. Zero-cost, zero-time,
 *     zero extra disk until files diverge. Smart Folders *moves* files but
 *     doesn't edit their content, so the clone stays cheap forever.
 *   - Everywhere else: plain `cp -R`. Costs disk, but works on any filesystem.
 *
 * Location: sibling folder to the domain root — e.g. if the domain is
 * `/Users/x/FamilyOffice`, the backup lives at
 * `/Users/x/FamilyOffice.pre-dovai.2026-04-17-142305`. Sibling placement
 * keeps APFS clones same-volume (clones across volumes don't exist).
 *
 * Restore uses a rename-then-copy flow. The current live directory is first
 * renamed to `<name>.pre-restore.<ts>` (near-instant), then the backup is
 * copied into place. If the copy fails, the rename is reversed and no data
 * is lost. Any files added after the backup are preserved in the pre-restore
 * snapshot, which the caller reports to the user.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type { DomainPaths } from "./global_paths.ts";

export type BackupMethod = "apfs_clone" | "copy";

export interface PreDovaiBackup {
  version: 1;
  domain_slug: string;
  /** ISO timestamp */
  created_at: string;
  method: BackupMethod;
  /** Absolute path of the live domain root at backup time. */
  source_root: string;
  /** Absolute path of the backup directory. */
  backup_root: string;
  /** Number of files in the backup (best-effort walk; excludes the manifest itself). */
  file_count: number;
  /** Total bytes in the backup. */
  total_bytes: number;
}

export interface RestoreResult {
  restored_files: number;
  /**
   * Path where the pre-restore state was saved (a rename of the live dir).
   * Contains any files the user added after backup; the caller should
   * surface this path so they can recover post-backup additions if needed.
   */
  snapshot_path: string;
}

/** Marker file written inside each backup so it is self-identifying. */
const BACKUP_MANIFEST_NAME = ".dovai_backup.json";

/** Directories we refuse to include in the backup. Must never grow without care. */
const BACKUP_EXCLUDE_TOPLEVEL = [".dovai"];

/** yyyy-mm-dd-hhmmss, filesystem-safe. */
function timestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function backupPathFor(sourceRoot: string, ts: string): string {
  const parent = path.dirname(sourceRoot);
  const name = path.basename(sourceRoot);
  return path.join(parent, `${name}.pre-dovai.${ts}`);
}

function snapshotPathFor(sourceRoot: string, ts: string): string {
  const parent = path.dirname(sourceRoot);
  const name = path.basename(sourceRoot);
  return path.join(parent, `${name}.pre-restore.${ts}`);
}

/** Run `cp` with the given args. Returns (ok, stderr). */
function runCp(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("cp", args);
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += String(d);
    });
    proc.on("exit", (code) => resolve({ ok: code === 0, stderr }));
    proc.on("error", (err) => resolve({ ok: false, stderr: String(err) }));
  });
}

/** Recursively walk a directory, returning (file count, total bytes). Defensive against I/O errors. */
async function walkSize(root: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        // Skip our own manifest when counting
        if (abs === path.join(root, BACKUP_MANIFEST_NAME)) continue;
        try {
          const st = await fsp.stat(abs);
          count++;
          bytes += st.size;
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  await walk(root);
  return { count, bytes };
}

/**
 * Create a pre-Dovai backup of the domain root. Writes a manifest inside the
 * backup and a pointer in the domain directory.
 *
 * Excludes any `.dovai/` at the top level of the domain root (defensive —
 * Dovai state should live at `~/.dovai/domains/<slug>/`, not inside the
 * user's files, but older installs may have left traces).
 */
export async function createPreDovaiBackup(dp: DomainPaths): Promise<PreDovaiBackup> {
  const source = dp.domainRoot;
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`domain root does not exist or is not a directory: ${source}`);
  }

  const ts = timestamp();
  const dest = backupPathFor(source, ts);
  if (existsSync(dest)) {
    throw new Error(`backup destination already exists: ${dest}`);
  }

  const isDarwin = os.platform() === "darwin";
  let method: BackupMethod = "copy";
  let cloneError = "";

  if (isDarwin) {
    const r = await runCp(["-Rc", source, dest]);
    if (r.ok) {
      method = "apfs_clone";
    } else {
      cloneError = r.stderr.trim();
      // Clean up any partial clone before fallback
      if (existsSync(dest)) {
        await fsp.rm(dest, { recursive: true, force: true });
      }
    }
  }

  if (method === "copy") {
    const r = await runCp(["-R", source, dest]);
    if (!r.ok) {
      const details = cloneError ? ` (clone attempted first: ${cloneError})` : "";
      throw new Error(`backup failed: ${r.stderr.trim() || "unknown"}${details}`);
    }
  }

  // Strip excluded top-level directories from the backup.
  for (const name of BACKUP_EXCLUDE_TOPLEVEL) {
    const stray = path.join(dest, name);
    if (existsSync(stray)) {
      await fsp.rm(stray, { recursive: true, force: true });
    }
  }

  const { count, bytes } = await walkSize(dest);

  const manifest: PreDovaiBackup = {
    version: 1,
    domain_slug: dp.slug,
    created_at: new Date().toISOString(),
    method,
    source_root: source,
    backup_root: dest,
    file_count: count,
    total_bytes: bytes,
  };

  // Self-identifying manifest inside the backup (travels with it)
  await fsp.writeFile(path.join(dest, BACKUP_MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  // Pointer in the domain dir for fast lookup
  await fsp.mkdir(dp.domainDir, { recursive: true });
  await fsp.writeFile(dp.preDovaiBackupPtr, JSON.stringify(manifest, null, 2));

  return manifest;
}

/** Load the backup pointer. Returns null if missing, corrupt, or the backup dir no longer exists. */
export function loadPreDovaiBackup(dp: DomainPaths): PreDovaiBackup | null {
  try {
    const raw = readFileSync(dp.preDovaiBackupPtr, "utf8");
    const parsed = JSON.parse(raw) as PreDovaiBackup;
    if (parsed.version !== 1) return null;
    if (!existsSync(parsed.backup_root)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Delete the backup directory and its pointer. No-op if the pointer is missing.
 * Refuses to delete a path that doesn't contain the expected `.pre-dovai.`
 * marker — a cheap safety check against corrupted pointers.
 */
export async function deletePreDovaiBackup(dp: DomainPaths): Promise<void> {
  const manifest = loadPreDovaiBackup(dp);
  if (!manifest) {
    // Clean up a dangling pointer if the dir is already gone
    if (existsSync(dp.preDovaiBackupPtr)) {
      await fsp.unlink(dp.preDovaiBackupPtr).catch(() => {});
    }
    return;
  }
  if (!manifest.backup_root.includes(".pre-dovai.")) {
    throw new Error(`refusing to delete: path does not match backup pattern: ${manifest.backup_root}`);
  }
  if (existsSync(manifest.backup_root)) {
    await fsp.rm(manifest.backup_root, { recursive: true, force: true });
  }
  if (existsSync(dp.preDovaiBackupPtr)) {
    await fsp.unlink(dp.preDovaiBackupPtr);
  }
}

/**
 * Restore the domain root to its pre-Dovai state.
 *
 * Flow:
 *   1. Validate backup exists and source is safe to operate on.
 *   2. Rename current live → `<name>.pre-restore.<ts>` (near-instant, no data lost).
 *   3. Copy backup contents → live domain root (APFS clone if possible).
 *   4. Strip the backup manifest file from the restored tree.
 *
 * If step 3 fails, step 2 is reversed and the original state is intact.
 * The pre-restore snapshot is preserved for the user to inspect / delete
 * manually — it contains any files added between backup time and restore.
 */
export async function restorePreDovaiBackup(dp: DomainPaths): Promise<RestoreResult> {
  const manifest = loadPreDovaiBackup(dp);
  if (!manifest) throw new Error(`no pre-Dovai backup found for domain ${dp.slug}`);
  if (!existsSync(manifest.backup_root)) {
    throw new Error(`backup directory is missing: ${manifest.backup_root}`);
  }

  const live = path.resolve(dp.domainRoot);
  if (!existsSync(live)) throw new Error(`domain root no longer exists: ${live}`);

  // Safety: never operate on the filesystem root or the user's home directory.
  if (live === "/" || live === path.resolve(os.homedir())) {
    throw new Error(`refusing to restore over sensitive path: ${live}`);
  }

  const ts = timestamp();
  const snapshotPath = snapshotPathFor(live, ts);
  if (existsSync(snapshotPath)) {
    throw new Error(`pre-restore snapshot path already exists: ${snapshotPath}`);
  }

  // Step 1: rename live → snapshot (near-instant, no bytes moved)
  await fsp.rename(live, snapshotPath);

  try {
    // Step 2: copy backup → live
    const isDarwin = os.platform() === "darwin";
    let ok = false;
    if (isDarwin) {
      const r = await runCp(["-Rc", manifest.backup_root, live]);
      ok = r.ok;
    }
    if (!ok) {
      const r = await runCp(["-R", manifest.backup_root, live]);
      if (!r.ok) throw new Error(`restore copy failed: ${r.stderr.trim() || "unknown"}`);
    }

    // Step 3: strip the self-identifying manifest from the restored tree
    const stray = path.join(live, BACKUP_MANIFEST_NAME);
    if (existsSync(stray)) {
      await fsp.unlink(stray).catch(() => {});
    }
  } catch (err) {
    // Recovery: put the snapshot back
    if (existsSync(live)) {
      await fsp.rm(live, { recursive: true, force: true }).catch(() => {});
    }
    await fsp.rename(snapshotPath, live).catch(() => {});
    throw err;
  }

  return { restored_files: manifest.file_count, snapshot_path: snapshotPath };
}
