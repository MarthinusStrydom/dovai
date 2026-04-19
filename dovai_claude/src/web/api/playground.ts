/**
 * /api/playground/* — user's private chat space (LM Studio).
 *
 * Entirely separate from Sarah's work. Chats live under
 * `<playgroundRoot>/`, which the filing clerk never scans and which
 * Sarah's operator manual forbids her from touching. Nothing in playground
 * leaks into the knowledge graph, wake context, or email triage.
 *
 * Key concepts:
 *   - Character: a saved system prompt + model + optional Telegram bot +
 *     per-character memory namespace. Isolated from other characters.
 *   - Chat: bound to at most one character. Memory is per-character.
 *
 * Routes:
 *   GET    /api/playground/models
 *   GET    /api/playground/characters
 *   POST   /api/playground/characters
 *   GET    /api/playground/characters/:slug
 *   PUT    /api/playground/characters/:slug
 *   DELETE /api/playground/characters/:slug
 *   GET    /api/playground/characters/:slug/memories
 *   POST   /api/playground/characters/:slug/memories
 *   DELETE /api/playground/characters/:slug/memories/:id
 *   POST   /api/playground/characters/:slug/memories/reflect
 *   POST   /api/playground/characters/:slug/memories/compact
 *   GET    /api/playground/chats
 *   POST   /api/playground/chats
 *   GET    /api/playground/chats/:id
 *   DELETE /api/playground/chats/:id
 *   POST   /api/playground/chats/:id/messages
 *   GET    /api/playground/chats/:id/images/:filename
 */
import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ServerContext } from "../types.ts";
import { loadProviderSettings, loadWorkspaceSettings } from "../../lib/config.ts";
import {
  listMemories,
  addMemory,
  deleteMemory,
  composeMemoryBlock,
  runExtractionAndPersist,
  compactMemories,
  reflectAndRebuildInferences,
  toNamespace,
} from "../../lib/memories.ts";
import {
  listCharacters,
  loadCharacter,
  saveCharacter,
  deleteCharacter,
  listChats,
  loadChatMeta,
  createChat,
  updateChatMeta,
  readMessages,
  appendMessage,
  deleteChat as deleteChatStorage,
  newChatId,
  saveImageDataUrl,
  type ChatMessage,
  type ChatContentPart,
  type CharacterFrontmatter,
} from "../../lib/playground.ts";

export function registerPlaygroundRoute(app: Hono, ctx: ServerContext): void {
  // ---- Models (proxy LM Studio's /v1/models) -----------------------------
  app.get("/api/playground/models", async (c) => {
    const { data: pr } = loadProviderSettings(ctx.global);
    const url = pr.lm_studio_url.replace(/\/+$/, "") + "/v1/models";
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return c.json({ error: `LM Studio returned ${res.status}` }, 502);
      const j = (await res.json()) as { data?: Array<{ id?: string }> };
      return c.json({ models: (j.data ?? []).map((m) => m.id).filter(Boolean) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // ---- Characters --------------------------------------------------------
  app.get("/api/playground/characters", (c) => c.json({ characters: listCharacters(ctx.global) }));

  app.get("/api/playground/characters/:slug", (c) => {
    const ch = loadCharacter(ctx.global, c.req.param("slug"));
    if (!ch) return c.json({ error: "not found" }, 404);
    return c.json(ch);
  });

  app.post("/api/playground/characters", async (c) => {
    const body = (await c.req.json()) as {
      slug?: string;
      name?: string;
      model?: string;
      temperature?: number;
      max_tokens?: number;
      telegram_bot_token?: string;
      system_prompt?: string;
    };
    if (!body.slug || !body.name || !body.model) {
      return c.json({ error: "slug, name, model required" }, 400);
    }
    if (body.slug === "_shared") {
      return c.json({ error: "_shared is reserved for no-character memory" }, 400);
    }
    const fm: CharacterFrontmatter = {
      name: body.name,
      model: body.model,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      telegram_bot_token: body.telegram_bot_token,
    };
    saveCharacter(ctx.global, body.slug, fm, body.system_prompt ?? "");
    void ctx.characterBots?.reload();
    const ch = loadCharacter(ctx.global, body.slug);
    return c.json(ch);
  });

  app.put("/api/playground/characters/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = (await c.req.json()) as {
      name?: string;
      model?: string;
      temperature?: number;
      max_tokens?: number;
      telegram_bot_token?: string;
      system_prompt?: string;
    };
    const existing = loadCharacter(ctx.global, slug);
    if (!existing) return c.json({ error: "not found" }, 404);
    const fm: CharacterFrontmatter = {
      name: body.name ?? existing.name,
      model: body.model ?? existing.model,
      temperature: body.temperature ?? existing.temperature,
      max_tokens: body.max_tokens ?? existing.max_tokens,
      telegram_bot_token: body.telegram_bot_token ?? existing.telegram_bot_token,
    };
    saveCharacter(ctx.global, slug, fm, body.system_prompt ?? existing.system_prompt);
    void ctx.characterBots?.reload();
    return c.json(loadCharacter(ctx.global, slug));
  });

  app.delete("/api/playground/characters/:slug", (c) => {
    const ok = deleteCharacter(ctx.global, c.req.param("slug"));
    void ctx.characterBots?.reload();
    return c.json({ ok });
  });

  // ---- Per-character memories --------------------------------------------
  // Memory is namespaced per character — a memory learned while chatting with
  // `book_voice` never appears when you're chatting with `code_reviewer`.
  // Use `_shared` as the slug for no-character chats.
  app.get("/api/playground/characters/:slug/memories", (c) => {
    const slug = toNamespace(c.req.param("slug"));
    return c.json({ memories: listMemories(ctx.global, slug) });
  });

  app.post("/api/playground/characters/:slug/memories", async (c) => {
    const slug = toNamespace(c.req.param("slug"));
    const body = (await c.req.json()) as {
      text?: string;
      kind?: "observation" | "inference" | "instruction";
      dimension?: string;
    };
    if (!body.text || !body.text.trim()) {
      return c.json({ error: "text required" }, 400);
    }
    const validDims = [
      "aesthetic", "values", "communication", "life_context",
      "cognitive", "emotional", "self_concept", "other",
    ] as const;
    const dimension = validDims.includes(body.dimension as typeof validDims[number])
      ? (body.dimension as typeof validDims[number])
      : "other";
    const m = addMemory(ctx.global, slug, {
      text: body.text,
      kind: body.kind || "observation",
      dimension,
      chat_id: null,
    });
    return c.json(m);
  });

  app.delete("/api/playground/characters/:slug/memories/:id", (c) => {
    const slug = toNamespace(c.req.param("slug"));
    const ok = deleteMemory(ctx.global, slug, c.req.param("id"));
    return c.json({ ok });
  });

  app.post("/api/playground/characters/:slug/memories/compact", async (c) => {
    const slug = toNamespace(c.req.param("slug"));
    const result = await compactMemories(ctx.global, slug);
    return c.json(result);
  });

  /** Reflection pass — rebuild inferences for this character. */
  app.post("/api/playground/characters/:slug/memories/reflect", async (c) => {
    const slug = toNamespace(c.req.param("slug"));
    const { data: pr } = loadProviderSettings(ctx.global);
    const { data: ws } = loadWorkspaceSettings(ctx.global);
    const modelsRes = await fetch(pr.lm_studio_url.replace(/\/+$/, "") + "/v1/models").catch(() => null);
    let model = "";
    if (modelsRes?.ok) {
      const j = (await modelsRes.json()) as { data?: Array<{ id?: string }> };
      model = j.data?.[0]?.id ?? "";
    }
    if (!model) return c.json({ error: "no model available from LM Studio" }, 502);
    const result = await reflectAndRebuildInferences({
      gp: ctx.global,
      characterSlug: slug,
      lmStudioUrl: pr.lm_studio_url,
      model,
      userName: ws.user_name,
      logger: ctx.logger,
    });
    return c.json(result);
  });

  // ---- Chats -------------------------------------------------------------
  app.get("/api/playground/chats", (c) => c.json({ chats: listChats(ctx.global) }));

  app.post("/api/playground/chats", async (c) => {
    const body = (await c.req.json()) as {
      title?: string;
      character?: string | null;
      model?: string;
      temperature?: number;
      max_tokens?: number;
      system_prompt?: string;
    };
    const title = body.title?.trim() || "New chat";
    const id = newChatId(title);

    // Resolve character details if one was specified. The character acts as
    // a source of defaults; any explicit body field overrides it.
    let system_prompt = body.system_prompt ?? "";
    let model = body.model ?? "";
    let temperature = body.temperature;
    let max_tokens = body.max_tokens;
    if (body.character) {
      const character = loadCharacter(ctx.global, body.character);
      if (character) {
        system_prompt ||= character.system_prompt;
        model ||= character.model;
        temperature ??= character.temperature;
        max_tokens ??= character.max_tokens;
      }
    }

    if (!model) return c.json({ error: "model required (or provide a character)" }, 400);

    const meta = createChat(ctx.global, {
      id,
      title,
      character: body.character ?? null,
      system_prompt,
      model,
      temperature,
      max_tokens,
    });
    return c.json(meta);
  });

  app.get("/api/playground/chats/:id", (c) => {
    const id = c.req.param("id");
    const meta = loadChatMeta(ctx.global, id);
    if (!meta) return c.json({ error: "not found" }, 404);
    const messages = readMessages(ctx.global, id);
    return c.json({ meta, messages });
  });

  app.delete("/api/playground/chats/:id", async (c) => {
    const ok = await deleteChatStorage(ctx.global, c.req.param("id"));
    return c.json({ ok });
  });

  app.get("/api/playground/chats/:id/images/:filename", (c) => {
    const id = c.req.param("id");
    const filename = c.req.param("filename");
    if (filename.includes("/") || filename.includes("..")) {
      return c.text("invalid filename", 400);
    }
    const full = path.join(ctx.global.playgroundChats, id, "images", filename);
    try {
      const buf = fs.readFileSync(full);
      const ext = path.extname(filename).slice(1).toLowerCase() || "png";
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      c.header("Content-Type", mime);
      return c.body(buf);
    } catch {
      return c.text("not found", 404);
    }
  });

  // ---- Messages: SSE stream ---------------------------------------------
  app.post("/api/playground/chats/:id/messages", async (c) => {
    const id = c.req.param("id");
    const meta = loadChatMeta(ctx.global, id);
    if (!meta) return c.json({ error: "chat not found" }, 404);

    const body = (await c.req.json()) as {
      text?: string;
      images?: string[]; // array of data: URLs
    };
    const text = (body.text ?? "").trim();
    const imageDataUrls = body.images ?? [];
    if (!text && imageDataUrls.length === 0) {
      return c.json({ error: "text or at least one image required" }, 400);
    }

    // Save any uploaded images to disk, collect filenames
    const savedFilenames: string[] = [];
    for (const du of imageDataUrls) {
      try {
        const fn = saveImageDataUrl(ctx.global, id, du, text.slice(0, 24));
        savedFilenames.push(fn);
      } catch (err) {
        return c.json({ error: `bad image: ${err instanceof Error ? err.message : err}` }, 400);
      }
    }

    // Build the user message for storage (records filenames, not raw data)
    const storedContent: ChatContentPart[] = [];
    if (text) storedContent.push({ type: "text", text });
    for (const fn of savedFilenames) {
      storedContent.push({
        type: "image_url",
        image_url: { url: `/api/playground/chats/${encodeURIComponent(id)}/images/${encodeURIComponent(fn)}` },
      });
    }
    const userMessage: ChatMessage = {
      role: "user",
      content: storedContent.length === 1 && storedContent[0]!.type === "text"
        ? storedContent[0]!.text!
        : storedContent,
      attached_images: savedFilenames.length > 0 ? savedFilenames : undefined,
    };
    appendMessage(ctx.global, id, userMessage);

    // Build the payload for LM Studio — images go as base64 data URLs (LM
    // Studio's OpenAI-compatible API expects the raw data in the prompt).
    const outboundContent: ChatContentPart[] = [];
    if (text) outboundContent.push({ type: "text", text });
    for (const du of imageDataUrls) {
      outboundContent.push({ type: "image_url", image_url: { url: du } });
    }
    const outboundUserMsg = {
      role: "user" as const,
      content: outboundContent.length === 1 && outboundContent[0]!.type === "text"
        ? outboundContent[0]!.text!
        : outboundContent,
    };

    // Assemble full message list for the model
    const history = readMessages(ctx.global, id);
    // Exclude the user message we just appended (we'll use outboundUserMsg
    // instead — with raw image data, not URL references)
    const historyForModel = history
      .slice(0, -1)
      .map((m) => ({ role: m.role, content: m.content }));
    // Load known memories (for THIS chat's character) and prepend as a
    // context block on the system prompt. Memory is per-character — chats
    // with no character bound route to the `_shared` namespace.
    const { data: ws } = loadWorkspaceSettings(ctx.global);
    const characterSlug = toNamespace(meta.character);
    const memoryBlock = composeMemoryBlock(ctx.global, characterSlug, ws.user_name);
    const combinedSystem = [meta.system_prompt, memoryBlock]
      .filter((s) => s && s.trim())
      .join("\n\n");
    const systemMessages = combinedSystem
      ? [{ role: "system" as const, content: combinedSystem }]
      : [];
    const messagesForModel = [
      ...systemMessages,
      ...historyForModel,
      outboundUserMsg,
    ];

    const { data: pr } = loadProviderSettings(ctx.global);
    const lmUrl = pr.lm_studio_url.replace(/\/+$/, "") + "/v1/chat/completions";

    return streamSSE(c, async (stream) => {
      let fullText = "";
      try {
        const res = await fetch(lmUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: meta.model,
            messages: messagesForModel,
            temperature: meta.temperature,
            max_tokens: meta.max_tokens,
            stream: true,
          }),
        });
        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => "");
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ message: `LM Studio ${res.status}: ${errText.slice(0, 400)}` }),
          });
          return;
        }

        // LM Studio returns SSE-style chunks: `data: {...}\n\n`, with the
        // final chunk being `data: [DONE]\n\n`. Parse and forward deltas.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const raw of lines) {
            const line = raw.trim();
            if (!line || !line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
              };
              const delta = chunk.choices?.[0]?.delta?.content ?? "";
              if (delta) {
                fullText += delta;
                await stream.writeSSE({ event: "delta", data: JSON.stringify({ delta }) });
              }
            } catch {
              // malformed chunk — skip
            }
          }
        }

        // Persist the assistant's final message
        appendMessage(ctx.global, id, {
          role: "assistant",
          content: fullText,
        });

        // Auto-title: if this was the first exchange and the title is still the default, generate one from the user's message.
        const updatedMessages = readMessages(ctx.global, id);
        if (updatedMessages.length === 2 && meta.title === "New chat") {
          const firstUserText = typeof userMessage.content === "string"
            ? userMessage.content
            : (userMessage.content.find((p) => p.type === "text") as ChatContentPart | undefined)?.text || "";
          const autoTitle = firstUserText.slice(0, 60).replace(/\s+/g, " ").trim() || "New chat";
          updateChatMeta(ctx.global, id, { title: autoTitle });
          await stream.writeSSE({ event: "title", data: JSON.stringify({ title: autoTitle }) });
        } else {
          updateChatMeta(ctx.global, id, {});
        }

        await stream.writeSSE({ event: "done", data: JSON.stringify({ fullText }) });

        // Fire-and-forget memory extraction — runs on the same LM Studio
        // instance, asynchronously, and must never block or break the
        // chat flow. Uses the latest messages (including the turn we
        // just completed) as the extraction input.
        ctx.logger.info("memory extraction: scheduling", { chat_id: id, model: meta.model });
        void (async () => {
          try {
            const latest = readMessages(ctx.global, id);
            // Convert multimodal parts to text for extraction (images aren't useful here)
            const flat = latest.map((m) => ({
              role: m.role,
              content: typeof m.content === "string"
                ? m.content
                : (m.content.find((p) => p.type === "text") as ChatContentPart | undefined)?.text || "",
            }));
            ctx.logger.info("memory extraction: starting", {
              chat_id: id,
              msg_count: flat.length,
              user_text_preview: flat[flat.length - 2]?.content?.slice?.(0, 100),
            });
            const added = await runExtractionAndPersist({
              gp: ctx.global,
              characterSlug,
              lmStudioUrl: pr.lm_studio_url,
              model: meta.model,
              userName: ws.user_name,
              chatId: id,
              messages: flat,
              logger: ctx.logger,
            });
            ctx.logger.info("memory extraction: done", {
              chat_id: id,
              observations: added.observations,
              inferences: added.inferences,
              instructions: added.instructions,
            });
          } catch (err) {
            ctx.logger.warn("memory extraction failed (non-fatal)", {
              chat_id: id,
              error: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
            });
          }
        })();
      } catch (err) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
        });
      }
    });
  });
}
