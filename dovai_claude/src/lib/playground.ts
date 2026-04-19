/**
 * Playground storage — user's private chat space.
 *
 * Entirely separate from Sarah's world. Lives under `<playgroundRoot>/`,
 * which is not scanned by the filing clerk, not ingested into the knowledge
 * graph, and explicitly off-limits to Sarah per her operator manual.
 *
 * Core concepts:
 *
 *   **Character** (formerly "preset") — an isolated AI agent with its own
 *   voice (system prompt), model, optional Telegram bot, and its own
 *   memory namespace. Memories learned in chats with one character never
 *   leak into another character's profile.
 *
 *   **Chat** — a conversation. Each chat is bound to at most one character
 *   (snapshot at creation time). Chats without a character route memory
 *   to a shared "_shared" namespace.
 *
 * Layout:
 *
 *   playground/
 *     characters/
 *       <slug>.md                — character definition (md + frontmatter)
 *     chats/
 *       <id>/
 *         meta.json              — title, timestamps, character slug, model
 *         messages.jsonl         — one JSON per message
 *         images/<filename>      — uploaded images
 *     learned/
 *       <character_slug>/        — per-character memory namespace
 *         memories.jsonl
 *       _shared/                 — memory for no-character chats
 *         memories.jsonl
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { GlobalPaths } from "./global_paths.ts";

// ---------------------------------------------------------------------------
// One-time migration from v1 layout (preset-based) to v2 (character-based)
// ---------------------------------------------------------------------------

/**
 * Run once on server startup. Renames v1 folders/files in place if v2
 * doesn't already exist. Idempotent — safe to call repeatedly.
 */
export function migrateV1ToV2(gp: GlobalPaths): void {
  const playground = gp.playground;
  // 1) presets/ → characters/
  // `characters/` may already exist as an empty dir from `initGlobalDovai`
  // scaffolding, so we can't just "rename if target missing". Instead:
  //   - if characters/ is empty → move all files in from presets/ and drop presets/
  //   - if characters/ already has contents → leave presets/ alone
  //     (user has started using the new location; don't clobber)
  const oldPresets = path.join(playground, "presets");
  const newCharacters = gp.playgroundCharacters;
  if (fs.existsSync(oldPresets)) {
    const newIsEmpty =
      !fs.existsSync(newCharacters) ||
      fs.readdirSync(newCharacters).filter((f) => !f.startsWith(".")).length === 0;
    if (newIsEmpty) {
      fs.mkdirSync(newCharacters, { recursive: true });
      for (const entry of fs.readdirSync(oldPresets)) {
        try {
          fs.renameSync(path.join(oldPresets, entry), path.join(newCharacters, entry));
        } catch {
          // fall through
        }
      }
      // Remove the now-empty old dir
      try { fs.rmdirSync(oldPresets); } catch { /* ignore */ }
    }
  }
  // 2) learned/memories.jsonl → learned/_shared/memories.jsonl
  const learnedRoot = path.join(playground, "learned");
  const oldFlatFile = path.join(learnedRoot, "memories.jsonl");
  const sharedDir = path.join(learnedRoot, "_shared");
  const sharedFile = path.join(sharedDir, "memories.jsonl");
  if (fs.existsSync(oldFlatFile) && !fs.existsSync(sharedFile)) {
    try {
      fs.mkdirSync(sharedDir, { recursive: true });
      fs.renameSync(oldFlatFile, sharedFile);
    } catch {
      // fall through
    }
  }
}

// ---------------------------------------------------------------------------
// Characters (formerly "Presets")
// ---------------------------------------------------------------------------

export interface CharacterFrontmatter {
  name: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  /**
   * Optional Telegram Bot token. If set, a bot is launched for this
   * character and will accept messages from any DM (the bot's name is
   * your gate; if you want tighter auth, keep the name private).
   */
  telegram_bot_token?: string;
}

export interface Character extends CharacterFrontmatter {
  slug: string;
  /** The markdown body is the system prompt. */
  system_prompt: string;
}

function characterPath(gp: GlobalPaths, slug: string): string {
  return path.join(gp.playgroundCharacters, `${slug}.md`);
}

export function listCharacters(gp: GlobalPaths): Character[] {
  try {
    const files = fs
      .readdirSync(gp.playgroundCharacters)
      .filter((f) => f.endsWith(".md"));
    return files
      .map((f) => loadCharacter(gp, f.replace(/\.md$/, "")))
      .filter((c): c is Character => c !== null);
  } catch {
    return [];
  }
}

export function loadCharacter(gp: GlobalPaths, slug: string): Character | null {
  try {
    const raw = fs.readFileSync(characterPath(gp, slug), "utf8");
    const parsed = matter(raw);
    const fm = parsed.data as Partial<CharacterFrontmatter>;
    if (!fm.name || !fm.model) return null;
    return {
      slug,
      name: fm.name,
      model: fm.model,
      temperature: fm.temperature,
      max_tokens: fm.max_tokens,
      telegram_bot_token: fm.telegram_bot_token,
      system_prompt: parsed.content.trim(),
    };
  } catch {
    return null;
  }
}

export function saveCharacter(
  gp: GlobalPaths,
  slug: string,
  fm: CharacterFrontmatter,
  systemPrompt: string,
): void {
  fs.mkdirSync(gp.playgroundCharacters, { recursive: true });
  // Strip undefined values — js-yaml can't serialize them.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v !== undefined && v !== "") cleaned[k] = v;
  }
  const out = matter.stringify(systemPrompt, cleaned);
  fs.writeFileSync(characterPath(gp, slug), out);
}

export function deleteCharacter(gp: GlobalPaths, slug: string): boolean {
  try {
    fs.unlinkSync(characterPath(gp, slug));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

export interface ChatContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  /** Either a plain string (text-only) or an array of parts (multimodal). */
  content: string | ChatContentPart[];
  /** ISO timestamp — appended by the server, never trust from client. */
  ts?: string;
  /** For user messages that uploaded images: filenames saved under images/. */
  attached_images?: string[];
}

export interface ChatMeta {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /**
   * Slug of the character used to start this chat (frozen — edits to the
   * character don't retroactively change this chat's behavior). null for
   * "no character" chats, which route memory to `_shared`.
   */
  character: string | null;
  /** Snapshot of the system prompt at chat creation, independent of edits. */
  system_prompt: string;
  /** Model id used (from LM Studio's /v1/models). */
  model: string;
  temperature?: number;
  max_tokens?: number;
  /**
   * If this chat was opened from Telegram: the Telegram chat_id. Lets us
   * reconnect incoming Telegram messages to the right Dovai chat.
   */
  telegram_chat_id?: number | string;
}

function chatDir(gp: GlobalPaths, id: string): string {
  return path.join(gp.playgroundChats, id);
}

export function slugifyForId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50) || "chat";
}

export function newChatId(title: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "T").split(".")[0];
  return `${ts}_${slugifyForId(title || "new_chat")}`;
}

export function listChats(gp: GlobalPaths): ChatMeta[] {
  try {
    const entries = fs.readdirSync(gp.playgroundChats, { withFileTypes: true });
    const out: ChatMeta[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const meta = loadChatMeta(gp, e.name);
      if (meta) out.push(meta);
    }
    // Newest first
    out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return out;
  } catch {
    return [];
  }
}

export function loadChatMeta(gp: GlobalPaths, id: string): ChatMeta | null {
  try {
    const raw = fs.readFileSync(path.join(chatDir(gp, id), "meta.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.id !== "string" || typeof parsed.title !== "string") return null;
    // Back-compat: v1 used `preset` instead of `character`. Accept either.
    if (!("character" in parsed) && "preset" in parsed) {
      parsed.character = parsed.preset;
      delete parsed.preset;
    }
    return parsed as ChatMeta;
  } catch {
    return null;
  }
}

/**
 * Find an existing chat by (character slug, Telegram chat_id). Used to
 * re-use a single persistent chat per Telegram conversation instead of
 * creating a new one on every incoming message.
 */
export function findChatByTelegramBinding(
  gp: GlobalPaths,
  characterSlug: string | null,
  telegramChatId: number | string,
): ChatMeta | null {
  const all = listChats(gp);
  const tgKey = String(telegramChatId);
  for (const c of all) {
    if (String(c.telegram_chat_id ?? "") !== tgKey) continue;
    if ((c.character ?? null) !== (characterSlug ?? null)) continue;
    return c;
  }
  return null;
}

export function createChat(gp: GlobalPaths, meta: Omit<ChatMeta, "created_at" | "updated_at">): ChatMeta {
  const now = new Date().toISOString();
  const full: ChatMeta = { ...meta, created_at: now, updated_at: now };
  const dir = chatDir(gp, full.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(full, null, 2));
  fs.writeFileSync(path.join(dir, "messages.jsonl"), ""); // empty
  return full;
}

export function updateChatMeta(gp: GlobalPaths, id: string, patch: Partial<ChatMeta>): ChatMeta | null {
  const meta = loadChatMeta(gp, id);
  if (!meta) return null;
  const updated: ChatMeta = { ...meta, ...patch, updated_at: new Date().toISOString() };
  fs.writeFileSync(path.join(chatDir(gp, id), "meta.json"), JSON.stringify(updated, null, 2));
  return updated;
}

export function readMessages(gp: GlobalPaths, id: string): ChatMessage[] {
  try {
    const raw = fs.readFileSync(path.join(chatDir(gp, id), "messages.jsonl"), "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ChatMessage);
  } catch {
    return [];
  }
}

export function appendMessage(gp: GlobalPaths, id: string, msg: ChatMessage): void {
  const withTs: ChatMessage = { ...msg, ts: msg.ts ?? new Date().toISOString() };
  fs.appendFileSync(
    path.join(chatDir(gp, id), "messages.jsonl"),
    JSON.stringify(withTs) + "\n",
  );
}

export async function deleteChat(gp: GlobalPaths, id: string): Promise<boolean> {
  try {
    await fsp.rm(chatDir(gp, id), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Image storage
// ---------------------------------------------------------------------------

/**
 * Decode a data:image/... URL and write it to the chat's images folder.
 * Returns the filename (relative to images/) for inclusion in the message.
 */
export function saveImageDataUrl(gp: GlobalPaths, chatId: string, dataUrl: string, hint?: string): string {
  const m = dataUrl.match(/^data:(image\/([a-zA-Z0-9+.-]+));base64,(.+)$/);
  if (!m) throw new Error("not a base64 data URL for an image");
  const mime = m[1]!;
  const ext = (m[2]! || "png").replace("+xml", "").slice(0, 8);
  const base = hint ? slugifyForId(hint) : "img";
  const ts = Date.now();
  const filename = `${ts}_${base}.${ext}`;
  const full = path.join(chatDir(gp, chatId), "images", filename);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.from(m[3]!, "base64"));
  void mime; // reserved in case we want to store it later
  return filename;
}

export function readImageAsDataUrl(gp: GlobalPaths, chatId: string, filename: string): string | null {
  try {
    const full = path.join(chatDir(gp, chatId), "images", filename);
    const buf = fs.readFileSync(full);
    const ext = path.extname(filename).slice(1).toLowerCase() || "png";
    const mime = ext === "jpg" ? "jpeg" : ext;
    return `data:image/${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}
