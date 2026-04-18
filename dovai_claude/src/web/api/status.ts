/**
 * GET /api/status  → overall status, per-domain compile progress, lock state, counts.
 * Polled by the web UI every few seconds for live progress updates.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import type { Hono } from "hono";
import type { ServerContext } from "../types.ts";
import { isLocked, readLock } from "../../lib/lock.ts";
import { dataDirPointerPath } from "../../lib/global_paths.ts";
import { listWakeQueue } from "../../wake/queue.ts";
import { loadWorkspaceSettings, computeSetupStatus } from "../../lib/config.ts";
import { loadDomainsRegistry } from "../../lib/domains.ts";
import { domainPaths } from "../../lib/global_paths.ts";
import { loadLifecycle } from "../../lib/lifecycle.ts";

async function countDir(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() || e.isDirectory()).length;
  } catch {
    return 0;
  }
}

async function countFailures(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export function registerStatusRoute(app: Hono, ctx: ServerContext): void {
  app.get("/api/status", async (c) => {
    const { global: gp, clerk } = ctx;
    const progress = clerk.progress;
    const domainProgress = clerk.domainProgress();
    const wakeQueue = await listWakeQueue(gp);
    const sessionLock = readLock(gp.sessionLock);
    const wakeLock = readLock(gp.wakeLock);
    const { data: wsSettings } = loadWorkspaceSettings(gp);
    const setup = computeSetupStatus(gp);

    const [activeTaskCount, doneTaskCount, draftCount, emailFails, telegramFails] =
      await Promise.all([
        countDir(gp.tasksActive),
        countDir(gp.tasksDone),
        countDir(gp.drafts),
        countFailures(gp.emailFailed),
        countFailures(gp.telegramFailed),
      ]);

    // Knowledge graph stats
    const graphStats = clerk.knowledgeGraph.stats();

    // Per-domain stale counts
    let totalStale = 0;
    const domainStale: Record<string, number> = {};
    for (const slug of clerk.domainSlugs()) {
      const state = clerk.domainCompileState(slug);
      if (!state) continue;
      const stale = Object.values(state.files).filter((e) => e.stale).length;
      domainStale[slug] = stale;
      totalStale += stale;
    }

    // Domain registry info
    const registry = loadDomainsRegistry(gp);

    const dataDirConfigured = fsSync.existsSync(dataDirPointerPath(gp.stateRoot));

    return c.json({
      home: gp.dovaiHome,
      state_root: gp.stateRoot,
      data_root: gp.dataRoot,
      data_dir_configured: dataDirConfigured,
      ai_name: wsSettings.ai_name,
      setup,
      compile: {
        ...progress,
        stale: totalStale,
      },
      domains: registry.domains.map((d) => {
        const dp = domainPaths(gp, d.slug, d.root);
        return {
          slug: d.slug,
          name: d.name,
          root: d.root,
          enabled: d.enabled,
          compile: domainProgress[d.slug] ?? null,
          lifecycle: loadLifecycle(dp),
          stale: domainStale[d.slug] ?? 0,
        };
      }),
      wake: {
        queue_size: wakeQueue.length,
        session_active: isLocked(gp.sessionLock, "session"),
        session_pid: sessionLock?.pid ?? null,
        wake_in_flight: isLocked(gp.wakeLock, "wake"),
        wake_pid: wakeLock?.pid ?? null,
      },
      counts: {
        active_tasks: activeTaskCount,
        done_tasks: doneTaskCount,
        pending_drafts: draftCount,
      },
      failures: {
        email: emailFails,
        telegram: telegramFails,
        total: emailFails + telegramFails,
      },
      knowledge_graph: graphStats,
      time: new Date().toISOString(),
    });
  });
}
