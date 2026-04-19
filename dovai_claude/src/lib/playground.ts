/**
 * Playground storage — user's private chat space.
 *
 * Entirely separate from Sarah's world. Lives under `<playgroundRoot>/`,
 * which is not scanned by the filing clerk, not ingested into the knowledge
 * graph, and explicitly off-limits to Sarah per her operator manual.
 *
 * Core concepts:
 *
 *   **Character** — an isolated AI agent with its own voice (system
 *   prompt), model, optional Telegram bot, and its own chats + memory.
 *   Each character gets its own top-level folder on disk.
 *
 *   **Chat** — a conversation. Bound to at most one character at creation.
 *   Lives inside that character's folder. Chats with no character go to
 *   the `_shared/` bucket.
 *
 * Layout (v3 "nested per character"):
 *
 *   playground/
 *     _shared/                       — no-character bucket
 *       chats/<id>/                  — meta.json, messages.jsonl, images/
 *       learned/memories.jsonl       — shared memory
 *     <character_slug>/              — one folder per character
 *       character.md                 — definition (markdown + frontmatter)
 *       chats/<id>/                  — chats bound to this character
 *       learned/memories.jsonl       — character's own memory namespace
 *
 * Deleting a character = deleting its folder. Copying/backing up a
 * character = copying its folder. One mental model, matching the
 * architecture.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { GlobalPaths } from "./global_paths.ts";

/** Reserved slug for no-character chats + memory. Also a real folder on disk. */
export const SHARED_BUCKET = "_shared";

// ---------------------------------------------------------------------------
// Path helpers — all routes to disk go through these
// ---------------------------------------------------------------------------

function normaliseSlug(characterSlug: string | null | undefined): string {
  if (!characterSlug || !String(characterSlug).trim()) return SHARED_BUCKET;
  return String(characterSlug).trim();
}

/** Root folder for a character (or `_shared`). */
export function characterRoot(gp: GlobalPaths, characterSlug: string | null | undefined): string {
  return path.join(gp.playground, normaliseSlug(characterSlug));
}

/** Location of a character's definition file. Not valid for `_shared`. */
export function characterDefFile(gp: GlobalPaths, slug: string): string {
  return path.join(gp.playground, slug, "character.md");
}

/** Folder holding a character's (or _shared's) chat directories. */
export function chatsRoot(gp: GlobalPaths, characterSlug: string | null | undefined): string {
  return path.join(characterRoot(gp, characterSlug), "chats");
}

/** Folder for a specific chat. */
export function chatDirFor(gp: GlobalPaths, characterSlug: string | null | undefined, chatId: string): string {
  return path.join(chatsRoot(gp, characterSlug), chatId);
}

// ---------------------------------------------------------------------------
// Migration from any earlier layout to the current nested-per-character one.
// Idempotent — safe to call on every server start.
// ---------------------------------------------------------------------------

/**
 * Reorganise the playground into the v3 nested layout. Handles three prior
 * layouts in one pass:
 *
 *   v1 (oldest): presets/<slug>.md, chats/<id>/, learned/memories.jsonl
 *   v2:          characters/<slug>.md, chats/<id>/, learned/<slug>/memories.jsonl
 *   v3 (now):    <slug>/{character.md, chats/, learned/memories.jsonl}
 *
 * Moves instead of copies (fs.renameSync where possible). Never deletes user
 * data; only moves it around and removes genuinely empty source dirs.
 */
export function migrateToNestedLayout(gp: GlobalPaths): void {
  const pg = gp.playground;
  if (!fs.existsSync(pg)) return;

  /**
   * Safely remove a legacy directory after its contents have been moved.
   * macOS drops `.DS_Store` files everywhere, so plain rmdir fails even
   * when the folder has no real content. If the directory contains only
   * dotfiles, nuke recursively. If it has real contents (something we
   * didn't migrate), leave it alone — the user's data is never deleted.
   */
  const removeIfOnlyDotfiles = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    const nonDot = entries.filter((f) => !f.startsWith("."));
    if (nonDot.length > 0) return; // real content present — leave it
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  // 1) Character definition files: presets/*.md OR characters/*.md → <slug>/character.md
  for (const oldFolder of ["presets", "characters"]) {
    const src = path.join(pg, oldFolder);
    if (!fs.existsSync(src)) continue;
    let entries: string[] = [];
    try { entries = fs.readdirSync(src); } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      const slug = file.replace(/\.md$/, "");
      if (slug === SHARED_BUCKET) continue; // paranoid — would clobber
      const newFile = characterDefFile(gp, slug);
      if (fs.existsSync(newFile)) continue; // already migrated
      try {
        fs.mkdirSync(path.dirname(newFile), { recursive: true });
        fs.renameSync(path.join(src, file), newFile);
      } catch { /* skip */ }
    }
    removeIfOnlyDotfiles(src);
  }

  // 2) Chats: flat chats/<id>/ → <slug>/chats/<id>/ (or _shared/chats/<id>/)
  const oldChatsDir = path.join(pg, "chats");
  if (fs.existsSync(oldChatsDir)) {
    let chatEntries: fs.Dirent[] = [];
    try { chatEntries = fs.readdirSync(oldChatsDir, { withFileTypes: true }); } catch { chatEntries = []; }
    for (const e of chatEntries) {
      if (!e.isDirectory()) continue;
      const oldChatDir = path.join(oldChatsDir, e.name);
      // Decide the destination bucket from the chat's own meta.json
      let bucket = SHARED_BUCKET;
      try {
        const raw = fs.readFileSync(path.join(oldChatDir, "meta.json"), "utf8");
        const meta = JSON.parse(raw);
        // Accept both `character` and legacy `preset` field
        const slug = (meta.character ?? meta.preset ?? null) as string | null;
        if (slug && String(slug).trim() && slug !== SHARED_BUCKET) bucket = String(slug).trim();
      } catch { /* leave as shared */ }
      const newChatDir = path.join(pg, bucket, "chats", e.name);
      if (fs.existsSync(newChatDir)) continue;
      try {
        fs.mkdirSync(path.dirname(newChatDir), { recursive: true });
        fs.renameSync(oldChatDir, newChatDir);
      } catch { /* skip this chat */ }
    }
    removeIfOnlyDotfiles(oldChatsDir);
  }

  // 3) Memory files:
  //    a) learned/memories.jsonl (v1 flat) → _shared/learned/memories.jsonl
  //    b) learned/<slug>/memories.jsonl  → <slug>/learned/memories.jsonl
  const oldLearnedDir = path.join(pg, "learned");
  if (fs.existsSync(oldLearnedDir)) {
    // 3a) flat file first
    const flatFile = path.join(oldLearnedDir, "memories.jsonl");
    if (fs.existsSync(flatFile)) {
      const dest = path.join(pg, SHARED_BUCKET, "learned", "memories.jsonl");
      if (!fs.existsSync(dest)) {
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(flatFile, dest);
        } catch { /* skip */ }
      }
    }
    // 3b) subfolders (one per character/_shared)
    let slugEntries: fs.Dirent[] = [];
    try { slugEntries = fs.readdirSync(oldLearnedDir, { withFileTypes: true }); } catch { slugEntries = []; }
    for (const e of slugEntries) {
      if (!e.isDirectory()) continue;
      const slug = e.name; // may be `_shared` or an actual character slug
      const srcSlugDir = path.join(oldLearnedDir, slug);
      const destSlugDir = path.join(pg, slug, "learned");
      if (fs.existsSync(destSlugDir)) {
        // Destination exists — move individual files in rather than clobber
        let innerFiles: string[] = [];
        try { innerFiles = fs.readdirSync(srcSlugDir); } catch { innerFiles = []; }
        for (const f of innerFiles) {
          const from = path.join(srcSlugDir, f);
          const to = path.join(destSlugDir, f);
          if (fs.existsSync(to)) continue;
          try { fs.renameSync(from, to); } catch { /* skip */ }
        }
        removeIfOnlyDotfiles(srcSlugDir);
      } else {
        try {
          fs.mkdirSync(path.dirname(destSlugDir), { recursive: true });
          fs.renameSync(srcSlugDir, destSlugDir);
        } catch { /* skip */ }
      }
    }
    removeIfOnlyDotfiles(oldLearnedDir);
  }
}

/** Legacy alias so existing imports keep working during the transition. */
export const migrateV1ToV2 = migrateToNestedLayout;

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

/**
 * Scan the playground root for folders that are Characters. A folder is
 * a character iff it contains a `character.md` file with valid frontmatter.
 * The `_shared` bucket is never treated as a character even if it somehow
 * contained a stray `character.md`.
 */
export function listCharacters(gp: GlobalPaths): Character[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(gp.playground, { withFileTypes: true }); } catch { return []; }
  const out: Character[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === SHARED_BUCKET) continue;
    if (e.name.startsWith(".")) continue;
    const ch = loadCharacter(gp, e.name);
    if (ch) out.push(ch);
  }
  // Alphabetical — consistent UI ordering
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function loadCharacter(gp: GlobalPaths, slug: string): Character | null {
  if (slug === SHARED_BUCKET) return null;
  try {
    const raw = fs.readFileSync(characterDefFile(gp, slug), "utf8");
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

/**
 * Write a character's definition + ensure its `chats/` and `learned/`
 * subfolders exist. Creating the full folder layout on save keeps "new
 * character" atomic: one button creates the whole structure.
 */
export function saveCharacter(
  gp: GlobalPaths,
  slug: string,
  fm: CharacterFrontmatter,
  systemPrompt: string,
): void {
  if (slug === SHARED_BUCKET) {
    throw new Error(`"${SHARED_BUCKET}" is reserved and cannot be used as a character slug`);
  }
  const root = characterRoot(gp, slug);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, "chats"), { recursive: true });
  fs.mkdirSync(path.join(root, "learned"), { recursive: true });
  // Strip undefined / empty values — js-yaml can't serialize undefined.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v !== undefined && v !== "") cleaned[k] = v;
  }
  const out = matter.stringify(systemPrompt, cleaned);
  fs.writeFileSync(characterDefFile(gp, slug), out);
}

/**
 * Delete a character's entire folder (definition + chats + learned + images).
 * This is intentional — the UI warns the user, and the folder structure
 * makes "delete everything about this character" a single operation.
 */
export function deleteCharacter(gp: GlobalPaths, slug: string): boolean {
  if (slug === SHARED_BUCKET) return false;
  try {
    fs.rmSync(characterRoot(gp, slug), { recursive: true, force: true });
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

/**
 * Scan every known bucket (every character folder + `_shared/`) for their
 * `chats/` subfolder. Returns a flat list of chat directories: where each
 * chat physically lives on disk + its bucket slug.
 *
 * Used internally to (a) list all chats, (b) look up a chat by id without
 * knowing its character.
 */
function listAllChatDirs(gp: GlobalPaths): Array<{ bucket: string; id: string; dir: string }> {
  const out: Array<{ bucket: string; id: string; dir: string }> = [];
  let buckets: fs.Dirent[] = [];
  try { buckets = fs.readdirSync(gp.playground, { withFileTypes: true }); } catch { return out; }
  for (const b of buckets) {
    if (!b.isDirectory()) continue;
    if (b.name.startsWith(".")) continue;
    const chatsDir = path.join(gp.playground, b.name, "chats");
    if (!fs.existsSync(chatsDir)) continue;
    let chatEntries: fs.Dirent[] = [];
    try { chatEntries = fs.readdirSync(chatsDir, { withFileTypes: true }); } catch { continue; }
    for (const c of chatEntries) {
      if (!c.isDirectory()) continue;
      out.push({ bucket: b.name, id: c.name, dir: path.join(chatsDir, c.name) });
    }
  }
  return out;
}

/** Locate the on-disk folder for a chat by id. Null if not found. */
export function findChatDir(gp: GlobalPaths, chatId: string): string | null {
  const hit = listAllChatDirs(gp).find((c) => c.id === chatId);
  return hit?.dir ?? null;
}

/**
 * List every chat across every bucket. Filter optional — pass a character
 * slug (or `_shared`) to limit the list to that bucket.
 */
export function listChats(gp: GlobalPaths, filterSlug?: string | null): ChatMeta[] {
  const out: ChatMeta[] = [];
  for (const rec of listAllChatDirs(gp)) {
    if (filterSlug !== undefined && filterSlug !== null) {
      // `_shared` is valid as a filter; the bucket name matches.
      if (rec.bucket !== normaliseSlug(filterSlug)) continue;
    }
    const meta = loadChatMetaFromDir(rec.dir);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return out;
}

function loadChatMetaFromDir(dir: string): ChatMeta | null {
  try {
    const raw = fs.readFileSync(path.join(dir, "meta.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.id !== "string" || typeof parsed.title !== "string") return null;
    // Back-compat: v1 used `preset` instead of `character`.
    if (!("character" in parsed) && "preset" in parsed) {
      parsed.character = parsed.preset;
      delete parsed.preset;
    }
    return parsed as ChatMeta;
  } catch {
    return null;
  }
}

export function loadChatMeta(gp: GlobalPaths, id: string): ChatMeta | null {
  const dir = findChatDir(gp, id);
  if (!dir) return null;
  return loadChatMetaFromDir(dir);
}

/**
 * Find an existing chat by (character slug, Telegram chat_id). Used to
 * reuse a single persistent chat per Telegram conversation instead of
 * creating a new one on every incoming message.
 */
export function findChatByTelegramBinding(
  gp: GlobalPaths,
  characterSlug: string | null,
  telegramChatId: number | string,
): ChatMeta | null {
  const all = listChats(gp, characterSlug ?? undefined);
  const tgKey = String(telegramChatId);
  for (const c of all) {
    if (String(c.telegram_chat_id ?? "") !== tgKey) continue;
    return c;
  }
  return null;
}

export function createChat(gp: GlobalPaths, meta: Omit<ChatMeta, "created_at" | "updated_at">): ChatMeta {
  const now = new Date().toISOString();
  const full: ChatMeta = { ...meta, created_at: now, updated_at: now };
  const dir = chatDirFor(gp, full.character, full.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(full, null, 2));
  fs.writeFileSync(path.join(dir, "messages.jsonl"), ""); // empty
  return full;
}

export function updateChatMeta(gp: GlobalPaths, id: string, patch: Partial<ChatMeta>): ChatMeta | null {
  const dir = findChatDir(gp, id);
  if (!dir) return null;
  const meta = loadChatMetaFromDir(dir);
  if (!meta) return null;
  const updated: ChatMeta = { ...meta, ...patch, updated_at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(updated, null, 2));
  return updated;
}

export function readMessages(gp: GlobalPaths, id: string): ChatMessage[] {
  const dir = findChatDir(gp, id);
  if (!dir) return [];
  try {
    const raw = fs.readFileSync(path.join(dir, "messages.jsonl"), "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ChatMessage);
  } catch {
    return [];
  }
}

export function appendMessage(gp: GlobalPaths, id: string, msg: ChatMessage): void {
  const dir = findChatDir(gp, id);
  if (!dir) throw new Error(`chat not found: ${id}`);
  const withTs: ChatMessage = { ...msg, ts: msg.ts ?? new Date().toISOString() };
  fs.appendFileSync(path.join(dir, "messages.jsonl"), JSON.stringify(withTs) + "\n");
}

export async function deleteChat(gp: GlobalPaths, id: string): Promise<boolean> {
  const dir = findChatDir(gp, id);
  if (!dir) return false;
  try {
    await fsp.rm(dir, { recursive: true, force: true });
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
  const dir = findChatDir(gp, chatId);
  if (!dir) throw new Error(`chat not found: ${chatId}`);
  const full = path.join(dir, "images", filename);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.from(m[3]!, "base64"));
  void mime; // reserved in case we want to store it later
  return filename;
}

/** Serve an image from a chat — used by the /images/:filename route. */
export function resolveChatImage(gp: GlobalPaths, chatId: string, filename: string): string | null {
  if (filename.includes("/") || filename.includes("..")) return null;
  const dir = findChatDir(gp, chatId);
  if (!dir) return null;
  return path.join(dir, "images", filename);
}

export function readImageAsDataUrl(gp: GlobalPaths, chatId: string, filename: string): string | null {
  const full = resolveChatImage(gp, chatId, filename);
  if (!full) return null;
  try {
    const buf = fs.readFileSync(full);
    const ext = path.extname(filename).slice(1).toLowerCase() || "png";
    const mime = ext === "jpg" ? "jpeg" : ext;
    return `data:image/${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}
