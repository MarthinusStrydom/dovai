#!/usr/bin/env tsx
/**
 * `dovai migrate` — move user content from ~/.dovai/ into a user-chosen
 * folder (typically Drive/iCloud synced) and write the data_dir pointer.
 *
 * Invoked from bin/dovai.
 *
 * Usage:
 *   dovai migrate <target_path>     move data to <target_path>/Dovai/
 *   dovai migrate --rollback        restore the most recent pre-migrate tarball
 *   dovai migrate --detect          list suggested target folders (Drive, iCloud)
 *   dovai migrate --status          show current data_dir pointer state
 *
 * Preconditions (for forward migration):
 *   - server not running (refuses if state/server.lock or state/server.json
 *     shows a live PID)
 *   - ~/.dovai/data_dir pointer is absent (otherwise: already migrated)
 *   - target path is absolute
 *   - target path either doesn't exist yet, or is an empty directory
 *
 * Safety:
 *   - always writes ~/.dovai/migrations/pre-migrate-<ts>.tar.gz BEFORE
 *     touching anything, so --rollback can restore prior state
 *   - moves are done per-item with rename-first (atomic on same fs) and
 *     cp+rm fallback for cross-device targets (e.g. Drive on a different
 *     mount)
 *   - stops on first error and reports what was moved; rollback
 *     restores everything from the tarball
 *
 * See: docs/PLAN_DATA_DIR_SPLIT.md
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// What moves, what stays
// ---------------------------------------------------------------------------

/**
 * Top-level entries (files or directories) under ~/.dovai/ that are USER
 * CONTENT and must move to the data dir.
 */
const TOP_LEVEL_MOVES = [
  "CLAUDE.md",
  "identity.md",
  "GEMINI.md", // may be a symlink to CLAUDE.md — handled specially
  "settings",
  "contacts",
  "sops",
  "tasks",
  "drafts",
  "memory",
  "dovai_files",
] as const;

/**
 * Individual files inside ~/.dovai/state/ that are USER CONTENT. Everything
 * else in state/ stays (locks, server.json, domains.json, knowledge_graph,
 * whisper-models/).
 */
const STATE_SUBDIR_MOVES = [
  "activity.jsonl",
  "conversation_log.md",
] as const;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const STATE_ROOT = path.join(os.homedir(), ".dovai");
const POINTER_FILE = path.join(STATE_ROOT, "data_dir");
const MIGRATIONS_DIR = path.join(STATE_ROOT, "migrations");
const SERVER_INFO = path.join(STATE_ROOT, "state", "server.json");
const SERVER_LOCK = path.join(STATE_ROOT, "state", "server.lock");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function isServerRunning(): { running: boolean; pid?: number } {
  if (!fs.existsSync(SERVER_INFO)) return { running: false };
  try {
    const raw = fs.readFileSync(SERVER_INFO, "utf8");
    const info = JSON.parse(raw) as { pid?: number };
    const pid = typeof info.pid === "number" ? info.pid : undefined;
    if (!pid) return { running: false };
    try {
      process.kill(pid, 0);
      return { running: true, pid };
    } catch {
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function walkSize(p: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const stat = await fsp.lstat(p).catch(() => null);
  if (!stat) return { files, bytes };
  if (stat.isSymbolicLink()) return { files: 1, bytes: 0 };
  if (stat.isFile()) return { files: 1, bytes: stat.size };
  if (stat.isDirectory()) {
    const entries = await fsp.readdir(p);
    for (const e of entries) {
      const r = await walkSize(path.join(p, e));
      files += r.files;
      bytes += r.bytes;
    }
  }
  return { files, bytes };
}

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    c.stderr.on("data", (d) => { stderr += d.toString(); });
    c.on("close", (code) => resolve({ code: code ?? 1, stderr }));
    c.on("error", (e) => resolve({ code: 1, stderr: String(e) }));
  });
}

/**
 * Move a single entry (file, directory, or symlink) from src → dst.
 * Tries `rename` first (atomic on same fs); falls back to cp+rm for
 * cross-device moves (e.g. Drive CloudStorage on a different mount).
 * Preserves symlinks as symlinks.
 */
async function moveEntry(src: string, dst: string): Promise<void> {
  const stat = await fsp.lstat(src);

  // Preserve symlinks verbatim
  if (stat.isSymbolicLink()) {
    const target = await fsp.readlink(src);
    await fsp.symlink(target, dst);
    await fsp.unlink(src);
    return;
  }

  // Try atomic rename first
  try {
    await fsp.rename(src, dst);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "ENOTSUP") throw err;
    // Fall through to copy-then-remove
  }

  // Cross-device: cp -R then rm -rf
  const cpRes = await run("cp", ["-R", src, dst]);
  if (cpRes.code !== 0) {
    throw new Error(`cp -R failed: ${cpRes.stderr.trim() || `exit ${cpRes.code}`}`);
  }
  const rmRes = await run("rm", ["-rf", src]);
  if (rmRes.code !== 0) {
    throw new Error(
      `copy succeeded but rm failed: ${rmRes.stderr.trim() || `exit ${rmRes.code}`}. ` +
        `Manual cleanup: rm -rf ${src}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function detectCloudFolders(): { label: string; path: string }[] {
  const home = os.homedir();
  const suggestions: { label: string; path: string }[] = [];

  // Google Drive (macOS CloudStorage)
  const cloudStorage = path.join(home, "Library", "CloudStorage");
  if (fs.existsSync(cloudStorage)) {
    const entries = fs.readdirSync(cloudStorage);
    for (const e of entries) {
      if (e.startsWith("GoogleDrive-")) {
        const myDrive = path.join(cloudStorage, e, "My Drive");
        if (fs.existsSync(myDrive)) {
          suggestions.push({ label: `Google Drive (${e.slice("GoogleDrive-".length)})`, path: myDrive });
        }
      } else if (e.startsWith("Dropbox")) {
        suggestions.push({ label: `Dropbox`, path: path.join(cloudStorage, e) });
      }
    }
  }

  // iCloud Drive
  const icloud = path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
  if (fs.existsSync(icloud)) {
    suggestions.push({ label: "iCloud Drive", path: icloud });
  }

  // ~/Dropbox (legacy, non-CloudStorage)
  const legacyDropbox = path.join(home, "Dropbox");
  if (fs.existsSync(legacyDropbox)) {
    suggestions.push({ label: "Dropbox (legacy location)", path: legacyDropbox });
  }

  return suggestions;
}

async function cmdDetect(): Promise<number> {
  const suggestions = detectCloudFolders();
  process.stdout.write("\nDetected cloud-sync folders:\n\n");
  if (suggestions.length === 0) {
    process.stdout.write("  (none found — pick any folder you like)\n");
    process.stdout.write("\nFallback: ~/Documents/Dovai\n\n");
    return 0;
  }
  for (const s of suggestions) {
    process.stdout.write(`  • ${s.label}\n    ${s.path}/Dovai\n\n`);
  }
  process.stdout.write("Run:  dovai migrate <path>\n\n");
  return 0;
}

async function cmdStatus(): Promise<number> {
  if (!fs.existsSync(POINTER_FILE)) {
    process.stdout.write("\nData dir: NOT SET — Dovai is using ~/.dovai/ for everything.\n");
    process.stdout.write("Run:  dovai migrate --detect    to see suggested targets\n");
    process.stdout.write("      dovai migrate <path>      to move user data to <path>/Dovai/\n\n");
    return 0;
  }
  const target = fs.readFileSync(POINTER_FILE, "utf8").trim();
  const exists = fs.existsSync(target);
  process.stdout.write(`\nData dir: ${target}\n`);
  process.stdout.write(`Exists:   ${exists ? "yes" : "NO — folder is missing"}\n`);
  if (exists) {
    const size = await walkSize(target);
    process.stdout.write(`Contents: ${size.files} files, ${humanSize(size.bytes)}\n`);
  }
  process.stdout.write("\n");
  return 0;
}

async function cmdMigrate(targetArg: string): Promise<number> {
  // Resolve target path
  let target = targetArg.startsWith("~")
    ? path.join(os.homedir(), targetArg.slice(1))
    : targetArg;
  target = path.resolve(target);

  if (!path.isAbsolute(target)) {
    process.stderr.write(`error: target path must be absolute: ${target}\n`);
    return 1;
  }

  // A trailing "Dovai" is natural — if the user gave us "/path/to/My Drive",
  // we want the data at "/path/to/My Drive/Dovai". If they gave us
  // "/path/to/My Drive/Dovai" directly, respect that.
  const finalTarget = path.basename(target) === "Dovai" ? target : path.join(target, "Dovai");

  process.stdout.write(`\nMigrating Dovai user data\n`);
  process.stdout.write(`  from: ${STATE_ROOT}\n`);
  process.stdout.write(`  to:   ${finalTarget}\n\n`);

  // Preconditions
  if (fs.existsSync(POINTER_FILE)) {
    const current = fs.readFileSync(POINTER_FILE, "utf8").trim();
    process.stderr.write(
      `error: data dir is already configured at ${current}\n` +
        `       (if you want to change it, delete ${POINTER_FILE} first, then re-run)\n`,
    );
    return 1;
  }

  const serverState = isServerRunning();
  if (serverState.running) {
    process.stderr.write(
      `error: Dovai server is running (pid ${serverState.pid})\n` +
        `       Stop it first with:  dovai stop\n`,
    );
    return 1;
  }

  // Target folder must exist (user or wizard created it) OR parent must exist.
  if (fs.existsSync(finalTarget)) {
    const entries = await fsp.readdir(finalTarget);
    const nonHidden = entries.filter((e) => !e.startsWith("."));
    if (nonHidden.length > 0) {
      process.stderr.write(
        `error: target ${finalTarget} is not empty (${nonHidden.length} items).\n` +
          `       Pick a different target or empty it first.\n`,
      );
      return 1;
    }
  } else {
    const parent = path.dirname(finalTarget);
    if (!fs.existsSync(parent)) {
      process.stderr.write(
        `error: parent directory ${parent} does not exist.\n` +
          `       Check the path (is Drive actually mounted here?).\n`,
      );
      return 1;
    }
  }

  // Step 1: pre-migration tarball
  process.stdout.write("1/5  creating pre-migration tarball (safety net)…\n");
  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  const ts = timestamp();
  const tarball = path.join(MIGRATIONS_DIR, `pre-migrate-${ts}.tar.gz`);
  const tarRes = await run("tar", [
    "-czf", tarball,
    "-C", path.dirname(STATE_ROOT),
    "--exclude", path.join(path.basename(STATE_ROOT), "migrations"),
    "--exclude", path.join(path.basename(STATE_ROOT), "logs"),
    path.basename(STATE_ROOT),
  ]);
  if (tarRes.code !== 0) {
    process.stderr.write(`tarball failed: ${tarRes.stderr.trim()}\n`);
    return 1;
  }
  const tarSize = (await fsp.stat(tarball)).size;
  process.stdout.write(`     wrote ${tarball} (${humanSize(tarSize)})\n\n`);

  // Step 2: create target directory
  process.stdout.write("2/5  creating target directory…\n");
  fs.mkdirSync(finalTarget, { recursive: true });
  fs.mkdirSync(path.join(finalTarget, "state"), { recursive: true });
  process.stdout.write(`     ${finalTarget}/ ready\n\n`);

  // Step 3: move top-level entries
  process.stdout.write("3/5  moving user content…\n");
  let filesMoved = 0;
  let bytesMoved = 0;
  for (const entry of TOP_LEVEL_MOVES) {
    const src = path.join(STATE_ROOT, entry);
    const dst = path.join(finalTarget, entry);
    // Use lstat so broken symlinks (target already moved this run) still count as "present"
    let srcExists = false;
    try { fs.lstatSync(src); srcExists = true; } catch { /* ENOENT */ }
    if (!srcExists) {
      process.stdout.write(`     skip ${entry} (not present)\n`);
      continue;
    }
    const size = await walkSize(src);
    try {
      await moveEntry(src, dst);
      filesMoved += size.files;
      bytesMoved += size.bytes;
      process.stdout.write(`     moved ${entry} (${size.files} files, ${humanSize(size.bytes)})\n`);
    } catch (err) {
      process.stderr.write(
        `     FAILED to move ${entry}: ${(err as Error).message}\n` +
          `     Run: dovai migrate --rollback  to restore from ${tarball}\n`,
      );
      return 1;
    }
  }

  // Step 4: move user-data files out of state/
  process.stdout.write("\n4/5  moving user-state files…\n");
  for (const entry of STATE_SUBDIR_MOVES) {
    const src = path.join(STATE_ROOT, "state", entry);
    const dst = path.join(finalTarget, "state", entry);
    // Use lstat so broken symlinks (target already moved this run) still count as "present"
    let srcExists = false;
    try { fs.lstatSync(src); srcExists = true; } catch { /* ENOENT */ }
    if (!srcExists) {
      process.stdout.write(`     skip state/${entry} (not present)\n`);
      continue;
    }
    const size = await walkSize(src);
    try {
      await moveEntry(src, dst);
      filesMoved += size.files;
      bytesMoved += size.bytes;
      process.stdout.write(`     moved state/${entry} (${humanSize(size.bytes)})\n`);
    } catch (err) {
      process.stderr.write(
        `     FAILED to move state/${entry}: ${(err as Error).message}\n` +
          `     Run: dovai migrate --rollback  to restore from ${tarball}\n`,
      );
      return 1;
    }
  }

  // Step 5: write pointer
  process.stdout.write("\n5/5  writing pointer file…\n");
  fs.writeFileSync(POINTER_FILE, finalTarget + "\n");
  process.stdout.write(`     ${POINTER_FILE} → ${finalTarget}\n\n`);

  // Summary
  process.stdout.write(`✓ migration complete\n\n`);
  process.stdout.write(`  moved:     ${filesMoved} files, ${humanSize(bytesMoved)}\n`);
  process.stdout.write(`  data dir:  ${finalTarget}\n`);
  process.stdout.write(`  tarball:   ${tarball}\n`);
  process.stdout.write(`\nNext: run  dovai start  (or just  dovai) to bring Sarah back up.\n`);
  process.stdout.write(`If anything's wrong:  dovai migrate --rollback\n\n`);
  return 0;
}

async function cmdRollback(): Promise<number> {
  process.stdout.write("\nRolling back Dovai migration\n\n");

  const serverState = isServerRunning();
  if (serverState.running) {
    process.stderr.write(
      `error: Dovai server is running (pid ${serverState.pid})\n` +
        `       Stop it first with:  dovai stop\n`,
    );
    return 1;
  }

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    process.stderr.write("error: no migrations directory found — nothing to roll back\n");
    return 1;
  }

  const tarballs = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.startsWith("pre-migrate-") && f.endsWith(".tar.gz"))
    .sort()
    .reverse();

  if (tarballs.length === 0) {
    process.stderr.write("error: no pre-migrate tarballs found\n");
    return 1;
  }

  const tarball = path.join(MIGRATIONS_DIR, tarballs[0]!);
  process.stdout.write(`Restoring from: ${tarball}\n\n`);

  // Read the pointer so we know which target dir to clean up
  let targetToClean: string | null = null;
  if (fs.existsSync(POINTER_FILE)) {
    targetToClean = fs.readFileSync(POINTER_FILE, "utf8").trim();
  }

  // Move current ~/.dovai/ aside (keep migrations/ intact)
  const aside = `${STATE_ROOT}.rollback.${timestamp()}`;
  process.stdout.write(`1/3  moving current state aside → ${aside}\n`);
  await fsp.rename(STATE_ROOT, aside);

  // Extract tarball back into ~/.dovai/
  process.stdout.write(`2/3  extracting tarball…\n`);
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  const exRes = await run("tar", [
    "-xzf", tarball,
    "-C", path.dirname(STATE_ROOT),
  ]);
  if (exRes.code !== 0) {
    // Try to restore the aside
    await fsp.rename(aside, STATE_ROOT).catch(() => {});
    process.stderr.write(`error: tar extract failed: ${exRes.stderr.trim()}\n`);
    return 1;
  }

  // Preserve the tarball by moving it back into the restored migrations dir
  // (the tarball was extracted from a state that didn't include migrations/)
  const restoredMigrations = path.join(STATE_ROOT, "migrations");
  fs.mkdirSync(restoredMigrations, { recursive: true });
  const asideMig = path.join(aside, "migrations");
  if (fs.existsSync(asideMig)) {
    for (const f of fs.readdirSync(asideMig)) {
      fs.renameSync(path.join(asideMig, f), path.join(restoredMigrations, f));
    }
  }

  process.stdout.write(`3/3  cleanup\n`);
  process.stdout.write(`     aside:          ${aside} (delete when ready)\n`);
  if (targetToClean && fs.existsSync(targetToClean)) {
    process.stdout.write(`     data-dir target: ${targetToClean} (delete when ready)\n`);
  }
  process.stdout.write(`\n✓ rollback complete — Dovai is restored to pre-migration state\n\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const first = args[0];

  if (!first || first === "--help" || first === "-h") {
    process.stdout.write(
      "\nUsage:\n" +
        "  dovai migrate <target_path>     move user data to <target_path>/Dovai/\n" +
        "  dovai migrate --detect          list suggested cloud-sync folders\n" +
        "  dovai migrate --status          show current data_dir state\n" +
        "  dovai migrate --rollback        restore from most recent pre-migrate tarball\n\n",
    );
    process.exit(first === "--help" || first === "-h" ? 0 : 1);
  }

  try {
    let code: number;
    if (first === "--detect") code = await cmdDetect();
    else if (first === "--status") code = await cmdStatus();
    else if (first === "--rollback") code = await cmdRollback();
    else code = await cmdMigrate(first);
    process.exit(code);
  } catch (err) {
    process.stderr.write(`\nfatal: ${(err as Error).message}\n\n`);
    process.exit(1);
  }
}

main();
