/**
 * File-based lock protocol. Used for:
 *   - server.lock: prevents two dovai-server instances on the same workspace
 *   - wake.lock:    prevents two `claude -p` wakes running concurrently
 *   - session.lock: signals an interactive Claude Code session is active
 *                   (heartbeated every ~30s; stale after 2 min means dead)
 */
import fs from "node:fs";

const STALE_MS = {
  server: 60_000, // server heartbeat every 30s, stale after 60s
  wake: 30 * 60_000, // wake locks are held only for the duration of claude -p
  session: 2 * 60_000, // session heartbeat every 30s, stale after 2 min
};

export interface LockInfo {
  pid: number;
  heartbeat: number;
}

export function readLock(path: string): LockInfo | null {
  try {
    const raw = fs.readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid === "number" && typeof parsed.heartbeat === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function isFresh(lock: LockInfo | null, kind: keyof typeof STALE_MS): boolean {
  if (!lock) return false;
  const age = Date.now() - lock.heartbeat;
  return age < STALE_MS[kind];
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 probes existence without killing. Throws ESRCH if dead.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to acquire a lock. Returns true if acquired, false if another live holder exists.
 * If a stale lock is found (dead pid or expired heartbeat), it is removed and acquired.
 */
export function acquireLock(path: string, kind: keyof typeof STALE_MS): boolean {
  const existing = readLock(path);
  if (existing && isFresh(existing, kind) && isProcessAlive(existing.pid)) {
    return false;
  }
  // Stale or missing — safe to overwrite
  writeLock(path);
  return true;
}

export function writeLock(path: string): void {
  const info: LockInfo = { pid: process.pid, heartbeat: Date.now() };
  fs.writeFileSync(path, JSON.stringify(info));
}

export function refreshLock(path: string): void {
  try {
    writeLock(path);
  } catch {
    // ignore — the lock file might be in a missing dir temporarily
  }
}

export function releaseLock(path: string): void {
  try {
    const existing = readLock(path);
    // Only delete if it's ours (guards against racing a later acquirer)
    if (existing && existing.pid === process.pid) {
      fs.unlinkSync(path);
    }
  } catch {
    // ignore
  }
}

/**
 * Checks whether any holder (live or recent) exists. Used by the wake dispatcher
 * to decide whether to skip this cycle.
 */
export function isLocked(path: string, kind: keyof typeof STALE_MS): boolean {
  const existing = readLock(path);
  if (!existing) return false;
  if (!isFresh(existing, kind)) return false;
  return isProcessAlive(existing.pid);
}
