/**
 * Playground storage — user's private chat space.
 *
 * Entirely separate from Sarah's world. Lives under `<dataRoot>/playground/`,
 * which is not scanned by the filing clerk, not ingested into the knowledge
 * graph, and explicitly off-limits to Sarah per her operator manual.
 *
 * Layout:
 *
 *   playground/
 *     presets/
 *       <slug>.md                — markdown + frontmatter per preset
 *     chats/
 *       <id>/
 *         meta.json              — {title, created_at, updated_at, preset, model}
 *         messages.jsonl         — one JSON per message (see ChatMessage)
 *         images/
 *           <filename>           — uploaded images referenced by messages
 *
 * Chat IDs are timestamp-prefixed slugs so they sort chronologically
 * in a directory listing. Example: `2026-04-19T094512_book_chapter_3`.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { GlobalPaths } from "./global_paths.ts";

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface PresetFrontmatter {
  name: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
}

export interface Preset extends PresetFrontmatter {
  slug: string;
  /** The markdown body is the system prompt. */
  system_prompt: string;
}

function presetPath(gp: GlobalPaths, slug: string): string {
  return path.join(gp.playgroundPresets, `${slug}.md`);
}

export function listPresets(gp: GlobalPaths): Preset[] {
  try {
    const files = fs
      .readdirSync(gp.playgroundPresets)
      .filter((f) => f.endsWith(".md"));
    return files
      .map((f) => loadPreset(gp, f.replace(/\.md$/, "")))
      .filter((p): p is Preset => p !== null);
  } catch {
    return [];
  }
}

export function loadPreset(gp: GlobalPaths, slug: string): Preset | null {
  try {
    const raw = fs.readFileSync(presetPath(gp, slug), "utf8");
    const parsed = matter(raw);
    const fm = parsed.data as Partial<PresetFrontmatter>;
    if (!fm.name || !fm.model) return null;
    return {
      slug,
      name: fm.name,
      model: fm.model,
      temperature: fm.temperature,
      max_tokens: fm.max_tokens,
      system_prompt: parsed.content.trim(),
    };
  } catch {
    return null;
  }
}

export function savePreset(
  gp: GlobalPaths,
  slug: string,
  fm: PresetFrontmatter,
  systemPrompt: string,
): void {
  fs.mkdirSync(gp.playgroundPresets, { recursive: true });
  // Strip undefined values — js-yaml can't serialize them, and gray-matter
  // blows up on "unacceptable kind of an object to dump [object Undefined]".
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v !== undefined) cleaned[k] = v;
  }
  const out = matter.stringify(systemPrompt, cleaned);
  fs.writeFileSync(presetPath(gp, slug), out);
}

export function deletePreset(gp: GlobalPaths, slug: string): boolean {
  try {
    fs.unlinkSync(presetPath(gp, slug));
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
  /** Slug of the preset used to start this chat (frozen — edits to the preset
   *  don't retroactively change this chat's behavior). */
  preset: string | null;
  /** Snapshot of the system prompt at chat creation time, independent of any
   *  later preset edits. */
  system_prompt: string;
  /** Model id used (from LM Studio's /v1/models). */
  model: string;
  temperature?: number;
  max_tokens?: number;
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
    if (typeof parsed.id === "string" && typeof parsed.title === "string") {
      return parsed as ChatMeta;
    }
    return null;
  } catch {
    return null;
  }
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
