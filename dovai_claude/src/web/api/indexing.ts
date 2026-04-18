/**
 * /api/domains/:slug/indexing — explicit indexing control.
 *
 * Domains no longer auto-index on registration. The user must start indexing
 * explicitly via this endpoint (or the Web UI button that calls it).
 */
import type { Hono } from "hono";
import type { ServerContext } from "../types.ts";
import { loadDomainsRegistry } from "../../lib/domains.ts";
import { domainPaths } from "../../lib/global_paths.ts";
import { loadLifecycle } from "../../lib/lifecycle.ts";

function sanitizeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase();
}

export function registerIndexingRoute(app: Hono, ctx: ServerContext): void {
  // Start indexing for a domain
  app.post("/api/domains/:slug/indexing/start", async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const registry = loadDomainsRegistry(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    const dp = domainPaths(ctx.global, slug, domain.root);
    const lifecycle = loadLifecycle(dp);

    if (lifecycle.indexing.status === "running") {
      return c.json({ error: "indexing already in progress" }, 409);
    }
    if (lifecycle.smart_folders.status === "running") {
      return c.json({ error: "Cannot start indexing while Smart Folders is in progress" }, 409);
    }

    try {
      await ctx.clerk.startIndexing(slug);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });
}
