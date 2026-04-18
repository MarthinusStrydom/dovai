/**
 * Filing Clerk coordinator.
 *
 * Manages one DomainClerk per registered domain, plus a shared
 * KnowledgeGraph. The coordinator is what the rest of the server
 * interacts with — it delegates domain-specific work to the clerks.
 *
 * Lifecycle:
 *   1. Constructor: loads domain registry, creates DomainClerk per domain
 *   2. start()    : starts all DomainClerks
 *   3. stop()     : stops all DomainClerks
 *   4. addDomain/removeDomain: hot-add/remove with registry persistence
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DomainClerk } from "./domain_clerk.ts";
import { KnowledgeGraph } from "../lib/knowledge_graph.ts";
import { loadDomainsRegistry, addDomainToRegistry, removeDomainFromRegistry } from "../lib/domains.ts";
import { domainPaths, type GlobalPaths, type DomainPaths, type DomainConfig } from "../lib/global_paths.ts";
import type { CompileProgress } from "../lib/compile_state.ts";
import { loadLifecycle, updateLifecycle } from "../lib/lifecycle.ts";
import type { Logger } from "../lib/logger.ts";

export class FilingClerk {
  private clerks = new Map<string, DomainClerk>();
  private logger: Logger;
  readonly knowledgeGraph: KnowledgeGraph;

  constructor(
    private readonly gp: GlobalPaths,
    logger: Logger,
  ) {
    this.logger = logger.child("clerk");
    this.knowledgeGraph = new KnowledgeGraph(gp);

    // Create a DomainClerk for each registered domain
    const registry = loadDomainsRegistry(gp);
    for (const domain of registry.domains) {
      if (!domain.enabled) continue;
      const dp = domainPaths(gp, domain.slug, domain.root);
      const clerk = new DomainClerk(dp, gp, this.knowledgeGraph, logger);
      this.clerks.set(domain.slug, clerk);
    }
  }

  /** Aggregate progress across all domains. */
  get progress(): CompileProgress {
    let total = 0;
    let compiled = 0;
    let pending = 0;
    let failed = 0;
    let allDone = true;
    for (const clerk of this.clerks.values()) {
      const p = clerk.progress;
      total += p.total;
      compiled += p.compiled;
      pending += p.pending;
      failed += p.failed;
      if (!p.initial_compile_completed) allDone = false;
    }
    const percent = total === 0 ? 100 : Math.round((compiled / total) * 100);
    return { total, compiled, pending, failed, percent, initial_compile_completed: allDone };
  }

  /** True if ALL domains have completed initial compile. */
  get initialCompileCompleted(): boolean {
    if (this.clerks.size === 0) return true;
    for (const clerk of this.clerks.values()) {
      if (!clerk.initialCompileCompleted) return false;
    }
    return true;
  }

  /** True if at least one domain has completed initial compile. */
  get anyDomainCompileCompleted(): boolean {
    if (this.clerks.size === 0) return true;
    for (const clerk of this.clerks.values()) {
      if (clerk.initialCompileCompleted) return true;
    }
    return false;
  }

  /** Check if a specific domain has completed initial compile. */
  isDomainCompileCompleted(slug: string): boolean {
    const clerk = this.clerks.get(slug);
    if (!clerk) return true; // unknown domain — don't block
    return clerk.initialCompileCompleted;
  }

  /** Per-domain progress for the status endpoint. */
  domainProgress(): Record<string, CompileProgress> {
    const result: Record<string, CompileProgress> = {};
    for (const [slug, clerk] of this.clerks) {
      result[slug] = clerk.progress;
    }
    return result;
  }

  /** Get the compile state for a specific domain. */
  domainCompileState(slug: string) {
    return this.clerks.get(slug)?.compileState;
  }

  /** List all active domain slugs. */
  domainSlugs(): string[] {
    return [...this.clerks.keys()];
  }

  /**
   * Start domain clerks whose lifecycle indicates indexing has been requested.
   * Domains still in "not_started" (waiting for the user to click Start
   * Indexing) are left idle. Pre-existing domains that were indexed before
   * lifecycle.json existed are auto-migrated.
   */
  async start(): Promise<void> {
    this.logger.info("starting filing clerk coordinator", {
      domains: [...this.clerks.keys()],
    });

    // Clean up orphaned OCR temp directories from prior crashes
    cleanupOcrTempDirs(this.logger);

    const registry = loadDomainsRegistry(this.gp);
    const startPromises: Promise<void>[] = [];

    for (const [slug, clerk] of this.clerks) {
      const domain = registry.domains.find((d) => d.slug === slug);
      if (!domain) continue;

      const dp = domainPaths(this.gp, slug, domain.root);
      const lifecycle = loadLifecycle(dp);

      // Detect Smart Folders runs interrupted by a server restart.
      // The orchestrator runs in-process, so "running" at boot means it
      // was killed mid-flight. Mark it as errored so the user can retry.
      if (lifecycle.smart_folders.status === "running") {
        updateLifecycle(dp, (lc) => {
          lc.smart_folders.status = "errored";
          lc.smart_folders.error = "Run interrupted by server restart. Click Retry to try again.";
        });
        this.logger.warn("reset stale Smart Folders run", { slug });
      }

      if (lifecycle.indexing.status === "not_started") {
        // Migration: domain indexed before lifecycle.json existed
        if (clerk.initialCompileCompleted) {
          updateLifecycle(dp, (lc) => {
            lc.indexing.status = "complete";
            lc.indexing.completed_at = new Date().toISOString();
          });
          startPromises.push(clerk.start());
        }
        // else: new domain awaiting explicit start — leave idle
      } else {
        // "running" or "complete" — resume (watcher + diff scan)
        startPromises.push(clerk.start());
      }
    }

    await Promise.all(startPromises);
  }

  /** Stop all domain clerks. */
  async stop(): Promise<void> {
    const stopPromises = [...this.clerks.values()].map((c) => c.stop());
    await Promise.all(stopPromises);
    this.logger.info("filing clerk coordinator stopped");
  }

  /**
   * Register a new domain. Creates a DomainClerk but does NOT start indexing.
   * Call startIndexing(slug) explicitly when the user requests it.
   */
  async addDomain(config: DomainConfig): Promise<void> {
    if (this.clerks.has(config.slug)) {
      await this.removeDomain(config.slug);
    }
    addDomainToRegistry(this.gp, config);
    const dp = domainPaths(this.gp, config.slug, config.root);
    const clerk = new DomainClerk(dp, this.gp, this.knowledgeGraph, this.logger);
    this.clerks.set(config.slug, clerk);
    this.logger.info("domain registered", { slug: config.slug, root: config.root });
  }

  /**
   * Start indexing for a registered domain. Updates lifecycle on first start,
   * then starts the DomainClerk (scan + compile + watcher).
   */
  async startIndexing(slug: string): Promise<void> {
    const clerk = this.clerks.get(slug);
    if (!clerk) throw new Error(`domain '${slug}' not registered`);

    const registry = loadDomainsRegistry(this.gp);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) throw new Error(`domain '${slug}' not found in registry`);

    const dp = domainPaths(this.gp, slug, domain.root);
    updateLifecycle(dp, (lc) => {
      if (lc.indexing.status === "not_started") {
        lc.indexing.status = "running";
        lc.indexing.started_at = new Date().toISOString();
      }
    });

    await clerk.start();
    this.logger.info("indexing started", { slug });
  }

  /**
   * Reset a domain's index: stop clerk, wipe compile.json + index/,
   * clear KG contributions, then restart the clerk fresh.
   * The domain stays registered — only its compiled data is erased.
   */
  async resetDomainIndex(slug: string): Promise<void> {
    const registry = loadDomainsRegistry(this.gp);
    const domain = registry.domains.find((d) => d.slug === slug);
    if (!domain) throw new Error(`domain '${slug}' not found in registry`);

    // 1. Stop the running clerk
    const clerk = this.clerks.get(slug);
    if (clerk) {
      await clerk.stop();
      this.clerks.delete(slug);
    }

    // 2. Wipe compile state
    const dp = domainPaths(this.gp, slug, domain.root);
    const emptyState = JSON.stringify({ version: 1, files: {} });
    fs.writeFileSync(dp.compileJson, emptyState);

    // 3. Wipe index directory
    if (fs.existsSync(dp.indexDir)) {
      await fsp.rm(dp.indexDir, { recursive: true, force: true });
      fs.mkdirSync(dp.indexDir, { recursive: true });
    }

    // 4. Clear knowledge graph contributions for this domain
    this.knowledgeGraph.removeDomainContributions(slug);
    this.knowledgeGraph.save();

    // 5. Update lifecycle — indexing restarts from scratch
    updateLifecycle(dp, (lc) => {
      lc.indexing.status = "running";
      lc.indexing.started_at = new Date().toISOString();
      lc.indexing.completed_at = undefined;
    });

    // 6. Start a fresh clerk — will see everything as new and recompile
    const freshClerk = new DomainClerk(dp, this.gp, this.knowledgeGraph, this.logger);
    this.clerks.set(slug, freshClerk);
    await freshClerk.start();

    this.logger.info("domain index reset", { slug });
  }

  /** Hot-remove a domain. Stops its DomainClerk and removes from registry. */
  async removeDomain(slug: string): Promise<void> {
    const clerk = this.clerks.get(slug);
    if (clerk) {
      await clerk.stop();
      this.clerks.delete(slug);
    }
    removeDomainFromRegistry(this.gp, slug);
    this.knowledgeGraph.removeDomainContributions(slug);
    this.knowledgeGraph.save();
    this.logger.info("domain removed", { slug });
  }
}

/**
 * Remove orphaned /tmp/dovai-ocr-* directories left behind by a prior
 * crash during PDF OCR extraction. These are safe to delete — they only
 * contain intermediate OCR output that's already been consumed or abandoned.
 */
function cleanupOcrTempDirs(logger: Logger): void {
  try {
    const tmpDir = os.tmpdir();
    const entries = fs.readdirSync(tmpDir);
    let cleaned = 0;
    for (const entry of entries) {
      if (!entry.startsWith("dovai-ocr-")) continue;
      const abs = path.join(tmpDir, entry);
      try {
        fs.rmSync(abs, { recursive: true, force: true });
        cleaned++;
      } catch {
        // ignore — may be in use by another process
      }
    }
    if (cleaned > 0) {
      logger.info("cleaned up orphaned OCR temp directories", { count: cleaned });
    }
  } catch {
    // /tmp unreadable — not fatal
  }
}
