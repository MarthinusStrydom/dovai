/**
 * /api/domains — domain registry CRUD.
 *
 *   GET    /api/domains                    — list all domains with compile status
 *   POST   /api/domains                    — register new domain { slug, name, path }
 *   PUT    /api/domains/:slug              — update domain config
 *   DELETE /api/domains/:slug              — unregister (preserves files)
 *   POST   /api/domains/:slug/rescan       — force re-index
 *   POST   /api/domains/:slug/reset-index  — wipe compile state + index, restart fresh
 *   GET    /api/domains/:slug/context       — read domain context.md
 *   PUT    /api/domains/:slug/context       — write domain context.md
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import type { ServerContext } from "../types.ts";
import { loadDomainsRegistry } from "../../lib/domains.ts";
import { loadDomainContext, saveDomainContext } from "../../lib/config.ts";
import { domainPaths } from "../../lib/global_paths.ts";
import { loadLifecycle, updateLifecycle } from "../../lib/lifecycle.ts";
import { createPreDovaiBackup, loadPreDovaiBackup } from "../../lib/backup.ts";
import { classifyDomain } from "../../lib/domain_size.ts";
import { walkDomain } from "../../filing_clerk/scanner.ts";

function sanitizeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase();
}

/**
 * Compute domain size by walking the domain's file tree. The walk honours
 * the scanner's ignored-dir rules, so the reported count matches what the
 * filing clerk would actually index. Defensive against missing roots and
 * I/O errors — returns zeros rather than throwing.
 */
async function computeDomainSize(
  gp: ReturnType<typeof import("../../lib/global_paths.ts").globalPaths>,
  slug: string,
  root: string,
): Promise<{ file_count: number; total_bytes: number }> {
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { file_count: 0, total_bytes: 0 };
    }
    const dp = domainPaths(gp, slug, root);
    const files = await walkDomain(dp);
    let bytes = 0;
    for (const rel of files) {
      try {
        const st = await fsp.stat(path.join(root, rel));
        bytes += st.size;
      } catch {
        // ignore unreadable files
      }
    }
    return { file_count: files.length, total_bytes: bytes };
  } catch {
    return { file_count: 0, total_bytes: 0 };
  }
}

export function registerDomainsRoute(app: Hono, ctx: ServerContext): void {
  // List all domains with compile status + lifecycle + backup metadata.
  // Note: intentionally does NOT include domain size on the list endpoint
  // (walking every domain on every list call would be expensive). Callers
  // wanting size should hit GET /api/domains/:slug.
  app.get("/api/domains", (c) => {
    const registry = loadDomainsRegistry(ctx.global);
    const domainProgress = ctx.clerk.domainProgress();
    const domains = registry.domains.map((d) => {
      const dp = domainPaths(ctx.global, d.slug, d.root);
      const lifecycle = loadLifecycle(dp);
      const backup = loadPreDovaiBackup(dp);
      return {
        slug: d.slug,
        name: d.name,
        root: d.root,
        enabled: d.enabled,
        added_at: d.added_at,
        compile: domainProgress[d.slug] ?? null,
        lifecycle,
        backup: backup
          ? {
              created_at: backup.created_at,
              method: backup.method,
              backup_root: backup.backup_root,
              file_count: backup.file_count,
              total_bytes: backup.total_bytes,
            }
          : null,
      };
    });
    return c.json(domains);
  });

  // Per-domain detail: everything the per-domain Web UI page needs in one
  // round-trip, including a fresh domain-size classification.
  app.get("/api/domains/:slug", async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const registry = loadDomainsRegistry(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    const dp = domainPaths(ctx.global, slug, domain.root);
    const lifecycle = loadLifecycle(dp);
    const backup = loadPreDovaiBackup(dp);
    const compile = ctx.clerk.domainProgress()[slug] ?? null;
    const { file_count, total_bytes } = await computeDomainSize(ctx.global, slug, domain.root);
    const size = classifyDomain(file_count, total_bytes);

    return c.json({
      slug: domain.slug,
      name: domain.name,
      root: domain.root,
      enabled: domain.enabled,
      added_at: domain.added_at,
      compile,
      lifecycle,
      size,
      backup: backup
        ? {
            created_at: backup.created_at,
            method: backup.method,
            backup_root: backup.backup_root,
            file_count: backup.file_count,
            total_bytes: backup.total_bytes,
          }
        : null,
    });
  });

  // Register a new domain — creates backup, initialises lifecycle, does NOT
  // auto-start indexing. The user must explicitly click "Start Indexing" or
  // call POST /api/domains/:slug/indexing/start.
  app.post("/api/domains", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      slug?: string;
      name?: string;
      path?: string;
    };
    if (!body.path) return c.json({ error: "path required" }, 400);
    if (!body.name) return c.json({ error: "name required" }, 400);

    const slug = sanitizeSlug(body.slug || body.name);
    if (!slug) return c.json({ error: "invalid slug" }, 400);

    const absPath = body.path;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
      return c.json({ error: "path does not exist or is not a directory" }, 400);
    }

    // Check for duplicates
    const existing = loadDomainsRegistry(ctx.global);
    if (existing.domains.some((d) => d.slug === slug)) {
      return c.json({ error: `domain '${slug}' already exists` }, 409);
    }

    // Create pre-Dovai backup before registering (blocks response).
    // Backup runs first because it's the most likely step to fail (disk full,
    // permissions). If it succeeds, registration + lifecycle are written together.
    const dp = domainPaths(ctx.global, slug, absPath);
    let backup;
    try {
      backup = await createPreDovaiBackup(dp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `backup failed — domain not registered: ${msg}` }, 500);
    }

    // Register domain (no auto-start), then write lifecycle.
    // If registration fails, the backup dir is harmless (user can delete it).
    const config = {
      slug,
      name: body.name,
      root: absPath,
      added_at: new Date().toISOString(),
      enabled: true,
    };
    await ctx.clerk.addDomain(config);

    updateLifecycle(dp, (lc) => {
      lc.backup.status = "complete";
      lc.backup.ref = backup.backup_root;
      lc.backup.created_at = backup.created_at;
    });

    return c.json({ ok: true, slug });
  });

  // Update domain config (name, path, enabled)
  app.put("/api/domains/:slug", async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      root?: string;
      enabled?: boolean;
    };

    const { loadDomainsRegistry: reload, addDomainToRegistry } = await import("../../lib/domains.ts");
    const registry = reload(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    let needsRestart = false;

    if (typeof body.name === "string" && body.name !== domain.name) {
      domain.name = body.name;
    }

    if (typeof body.root === "string" && body.root !== domain.root) {
      if (!fs.existsSync(body.root) || !fs.statSync(body.root).isDirectory()) {
        return c.json({ error: "path does not exist or is not a directory" }, 400);
      }
      domain.root = body.root;
      needsRestart = true;
    }

    // Persist the updated domain config
    addDomainToRegistry(ctx.global, domain);

    if (typeof body.enabled === "boolean" && body.enabled !== domain.enabled) {
      if (body.enabled) {
        domain.enabled = true;
        addDomainToRegistry(ctx.global, domain);
        await ctx.clerk.addDomain(domain);
        // Resume indexing if it was previously started
        const dp = domainPaths(ctx.global, slug, domain.root);
        const lifecycle = loadLifecycle(dp);
        if (lifecycle.indexing.status !== "not_started") {
          await ctx.clerk.startIndexing(slug);
        }
      } else {
        await ctx.clerk.removeDomain(slug);
        domain.enabled = false;
        addDomainToRegistry(ctx.global, domain);
      }
    } else if (needsRestart && domain.enabled) {
      // Path changed — restart the clerk with the new root
      await ctx.clerk.resetDomainIndex(slug);
    }

    return c.json({ ok: true });
  });

  // Unregister a domain (preserves files)
  app.delete("/api/domains/:slug", async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const registry = loadDomainsRegistry(ctx.global);
    if (!registry.domains.some((d) => d.slug === slug)) {
      return c.json({ error: "domain not found" }, 404);
    }

    await ctx.clerk.removeDomain(slug);
    return c.json({ ok: true });
  });

  // Force re-index a domain
  app.post("/api/domains/:slug/rescan", async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const registry = loadDomainsRegistry(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    // Remove and re-add to force a fresh scan, then start indexing
    await ctx.clerk.removeDomain(slug);
    await ctx.clerk.addDomain(domain);
    await ctx.clerk.startIndexing(slug);
    return c.json({ ok: true });
  });

  // Reset domain index — wipe compile state + summary files, restart fresh
  app.post("/api/domains/:slug/reset-index", async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    try {
      await ctx.clerk.resetDomainIndex(slug);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  // Read domain context
  app.get("/api/domains/:slug/context", (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const registry = loadDomainsRegistry(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    const dp = domainPaths(ctx.global, slug, domain.root);
    const content = loadDomainContext(dp);
    return c.json({ slug, content });
  });

  // Write domain context
  app.put("/api/domains/:slug/context", async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const body = (await c.req.json().catch(() => ({}))) as { content?: string };
    if (typeof body.content !== "string") return c.json({ error: "content required" }, 400);

    const registry = loadDomainsRegistry(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    const dp = domainPaths(ctx.global, slug, domain.root);
    saveDomainContext(dp, body.content);
    return c.json({ ok: true });
  });
}
