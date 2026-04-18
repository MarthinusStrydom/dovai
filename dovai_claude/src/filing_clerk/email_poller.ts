/**
 * Email poller.
 *
 * Connects to IMAP every 5 min, fetches new messages, writes them as files
 * to dovai_files/email/inbox/, and enqueues a wake event for each so the
 * AI CLI processes them promptly.
 *
 * Format on disk:
 *   <ts>_<slug>.json   — parsed metadata (from, to, subject, body, attachments)
 *   <ts>_<slug>/       — folder with the raw .eml and any attachment files
 *
 * State tracking: we persist the highest IMAP UID we've seen in
 * dovai_files/email/.last_uid so we don't re-fetch on restart.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { loadProviderSettings } from "../lib/config.ts";
import { enqueueWake } from "../wake/queue.ts";
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";

const POLL_INTERVAL_MS = 5 * 60_000;

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

export class EmailPoller {
  private timer: NodeJS.Timeout | null = null;
  private logger: Logger;
  private lastUidFile: string;
  private running = false;

  constructor(
    private readonly gp: GlobalPaths,
    logger: Logger,
  ) {
    this.logger = logger.child("email");
    this.lastUidFile = path.join(gp.dovaiFiles, "email", ".last_uid");
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

  private async pollOnce(): Promise<void> {
    if (!this.running) return;

    const { data: providers } = loadProviderSettings(this.gp);
    if (!providers.email_imap_host || !providers.email_imap_user || !providers.email_imap_password) {
      return; // not configured yet
    }

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
        // Fetch anything with UID greater than the last seen UID
        const from = lastUid > 0 ? lastUid + 1 : "1";
        let newMaxUid = lastUid;

        const iter = client.fetch(`${from}:*`, { uid: true, source: true, envelope: true });
        for await (const msg of iter) {
          if (!msg.uid || msg.uid <= lastUid) continue;
          if (!msg.source) continue;

          try {
            const parsed = await simpleParser(msg.source);
            const subject = parsed.subject || "(no subject)";
            const fromAddr = parsed.from?.text || "";
            const ts = tsPrefix();
            const slug = slugify(subject);
            const inbox = path.join(this.gp.dovaiFiles, "email", "inbox");
            await fs.mkdir(inbox, { recursive: true });

            // Store raw eml in a subfolder alongside parsed metadata
            const folderName = `${ts}_${slug}`;
            const folder = path.join(inbox, folderName);
            await fs.mkdir(folder, { recursive: true });

            await fs.writeFile(path.join(folder, "message.eml"), msg.source);

            const meta = {
              uid: msg.uid,
              received_at: new Date().toISOString(),
              from: fromAddr,
              to: parsed.to ? ("text" in parsed.to ? parsed.to.text : "") : "",
              subject,
              body_text: parsed.text || "",
              body_html: parsed.html || "",
              attachments: [] as Array<{ filename: string; path: string }>,
            };

            for (const att of parsed.attachments || []) {
              if (!att.filename) continue;
              const attPath = path.join(folder, att.filename);
              await fs.writeFile(attPath, att.content as Buffer);
              meta.attachments.push({
                filename: att.filename,
                path: path.relative(this.gp.dovaiHome, attPath).split(path.sep).join("/"),
              });
            }

            await fs.writeFile(path.join(folder, "meta.json"), JSON.stringify(meta, null, 2));

            this.logger.info("new email fetched", { uid: msg.uid, subject, from: fromAddr });
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
    } catch (err) {
      this.logger.warn("imap poll failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
  }
}
