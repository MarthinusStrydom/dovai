/**
 * Email poller.
 *
 * Pulls new mail every 5 minutes, writes each message as a file under
 * `dovai_files/email/inbox/`, and enqueues a wake event so the AI CLI
 * processes it promptly.
 *
 * Two backends, chosen by `providers.email_backend`:
 *
 *   - "gmail_oauth" (recommended) — Gmail API. Incremental sync via
 *     history.list; falls back to messages.list(q="newer_than:7d") on
 *     first run so we don't re-download years of history.
 *
 *   - "imap" (legacy) — IMAP FETCH with UID-based pagination.
 *
 * On-disk format is identical across backends so filing_clerk + knowledge
 * graph + search don't care how mail arrived:
 *   <ts>_<slug>.json          — parsed metadata (unused if folder present)
 *   <ts>_<slug>/message.eml   — the raw MIME source
 *   <ts>_<slug>/meta.json     — parsed fields (from, to, subject, body, attachments)
 *   <ts>_<slug>/<attachment>  — each attachment saved verbatim
 *
 * State tracking (per-backend, single-file):
 *   dovai_files/email/.last_uid         — IMAP highest-UID-seen
 *   dovai_files/email/.last_history_id  — Gmail last historyId
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { loadProviderSettings } from "../lib/config.ts";
import { enqueueWake } from "../wake/queue.ts";
import { makeGmailClient } from "../lib/gmail_auth.ts";
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";

const POLL_INTERVAL_MS = 5 * 60_000;

/**
 * On first Gmail connect, fetch only mail from the last N days so Sarah
 * doesn't suddenly process years of inbox history.
 */
const GMAIL_BOOTSTRAP_QUERY = "newer_than:7d";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function tsPrefix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Write a parsed email + its raw source to disk in the canonical layout.
 * Returns the folder name (e.g. "2026-04-18T..._subject_slug").
 */
async function persistEmail(
  gp: GlobalPaths,
  logger: Logger,
  rawSource: Buffer,
  parsed: ParsedMail,
  extraMeta: Record<string, unknown> = {},
): Promise<{ folderName: string; subject: string; fromAddr: string }> {
  const subject = parsed.subject || "(no subject)";
  const fromAddr = parsed.from?.text || "";
  const ts = tsPrefix();
  const slug = slugify(subject);
  const inbox = path.join(gp.dovaiFiles, "email", "inbox");
  await fs.mkdir(inbox, { recursive: true });

  const folderName = `${ts}_${slug}`;
  const folder = path.join(inbox, folderName);
  await fs.mkdir(folder, { recursive: true });

  await fs.writeFile(path.join(folder, "message.eml"), rawSource);

  const meta: Record<string, unknown> = {
    received_at: new Date().toISOString(),
    from: fromAddr,
    to: parsed.to ? ("text" in parsed.to ? parsed.to.text : "") : "",
    cc: parsed.cc ? ("text" in parsed.cc ? parsed.cc.text : "") : "",
    subject,
    body_text: parsed.text || "",
    body_html: parsed.html || "",
    attachments: [] as Array<{ filename: string; path: string }>,
    ...extraMeta,
  };

  const attachments = meta.attachments as Array<{ filename: string; path: string }>;
  for (const att of parsed.attachments || []) {
    if (!att.filename) continue;
    const attPath = path.join(folder, att.filename);
    await fs.writeFile(attPath, att.content as Buffer);
    attachments.push({
      filename: att.filename,
      path: path.relative(gp.dovaiHome, attPath).split(path.sep).join("/"),
    });
  }

  await fs.writeFile(path.join(folder, "meta.json"), JSON.stringify(meta, null, 2));
  logger.info("new email fetched", { subject, from: fromAddr, folder: folderName });

  return { folderName, subject, fromAddr };
}

export class EmailPoller {
  private timer: NodeJS.Timeout | null = null;
  private logger: Logger;
  private lastUidFile: string;
  private lastHistoryIdFile: string;
  private running = false;

  constructor(
    private readonly gp: GlobalPaths,
    logger: Logger,
  ) {
    this.logger = logger.child("email");
    this.lastUidFile = path.join(gp.dovaiFiles, "email", ".last_uid");
    this.lastHistoryIdFile = path.join(gp.dovaiFiles, "email", ".last_history_id");
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info("email poller starting");
    // First poll after a short delay so settings can be loaded
    setTimeout(() => this.pollOnce().catch(() => undefined), 5_000);
    this.timer = setInterval(() => this.pollOnce().catch(() => undefined), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ------------------------------------------------------------------
  // Backend dispatch
  // ------------------------------------------------------------------

  private async pollOnce(): Promise<void> {
    if (!this.running) return;

    const { data: pr } = loadProviderSettings(this.gp);

    if (pr.email_backend === "gmail_oauth") {
      if (!pr.gmail_refresh_token) return; // not connected yet
      try {
        await this.pollOnceGmail();
      } catch (err) {
        this.logger.warn("gmail poll failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Default / legacy: IMAP
    if (!pr.email_imap_host || !pr.email_imap_user || !pr.email_imap_password) {
      return;
    }
    try {
      await this.pollOnceImap();
    } catch (err) {
      this.logger.warn("imap poll failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ------------------------------------------------------------------
  // Gmail API backend
  // ------------------------------------------------------------------

  private async readLastHistoryId(): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.lastHistoryIdFile, "utf8");
      return raw.trim() || null;
    } catch {
      return null;
    }
  }

  private async writeLastHistoryId(id: string): Promise<void> {
    await fs.mkdir(path.dirname(this.lastHistoryIdFile), { recursive: true });
    await fs.writeFile(this.lastHistoryIdFile, String(id));
  }

  private async pollOnceGmail(): Promise<void> {
    const { data: pr } = loadProviderSettings(this.gp);
    const gmail = makeGmailClient(pr);
    const lastHistoryId = await this.readLastHistoryId();

    let newMessageIds: string[];
    let newestHistoryId: string | null = null;

    if (!lastHistoryId) {
      // Bootstrap: first run. Fetch only recent messages so we don't
      // process years of backlog, and record the current historyId to
      // anchor future incremental polls.
      this.logger.info("gmail bootstrap: fetching recent messages", { q: GMAIL_BOOTSTRAP_QUERY });
      const listed = await gmail.users.messages.list({
        userId: "me",
        q: GMAIL_BOOTSTRAP_QUERY,
        maxResults: 100,
      });
      newMessageIds = (listed.data.messages ?? []).map((m) => m.id!).filter(Boolean);

      // Capture current historyId so next poll starts incrementally.
      const profile = await gmail.users.getProfile({ userId: "me" });
      newestHistoryId = profile.data.historyId ?? null;
    } else {
      // Incremental: ask Gmail what's changed since last historyId.
      const histRes = await gmail.users.history.list({
        userId: "me",
        startHistoryId: lastHistoryId,
        historyTypes: ["messageAdded"],
        maxResults: 100,
      });

      const added = new Set<string>();
      for (const h of histRes.data.history ?? []) {
        for (const m of h.messagesAdded ?? []) {
          if (m.message?.id) added.add(m.message.id);
        }
      }
      newMessageIds = [...added];
      newestHistoryId = histRes.data.historyId ?? lastHistoryId;
    }

    if (newMessageIds.length === 0) {
      if (newestHistoryId && newestHistoryId !== lastHistoryId) {
        await this.writeLastHistoryId(newestHistoryId);
      }
      return;
    }

    this.logger.info("gmail new messages", { count: newMessageIds.length });

    for (const messageId of newMessageIds) {
      try {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "raw",
        });
        const rawB64url = msg.data.raw ?? "";
        if (!rawB64url) continue;

        // Gmail returns base64url-encoded raw MIME. Buffer.from supports base64url.
        const rawBuf = Buffer.from(rawB64url, "base64url");
        const parsed = await simpleParser(rawBuf);

        const { folderName, subject, fromAddr } = await persistEmail(
          this.gp,
          this.logger,
          rawBuf,
          parsed,
          {
            gmail_message_id: messageId,
            gmail_thread_id: msg.data.threadId ?? null,
            gmail_labels: msg.data.labelIds ?? [],
          },
        );

        await enqueueWake(this.gp, {
          source: "email",
          from: fromAddr,
          subject,
          folder: folderName,
        });
      } catch (err) {
        this.logger.error("failed fetching gmail message", {
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (newestHistoryId) {
      await this.writeLastHistoryId(newestHistoryId);
    }
  }

  // ------------------------------------------------------------------
  // IMAP backend (legacy)
  // ------------------------------------------------------------------

  private async readLastUid(): Promise<number> {
    try {
      const raw = await fs.readFile(this.lastUidFile, "utf8");
      const n = parseInt(raw.trim(), 10);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  private async writeLastUid(uid: number): Promise<void> {
    await fs.mkdir(path.dirname(this.lastUidFile), { recursive: true });
    await fs.writeFile(this.lastUidFile, String(uid));
  }

  private async pollOnceImap(): Promise<void> {
    const { data: providers } = loadProviderSettings(this.gp);
    const lastUid = await this.readLastUid();

    const client = new ImapFlow({
      host: providers.email_imap_host,
      port: providers.email_imap_port || 993,
      secure: true,
      auth: {
        user: providers.email_imap_user,
        pass: providers.email_imap_password,
      },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const from = lastUid > 0 ? lastUid + 1 : "1";
        let newMaxUid = lastUid;

        const iter = client.fetch(`${from}:*`, { uid: true, source: true, envelope: true });
        for await (const msg of iter) {
          if (!msg.uid || msg.uid <= lastUid) continue;
          if (!msg.source) continue;

          try {
            const parsed = await simpleParser(msg.source);
            const { folderName, subject, fromAddr } = await persistEmail(
              this.gp,
              this.logger,
              msg.source,
              parsed,
              { uid: msg.uid },
            );

            await enqueueWake(this.gp, {
              source: "email",
              from: fromAddr,
              subject,
              folder: folderName,
            });
            if (msg.uid > newMaxUid) newMaxUid = msg.uid;
          } catch (err) {
            this.logger.error("failed parsing email", {
              uid: msg.uid,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (newMaxUid > lastUid) {
          await this.writeLastUid(newMaxUid);
        }
      } finally {
        lock.release();
      }
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
  }
}
