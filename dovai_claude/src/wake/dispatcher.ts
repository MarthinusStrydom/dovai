/**
 * Wake Dispatcher: invokes the AI CLI in headless mode when there are pending
 * wake events and no session/wake locks are held.
 *
 * Runs on a short poll interval. On each tick:
 *   - if queue is empty → noop
 *   - if session.lock is fresh (user is in an interactive session) → defer
 *   - if wake.lock is held → another wake is in progress, skip
 *   - else: acquire wake.lock, spawn CLI, wait for exit, release lock
 *
 * The AI CLI is expected to delete the wake queue files it processes.
 * The dispatcher verifies the queue was drained and logs any stragglers.
 */
import { spawn } from "node:child_process";
import {
  acquireLock,
  isLocked,
  readLock,
  refreshLock,
  releaseLock,
} from "../lib/lock.ts";
import { listWakeQueue, readWakeEvent } from "./queue.ts";
import { buildConversationHistory, writeConversationLog } from "./conversation_history.ts";
import { crystalliseSession, type ToolStep } from "./crystallise.ts";
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";
import type { FilingClerk } from "../filing_clerk/index.ts";
import { resolveCliProvider } from "../cli_provider/resolve.ts";

const POLL_INTERVAL_MS = 3_000;
const DEBOUNCE_MS = 1_500;

export class WakeDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastQueueNonEmptyAt = 0;
  private inFlight = false;

  constructor(
    private readonly gp: GlobalPaths,
    private readonly logger: Logger,
    private readonly clerk: FilingClerk,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info("wake dispatcher started");
    this.timer = setInterval(() => this.tick().catch(() => undefined), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info("wake dispatcher stopped");
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;

    const queue = await listWakeQueue(this.gp);
    if (queue.length === 0) {
      this.lastQueueNonEmptyAt = 0;
      return;
    }

    // Gate: don't wake the AI CLI until at least one domain has finished its
    // initial compile. Once any domain is ready, let events through — the AI
    // can work on that domain while others are still indexing. Events without
    // a domain tag (approvals, scheduled, manual) are never blocked once any
    // domain is ready. Events tagged to a specific domain that is still
    // compiling are filtered out and left in the queue for later.
    if (!this.clerk.anyDomainCompileCompleted) {
      this.logger.debug("queue has events but no domain has completed initial compile", {
        queued: queue.length,
      });
      return;
    }

    // Filter: if not all domains are done, check each event. Only proceed
    // if at least one event is actionable (non-domain or its domain is ready).
    if (!this.clerk.initialCompileCompleted) {
      let actionable = 0;
      for (const name of queue) {
        const event = await readWakeEvent(this.gp, name);
        const domain = event?.domain as string | undefined;
        if (!domain || this.clerk.isDomainCompileCompleted(domain)) {
          actionable++;
        }
      }
      if (actionable === 0) {
        this.logger.debug("queue has events but all are for domains still compiling", {
          queued: queue.length,
        });
        return;
      }
    }

    // Debounce: wait a short window so bursts of events coalesce into one wake
    const now = Date.now();
    if (this.lastQueueNonEmptyAt === 0) {
      this.lastQueueNonEmptyAt = now;
      return;
    }
    if (now - this.lastQueueNonEmptyAt < DEBOUNCE_MS) return;

    // Check locks — only the wake lock matters.
    // We intentionally do NOT check session.lock here. The user may keep an
    // interactive terminal open all day; blocking headless wakes during that
    // time means telegram/email messages never get processed. The wake lock
    // prevents concurrent headless wakes from trampling each other, and the
    // headless wake only touches queue files + outbox — no conflict with the
    // interactive session.
    if (isLocked(this.gp.wakeLock, "wake")) {
      const info = readLock(this.gp.wakeLock);
      this.logger.debug("wake already in flight", { holder_pid: info?.pid });
      return;
    }

    // Acquire wake lock (handles stale lock cleanup internally)
    if (!acquireLock(this.gp.wakeLock, "wake")) {
      return;
    }

    this.inFlight = true;
    try {
      this.lastQueueNonEmptyAt = 0;

      // Build unified conversation history so Sarah has cross-channel context
      let conversationHistory = "";
      try {
        conversationHistory = await buildConversationHistory(this.gp, this.logger);
      } catch (err) {
        this.logger.warn("failed to build conversation history", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await this.invokeAiCli(queue.length, conversationHistory);
    } finally {
      releaseLock(this.gp.wakeLock);
      this.inFlight = false;
    }
  }

  private async invokeAiCli(queuedCount: number, conversationHistory: string): Promise<void> {
    const provider = resolveCliProvider(this.gp);

    let prompt =
      `You've been woken by the filing clerk. ${queuedCount} event(s) are pending.\n\n` +
      `Your working directory is ~/.dovai/. Read CLAUDE.md first — that is your operating manual.\n` +
      `Then read every file in wake_queue/, process each event per your instructions, ` +
      `and delete the event files once handled.\n\n` +
      `For efficient file lookup, use the pre-built index:\n` +
      `- domains/<slug>/index/_digests/ — folder summaries (start here)\n` +
      `- domains/<slug>/index/<path>.summary.md — individual file summaries\n` +
      `- state/knowledge_graph.json — entity-to-file mapping\n` +
      `Do NOT use Glob/Grep to search the filesystem when the index already has the answer.`;

    if (conversationHistory) {
      prompt += `\n\n${conversationHistory}`;
    }

    const cmd = process.env[provider.binaryEnvVar] || provider.binary;
    const args = provider.headlessArgs(prompt);

    this.logger.info("invoking AI CLI", {
      cli: provider.id,
      binary: cmd,
      queued: queuedCount,
      cwd: this.gp.dovaiHome,
    });

    const startTs = Date.now();

    // Strip CLI-specific env vars before spawning — prevents "nested CLI"
    // detection issues that cause the child to refuse to start.
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (provider.stripEnvPrefixes.some((p) => k === p || k.startsWith(p))) continue;
      childEnv[k] = v;
    }

    const child = spawn(cmd, args, {
      cwd: this.gp.dovaiHome,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });

    let rawStdout = "";
    let stderr = "";
    const toolTrace: ToolStep[] = [];
    let resultText = "";
    let costUsd: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    child.stdout?.on("data", (d) => {
      rawStdout += d.toString();
      // Parse complete NDJSON lines as they arrive
      const lines = rawStdout.split("\n");
      rawStdout = lines.pop() || ""; // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const event = provider.parseLine(msg);
          if (event?.kind === "tool_call") {
            toolTrace.push({ tool: event.tool, input_summary: event.inputSummary });
          } else if (event?.kind === "result") {
            resultText = event.text;
            costUsd = event.costUsd;
            inputTokens = event.inputTokens;
            outputTokens = event.outputTokens;
          }
        } catch {
          // malformed line — ignore
        }
      }
    });
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    // Refresh wake lock periodically so long-running claude invocations don't
    // get their lock marked stale.
    const refresher = setInterval(() => refreshLock(this.gp.wakeLock), 15_000);

    const result = await new Promise<{ code: number | null }>((resolve) => {
      child.on("close", (code) => resolve({ code }));
      child.on("error", (err) => {
        this.logger.error("AI CLI spawn error", { error: err.message });
        resolve({ code: -1 });
      });
    });

    clearInterval(refresher);

    // Flush any remaining partial line from stdout
    if (rawStdout.trim()) {
      try {
        const msg = JSON.parse(rawStdout);
        const event = provider.parseLine(msg);
        if (event?.kind === "result") {
          resultText = event.text;
          costUsd = event.costUsd;
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
        }
      } catch { /* ignore */ }
    }

    const elapsedMs = Date.now() - startTs;
    const endedAt = new Date().toISOString();
    const remainingQueue = await listWakeQueue(this.gp);
    this.logger.info("AI CLI wake finished", {
      exit_code: result.code,
      elapsed_ms: elapsedMs,
      remaining_in_queue: remainingQueue.length,
      tool_steps: toolTrace.length,
      result_preview: resultText.slice(0, 500),
      stderr_preview: stderr.slice(0, 500),
    });

    // Crystallise the session: write a persistent record of what happened
    try {
      await crystalliseSession(
        this.gp,
        {
          started_at: new Date(startTs).toISOString(),
          ended_at: endedAt,
          event_count: queuedCount,
          exit_code: result.code,
          duration_ms: elapsedMs,
          result_text: resultText.slice(0, 2000),
          stderr_preview: stderr.slice(0, 500),
          tool_trace: toolTrace,
          cost_usd: costUsd,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
        this.logger,
      );
    } catch (err) {
      this.logger.warn("session crystallisation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Refresh the conversation log file so the next CLI session has fresh context
    writeConversationLog(this.gp, this.logger).catch(() => {});
  }
}
