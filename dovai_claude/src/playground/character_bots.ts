/**
 * Character Telegram bot manager.
 *
 * Each Character (in the Chat playground) may optionally have its own
 * Telegram bot token. When set, we run a long-polling bot for that
 * character — a separate bot per character, with its own voice, its own
 * memory namespace, and its own isolated conversation history.
 *
 * Flow on an incoming Telegram message:
 *
 *   1. The character is identified by which bot received the message.
 *   2. We find (or create) a Dovai chat bound to the tuple
 *      (character_slug, telegram_chat_id). One persistent chat per
 *      Telegram conversation, so follow-ups resume history instead of
 *      starting fresh.
 *   3. Save the user message.
 *   4. Compose the prompt: character.system_prompt + per-character
 *      memory block + history.
 *   5. Call LM Studio (non-streaming — Telegram delivers one complete
 *      message, not tokens as they arrive).
 *   6. Send the reply back to the Telegram chat (splitting into chunks
 *      if the response exceeds Telegram's 4096-char limit).
 *   7. Fire memory extraction async in the character's namespace.
 *
 * Isolation promise: all of this lives in playground/. Sarah never
 * sees any of it. Memories from one character never leak to another.
 *
 * Auth: the presence of a `telegram_bot_token` on a character is the
 * gate — if set, the bot runs and accepts any DM. The assumption is
 * that the bot's @username is private information; if the user shares
 * it publicly that's on them. No explicit allowlist in v1.
 */
import TelegramBot from "node-telegram-bot-api";
import {
  listCharacters,
  loadCharacter,
  findChatByTelegramBinding,
  createChat,
  appendMessage,
  readMessages,
  newChatId,
  updateChatMeta,
  type Character,
  type ChatMessage,
} from "../lib/playground.ts";
import { loadProviderSettings, loadWorkspaceSettings } from "../lib/config.ts";
import {
  composeMemoryBlock,
  runExtractionAndPersist,
  toNamespace,
} from "../lib/memories.ts";
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";
import type { CharacterBotManager } from "../web/types.ts";

/** Telegram's hard limit per sendMessage. */
const TELEGRAM_MAX_CHUNK = 4000;

interface ActiveBot {
  slug: string;
  token: string;
  bot: TelegramBot;
}

export class CharacterBotManagerImpl implements CharacterBotManager {
  private bots = new Map<string, ActiveBot>();
  private logger: Logger;

  constructor(
    private readonly gp: GlobalPaths,
    logger: Logger,
  ) {
    this.logger = logger.child("char-bots");
  }

  async start(): Promise<void> {
    await this.reload();
  }

  async stop(): Promise<void> {
    for (const { bot, slug } of this.bots.values()) {
      try {
        await bot.stopPolling();
      } catch (err) {
        this.logger.warn("error stopping bot", {
          slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.bots.clear();
  }

  /**
   * Diff the desired set of bots against current. Start new ones, stop
   * removed ones, restart when a token changes.
   */
  async reload(): Promise<void> {
    const characters = listCharacters(this.gp);
    const desired = new Map<string, string>(); // slug → token
    for (const ch of characters) {
      if (ch.telegram_bot_token && ch.telegram_bot_token.trim()) {
        desired.set(ch.slug, ch.telegram_bot_token.trim());
      }
    }

    // Stop bots no longer desired or whose token changed
    for (const [slug, active] of [...this.bots.entries()]) {
      const wanted = desired.get(slug);
      if (!wanted || wanted !== active.token) {
        try {
          await active.bot.stopPolling();
        } catch { /* ignore */ }
        this.bots.delete(slug);
        this.logger.info("bot stopped", { slug });
      }
    }

    // Start desired bots that aren't already running
    for (const [slug, token] of desired.entries()) {
      if (this.bots.has(slug)) continue;
      try {
        const bot = new TelegramBot(token, { polling: true });
        bot.on("message", (msg) => {
          void this.handleMessage(slug, msg).catch((err) => {
            this.logger.error("handler threw", {
              slug,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        });
        bot.on("polling_error", (err) => {
          this.logger.warn("polling error", {
            slug,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        this.bots.set(slug, { slug, token, bot });
        this.logger.info("bot started", { slug });
      } catch (err) {
        this.logger.error("bot start failed", {
          slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Handle a single incoming Telegram message for the given character.
   * Runs the full chat loop: resolve-or-create chat, save user message,
   * call LM Studio, reply, fire extraction.
   */
  private async handleMessage(characterSlug: string, msg: TelegramBot.Message): Promise<void> {
    const text = msg.text?.trim();
    if (!text) return; // ignore non-text messages for v1 (no image handling yet)

    const character = loadCharacter(this.gp, characterSlug);
    if (!character) {
      this.logger.warn("message for unknown character", { slug: characterSlug });
      return;
    }

    const active = this.bots.get(characterSlug);
    if (!active) return;

    const telegramChatId = msg.chat.id;

    // 1. Resolve or create the chat for this (character, telegram_chat_id)
    let chatMeta = findChatByTelegramBinding(this.gp, characterSlug, telegramChatId);
    if (!chatMeta) {
      const title = text.slice(0, 60).replace(/\s+/g, " ").trim() || "Telegram chat";
      const id = newChatId(title);
      chatMeta = createChat(this.gp, {
        id,
        title,
        character: characterSlug,
        system_prompt: character.system_prompt,
        model: character.model,
        temperature: character.temperature,
        max_tokens: character.max_tokens,
        telegram_chat_id: telegramChatId,
      });
      this.logger.info("new telegram-bound chat", { slug: characterSlug, chat_id: id, tg_chat: telegramChatId });
    }

    // 2. Save user message
    const userMsg: ChatMessage = { role: "user", content: text };
    appendMessage(this.gp, chatMeta.id, userMsg);

    // 3. Compose prompt with character memory
    const { data: pr } = loadProviderSettings(this.gp);
    const { data: ws } = loadWorkspaceSettings(this.gp);
    const namespace = toNamespace(character.slug);
    const memoryBlock = composeMemoryBlock(this.gp, namespace, ws.user_name);
    const combinedSystem = [character.system_prompt, memoryBlock]
      .filter((s) => s && s.trim())
      .join("\n\n");

    // 4. Call LM Studio non-streaming
    const history = readMessages(this.gp, chatMeta.id);
    const historyForModel = history.map((m) => ({
      role: m.role,
      content: typeof m.content === "string"
        ? m.content
        : (m.content.find((p) => p.type === "text") as { text?: string } | undefined)?.text || "",
    }));
    const messagesForModel: Array<{ role: string; content: string }> = [];
    if (combinedSystem) messagesForModel.push({ role: "system", content: combinedSystem });
    messagesForModel.push(...historyForModel);

    let reply = "";
    try {
      const url = pr.lm_studio_url.replace(/\/+$/, "") + "/v1/chat/completions";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: chatMeta.model,
          messages: messagesForModel,
          temperature: chatMeta.temperature,
          max_tokens: chatMeta.max_tokens,
          stream: false,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        await active.bot.sendMessage(
          telegramChatId,
          `(${character.name} is having trouble — LM Studio returned ${res.status}.${errText ? " " + errText.slice(0, 200) : ""})`,
        );
        return;
      }
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      reply = json.choices?.[0]?.message?.content?.trim() ?? "";
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn("LM Studio call failed", { slug: characterSlug, error: errMsg });
      await active.bot.sendMessage(telegramChatId, `(couldn't reach LM Studio: ${errMsg})`);
      return;
    }

    if (!reply) {
      await active.bot.sendMessage(telegramChatId, "(empty response — try again?)");
      return;
    }

    // 5. Persist assistant message
    appendMessage(this.gp, chatMeta.id, { role: "assistant", content: reply });

    // 6. Send to Telegram (chunk if needed)
    for (const chunk of chunkForTelegram(reply)) {
      try {
        await active.bot.sendMessage(telegramChatId, chunk);
      } catch (err) {
        this.logger.warn("telegram send failed", {
          slug: characterSlug,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }

    // Bump the chat's updated_at so it resorts in the UI list
    updateChatMeta(this.gp, chatMeta.id, {});

    // 7. Fire extraction async (same pattern as the web chat endpoint)
    void (async () => {
      try {
        const latest = readMessages(this.gp, chatMeta!.id);
        const flat = latest.map((m) => ({
          role: m.role,
          content: typeof m.content === "string"
            ? m.content
            : (m.content.find((p) => p.type === "text") as { text?: string } | undefined)?.text || "",
        }));
        const added = await runExtractionAndPersist({
          gp: this.gp,
          characterSlug: namespace,
          lmStudioUrl: pr.lm_studio_url,
          model: chatMeta!.model,
          userName: ws.user_name,
          chatId: chatMeta!.id,
          messages: flat,
          logger: this.logger,
        });
        if (added.observations + added.inferences + added.instructions > 0) {
          this.logger.info("telegram extraction", {
            slug: characterSlug,
            added,
          });
        }
      } catch (err) {
        this.logger.warn("telegram extraction failed (non-fatal)", {
          slug: characterSlug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }
}

/**
 * Split long replies into Telegram-safe chunks. Try to break at paragraph
 * boundaries first, then sentences, then just cut at the length limit.
 */
function chunkForTelegram(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_CHUNK) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MAX_CHUNK) {
    let cut = remaining.lastIndexOf("\n\n", TELEGRAM_MAX_CHUNK);
    if (cut < TELEGRAM_MAX_CHUNK / 2) cut = remaining.lastIndexOf("\n", TELEGRAM_MAX_CHUNK);
    if (cut < TELEGRAM_MAX_CHUNK / 2) cut = remaining.lastIndexOf(". ", TELEGRAM_MAX_CHUNK);
    if (cut < TELEGRAM_MAX_CHUNK / 2) cut = TELEGRAM_MAX_CHUNK;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Also re-export the unused `Character` type to silence linter if needed
export type { Character };
