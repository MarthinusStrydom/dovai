/**
 * /api/settings — read/write the three settings files (workspace, providers, wakes).
 * Each is a markdown file with YAML frontmatter.
 */
import type { Hono } from "hono";
import type { ServerContext } from "../types.ts";
import fs from "node:fs";
import path from "node:path";
import {
  loadIdentity,
  loadProviderSettings,
  loadWakeSettings,
  loadWorkspaceSettings,
  saveIdentity,
  saveProviderSettings,
  saveWakeSettings,
  saveWorkspaceSettings,
} from "../../lib/config.ts";
import { TEMPLATES_DIR } from "../../lib/paths.ts";

export function registerSettingsRoute(app: Hono, ctx: ServerContext): void {
  // Workspace settings
  app.get("/api/settings/workspace", (c) => {
    const { data, body } = loadWorkspaceSettings(ctx.global);
    return c.json({ data, body });
  });
  app.put("/api/settings/workspace", async (c) => {
    const payload = (await c.req.json()) as { data: any; body: string };
    saveWorkspaceSettings(ctx.global, payload.data, payload.body || "");
    return c.json({ ok: true });
  });

  // Provider settings
  app.get("/api/settings/providers", (c) => {
    const { data, body } = loadProviderSettings(ctx.global);
    return c.json({ data, body });
  });
  app.put("/api/settings/providers", async (c) => {
    const payload = (await c.req.json()) as { data: any; body: string };
    saveProviderSettings(ctx.global, payload.data, payload.body || "");
    return c.json({ ok: true });
  });

  // Identity (free-form markdown, no frontmatter schema).
  // If the user has never edited it, we return the shipped template so the
  // wizard has something to show them as a starting point.
  app.get("/api/settings/identity", (c) => {
    let content = loadIdentity(ctx.global);
    if (!content) {
      const templatePath = path.join(TEMPLATES_DIR, "identity.md");
      if (fs.existsSync(templatePath)) {
        content = fs.readFileSync(templatePath, "utf8");
      }
    }
    return c.json({ content });
  });
  app.put("/api/settings/identity", async (c) => {
    const payload = (await c.req.json()) as { content: string };
    saveIdentity(ctx.global, payload.content || "");
    return c.json({ ok: true });
  });

  // Wake settings
  app.get("/api/settings/wakes", (c) => {
    const { data, body } = loadWakeSettings(ctx.global);
    return c.json({ data, body });
  });
  app.put("/api/settings/wakes", async (c) => {
    const payload = (await c.req.json()) as { data: any; body: string };
    saveWakeSettings(ctx.global, payload.data, payload.body || "");
    // Reload the scheduler with the new wake times
    ctx.scheduler.reload();
    return c.json({ ok: true });
  });
}
