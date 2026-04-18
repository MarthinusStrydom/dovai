/**
 * DomainClerk: per-domain filing clerk.
 *
 * Each domain (EHHOA, Personal, etc.) gets its own DomainClerk instance
 * that owns its CompileState, Compiler, FileWatcher, and job queue. The
 * coordinator FilingClerk creates and manages these.
 *
 * Lifecycle:
 *   1. start()       — initial scan, compile, start watcher
 *   2. events queued in-memory, drained by a single async worker
 *   3. compiled files push wake events (tagged with domain slug)
 *   4. after initial compile: generate folder digests
 *   5. stop()        — stops watcher, exits
 *
 * Resilience:
 *   - Circuit breaker pauses queue after consecutive transient failures
 *   - Health check polls LM Studio and resumes queue when it's back
 *   - Flap detection: exponential backoff on repeated open/close cycles
 *   - Orphaned "compiling" entries reset to "pending" on startup
 *   - Transient failures reset to "pending" on startup for retry
 *   - Watcher deferred until initial scan completes (no race conditions)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Compiler } from "./compiler.ts";
import { diffScan, type ScanResult } from "./scanner.ts";
import { FileWatcher, type FileEvent } from "./file_watcher.ts";
import {
  loadCompileState,
  saveCompileState,
  type CompileState,
  computeProgress,
  type CompileProgress,
} from "../lib/compile_state.ts";
import { enqueueWake } from "../wake/queue.ts";
import { consumeFileWakeSuppression } from "../lib/file_suppressions.ts";
import { KnowledgeGraph } from "../lib/knowledge_graph.ts";
import { qualify } from "../lib/global_paths.ts";
import { markDependentsStale, clearStale } from "./staleness.ts";
import { generateAllDigests, regenerateDigestForFile } from "./digest.ts";
import { loadProviderSettings } from "../lib/config.ts";
import { updateLifecycle } from "../lib/lifecycle.ts";
import type { DomainPaths, GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";

type Job =
  | { kind: "compile"; relPath: string; incremental?: boolean }
  | { kind: "remove"; relPath: string };

/** After this many consecutive transient compile failures, pause the queue. */
const CIRCUIT_BREAKER_THRESHOLD = 3;
/** Base interval (ms) for health check when circuit is open. */
const HEALTH_CHECK_BASE_MS = 30_000;
/** Max health check interval after repeated flaps. */
const HEALTH_CHECK_MAX_MS = 5 * 60_000;
/** Max number of open/close cycles before we use max interval. */
const FLAP_BACKOFF_LIMIT = 5;

export class DomainClerk {
  private state: CompileState;
  private compiler: Compiler;
  private watcher: FileWatcher;
  private queue: Job[] = [];
  private processing = false;
  private running = false;
  private stopped = false; // true after stop() — prevents late callbacks
  private initialCompileRunning = false;
  private logger: Logger;

  // ── Domain root reachability ────────────────────────────────────────
  private domainRootCheckTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Circuit breaker state ──────────────────────────────────────────
  private consecutiveTransientFailures = 0;
  private circuitOpen = false;
  private healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many times the circuit has opened — drives backoff. */
  private circuitOpenCount = 0;

  constructor(
    private readonly dp: DomainPaths,
    private readonly gp: GlobalPaths,
    private readonly knowledgeGraph: KnowledgeGraph,
    logger: Logger,
  ) {
    this.logger = logger.child(`clerk:${dp.slug}`);
    this.state = loadCompileState(dp);
    this.compiler = new Compiler({
      domainPaths: dp,
      globalPaths: gp,
      logger: this.logger.child("compile"),
      knowledgeGraph,
    });
    this.watcher = new FileWatcher(dp, this.logger.child("watch"));
  }

  get slug(): string {
    return this.dp.slug;
  }

  get progress(): CompileProgress {
    return computeProgress(this.state);
  }

  get initialCompileCompleted(): boolean {
    return this.state.initial_compile_completed;
  }

  get compileState(): CompileState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.logger.info("starting domain clerk", { domain: this.dp.slug, root: this.dp.domainRoot });

    // Check that the domain root folder is reachable before doing anything
    if (!await this.checkDomainRootReachable()) {
      this.running = false;
      return;
    }

    // Reset orphaned "compiling" entries (server crashed mid-compile)
    this.resetOrphanedCompiling();

    // Reset transient failures (LM Studio was down last run)
    this.resetTransientFailures();

    // Run initial scan+compile. Watcher starts AFTER scan completes
    // to prevent race conditions between scan results and live events.
    void this.runInitialScanAndCompile();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    this.clearHealthCheckTimer();
    if (this.domainRootCheckTimer) {
      clearTimeout(this.domainRootCheckTimer);
      this.domainRootCheckTimer = null;
    }
    await this.watcher.stop();
    this.logger.info("stopped", { domain: this.dp.slug });
  }

  // ── Initial scan & compile ─────────────────────────────────────────

  private async runInitialScanAndCompile(): Promise<void> {
    if (this.initialCompileRunning) return;
    this.initialCompileRunning = true;
    try {
      this.logger.info("scanning domain", { domain: this.dp.slug });
      const scan = await diffScan(this.dp, this.state, this.compiler, this.logger);
      this.logger.info("scan complete", {
        domain: this.dp.slug,
        added: scan.added.length,
        changed: scan.changed.length,
        removed: scan.removed.length,
        unchanged: scan.unchanged.length,
      });

      await this.applyScanResults(scan);

      // Queue any files still in "pending" state (e.g. reset from transient
      // failures or orphaned compiling entries) that the scan reported as unchanged.
      this.requeuePendingFiles();

      await this.drainQueue();

      if (!this.state.initial_compile_completed) {
        this.state.initial_compile_completed = true;
        this.state.initial_compile_completed_at = new Date().toISOString();
        saveCompileState(this.dp, this.state);
        this.logger.info("initial compile complete", { domain: this.dp.slug });

        // Update lifecycle to reflect indexing completion
        updateLifecycle(this.dp, (lc) => {
          if (lc.indexing.status === "running") {
            lc.indexing.status = "complete";
            lc.indexing.completed_at = new Date().toISOString();
          }
        });
      }

      try {
        const digestCount = await generateAllDigests(this.dp, this.gp, this.state, this.logger);
        if (digestCount > 0) {
          this.logger.info("folder digests generated", { domain: this.dp.slug, count: digestCount });
        }
      } catch (err) {
        this.logger.warn("digest generation failed", {
          domain: this.dp.slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const graphStats = this.knowledgeGraph.stats();
      if (graphStats.entities > 0) {
        this.logger.info("knowledge graph populated", graphStats);
      }
    } catch (err) {
      this.logger.error("initial scan/compile failed", {
        domain: this.dp.slug,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.initialCompileRunning = false;

      // Start watcher AFTER initial scan+compile to avoid races.
      if (this.running) {
        this.watcher.start((ev) => this.onFileEvent(ev));
      }
    }
  }

  private async applyScanResults(scan: ScanResult): Promise<void> {
    for (const rel of scan.added) {
      try {
        const entry = await this.compiler.statFile(rel);
        this.state.files[rel] = entry;
        this.queue.push({ kind: "compile", relPath: rel });
      } catch (err) {
        this.logger.warn("stat failed on added file", { rel, error: String(err) });
      }
    }

    for (const rel of scan.changed) {
      try {
        const entry = await this.compiler.statFile(rel);
        this.state.files[rel] = entry;
        this.queue.push({ kind: "compile", relPath: rel });
      } catch (err) {
        this.logger.warn("stat failed on changed file", { rel, error: String(err) });
      }
    }

    for (const rel of scan.removed) {
      this.queue.push({ kind: "remove", relPath: rel });
    }

    saveCompileState(this.dp, this.state);
  }

  // ── File watcher events ────────────────────────────────────────────

  private onFileEvent(ev: FileEvent): void {
    if (!this.running) return;

    if (ev.kind === "unlink") {
      this.queue.push({ kind: "remove", relPath: ev.relPath });
      void this.drainQueue();
    } else {
      void this.compiler
        .statFile(ev.relPath)
        .then((entry) => {
          if (!this.running) return;
          const existing = this.state.files[ev.relPath];
          if (existing && existing.sha256 === entry.sha256 && existing.status === "compiled") {
            return;
          }
          this.state.files[ev.relPath] = entry;
          saveCompileState(this.dp, this.state);
          this.queue.push({ kind: "compile", relPath: ev.relPath, incremental: true });
          void this.drainQueue();
        })
        .catch((err) => {
          this.logger.warn("stat failed on file event", {
            rel: ev.relPath,
            error: String(err),
          });
        });
    }
  }

  // ── Queue processing ───────────────────────────────────────────────

  private async drainQueue(): Promise<void> {
    if (this.processing) return;
    if (this.circuitOpen) return;
    this.processing = true;
    try {
      while (this.queue.length > 0 && this.running && !this.circuitOpen) {
        const job = this.queue.shift()!;
        await this.processJob(job);
      }
    } catch (err) {
      // Catch unexpected errors so the queue worker doesn't die silently.
      this.logger.error("unexpected error in queue drain", {
        domain: this.dp.slug,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.processing = false;
    }
  }

  private async processJob(job: Job): Promise<void> {
    if (job.kind === "remove") {
      await this.handleRemove(job.relPath);
      return;
    }
    await this.handleCompile(job.relPath, job.incremental);
  }

  private async handleCompile(relPath: string, incremental?: boolean): Promise<void> {
    const entry = this.state.files[relPath];
    if (!entry) return;
    this.logger.info("compiling", { file: relPath, domain: this.dp.slug, priority: incremental ? "high" : "normal" });

    clearStale(this.state, relPath);

    const updated = await this.compiler.compile(entry, this.state, incremental ? "high" : "normal");
    this.state.files[relPath] = updated;
    saveCompileState(this.dp, this.state);

    // Circuit breaker: track consecutive transient failures
    if (updated.status === "failed" && updated.error_transient) {
      this.consecutiveTransientFailures++;
      if (this.consecutiveTransientFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        // Revert ALL transient-failed entries in this burst back to pending.
        // They'll be requeued when the circuit closes.
        this.revertTransientBurstToPending();
        this.openCircuit();
      }
      return;
    }

    // Successful compile or permanent failure — reset the streak
    if (updated.status === "compiled" || (updated.status === "failed" && !updated.error_transient)) {
      this.consecutiveTransientFailures = 0;
    }

    if (updated.status === "compiled") {
      const staleFiles = markDependentsStale(this.state, relPath, this.logger);
      if (staleFiles.length > 0) {
        saveCompileState(this.dp, this.state);
      }

      if (this.state.initial_compile_completed) {
        void regenerateDigestForFile(this.dp, this.gp, this.state, relPath, this.logger).catch(
          (err) => this.logger.warn("incremental digest failed", { error: String(err) }),
        );
      }

      if (this.state.initial_compile_completed) {
        const suppressed = await consumeFileWakeSuppression(this.gp, relPath);
        if (suppressed) {
          this.logger.info("wake suppressed (self-filed by claude)", { file: relPath });
        } else {
          await enqueueWake(this.gp, {
            source: "file",
            domain: this.dp.slug,
            path: relPath,
            summary_path: updated.summary_path,
          });
        }
      }
    }
  }

  private async handleRemove(relPath: string): Promise<void> {
    const entry = this.state.files[relPath];
    if (!entry) return;
    this.logger.info("removing from index", { file: relPath, domain: this.dp.slug });

    if (entry.summary_path) {
      const abs = path.join(this.dp.domainDir, entry.summary_path);
      try {
        await fs.rm(abs, { force: true });
      } catch {
        // ignore
      }
    }

    // Knowledge graph update (non-fatal)
    try {
      const qualifiedPath = qualify(this.dp.slug, relPath);
      this.knowledgeGraph.removeFileContributions(qualifiedPath);
      this.knowledgeGraph.save();
    } catch (err) {
      this.logger.warn("knowledge graph removal failed (non-fatal)", {
        file: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    delete this.state.files[relPath];
    saveCompileState(this.dp, this.state);

    if (this.state.initial_compile_completed) {
      const suppressed = await consumeFileWakeSuppression(this.gp, relPath);
      if (suppressed) {
        this.logger.info("remove wake suppressed (self-moved by claude)", { file: relPath });
      } else {
        await enqueueWake(this.gp, {
          source: "file_removed",
          domain: this.dp.slug,
          path: relPath,
        });
      }
    }
  }

  // ── Circuit breaker ────────────────────────────────────────────────

  private openCircuit(): void {
    if (this.circuitOpen) return;
    this.circuitOpen = true;
    this.circuitOpenCount++;
    const remaining = this.queue.filter((j) => j.kind === "compile").length;
    this.logger.warn("circuit breaker OPEN — LM Studio appears down, pausing compile queue", {
      domain: this.dp.slug,
      consecutiveFailures: this.consecutiveTransientFailures,
      queuedFiles: remaining,
      openCount: this.circuitOpenCount,
    });

    // Exponential backoff on repeated flaps
    const backoffFactor = Math.min(this.circuitOpenCount, FLAP_BACKOFF_LIMIT);
    const interval = Math.min(HEALTH_CHECK_BASE_MS * Math.pow(2, backoffFactor - 1), HEALTH_CHECK_MAX_MS);

    this.scheduleHealthCheck(interval);
  }

  private closeCircuit(): void {
    if (!this.circuitOpen) return;
    if (this.stopped) return; // don't resume after stop()
    this.circuitOpen = false;
    this.consecutiveTransientFailures = 0;
    this.clearHealthCheckTimer();

    // Requeue any pending files that were reverted during the burst
    this.requeuePendingFiles();

    const remaining = this.queue.filter((j) => j.kind === "compile").length;
    this.logger.info("circuit breaker CLOSED — LM Studio is back, resuming compile queue", {
      domain: this.dp.slug,
      queuedFiles: remaining,
    });

    void this.drainQueue();
  }

  private scheduleHealthCheck(intervalMs: number): void {
    this.clearHealthCheckTimer();
    this.healthCheckTimer = setTimeout(() => {
      void this.checkLmStudioHealth(intervalMs);
    }, intervalMs);
  }

  private clearHealthCheckTimer(): void {
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private async checkLmStudioHealth(intervalMs: number): Promise<void> {
    if (this.stopped || !this.circuitOpen) return;

    try {
      const { data: providers } = loadProviderSettings(this.gp);
      const baseUrl = providers.lm_studio_url.replace(/\/+$/, "");
      const res = await fetch(`${baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        this.closeCircuit();
        return;
      }
    } catch {
      // Still down
    }

    // Schedule next check (same interval — backoff was computed at open time)
    if (!this.stopped && this.circuitOpen) {
      this.scheduleHealthCheck(intervalMs);
    }
  }

  // ── Domain root reachability ────────────────────────────────────────

  /** How often to retry when the domain root is unreachable. */
  private static readonly DOMAIN_ROOT_RECHECK_MS = 60_000;

  /**
   * Check that the domain root folder exists and is readable.
   * Returns true if reachable, false if not (and schedules a recheck).
   */
  private async checkDomainRootReachable(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.dp.domainRoot);
      if (stat.isDirectory()) return true;
    } catch {
      // not reachable
    }

    this.logger.error("domain root UNREACHABLE — folder missing, unmounted, or inaccessible", {
      domain: this.dp.slug,
      root: this.dp.domainRoot,
    });

    // Schedule periodic rechecks — when the drive comes back, start normally
    this.scheduleDomainRootRecheck();
    return false;
  }

  private scheduleDomainRootRecheck(): void {
    if (this.stopped) return;
    this.domainRootCheckTimer = setTimeout(() => {
      void this.retryDomainRootCheck();
    }, DomainClerk.DOMAIN_ROOT_RECHECK_MS);
  }

  private async retryDomainRootCheck(): Promise<void> {
    if (this.stopped) return;

    try {
      const stat = await fs.stat(this.dp.domainRoot);
      if (stat.isDirectory()) {
        this.logger.info("domain root is back — starting domain clerk", {
          domain: this.dp.slug,
          root: this.dp.domainRoot,
        });
        // Folder is back — do the full startup sequence
        this.resetOrphanedCompiling();
        this.resetTransientFailures();
        void this.runInitialScanAndCompile();
        return;
      }
    } catch {
      // still unreachable
    }

    this.logger.warn("domain root still unreachable, will retry", {
      domain: this.dp.slug,
      root: this.dp.domainRoot,
    });
    this.scheduleDomainRootRecheck();
  }

  // ── Startup recovery ───────────────────────────────────────────────

  /**
   * Reset entries stuck in "compiling" state from a prior crash.
   * If the server was killed mid-compile, these entries are orphaned.
   */
  private resetOrphanedCompiling(): void {
    let count = 0;
    for (const entry of Object.values(this.state.files)) {
      if (entry.status === "compiling") {
        entry.status = "pending";
        entry.error = undefined;
        entry.error_transient = undefined;
        count++;
      }
    }
    if (count > 0) {
      saveCompileState(this.dp, this.state);
      this.logger.info("reset orphaned compiling entries", { domain: this.dp.slug, count });
    }
  }

  /**
   * Reset entries that failed due to transient errors (LM Studio was down).
   * Permanent failures (bad file, context exceeded) stay as-is.
   */
  private resetTransientFailures(): void {
    let count = 0;
    for (const entry of Object.values(this.state.files)) {
      if (entry.status === "failed" && entry.error_transient) {
        entry.status = "pending";
        entry.error = undefined;
        entry.error_transient = undefined;
        count++;
      }
    }
    if (count > 0) {
      saveCompileState(this.dp, this.state);
      this.logger.info("reset transient failures for retry", { domain: this.dp.slug, count });
    }
  }

  /**
   * When the circuit breaker trips, revert the transient-failed entries
   * from this burst back to "pending" so they're retried when the circuit closes.
   */
  private revertTransientBurstToPending(): void {
    let count = 0;
    for (const entry of Object.values(this.state.files)) {
      if (entry.status === "failed" && entry.error_transient) {
        entry.status = "pending";
        entry.error = undefined;
        entry.error_transient = undefined;
        count++;
      }
    }
    if (count > 0) {
      saveCompileState(this.dp, this.state);
    }
  }

  /**
   * Queue any files in "pending" state that aren't already in the job queue.
   */
  private requeuePendingFiles(): void {
    const alreadyQueued = new Set(
      this.queue.filter((j) => j.kind === "compile").map((j) => j.relPath),
    );
    let count = 0;
    for (const entry of Object.values(this.state.files)) {
      if (entry.status === "pending" && !alreadyQueued.has(entry.rel_path)) {
        this.queue.push({ kind: "compile", relPath: entry.rel_path });
        count++;
      }
    }
    if (count > 0) {
      this.logger.info("requeued pending files for compile", { domain: this.dp.slug, count });
    }
  }
}
