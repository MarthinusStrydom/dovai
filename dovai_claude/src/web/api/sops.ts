/**
 * /api/sops — list / read / create / update / delete SOPs.
 * Each SOP is a markdown file in <workspace>/.dovai/sops/.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import matter from "gray-matter";
import type { ServerContext } from "../types.ts";

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-]/g, "_");
}

export function registerSopsRoute(app: Hono, ctx: ServerContext): void {
  // List all SOPs (summary info)
  app.get("/api/sops", async (c) => {
    try {
      const files = await fs.readdir(ctx.global.sops);
      const mds = files.filter((f) => f.endsWith(".md"));
      const out = [];
      for (const f of mds) {
        try {
          const raw = await fs.readFile(path.join(ctx.global.sops, f), "utf8");
          const parsed = matter(raw);
          out.push({
            id: f.replace(/\.md$/, ""),
            filename: f,
            frontmatter: parsed.data,
            preview: parsed.content.slice(0, 200),
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

  // Read one SOP
  app.get("/api/sops/:id", async (c) => {
    const id = sanitize(c.req.param("id"));
    const fp = path.join(ctx.global.sops, `${id}.md`);
    try {
      const raw = await fs.readFile(fp, "utf8");
      return c.json({ id, content: raw });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  // Create or replace an SOP
  app.put("/api/sops/:id", async (c) => {
    const id = sanitize(c.req.param("id"));
    const body = (await c.req.json()) as { content?: string };
    if (typeof body.content !== "string") return c.json({ error: "content required" }, 400);
    const fp = path.join(ctx.global.sops, `${id}.md`);
    await fs.mkdir(ctx.global.sops, { recursive: true });
    await fs.writeFile(fp, body.content);
    // Reload scheduler — SOP may have cron triggers
    ctx.scheduler.reload();
    return c.json({ ok: true, id });
  });

  // Delete an SOP
  app.delete("/api/sops/:id", async (c) => {
    const id = sanitize(c.req.param("id"));
    const fp = path.join(ctx.global.sops, `${id}.md`);
    await fs.rm(fp, { force: true });
    // Reload scheduler — removed SOP's triggers must stop
    ctx.scheduler.reload();
    return c.json({ ok: true });
  });
}
