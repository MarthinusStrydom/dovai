/**
 * Cross-machine ownership lock for the data dir.
 *
 * Problem this solves: once the data dir is on Drive/iCloud, any machine
 * that can see it could theoretically start a Dovai server pointed at it.
 * If two servers ran simultaneously, Drive would race them and create
 * conflict copies of drafts, tasks, and the conversation log — a mess.
 *
 * Mechanism: `<data_dir>/.dovai-owner` is a small JSON file recording the
 * hostname + PID + heartbeat timestamp of the currently active server.
 * Servers check it on startup; only one machine can hold the lock at a
 * time. Heartbeat is refreshed every 30s; after 2 minutes of silence the
 * lock is considered stale and another machine may take over (covers crashes,
 * reboots, etc.).
 *
 * Same-machine collisions are still caught by the existing process-level
 * `serverLock` — this is purely for the cross-machine case.
 *
 * See: docs/PLAN_DATA_DIR_SPLIT.md (Phase 4).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** How long between heartbeats before the lock is considered stale. */
const STALE_MS = 2 * 60_000; // 2 minutes

export interface OwnerInfo {
  hostname: string;
  pid: number;
  started_at: string;
  heartbeat: number;
}

export function ownerLockPath(dataRoot: string): string {
  return path.join(dataRoot, ".dovai-owner");
}

export function readOwner(dataRoot: string): OwnerInfo | null {
  const p = ownerLockPath(dataRoot);
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.hostname === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.heartbeat === "number" &&
      typeof parsed.started_at === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function isOwnerFresh(owner: OwnerInfo): boolean {
  return Date.now() - owner.heartbeat < STALE_MS;
}

function writeOwner(dataRoot: string, startedAt: string): void {
  const info: OwnerInfo = {
    hostname: os.hostname(),
    pid: process.pid,
    started_at: startedAt,
    heartbeat: Date.now(),
  };
  fs.writeFileSync(ownerLockPath(dataRoot), JSON.stringify(info, null, 2));
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; reason: "other_host_live"; existing: OwnerInfo }
  | { ok: false; reason: "same_host_live"; existing: OwnerInfo }
  | { ok: true; takeover: "stale" | "same_host_crash"; previous: OwnerInfo };

/**
 * Try to acquire data-dir ownership for this machine. Possible outcomes:
 *
 *   - no existing lock → acquire, ok=true
 *   - existing lock, same hostname, fresh heartbeat → REFUSE (another Sarah
 *     is running on this same box — same-host case, also caught by
 *     serverLock but surfaced here for a clearer message)
 *   - existing lock, different hostname, fresh heartbeat → REFUSE (another
 *     Sarah is live on another machine; stop her first)
 *   - existing lock, stale heartbeat → take ownership, report the takeover
 *     so the caller can log it
 *   - existing lock, same hostname, stale → take ownership (we crashed and
 *     restarted before cleanup)
 *
 * Skip entirely by passing `dataRoot === stateRoot` (no migration yet —
 * cross-machine concerns don't apply to an unmigrated install).
 */
export function acquireOwnership(dataRoot: string, stateRoot: string): AcquireResult {
  // Pre-migration: dataRoot === stateRoot, which means this data is
  // definitionally local-only. Cross-machine lock is meaningless; skip.
  if (dataRoot === stateRoot) {
    return { ok: true };
  }

  const startedAt = new Date().toISOString();
  const existing = readOwner(dataRoot);

  if (!existing) {
    writeOwner(dataRoot, startedAt);
    return { ok: true };
  }

  const fresh = isOwnerFresh(existing);
  const sameHost = existing.hostname === os.hostname();

  // On the same host we can verify the claimed PID is actually running.
  // If it isn't, the lock is stale regardless of heartbeat — take over.
  // (Cross-host we can't check remotely, so heartbeat is the only signal.)
  const sameHostDead = sameHost && !isPidAlive(existing.pid);

  if (fresh && sameHost && !sameHostDead) {
    return { ok: false, reason: "same_host_live", existing };
  }
  if (fresh && !sameHost) {
    return { ok: false, reason: "other_host_live", existing };
  }

  // Stale or crashed — take over
  writeOwner(dataRoot, startedAt);
  return {
    ok: true,
    takeover: sameHostDead ? "same_host_crash" : "stale",
    previous: existing,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Refresh the heartbeat. Called every 30s on the server heartbeat interval. */
export function refreshOwnership(dataRoot: string, stateRoot: string): void {
  if (dataRoot === stateRoot) return;
  try {
    const existing = readOwner(dataRoot);
    if (!existing || existing.pid !== process.pid || existing.hostname !== os.hostname()) {
      // Something else took over — don't stomp. The server will notice on
      // next heartbeat check and log; shutting down gracefully is the right
      // response but is left to the caller to decide.
      return;
    }
    existing.heartbeat = Date.now();
    fs.writeFileSync(ownerLockPath(dataRoot), JSON.stringify(existing, null, 2));
  } catch {
    // Drive might be momentarily unavailable — skip this tick
  }
}

/**
 * Release ownership on clean shutdown. Only removes the file if we still
 * hold it (safety against racing a takeover).
 */
export function releaseOwnership(dataRoot: string, stateRoot: string): void {
  if (dataRoot === stateRoot) return;
  try {
    const existing = readOwner(dataRoot);
    if (existing && existing.pid === process.pid && existing.hostname === os.hostname()) {
      fs.unlinkSync(ownerLockPath(dataRoot));
    }
  } catch {
    // ignore
  }
}
