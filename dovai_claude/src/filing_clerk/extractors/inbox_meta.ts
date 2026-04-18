/**
 * Extractor for `meta.json` files inside `dovai_files/email/inbox/` and
 * `dovai_files/telegram/inbox/`.
 *
 * The email poller and telegram bot each write a `meta.json` per message with
 * a structured shape (from, to, subject, body_text, attachments — or chat_id,
 * from_username, text, attachments). If we let the generic text extractor
 * handle these files it would feed the raw JSON to LM Studio — including
 * the enormous `body_html` field that emails often carry — which wastes
 * tokens and produces ugly summaries.
 *
 * This extractor formats the meta.json as a clean plain-text message that
 * LM Studio can summarise usefully. Attachments are listed by filename;
 * each attachment file also gets indexed on its own via the normal
 * extractor pipeline (PDFs, images, xlsx, etc.).
 */
import fs from "node:fs/promises";
import type { Extraction } from "./index.ts";

interface EmailMeta {
  uid?: number;
  received_at?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body_text?: string;
  body_html?: string;
  attachments?: Array<{ filename?: string; path?: string }>;
}

interface TelegramMeta {
  received_at?: string;
  chat_id?: number | string;
  from_username?: string;
  from_name?: string;
  text?: string;
  transcription?: string;
  attachments?: Array<{ kind?: string; filename?: string; path?: string }>;
}

/**
 * Check whether the workspace-relative path is an inbox `meta.json` file.
 */
export function isInboxMetaPath(relPath: string): boolean {
  if (!relPath.endsWith("/meta.json")) return false;
  return (
    relPath.startsWith("dovai_files/email/inbox/") ||
    relPath.startsWith("dovai_files/telegram/inbox/")
  );
}

export async function extractInboxMeta(
  absPath: string,
  relPath: string,
): Promise<Extraction | null> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  if (relPath.startsWith("dovai_files/email/inbox/")) {
    return { text: formatEmailMeta(parsed as EmailMeta), method: "inbox_meta_email" };
  }
  if (relPath.startsWith("dovai_files/telegram/inbox/")) {
    return { text: formatTelegramMeta(parsed as TelegramMeta), method: "inbox_meta_telegram" };
  }
  return null;
}

function formatEmailMeta(m: EmailMeta): string {
  const lines: string[] = [];
  lines.push("# Email message");
  lines.push("");
  if (m.received_at) lines.push(`Received: ${m.received_at}`);
  if (m.from) lines.push(`From: ${m.from}`);
  if (m.to) lines.push(`To: ${m.to}`);
  if (m.cc) lines.push(`Cc: ${m.cc}`);
  if (m.subject) lines.push(`Subject: ${m.subject}`);
  if (m.attachments && m.attachments.length > 0) {
    lines.push(
      `Attachments: ${m.attachments
        .map((a) => a.filename || a.path || "?")
        .join(", ")}`,
    );
  }
  lines.push("");
  lines.push("## Body");
  lines.push("");
  lines.push((m.body_text || "").trim() || "(no plain-text body)");
  return lines.join("\n");
}

function formatTelegramMeta(m: TelegramMeta): string {
  const lines: string[] = [];
  lines.push("# Telegram message");
  lines.push("");
  if (m.received_at) lines.push(`Received: ${m.received_at}`);
  const sender = m.from_name || m.from_username || "(unknown)";
  lines.push(`From: ${sender}`);
  if (m.chat_id !== undefined) lines.push(`Chat: ${m.chat_id}`);
  if (m.attachments && m.attachments.length > 0) {
    lines.push(
      `Attachments: ${m.attachments
        .map((a) => `${a.kind ?? "file"}:${a.filename ?? a.path ?? "?"}`)
        .join(", ")}`,
    );
  }
  lines.push("");
  lines.push("## Text");
  lines.push("");
  lines.push((m.text || "").trim() || "(no text)");

  if (m.transcription?.trim()) {
    lines.push("");
    lines.push("## Voice transcription");
    lines.push("");
    lines.push(m.transcription.trim());
  }

  return lines.join("\n");
}
