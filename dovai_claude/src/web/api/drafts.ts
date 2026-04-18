/**
 * /api/drafts — the approval queue.
 *
 * A draft is a markdown file in <workspace>/.dovai/drafts/ with frontmatter
 * describing what it is (email, document, SOP change) and where to find the
 * content. When the user clicks Approve in the UI, we mark the draft
 * `approved: true` in the frontmatter. On the next wake, Claude Code reads
 * the updated draft file, sees the approval, and proceeds (e.g. actually
 * sends the email by writing its JSON to the outbox).
 *
 * Rejected drafts are marked `approved: false` with a reason.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import matter from "gray-matter";
import type { ServerContext } from "../types.ts";
import { enqueueWake } from "../../wake/queue.ts";
import { appendLedger } from "../../lib/ledger.ts";

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
}

export function registerDraftsRoute(app: Hono, ctx: ServerContext): void {
  app.get("/api/drafts", async (c) => {
    try {
      const files = await fs.readdir(ctx.global.drafts);
      const out: Array<{ filename: string; frontmatter: any; preview: string }> = [];
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        try {
          const raw = await fs.readFile(path.join(ctx.global.drafts, f), "utf8");
          const parsed = matter(raw);
          out.push({
            filename: f,
            frontmatter: parsed.data,
            preview: parsed.content,
          });
        } catch {
          // skip
        }
      }
      return c.json(out);
    } catch {
      return c.json([]);
    }
  });

  // Read one draft's full contents
  app.get("/api/drafts/:filename", async (c) => {
    const filename = sanitize(c.req.param("filename"));
    const fp = path.join(ctx.global.drafts, filename);
    try {
      const raw = await fs.readFile(fp, "utf8");
      return c.json({ filename, content: raw });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  // Approve a draft
  app.post("/api/drafts/:filename/approve", async (c) => {
    const filename = sanitize(c.req.param("filename"));
    const body = (await c.req.json().catch(() => ({}))) as { note?: string; edited_body?: string };
    const fp = path.join(ctx.global.drafts, filename);
    try {
      const raw = await fs.readFile(fp, "utf8");
      const parsed = matter(raw);
      parsed.data["approved"] = true;
      parsed.data["approved_at"] = new Date().toISOString();
      if (body.note) parsed.data["approval_note"] = body.note;
      // If the user edited the draft body before approving, use their version
      const content = typeof body.edited_body === "string" ? body.edited_body : parsed.content;
      if (typeof body.edited_body === "string") parsed.data["edited_by_user"] = true;
      const updated = matter.stringify(content, parsed.data);
      await fs.writeFile(fp, updated);
      await enqueueWake(ctx.global, { source: "approval", draft: filename, action: "approved" });
      const title = parsed.data["title"] || filename;
      appendLedger(ctx.global, {
        action: "draft_approved",
        description: `Draft approved: ${title}`,
        ref: filename,
        details: { draft: filename, title, note: body.note },
      });
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  // Reject a draft
  app.post("/api/drafts/:filename/reject", async (c) => {
    const filename = sanitize(c.req.param("filename"));
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const fp = path.join(ctx.global.drafts, filename);
    try {
      const raw = await fs.readFile(fp, "utf8");
      const parsed = matter(raw);
      parsed.data["approved"] = false;
      parsed.data["rejected_at"] = new Date().toISOString();
      if (body.reason) parsed.data["rejection_reason"] = body.reason;
      const updated = matter.stringify(parsed.content, parsed.data);
      await fs.writeFile(fp, updated);
      await enqueueWake(ctx.global, {
        source: "approval",
        draft: filename,
        action: "rejected",
        reason: body.reason,
      });
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });
}
