/**
 * Wake queue: pending events that need Claude Code's attention.
 * Each event is a JSON file in .dovai/wake_queue/ named <timestamp>_<slug>.json.
 *
 * Claude Code (on wake) is instructed to read every file in wake_queue/,
 * process them, and delete them. See CLAUDE.md template.
 *
 * Why files rather than an in-memory queue? Because the filing clerk and
 * claude -p invocations are separate processes. Files are the contract.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GlobalPaths } from "../lib/global_paths.ts";

export type WakeSource =
  | "file"
  | "file_removed"
  | "email"
  | "telegram"
  | "scheduled"
  | "sop"
  | "user_chat"
  | "approval"
  | "manual"
  | "send_failed"
  | "email_sent"
  | "telegram_sent"
  | "email_blocked";

export interface WakeEvent {
  source: WakeSource;
  /** When the event was created */
  created_at?: string;
  /** Arbitrary payload depending on source */
  [key: string]: unknown;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
}

export async function enqueueWake(gp: GlobalPaths, event: WakeEvent): Promise<string> {
  await fs.mkdir(gp.wakeQueue, { recursive: true });
  const filename = `${timestamp()}_${slugify(event.source)}.json`;
  const filepath = path.join(gp.wakeQueue, filename);
  const payload = { created_at: new Date().toISOString(), ...event };
  await fs.writeFile(filepath, JSON.stringify(payload, null, 2));
  return filepath;
}

export async function listWakeQueue(gp: GlobalPaths): Promise<string[]> {
  try {
    const entries = await fs.readdir(gp.wakeQueue);
    return entries.filter((e) => e.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

export async function readWakeEvent(gp: GlobalPaths, name: string): Promise<WakeEvent | null> {
  try {
    const raw = await fs.readFile(path.join(gp.wakeQueue, name), "utf8");
    return JSON.parse(raw) as WakeEvent;
  } catch {
    return null;
  }
}

export async function clearWakeQueue(gp: GlobalPaths): Promise<void> {
  const files = await listWakeQueue(gp);
  await Promise.all(
    files.map((f) => fs.rm(path.join(gp.wakeQueue, f), { force: true }).catch(() => undefined)),
  );
}
