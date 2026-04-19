/**
 * Chat memory store — the "what I know about the user" layer for the
 * Chat playground. Completely private, local-only, and isolated from
 * Sarah (lives under `playgroundRoot/learned/`).
 *
 * Storage: a single append-only JSONL file. Soft-deletes keep the
 * history intact so accidents are reversible.
 *
 * File: <playgroundRoot>/learned/memories.jsonl
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { GlobalPaths } from "./global_paths.ts";

export interface Memory {
  id: string;
  ts: string;               // ISO timestamp
  chat_id: string | null;   // which chat surfaced this (null if manually added)
  text: string;             // one-sentence fact about the user
  category: string;         // e.g. "preference.music", "biographical", "interest"
  deleted: boolean;
  /** If the AI rewrites / supersedes an older fact, it can reference it here. */
  supersedes?: string;
}

function memoriesDir(gp: GlobalPaths): string {
  return path.join(gp.playground, "learned");
}

function memoriesFile(gp: GlobalPaths): string {
  return path.join(memoriesDir(gp), "memories.jsonl");
}

function ensureDir(gp: GlobalPaths): void {
  fs.mkdirSync(memoriesDir(gp), { recursive: true });
}

export function listMemories(gp: GlobalPaths, opts: { includeDeleted?: boolean } = {}): Memory[] {
  try {
    const raw = fs.readFileSync(memoriesFile(gp), "utf8");
    const all = raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l) as Memory; } catch { return null; }
      })
      .filter((m): m is Memory => m !== null);

    // Collapse tombstones and supersessions so callers just see the current view.
    //
    // For soft-delete we append a second row with the same `id` and
    // `deleted: true`. When listing the live view, we need to hide BOTH the
    // tombstone row AND the original row it tombstones. Build a set of
    // tombstoned ids first, then filter.
    const tombstonedIds = new Set<string>();
    const supersededIds = new Set<string>();
    for (const m of all) {
      if (m.deleted) tombstonedIds.add(m.id);
      if (m.supersedes) supersededIds.add(m.supersedes);
    }
    // Also dedup by id keeping only the latest row (in case of supersedes
    // chains or repeated rows with the same id).
    const latestById = new Map<string, Memory>();
    for (const m of all) {
      const prev = latestById.get(m.id);
      if (!prev || prev.ts <= m.ts) latestById.set(m.id, m);
    }
    const unique = [...latestById.values()];
    return unique.filter((m) => {
      if (!opts.includeDeleted && tombstonedIds.has(m.id)) return false;
      if (supersededIds.has(m.id)) return false;
      return true;
    });
  } catch {
    return [];
  }
}

export function addMemory(
  gp: GlobalPaths,
  data: { text: string; category?: string; chat_id?: string | null; supersedes?: string },
): Memory {
  ensureDir(gp);
  const mem: Memory = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    chat_id: data.chat_id ?? null,
    text: data.text.trim(),
    category: (data.category || "other").trim(),
    deleted: false,
    ...(data.supersedes ? { supersedes: data.supersedes } : {}),
  };
  fs.appendFileSync(memoriesFile(gp), JSON.stringify(mem) + "\n");
  return mem;
}

export function deleteMemory(gp: GlobalPaths, id: string): boolean {
  // Soft-delete by appending a tombstone row that points at the same id.
  // This keeps the file truly append-only and preserves history.
  const existing = listMemories(gp, { includeDeleted: true }).find((m) => m.id === id);
  if (!existing) return false;
  const tombstone: Memory = { ...existing, deleted: true, ts: new Date().toISOString() };
  fs.appendFileSync(memoriesFile(gp), JSON.stringify(tombstone) + "\n");
  return true;
}

/**
 * Compose the memory injection block for the chat's system prompt.
 * Returns an empty string if no memories exist.
 */
export function composeMemoryBlock(gp: GlobalPaths, userName: string): string {
  const memories = listMemories(gp);
  if (memories.length === 0) return "";

  // Group by category for readability
  const byCategory = new Map<string, Memory[]>();
  for (const m of memories) {
    const cat = m.category || "other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(m);
  }

  const lines: string[] = [
    `### What I've learned about ${userName || "the user"}`,
    `(These notes have been gathered across past conversations. Use them to ` +
      `adapt tone, suggestions, and references — don't parrot them back verbatim unless ` +
      `they're directly relevant.)`,
    "",
  ];

  // Sort categories, put "biographical" and "communication" first as they're
  // most impactful on tone/approach.
  const order = ["biographical", "communication", "preference", "interest", "other"];
  const keys = [...byCategory.keys()].sort((a, b) => {
    const ai = order.findIndex((p) => a.startsWith(p));
    const bi = order.findIndex((p) => b.startsWith(p));
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  for (const cat of keys) {
    const items = byCategory.get(cat)!;
    lines.push(`**${cat}:**`);
    for (const m of items) lines.push(`- ${m.text}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Extraction — calls LM Studio to find new facts from a recent exchange.
// ---------------------------------------------------------------------------

interface ExtractionCandidate {
  text: string;
  category?: string;
}

/**
 * Ask the LLM to extract new memories from the latest exchange. Returns
 * the list of candidates (plus the raw response for debugging). Failures
 * return an empty list — memory extraction is best-effort and must never
 * block the chat.
 */
export async function extractMemoriesFromExchange(params: {
  lmStudioUrl: string;
  model: string;
  userName: string;
  existingMemories: Memory[];
  messages: Array<{ role: string; content: string }>;
}): Promise<ExtractionCandidate[]> {
  const { lmStudioUrl, model, userName, existingMemories, messages } = params;

  const existingBlock = existingMemories.length === 0
    ? "(none yet)"
    : existingMemories.map((m) => `- [${m.category}] ${m.text}`).join("\n");

  const recent = messages
    .slice(-6) // last 3 exchanges
    .map((m) => `${m.role.toUpperCase()}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\n\n");

  const systemPrompt =
    `You are a memory-extraction assistant. Your job is to identify NEW facts ` +
    `about the user (${userName || "the user"}) from the most recent conversation ` +
    `exchange, so a future AI can remember them.\n\n` +
    `**Focus on:**\n` +
    `- Preferences (music, food, places, aesthetics)\n` +
    `- Biographical facts (family, job, location, age-relevant context)\n` +
    `- Interests, hobbies, projects\n` +
    `- Communication style preferences (terseness, formality, taboos)\n` +
    `- Anything the user explicitly asks you to remember\n\n` +
    `**Ignore:**\n` +
    `- Anything already in the existing-memories list\n` +
    `- Information about the AI or third parties the user doesn't clearly care about\n` +
    `- One-off references that don't generalise\n` +
    `- Your own inferences that aren't grounded in what the user actually said\n\n` +
    `**Output format:** Respond with ONLY a JSON array. No prose, no markdown fences, ` +
    `no explanation. Each item: \`{"text": "…", "category": "preference.music" | ` +
    `"biographical" | "interest" | "communication" | "other"}\`. If nothing new ` +
    `is worth remembering, output \`[]\`.\n\n` +
    `**Existing memories:**\n${existingBlock}\n\n` +
    `**Recent exchange:**\n${recent}\n\n` +
    `**Your JSON array:**`;

  try {
    const res = await fetch(lmStudioUrl.replace(/\/+$/, "") + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }],
        temperature: 0.2,
        max_tokens: 512,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    return parseExtractionResponse(raw);
  } catch {
    return [];
  }
}

/** Parse the model's JSON-array response forgivingly (handles stray prose). */
export function parseExtractionResponse(raw: string): ExtractionCandidate[] {
  if (!raw) return [];
  // Strip common code-fence wrappers
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  // Find the first [ and last ] to tolerate leading/trailing prose
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < 0 || end < start) return [];
  const arr = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(arr);
    if (!Array.isArray(parsed)) return [];
    const out: ExtractionCandidate[] = [];
    for (const item of parsed) {
      if (item && typeof item === "object" && typeof item.text === "string" && item.text.trim()) {
        out.push({
          text: item.text.trim(),
          category: typeof item.category === "string" ? item.category.trim() : "other",
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * End-to-end: extract new memories from an exchange and persist any
 * non-duplicate ones. Returns the count added. Swallows errors — this
 * is fire-and-forget background work.
 */
export async function runExtractionAndPersist(params: {
  gp: GlobalPaths;
  lmStudioUrl: string;
  model: string;
  userName: string;
  chatId: string;
  messages: Array<{ role: string; content: string }>;
}): Promise<number> {
  const { gp, lmStudioUrl, model, userName, chatId, messages } = params;
  const existing = listMemories(gp);
  const candidates = await extractMemoriesFromExchange({
    lmStudioUrl,
    model,
    userName,
    existingMemories: existing,
    messages,
  });
  if (candidates.length === 0) return 0;

  // Simple duplicate check: normalised text must not match any existing memory.
  const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
  const existingNormalised = new Set(existing.map((m) => normalize(m.text)));
  let added = 0;
  for (const c of candidates) {
    if (existingNormalised.has(normalize(c.text))) continue;
    addMemory(gp, { text: c.text, category: c.category, chat_id: chatId });
    existingNormalised.add(normalize(c.text));
    added++;
  }
  return added;
}

/** Rebuild the whole file, dropping tombstoned and superseded entries. */
export async function compactMemories(gp: GlobalPaths): Promise<{ before: number; after: number }> {
  const before = (await fsp.readFile(memoriesFile(gp), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean).length;
  const live = listMemories(gp);
  ensureDir(gp);
  const content = live.map((m) => JSON.stringify(m)).join("\n") + (live.length ? "\n" : "");
  await fsp.writeFile(memoriesFile(gp), content);
  return { before, after: live.length };
}
