/**
 * Telegram bot.
 *
 * Uses long-polling (simpler than webhooks; no need to expose a public URL).
 * Incoming messages are written to dovai_files/telegram/inbox/ and a wake
 * event is enqueued directly so the AI CLI processes them promptly.
 *
 * Format on disk:
 *   <ts>_<chatid>.json  — metadata, text, attachments[]
 *   <ts>_<chatid>/      — folder with downloaded media files
 *
 * Permissions: telegram_allowed_chat_ids in providers settings is a whitelist.
 * If empty → accept from anyone (bad for production but fine for v1 single-user).
 */
import fs from "node:fs/promises";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import { loadProviderSettings } from "../lib/config.ts";
import { transcribe } from "../lib/transcribe.ts";
import { enqueueWake } from "../wake/queue.ts";
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";

function tsPrefix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export class TelegramService {
  private bot: TelegramBot | null = null;
  private logger: Logger;
  private running = false;

  constructor(
    private readonly gp: GlobalPaths,
    logger: Logger,
  ) {
    this.logger = logger.child("telegram");
  }

  async start(): Promise<void> {
    if (this.running) return;
    const { data: providers } = loadProviderSettings(this.gp);
    if (!providers.telegram_bot_token) {
      this.logger.info("telegram bot disabled (no token)");
      return;
    }

    this.running = true;
    const allowed = new Set(providers.telegram_allowed_chat_ids.map(String));

    try {
      this.bot = new TelegramBot(providers.telegram_bot_token, { polling: true });
    } catch (err) {
      this.logger.error("failed to start telegram bot", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.running = false;
      return;
    }

    this.bot.on("message", async (msg) => {
      try {
        if (allowed.size > 0 && !allowed.has(String(msg.chat.id))) {
          this.logger.warn("ignoring message from non-allowed chat", { chat_id: msg.chat.id });
          return;
        }
        const { transcription } = await this.persistMessage(msg);
        const previewText = msg.text || msg.caption || transcription || "";
        await enqueueWake(this.gp, {
          source: "telegram",
          chat_id: msg.chat.id,
          from_name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" "),
          text_preview: previewText.slice(0, 200),
          has_voice: !!msg.voice,
        });
      } catch (err) {
        this.logger.error("error handling telegram message", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    this.bot.on("polling_error", (err) => {
      this.logger.warn("telegram polling error", { error: err.message });
    });

    this.logger.info("telegram bot started");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.bot) {
      try {
        await this.bot.stopPolling();
      } catch {
        // ignore
      }
      this.bot = null;
    }
  }

  private async persistMessage(msg: TelegramBot.Message): Promise<{ transcription: string }> {
    const ts = tsPrefix();
    const chatId = String(msg.chat.id);
    const folderName = `${ts}_${chatId}`;
    const folder = path.join(this.gp.dovaiFiles, "telegram", "inbox", folderName);
    await fs.mkdir(folder, { recursive: true });

    // Download any attached media
    const attachments: Array<{ kind: string; filename: string; path: string }> = [];
    if (msg.photo && msg.photo.length > 0 && this.bot) {
      const best = msg.photo[msg.photo.length - 1];
      if (best) {
        try {
          const filePath = await this.bot.downloadFile(best.file_id, folder);
          attachments.push({
            kind: "photo",
            filename: path.basename(filePath),
            path: path.relative(this.gp.dovaiHome, filePath).split(path.sep).join("/"),
          });
        } catch (err) {
          this.logger.warn("photo download failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    if (msg.document && this.bot) {
      try {
        const filePath = await this.bot.downloadFile(msg.document.file_id, folder);
        attachments.push({
          kind: "document",
          filename: msg.document.file_name || path.basename(filePath),
          path: path.relative(this.gp.dovaiHome, filePath).split(path.sep).join("/"),
        });
      } catch (err) {
        this.logger.warn("document download failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    let voiceTranscription = "";
    if (msg.voice && this.bot) {
      try {
        const filePath = await this.bot.downloadFile(msg.voice.file_id, folder);
        attachments.push({
          kind: "voice",
          filename: path.basename(filePath),
          path: path.relative(this.gp.dovaiHome, filePath).split(path.sep).join("/"),
        });

        // Transcribe the voice message so Sarah can read it immediately
        const { data: providers } = loadProviderSettings(this.gp);
        const result = await transcribe(filePath, providers.whisper_model_path, this.logger);
        if (result?.text) {
          voiceTranscription = result.text;
          this.logger.info("voice message transcribed", {
            chat_id: msg.chat.id,
            chars: result.text.length,
            ms: result.durationMs,
          });
        }
      } catch (err) {
        this.logger.warn("voice download/transcription failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Use transcribed voice text as the message text when no caption/text exists
    const messageText = msg.text || msg.caption || "";

    const meta = {
      received_at: new Date().toISOString(),
      chat_id: msg.chat.id,
      from_username: msg.from?.username || "",
      from_name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" "),
      text: messageText,
      transcription: voiceTranscription || undefined,
      attachments,
    };

    await fs.writeFile(path.join(folder, "meta.json"), JSON.stringify(meta, null, 2));

    this.logger.info("telegram message received", {
      chat_id: msg.chat.id,
      text_preview: meta.text.slice(0, 100),
      has_transcription: !!voiceTranscription,
    });

    return { transcription: voiceTranscription };
  }

  /**
   * Send a telegram message. Called by the outbox dispatcher.
   */
  async sendMessage(chatId: number | string, text: string, files: string[] = []): Promise<void> {
    if (!this.bot) throw new Error("telegram bot not running");
    if (files.length === 0) {
      await this.bot.sendMessage(chatId, text);
      return;
    }
    // Send text first, then each file
    if (text) {
      await this.bot.sendMessage(chatId, text);
    }
    for (const f of files) {
      try {
        const abs = path.isAbsolute(f) ? f : path.join(this.gp.dataRoot, f);
        const stat = await fs.stat(abs);
        if (!stat.isFile()) continue;
        await this.bot.sendDocument(chatId, abs);
      } catch (err) {
        this.logger.warn("failed sending telegram attachment", {
          file: f,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
