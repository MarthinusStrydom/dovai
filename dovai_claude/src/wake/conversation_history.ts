/**
 * Unified conversation history across all channels.
 *
 * Merges Telegram messages, emails, and CLI session summaries into one
 * chronological thread. This is what makes Sarah feel like one person
 * regardless of whether you talked to her on Telegram, in the terminal,
 * or via email — she remembers all of it.
 *
 * Sources:
 *   - dovai_files/telegram/inbox/  + telegram/sent/
 *   - dovai_files/email/inbox/     + email/sent/
 *   - index/_sessions/             (CLI + headless wake summaries)
 *
 * Built from the filesystem on every wake — no separate DB.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";

interface HistoryEntry {
  timestamp: Date;
  channel: "telegram" | "email" | "cli";
  direction: "in" | "out";
  from: string;
  to?: string;
  subject?: string;
  text: string;
  attachments: string[];
}

/**
 * Maximum number of entries to include. Keeps the prompt bounded while
 * covering several days of conversation across all channels.
 */
const MAX_ENTRIES = 80;

/**
 * Maximum characters per entry body. Long emails/session outputs get
 * truncated to keep the total history size reasonable.
 */
const MAX_BODY_CHARS = 800;

// -----------------------------------------------------------------------
// Timestamp parsing
// -----------------------------------------------------------------------

/**
 * Parse outbox/sent filename timestamps.
 * Formats: 20260417-1710_slug.json, 20260417-173400_slug.json, 20260414_slug.json
 */
function parseSentTimestamp(filename: string): Date | null {
  const full = filename.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  if (full) {
    const [, year, month, day, hour, minute] = full;
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`);
  }
  const dateOnly = filename.match(/^(\d{4})(\d{2})(\d{2})_/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return new Date(`${year}-${month}-${day}T12:00:00Z`);
  }
  return null;
}

/**
 * Parse session filename timestamp.
 * Format: session_2026-04-17T17-39-47-129Z.md
 */
function parseSessionTimestamp(filename: string): Date | null {
  const match = filename.match(/^session_(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.md$/);
  if (!match?.[1]) return null;
  const isoStr = match[1].replace(
    /(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1:$2:$3.$4Z",
  );
  const d = new Date(isoStr);
  return Number.isNaN(d.getTime()) ? null : d;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n[...truncated]";
}

// -----------------------------------------------------------------------
// Channel scanners
// -----------------------------------------------------------------------

async function scanTelegramInbox(gp: GlobalPaths): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  try {
    const dirs = await fs.readdir(gp.telegramInbox);
    for (const dir of dirs) {
      const metaPath = path.join(gp.telegramInbox, dir, "meta.json");
      try {
        const raw = await fs.readFile(metaPath, "utf8");
        const meta = JSON.parse(raw);
        const text = meta.transcription || meta.text || "";
        const attachments: string[] = [];
        if (meta.attachments) {
          for (const a of meta.attachments) {
            if (a.kind === "voice" && meta.transcription) {
              attachments.push("[voice message, transcribed]");
            } else if (a.kind === "voice") {
              attachments.push("[voice message]");
            } else if (a.kind === "photo") {
              attachments.push("[photo]");
            } else if (a.kind === "document") {
              attachments.push(`[document: ${a.filename || "file"}]`);
            }
          }
        }
        entries.push({
          timestamp: new Date(meta.received_at),
          channel: "telegram",
          direction: "in",
          from: meta.from_name || meta.from_username || "User",
          text: text.trim(),
          attachments,
        });
      } catch {
        continue;
      }
    }
  } catch { /* no inbox */ }
  return entries;
}

async function scanTelegramSent(gp: GlobalPaths): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  try {
    const files = await fs.readdir(gp.telegramSent);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(gp.telegramSent, file), "utf8");
        const msg = JSON.parse(raw);
        const ts = parseSentTimestamp(file);
        if (!ts) continue;
        const attachments: string[] = [];
        if (msg.files?.length) {
          for (const f of msg.files) attachments.push(`[attached: ${path.basename(f)}]`);
        }
        entries.push({
          timestamp: ts,
          channel: "telegram",
          direction: "out",
          from: "Sarah",
          text: (msg.text || "").trim(),
          attachments,
        });
      } catch {
        continue;
      }
    }
  } catch { /* no sent */ }
  return entries;
}

async function scanEmailInbox(gp: GlobalPaths): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  try {
    const dirs = await fs.readdir(gp.emailInbox);
    for (const dir of dirs) {
      const metaPath = path.join(gp.emailInbox, dir, "meta.json");
      try {
        const raw = await fs.readFile(metaPath, "utf8");
        const meta = JSON.parse(raw);
        const attachments: string[] = [];
        if (meta.attachments?.length) {
          for (const a of meta.attachments) {
            attachments.push(`[attachment: ${a.filename || "file"}]`);
          }
        }
        entries.push({
          timestamp: new Date(meta.received_at),
          channel: "email",
          direction: "in",
          from: meta.from || "unknown",
          to: meta.to || "",
          subject: meta.subject || "",
          text: (meta.body_text || "").trim(),
          attachments,
        });
      } catch {
        continue;
      }
    }
  } catch { /* no inbox */ }
  return entries;
}

async function scanEmailSent(gp: GlobalPaths): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  try {
    const files = await fs.readdir(gp.emailSent);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(gp.emailSent, file), "utf8");
        const msg = JSON.parse(raw);
        const ts = parseSentTimestamp(file);
        if (!ts) continue;
        const toStr = Array.isArray(msg.to) ? msg.to.join(", ") : (msg.to || "");
        const attachments: string[] = [];
        if (msg.attachments?.length) {
          for (const a of msg.attachments) attachments.push(`[attached: ${path.basename(a)}]`);
        }
        entries.push({
          timestamp: ts,
          channel: "email",
          direction: "out",
          from: "Sarah",
          to: toStr,
          subject: msg.subject || "",
          text: (msg.body_text || "").trim(),
          attachments,
        });
      } catch {
        continue;
      }
    }
  } catch { /* no sent */ }
  return entries;
}

async function scanSessions(gp: GlobalPaths): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  try {
    const files = await fs.readdir(gp.sessions);
    for (const file of files) {
      if (!file.startsWith("session_") || !file.endsWith(".md")) continue;
      const ts = parseSessionTimestamp(file);
      if (!ts) continue;
      try {
        const raw = await fs.readFile(path.join(gp.sessions, file), "utf8");
        // Extract the "Session output" section
        const outputMatch = raw.match(/## Session output\s*\n\n([\s\S]*?)(?:\n## |\n---|\Z)/);
        const output = outputMatch?.[1]?.trim() || "";
        if (!output || output === "_(no output captured)_") continue;
        entries.push({
          timestamp: ts,
          channel: "cli",
          direction: "out",
          from: "Sarah (headless wake)",
          text: output,
          attachments: [],
        });
      } catch {
        continue;
      }
    }
  } catch { /* no sessions */ }
  return entries;
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Build a unified conversation history across all channels.
 * Returns a formatted markdown string ready to inject into a prompt.
 */
export async function buildConversationHistory(
  gp: GlobalPaths,
  logger: Logger,
): Promise<string> {
  // Scan all channels in parallel
  const [tgIn, tgOut, emIn, emOut, sessions] = await Promise.all([
    scanTelegramInbox(gp),
    scanTelegramSent(gp),
    scanEmailInbox(gp),
    scanEmailSent(gp),
    scanSessions(gp),
  ]);

  const all = [...tgIn, ...tgOut, ...emIn, ...emOut, ...sessions];
  if (all.length === 0) return "";

  // Sort chronologically, take the most recent entries
  all.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const recent = all.slice(-MAX_ENTRIES);

  logger.debug("conversation history built", {
    telegram_in: tgIn.length,
    telegram_out: tgOut.length,
    email_in: emIn.length,
    email_out: emOut.length,
    sessions: sessions.length,
    total: all.length,
    included: recent.length,
  });

  // Format
  const lines: string[] = [];
  lines.push("## Conversation history (all channels)\n");
  lines.push("This is the recent conversation across Telegram, email, and CLI sessions.");
  lines.push("Use it for context — maintain continuity across channels, don't repeat");
  lines.push("yourself, and remember what was discussed regardless of how it was said.\n");

  let lastDate = "";
  for (const entry of recent) {
    const dateStr = entry.timestamp.toISOString().slice(0, 10);
    if (dateStr !== lastDate) {
      lines.push(`\n--- ${formatDate(entry.timestamp)} ---\n`);
      lastDate = dateStr;
    }

    const time = entry.timestamp.toISOString().slice(11, 16);
    const body = truncate(entry.text || "(no text)", MAX_BODY_CHARS);

    if (entry.channel === "telegram") {
      const tag = entry.direction === "in" ? `${entry.from} (telegram)` : "Sarah (telegram)";
      lines.push(`[${time}] ${tag}: ${body}`);
    } else if (entry.channel === "email") {
      if (entry.direction === "in") {
        lines.push(`[${time}] Email from ${entry.from}: "${entry.subject || "(no subject)"}"`);
        if (body && body !== "(no text)") lines.push(`  ${body}`);
      } else {
        lines.push(`[${time}] Sarah emailed ${entry.to}: "${entry.subject || "(no subject)"}"`);
        if (body && body !== "(no text)") lines.push(`  ${body}`);
      }
    } else if (entry.channel === "cli") {
      lines.push(`[${time}] ${entry.from}: ${body}`);
    }

    for (const att of entry.attachments) {
      lines.push(`  ${att}`);
    }
  }

  return lines.join("\n");
}

/**
 * Write the conversation history to a file so CLI interactive sessions
 * can read it on startup.
 */
export async function writeConversationLog(
  gp: GlobalPaths,
  logger: Logger,
): Promise<void> {
  const history = await buildConversationHistory(gp, logger);
  await fs.writeFile(gp.conversationLog, history || "_(no conversation history yet)_\n");
}

function formatDate(d: Date): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
