/**
 * /api/failures — list and act on messages that the outbox dispatcher gave
 * up sending. A failure is "loud": the JSON lives in
 * `dovai_files/{email,telegram}/failed/` alongside an `.error.txt` sidecar,
 * and a `send_failed` wake event was fired when it was moved there.
 *
 * Endpoints:
 *   GET    /api/failures                              — list all failed sends
 *   POST   /api/failures/:channel/:file/retry         — move the file back
 *                                                       to outbox/ so the
 *                                                       dispatcher re-sends
 *                                                       (retry counter resets)
 *   DELETE /api/failures/:channel/:file                — permanently delete
 *                                                       the failed message
 *
 * `channel` is "email" or "telegram". `file` is the bare JSON filename.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import type { ServerContext } from "../types.ts";

interface FailureRecord {
  channel: "email" | "telegram";
  file: string;
  /** Contents of the .error.txt sidecar, if any */
  error: string;
  /** Parsed summary from the original JSON (to/subject for email, text for telegram) */
  summary: Record<string, unknown>;
  /** mtime of the JSON */
  failed_at: string;
}

async function readFailures(
  dir: string,
  channel: "email" | "telegram",
): Promise<FailureRecord[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const jsons = entries.filter((e) => e.isFile() && e.name.endsWith(".json"));
    const out: FailureRecord[] = [];
    for (const e of jsons) {
      const jsonPath = path.join(dir, e.name);
      const errorPath = jsonPath.replace(/\.json$/, ".error.txt");
      let error = "(no error details)";
      try { error = await fs.readFile(errorPath, "utf8"); } catch {}
      let summary: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(jsonPath, "utf8");
        const parsed = JSON.parse(raw);
        if (channel === "email") {
          summary = {
            to: parsed.to,
            subject: parsed.subject,
            body_preview: typeof parsed.body_text === "string"
              ? parsed.body_text.slice(0, 200)
              : undefined,
          };
        } else {
          summary = {
            chat_id: parsed.chat_id,
            text: typeof parsed.text === "string" ? parsed.text.slice(0, 200) : undefined,
          };
        }
      } catch {}
      let failed_at = "";
      try {
        const stat = await fs.stat(jsonPath);
        failed_at = stat.mtime.toISOString();
      } catch {}
      out.push({ channel, file: e.name, error, summary, failed_at });
    }
    return out.sort((a, b) => b.failed_at.localeCompare(a.failed_at));
  } catch {
    return [];
  }
}

function sanitizeFilename(name: string): string {
  // Only allow the characters Sarah and the dispatcher generate. Reject
  // path traversal attempts outright.
  if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) return "";
  return name;
}

export function registerFailuresRoute(app: Hono, ctx: ServerContext): void {
  app.get("/api/failures", async (c) => {
    const [email, telegram] = await Promise.all([
      readFailures(ctx.global.emailFailed, "email"),
      readFailures(ctx.global.telegramFailed, "telegram"),
    ]);
    return c.json({ email, telegram, total: email.length + telegram.length });
  });

  app.post("/api/failures/:channel/:file/retry", async (c) => {
    const channel = c.req.param("channel");
    const file = sanitizeFilename(c.req.param("file"));
    if (!file) return c.json({ error: "invalid filename" }, 400);
    if (channel !== "email" && channel !== "telegram") {
      return c.json({ error: "invalid channel" }, 400);
    }
    const failedDir =
      channel === "email" ? ctx.global.emailFailed : ctx.global.telegramFailed;
    const outboxDir =
      channel === "email" ? ctx.global.emailOutbox : ctx.global.telegramOutbox;
    const src = path.join(failedDir, file);
    const errSidecar = src.replace(/\.json$/, ".error.txt");
    // Rename the file so chokidar sees a fresh add event even if a file
    // with the same basename already exists in outbox/.
    const retryName = file.replace(/\.json$/, `_retry-${Date.now()}.json`);
    const dst = path.join(outboxDir, retryName);
    try {
      await fs.rename(src, dst);
      await fs.rm(errSidecar, { force: true });
      return c.json({ ok: true, retry_file: retryName });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  app.delete("/api/failures/:channel/:file", async (c) => {
    const channel = c.req.param("channel");
    const file = sanitizeFilename(c.req.param("file"));
    if (!file) return c.json({ error: "invalid filename" }, 400);
    if (channel !== "email" && channel !== "telegram") {
      return c.json({ error: "invalid channel" }, 400);
    }
    const failedDir =
      channel === "email" ? ctx.global.emailFailed : ctx.global.telegramFailed;
    const src = path.join(failedDir, file);
    const errSidecar = src.replace(/\.json$/, ".error.txt");
    try {
      await fs.rm(src, { force: true });
      await fs.rm(errSidecar, { force: true });
      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });
}
