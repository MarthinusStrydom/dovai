/**
 * /api/domains/:slug/smart-folders — Smart Folders API.
 *
 *   POST  /smart-folders/start     — kick off Smart Folders
 *   GET   /smart-folders/progress  — poll progress
 *   POST  /smart-folders/skip      — mark skipped, unlock indexing
 *   POST  /smart-folders/unwind    — reverse the reorg
 *   GET   /smart-folders/triage    — list files + verdicts + reasons
 *   PATCH /smart-folders/triage    — override a file's verdict
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { Hono } from "hono";
import type { ServerContext } from "../types.ts";
import { loadDomainsRegistry } from "../../lib/domains.ts";
import { domainPaths } from "../../lib/global_paths.ts";
import { loadLifecycle, updateLifecycle } from "../../lib/lifecycle.ts";
import { runSmartFolders, getProgress } from "../../smart_folders/index.ts";
import { loadSmartFoldersResult, unwindSmartFolders } from "../../smart_folders/unwind.ts";
import type { TriageOverrides } from "../../smart_folders/types.ts";
import type { TriageVerdict } from "../../lib/triage.ts";

function sanitizeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase();
}

export function registerSmartFoldersRoute(app: Hono, ctx: ServerContext): void {
  // Start Smart Folders
  app.post("/api/domains/:slug/smart-folders/start", async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const registry = loadDomainsRegistry(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    const dp = domainPaths(ctx.global, slug, domain.root);
    const lifecycle = loadLifecycle(dp);

    if (lifecycle.smart_folders.status === "running") {
      return c.json({ error: "Smart Folders already running" }, 409);
    }
    if (lifecycle.smart_folders.status === "complete") {
      return c.json({ error: "Smart Folders already completed. Unwind first to re-run." }, 409);
    }
    if (lifecycle.indexing.status === "running") {
      return c.json({ error: "Cannot start Smart Folders while indexing is in progress" }, 409);
    }

    // Fire and forget — the orchestrator manages its own lifecycle + errors
    void runSmartFolders(dp, ctx.global, ctx.logger).catch(() => {
      // Error is already logged + written to lifecycle by the orchestrator
    });

    return c.json({ ok: true, status: "started" });
  });

  // Poll progress
  app.get("/api/domains/:slug/smart-folders/progress", (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const progress = getProgress(slug);
    if (!progress) {
      // Check lifecycle for stored state
      const registry = loadDomainsRegistry(ctx.global);
      const domain = registry.domains.find((d) => d.slug === slug);
      if (!domain) return c.json({ error: "domain not found" }, 404);
      const dp = domainPaths(ctx.global, slug, domain.root);
      const lifecycle = loadLifecycle(dp);
      return c.json({
        phase: lifecycle.smart_folders.status === "complete" ? "complete"
             : lifecycle.smart_folders.status === "errored" ? "errored"
             : "not_started",
        done_files: 0,
        total_files: 0,
        error: lifecycle.smart_folders.error,
      });
    }
    return c.json(progress);
  });

  // Skip Smart Folders — marks it as skipped, unlocks indexing
  app.post("/api/domains/:slug/smart-folders/skip", (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const registry = loadDomainsRegistry(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    const dp = domainPaths(ctx.global, slug, domain.root);
    updateLifecycle(dp, (lc) => {
      lc.smart_folders.status = "skipped";
    });

    return c.json({ ok: true });
  });

  // Unwind Smart Folders — reverse all moves
  app.post("/api/domains/:slug/smart-folders/unwind", async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const registry = loadDomainsRegistry(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    const dp = domainPaths(ctx.global, slug, domain.root);
    const lifecycle = loadLifecycle(dp);

    if (lifecycle.smart_folders.status !== "complete") {
      return c.json({ error: "Smart Folders has not completed — nothing to unwind" }, 400);
    }

    // Stop the clerk if indexing was running
    if (lifecycle.indexing.status !== "not_started") {
      try {
        await ctx.clerk.removeDomain(slug);
      } catch {
        /* ignore if not running */
      }
    }

    try {
      const result = await unwindSmartFolders(dp, ctx.logger);

      // Reset lifecycle
      updateLifecycle(dp, (lc) => {
        lc.smart_folders.status = "not_started";
        lc.smart_folders.ran_at = undefined;
        lc.smart_folders.error = undefined;
        lc.indexing.status = "not_started";
        lc.indexing.started_at = undefined;
        lc.indexing.completed_at = undefined;
      });

      // Clean up result file
      if (fs.existsSync(dp.smartFoldersResult)) {
        await fsp.unlink(dp.smartFoldersResult);
      }

      // Re-register domain
      const regDomain = registry.domains.find((d) => d.slug === slug);
      if (regDomain) {
        await ctx.clerk.addDomain(regDomain);
      }

      return c.json({
        ok: true,
        reversed: result.reversed,
        skipped: result.skipped,
      });
    } catch (err) {
      // Re-register even on failure
      const regDomain = registry.domains.find((d) => d.slug === slug);
      if (regDomain) {
        try { await ctx.clerk.addDomain(regDomain); } catch { /* ignore */ }
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  // Get triage verdicts (result.json + overrides.json merged)
  app.get("/api/domains/:slug/smart-folders/triage", (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const registry = loadDomainsRegistry(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    const dp = domainPaths(ctx.global, slug, domain.root);
    const result = loadSmartFoldersResult(dp);
    if (!result) return c.json({ error: "no Smart Folders result" }, 404);

    // Layer overrides on top
    let overrides: Record<string, TriageVerdict> = {};
    try {
      const raw = fs.readFileSync(dp.smartFoldersOverrides, "utf8");
      const parsed = JSON.parse(raw) as TriageOverrides;
      if (parsed.version === 1) overrides = parsed.overrides;
    } catch {
      // no overrides
    }

    const merged: Record<string, TriageVerdict> = { ...result.triage, ...overrides };

    return c.json({
      triage: merged,
      summary: result.summary,
      has_overrides: Object.keys(overrides).length > 0,
    });
  });

  // Override a single file's triage verdict
  app.patch("/api/domains/:slug/smart-folders/triage", async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const body = (await c.req.json().catch(() => ({}))) as {
      file?: string;
      verdict?: string;
      reason?: string;
    };
    if (!body.file) return c.json({ error: "file required" }, 400);
    if (!body.verdict || !["keep", "skip", "defer"].includes(body.verdict)) {
      return c.json({ error: "verdict must be keep, skip, or defer" }, 400);
    }

    const registry = loadDomainsRegistry(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    const dp = domainPaths(ctx.global, slug, domain.root);

    // Load existing overrides
    let overridesFile: TriageOverrides = { version: 1, overrides: {} };
    try {
      const raw = fs.readFileSync(dp.smartFoldersOverrides, "utf8");
      const parsed = JSON.parse(raw) as TriageOverrides;
      if (parsed.version === 1) overridesFile = parsed;
    } catch {
      // no existing file
    }

    overridesFile.overrides[body.file] = {
      verdict: body.verdict as "keep" | "skip" | "defer",
      reason: body.reason,
    };

    await fsp.mkdir(dp.smartFoldersDir, { recursive: true });
    const tmp = dp.smartFoldersOverrides + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(overridesFile, null, 2));
    await fsp.rename(tmp, dp.smartFoldersOverrides);

    return c.json({ ok: true });
  });
}
