/**
 * /api/domains/:slug/backup — pre-Dovai backup management.
 *
 *   GET    /api/domains/:slug/backup          — backup metadata
 *   POST   /api/domains/:slug/backup/restore  — restore domain to pre-Dovai state
 *   DELETE /api/domains/:slug/backup           — delete backup to reclaim disk
 */
import type { Hono } from "hono";
import type { ServerContext } from "../types.ts";
import { loadDomainsRegistry } from "../../lib/domains.ts";
import { domainPaths } from "../../lib/global_paths.ts";
import { loadPreDovaiBackup, restorePreDovaiBackup, deletePreDovaiBackup } from "../../lib/backup.ts";
import { updateLifecycle } from "../../lib/lifecycle.ts";

function sanitizeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase();
}

export function registerBackupRoute(app: Hono, ctx: ServerContext): void {
  // Get backup metadata
  app.get("/api/domains/:slug/backup", (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const registry = loadDomainsRegistry(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    const dp = domainPaths(ctx.global, slug, domain.root);
    const backup = loadPreDovaiBackup(dp);
    if (!backup) return c.json({ error: "no backup found" }, 404);

    return c.json({
      created_at: backup.created_at,
      method: backup.method,
      backup_root: backup.backup_root,
      file_count: backup.file_count,
      total_bytes: backup.total_bytes,
    });
  });

  // Restore domain to pre-Dovai state (nuclear — stops clerk, restores files,
  // resets lifecycle). The pre-restore snapshot preserves any files added after
  // backup, and its path is returned so the caller can inform the user.
  app.post("/api/domains/:slug/backup/restore", async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const registry = loadDomainsRegistry(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    // Stop the clerk before touching files
    await ctx.clerk.removeDomain(slug);

    const dp = domainPaths(ctx.global, slug, domain.root);
    try {
      const result = await restorePreDovaiBackup(dp);

      // Reset lifecycle — domain is back to pre-Dovai state
      updateLifecycle(dp, (lc) => {
        lc.smart_folders.status = "not_started";
        lc.smart_folders.ran_at = undefined;
        lc.smart_folders.error = undefined;
        lc.indexing.status = "not_started";
        lc.indexing.started_at = undefined;
        lc.indexing.completed_at = undefined;
      });

      // Re-register domain (without starting indexing)
      await ctx.clerk.addDomain(domain);

      return c.json({
        ok: true,
        restored_files: result.restored_files,
        snapshot_path: result.snapshot_path,
      });
    } catch (err) {
      // Re-register the domain even on failure so it stays in the system
      try {
        await ctx.clerk.addDomain(domain);
      } catch {
        /* ignore */
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  // Delete pre-Dovai backup to reclaim disk space
  app.delete("/api/domains/:slug/backup", async (c) => {
    const slug = sanitizeSlug(c.req.param("slug"));
    const registry = loadDomainsRegistry(ctx.global);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) return c.json({ error: "domain not found" }, 404);

    const dp = domainPaths(ctx.global, slug, domain.root);
    try {
      await deletePreDovaiBackup(dp);
      updateLifecycle(dp, (lc) => {
        lc.backup.status = "declined";
        lc.backup.ref = undefined;
        lc.backup.created_at = undefined;
      });
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });
}
