/**
 * /api/logs — tail today's JSONL log. Supports ?lines=N (default 200).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import type { ServerContext } from "../types.ts";

export function registerLogsRoute(app: Hono, ctx: ServerContext): void {
  app.get("/api/logs", async (c) => {
    const linesParam = c.req.query("lines");
    const lines = linesParam ? Math.min(parseInt(linesParam, 10) || 200, 2000) : 200;
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(ctx.global.logs, `${today}.jsonl`);
    try {
      const raw = await fs.readFile(file, "utf8");
      const all = raw.split("\n").filter((l) => l.trim());
      const tail = all.slice(-lines);
      const entries = tail
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { raw: l };
          }
        })
        .reverse(); // newest first
      return c.json(entries);
    } catch {
      return c.json([]);
    }
  });
}
