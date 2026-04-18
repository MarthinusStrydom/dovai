/**
 * Outbox dispatcher.
 *
 * Watches dovai_files/email/outbox/ and dovai_files/telegram/outbox/ for
 * *.json files dropped by Claude Code. For each:
 *   - parses the JSON
 *   - actually sends the email / telegram message
 *   - moves the file to sent/ on success
 *   - on failure: retries with exponential backoff (10s / 60s / 300s)
 *   - after the final failure: moves the file to failed/, writes an error
 *     sidecar, and enqueues a `send_failed` wake event so Sarah knows and
 *     can surface it to the user. Silent failures are a correctness bug —
 *     we would rather be loud than lose messages.
 *
 * JSON formats expected from Claude:
 *
 * email:
 * {
 *   "to": "...",
 *   "cc": "...",
 *   "bcc": "...",
 *   "subject": "...",
 *   "body_text": "...",
 *   "body_html": "...",
 *   "attachments": ["relative/path/to/file.pdf", ...]
 * }
 *
 * telegram:
 * {
 *   "chat_id": 12345,
 *   "text": "...",
 *   "files": ["relative/path/to/file.pdf", ...]
 * }
 */
import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import nodemailer from "nodemailer";
import { loadProviderSettings } from "../lib/config.ts";
import { enqueueWake } from "../wake/queue.ts";
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";
import type { TelegramService } from "./telegram_bot.ts";
import { appendLedger } from "../lib/ledger.ts";
import { checkEmailDedup } from "./email_dedup.ts";

/** Delays in milliseconds between retry attempts. Length == max attempts - 1. */
const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];

interface OutgoingEmail {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string;
  body_text?: string;
  body_html?: string;
  attachments?: string[];
}

interface OutgoingTelegram {
  chat_id?: number | string;
  text?: string;
  files?: string[];
}

export class OutboxDispatcher {
  private emailWatcher: chokidar.FSWatcher | null = null;
  private telegramWatcher: chokidar.FSWatcher | null = null;
  private logger: Logger;
  private running = false;
  /**
   * Per-file retry attempt count. Cleared when the file is moved to sent/
   * or failed/. Used to decide when to give up on a transient failure and
   * escalate to the user via the failed/ folder + wake event.
   */
  private attempts = new Map<string, number>();

  constructor(
    private readonly gp: GlobalPaths,
    logger: Logger,
    private readonly telegram: TelegramService,
  ) {
    this.logger = logger.child("outbox");
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await fs.mkdir(this.gp.emailOutbox, { recursive: true });
    await fs.mkdir(this.gp.emailSent, { recursive: true });
    await fs.mkdir(this.gp.emailFailed, { recursive: true });
    await fs.mkdir(this.gp.emailBlocked, { recursive: true });
    await fs.mkdir(this.gp.telegramOutbox, { recursive: true });
    await fs.mkdir(this.gp.telegramSent, { recursive: true });
    await fs.mkdir(this.gp.telegramFailed, { recursive: true });

    this.emailWatcher = chokidar.watch(this.gp.emailOutbox, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 250 },
    });
    this.emailWatcher.on("add", (file) => {
      if (file.endsWith(".json")) void this.handleEmail(file);
    });

    this.telegramWatcher = chokidar.watch(this.gp.telegramOutbox, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 250 },
    });
    this.telegramWatcher.on("add", (file) => {
      if (file.endsWith(".json")) void this.handleTelegram(file);
    });

    this.logger.info("outbox dispatcher started");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.emailWatcher) {
      await this.emailWatcher.close();
      this.emailWatcher = null;
    }
    if (this.telegramWatcher) {
      await this.telegramWatcher.close();
      this.telegramWatcher = null;
    }
    this.attempts.clear();
  }

  private async handleEmail(file: string): Promise<void> {
    // Clear any stale retry counter left over from a previous add event
    // for the same filename (file may have been moved back from failed/).
    let raw: string;
    let msg: OutgoingEmail;
    try {
      raw = await fs.readFile(file, "utf8");
      msg = JSON.parse(raw) as OutgoingEmail;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error("email parse failed", { file, error: errMsg });
      await this.markFailedFinal("email", file, errMsg, {});
      return;
    }

    // Dedup guard: ask LM Studio if this is a duplicate of a recent email.
    try {
      const dedup = await checkEmailDedup(this.gp, msg);
      if (dedup.blocked) {
        this.logger.warn("email blocked by dedup guard", {
          file: path.basename(file),
          reason: dedup.reason,
          matched: dedup.matchedEntry,
        });
        await this.markBlocked(file, dedup.reason, dedup.matchedEntry);
        return;
      }
      this.logger.debug("dedup guard passed", { file: path.basename(file), reason: dedup.reason });
    } catch (err) {
      // If the dedup check itself throws unexpectedly, block to be safe.
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn("dedup guard error — blocking to be safe", { file: path.basename(file), error: errMsg });
      await this.markBlocked(file, `Dedup check failed: ${errMsg}`);
      return;
    }

    try {
      await this.sendEmail(msg);
      this.attempts.delete(file);
      await this.moveToSent(file, this.gp.emailSent);
      this.logger.info("email sent", { file: path.basename(file), to: msg.to });
      const toStr = Array.isArray(msg.to) ? msg.to.join(", ") : (msg.to || "unknown");
      appendLedger(this.gp, {
        action: "email_sent",
        description: `Email to ${toStr}: ${msg.subject || "(no subject)"}`,
        ref: path.basename(file),
        details: { to: msg.to, subject: msg.subject, file: path.basename(file) },
      });
      await enqueueWake(this.gp, {
        source: "email_sent",
        channel: "email",
        file: path.basename(file),
        to: msg.to,
        subject: msg.subject,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const attempt = (this.attempts.get(file) ?? 0) + 1;
      this.attempts.set(file, attempt);
      if (attempt <= RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt - 1]!;
        this.logger.warn("email send failed — will retry", {
          file: path.basename(file),
          attempt,
          next_retry_ms: delay,
          error: errMsg,
        });
        setTimeout(() => {
          if (!this.running) return;
          void this.handleEmail(file);
        }, delay);
      } else {
        this.logger.error("email send failed — giving up", {
          file: path.basename(file),
          attempts: attempt,
          error: errMsg,
        });
        this.attempts.delete(file);
        await this.markFailedFinal("email", file, errMsg, {
          to: msg.to,
          subject: msg.subject,
        });
      }
    }
  }

  private async handleTelegram(file: string): Promise<void> {
    let raw: string;
    let msg: OutgoingTelegram;
    try {
      raw = await fs.readFile(file, "utf8");
      msg = JSON.parse(raw) as OutgoingTelegram;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error("telegram parse failed", { file, error: errMsg });
      await this.markFailedFinal("telegram", file, errMsg, {});
      return;
    }

    try {
      // Resolve chat_id: use what's in the JSON, else fall back to the
      // configured default in providers.md so Sarah can post without
      // remembering chat IDs.
      let chatId: number | string | undefined = msg.chat_id;
      if (!chatId) {
        const { data: providers } = loadProviderSettings(this.gp);
        chatId = providers.telegram_default_chat_id;
      }
      if (!chatId) throw new Error("no chat_id in message and no telegram_default_chat_id configured");
      await this.telegram.sendMessage(chatId, msg.text || "", msg.files || []);
      this.attempts.delete(file);
      await this.moveToSent(file, this.gp.telegramSent);
      this.logger.info("telegram sent", { file: path.basename(file), chat_id: chatId });
      const preview = (msg.text || "").slice(0, 80);
      appendLedger(this.gp, {
        action: "telegram_sent",
        description: `Telegram to ${chatId}: ${preview}${(msg.text || "").length > 80 ? "…" : ""}`,
        ref: path.basename(file),
        details: { chat_id: chatId, text_preview: preview, file: path.basename(file) },
      });
      await enqueueWake(this.gp, {
        source: "telegram_sent",
        channel: "telegram",
        file: path.basename(file),
        chat_id: chatId,
        text_preview: preview,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const attempt = (this.attempts.get(file) ?? 0) + 1;
      this.attempts.set(file, attempt);
      if (attempt <= RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt - 1]!;
        this.logger.warn("telegram send failed — will retry", {
          file: path.basename(file),
          attempt,
          next_retry_ms: delay,
          error: errMsg,
        });
        setTimeout(() => {
          if (!this.running) return;
          void this.handleTelegram(file);
        }, delay);
      } else {
        this.logger.error("telegram send failed — giving up", {
          file: path.basename(file),
          attempts: attempt,
          error: errMsg,
        });
        this.attempts.delete(file);
        await this.markFailedFinal("telegram", file, errMsg, {
          chat_id: msg.chat_id,
          text: msg.text,
        });
      }
    }
  }

  /**
   * Move the outgoing JSON into failed/, write an error sidecar, and wake
   * Sarah with a `send_failed` event so she can tell the user. This is the
   * "loud" path — after this, the message is no longer considered "sent"
   * by anyone.
   */
  private async markFailedFinal(
    channel: "email" | "telegram",
    file: string,
    error: string,
    payloadSummary: Record<string, unknown>,
  ): Promise<void> {
    const failedDir =
      channel === "email" ? this.gp.emailFailed : this.gp.telegramFailed;
    const base = path.basename(file);
    const failedPath = path.join(failedDir, base);
    try {
      await fs.mkdir(failedDir, { recursive: true });
      // Try to move the JSON. If the source is gone (race with user
      // intervention), just write an error sidecar describing the failure.
      try {
        await fs.rename(file, failedPath);
      } catch {
        // Source file gone — write a stub next to where it would have been.
      }
      const sidecar = failedPath.replace(/\.json$/, ".error.txt");
      await fs.writeFile(
        sidecar,
        `${new Date().toISOString()}\n${error}\n\n${JSON.stringify(payloadSummary, null, 2)}\n`,
      );
    } catch (err) {
      this.logger.error("failed to record permanent failure", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const subj = (payloadSummary.subject as string) || (payloadSummary.text as string) || "";
    const to = (payloadSummary.to as string) || (payloadSummary.chat_id as string) || "";
    appendLedger(this.gp, {
      action: `${channel}_failed`,
      description: `FAILED ${channel} to ${to}: ${subj || "(no subject)"} — ${error}`,
      ref: path.basename(file),
      details: { channel, error, ...payloadSummary },
    });
    try {
      await enqueueWake(this.gp, {
        source: "send_failed",
        channel,
        file: path.basename(file),
        error,
        ...payloadSummary,
      });
    } catch (err) {
      this.logger.error("failed to enqueue send_failed wake", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Move an email to blocked/, write a reason sidecar, record in the ledger,
   * and wake Sarah so she knows.
   */
  private async markBlocked(file: string, reason: string, matchedEntry?: string): Promise<void> {
    const base = path.basename(file);
    const blockedPath = path.join(this.gp.emailBlocked, base);
    try {
      await fs.mkdir(this.gp.emailBlocked, { recursive: true });
      try {
        await fs.rename(file, blockedPath);
      } catch {
        // source gone
      }
      const sidecar = blockedPath.replace(/\.json$/, ".reason.txt");
      const lines = [
        new Date().toISOString(),
        `Blocked: ${reason}`,
      ];
      if (matchedEntry) lines.push(`Matched: ${matchedEntry}`);
      await fs.writeFile(sidecar, lines.join("\n") + "\n");
    } catch (err) {
      this.logger.error("failed to move email to blocked", {
        file: base,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Read the email JSON to get subject/to for the ledger and wake event.
    let summary: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(blockedPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      summary = { to: parsed.to, subject: parsed.subject };
    } catch { /* best effort */ }

    const toStr = String(summary.to || "unknown");
    const subjStr = String(summary.subject || "(no subject)");
    appendLedger(this.gp, {
      action: "email_blocked",
      description: `BLOCKED duplicate email to ${toStr}: ${subjStr} — ${reason}`,
      ref: base,
      details: { reason, matchedEntry, ...summary },
    });

    try {
      await enqueueWake(this.gp, {
        source: "email_blocked",
        file: base,
        reason,
        ...summary,
      });
    } catch (err) {
      this.logger.error("failed to enqueue email_blocked wake", {
        file: base,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async sendEmail(msg: OutgoingEmail): Promise<void> {
    const { data: providers } = loadProviderSettings(this.gp);
    if (!providers.email_smtp_host) throw new Error("SMTP not configured");

    const transporter = nodemailer.createTransport({
      host: providers.email_smtp_host,
      port: providers.email_smtp_port || 587,
      secure: (providers.email_smtp_port || 587) === 465,
      auth: providers.email_smtp_user
        ? {
            user: providers.email_smtp_user,
            pass: providers.email_smtp_password,
          }
        : undefined,
    });

    const attachments = (msg.attachments || []).map((p) => {
      const abs = path.isAbsolute(p) ? p : path.join(this.gp.dovaiHome, p);
      return { filename: path.basename(abs), path: abs };
    });

    await transporter.sendMail({
      from: providers.email_smtp_from || providers.email_smtp_user,
      to: msg.to,
      cc: msg.cc,
      bcc: msg.bcc,
      subject: msg.subject || "(no subject)",
      text: msg.body_text,
      html: msg.body_html,
      attachments,
    });
  }

  private async moveToSent(file: string, sentDir: string): Promise<void> {
    const base = path.basename(file);
    const target = path.join(sentDir, base);
    await fs.rename(file, target);
  }
}
