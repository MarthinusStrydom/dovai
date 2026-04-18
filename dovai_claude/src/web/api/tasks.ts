/**
 * /api/tasks — list active and done tasks, read a single task's working folder.
 *
 * Each task is a folder under .dovai/tasks/{active,done}/<task_id>/.
 * The folder contains at minimum state.md (frontmatter with status, sop, deadline).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import matter from "gray-matter";
import type { ServerContext } from "../types.ts";

async function listTaskDir(dir: string): Promise<Array<{ id: string; state: any; updated_at: string }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const taskDir = path.join(dir, e.name);
      const stateFile = path.join(taskDir, "state.md");
      let state: any = {};
      let updated_at = "";
      try {
        const raw = await fs.readFile(stateFile, "utf8");
        const parsed = matter(raw);
        state = parsed.data;
        const stat = await fs.stat(stateFile);
        updated_at = stat.mtime.toISOString();
      } catch {
        try {
          const stat = await fs.stat(taskDir);
          updated_at = stat.mtime.toISOString();
        } catch {
          // ignore
        }
      }
      out.push({ id: e.name, state, updated_at });
    }
    return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  } catch {
    return [];
  }
}

export function registerTasksRoute(app: Hono, ctx: ServerContext): void {
  app.get("/api/tasks", async (c) => {
    const [active, done] = await Promise.all([
      listTaskDir(ctx.global.tasksActive),
      listTaskDir(ctx.global.tasksDone),
    ]);
    return c.json({ active, done });
  });

  app.get("/api/tasks/:status/:id", async (c) => {
    const statusParam = c.req.param("status");
    const id = c.req.param("id").replace(/[^a-zA-Z0-9_\-]/g, "_");
    const base = statusParam === "done" ? ctx.global.tasksDone : ctx.global.tasksActive;
    const taskDir = path.join(base, id);
    try {
      const files = await fs.readdir(taskDir, { withFileTypes: true });
      const result: Array<{ name: string; kind: string; content?: string }> = [];
      for (const e of files) {
        if (e.isDirectory()) {
          result.push({ name: e.name, kind: "dir" });
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if ([".md", ".txt", ".json"].includes(ext)) {
            try {
              const content = await fs.readFile(path.join(taskDir, e.name), "utf8");
              result.push({ name: e.name, kind: "file", content });
            } catch {
              result.push({ name: e.name, kind: "file" });
            }
          } else {
            result.push({ name: e.name, kind: "file" });
          }
        }
      }
      return c.json({ id, files: result });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });
}
