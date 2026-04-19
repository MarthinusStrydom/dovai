/**
 * Scheduled wake reconciler.
 *
 * Two sources of scheduled wakes:
 *
 *   1. Global `wake_times` in `settings/wakes.md` — general-purpose proactive
 *      wakes, fired with `{source: "scheduled", cron: "..."}`.
 *   2. Per-SOP cron triggers declared in the SOP's frontmatter `triggers`
 *      array. Fired with `{source: "sop", sop_id, cron}` so the headless
 *      wake knows which procedure to run.
 *
 * **Architecture: reconcile loop, not real-time cron timers.**
 *
 * We do NOT create `croner` timers that fire at exact clock times. On a
 * laptop that sleeps, those timers get suspended by macOS — the 08:05
 * firing just gets missed, and `croner` doesn't make up missed runs.
 *
 * Instead, a single tick runs every 60 seconds. On each tick, for every
 * declared trigger we ask `croner` "when SHOULD you have fired most
 * recently?" (`previousRun()`) and compare to the persisted last-fired
 * timestamp. If the cron's previous-run time is after our last-fired
 * record, we missed it — fire now, advance the state, move on.
 *
 * Benefits:
 *   - **Sleep-safe.** Mac wakes at 10:00, tick fires at 10:00:30, sees
 *     the 08:05 run was missed, fires it. No dedicated "catch up" code
 *     path — catch-up IS the firing mechanism.
 *   - **Crash-safe.** Server restart reloads state from disk; same logic.
 *   - **No duplicate runs.** Multiple missed firings of the same trigger
 *     (e.g. three days offline) collapse into one fire because the state
 *     advances to the most-recent-previous-run in a single step.
 *   - **Graceful first boot.** We record "now" as last-fired for every
 *     trigger on first encounter, so a fresh install doesn't try to
 *     catch up on years of theoretical history.
 *
 * Cost: firing precision is +0 to 60 seconds (the tick interval).
 * Negligible for every realistic Dovai use case.
 *
 * Cron syntax via `croner`. See https://croner.56k.guru/usage/pattern/
 */
import fs from "node:fs";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import matter from "gray-matter";
import { loadWakeSettings } from "../lib/config.ts";
import { enqueueWake } from "./queue.ts";
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";

/** How often the reconcile tick runs. */
const TICK_INTERVAL_MS = 60_000;

/**
 * Shape of a declared trigger we need to reconcile. A unique `key` (derived
 * from expression + sop id) is what we persist under.
 */
interface Trigger {
  key: string;
  expression: string;
  source: "scheduled" | "sop";
  sopId: string | undefined;
}

/** The persisted state file's shape. */
interface CronState {
  last_fired: Record<string, string>; // key → ISO timestamp
}

export class Scheduler {
  private triggers: Trigger[] = [];
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly gp: GlobalPaths,
    private readonly logger: Logger,
  ) {}

  /**
   * (Re)load triggers from wakes.md + SOP frontmatter, then start / restart
   * the reconcile tick. Safe to call repeatedly.
   */
  reload(): void {
    this.stop();
    this.triggers = this.collectTriggers();
    this.logger.info("scheduler triggers loaded", {
      count: this.triggers.length,
      triggers: this.triggers.map((t) => ({
        cron: t.expression,
        label: t.sopId ? `sop:${t.sopId}` : "global",
      })),
    });

    // Run an immediate tick on reload so a freshly-started server doesn't
    // wait up to 60 seconds before checking for missed runs.
    void this.tick();
    this.tickTimer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.triggers = [];
  }

  // ----------------------------------------------------------------------
  // Trigger discovery
  // ----------------------------------------------------------------------

  private collectTriggers(): Trigger[] {
    const out: Trigger[] = [];

    // Global wake_times
    const { data: wakes } = loadWakeSettings(this.gp);
    for (const expr of wakes.wake_times) {
      if (!expr || !expr.trim()) continue;
      if (!this.validateCron(expr, "global")) continue;
      out.push({
        key: `global::${expr}`,
        expression: expr,
        source: "scheduled",
        sopId: undefined,
      });
    }

    // Per-SOP cron triggers
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.gp.sops).filter((f) => f.endsWith(".md"));
    } catch {
      // sops/ doesn't exist yet — fine
    }

    for (const file of files) {
      const sopId = file.replace(/\.md$/, "");
      try {
        const raw = fs.readFileSync(path.join(this.gp.sops, file), "utf8");
        const parsed = matter(raw);
        const triggers = parsed.data?.triggers;
        if (!Array.isArray(triggers)) continue;

        for (const trigger of triggers) {
          if (
            trigger &&
            typeof trigger === "object" &&
            trigger.source === "scheduled" &&
            typeof trigger.cron === "string"
          ) {
            const expr = trigger.cron;
            if (!this.validateCron(expr, sopId)) continue;
            out.push({
              key: `sop::${sopId}::${expr}`,
              expression: expr,
              source: "sop",
              sopId,
            });
          }
        }
      } catch (err) {
        this.logger.warn("failed to read SOP for triggers", {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return out;
  }

  private validateCron(expr: string, context: string): boolean {
    try {
      // Parse-and-discard to validate syntax.
      CronExpressionParser.parse(expr);
      return true;
    } catch (err) {
      this.logger.warn("invalid cron expression", {
        expr,
        context,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // ----------------------------------------------------------------------
  // Reconcile tick
  // ----------------------------------------------------------------------

  /**
   * Check every trigger: did it miss a firing since we last recorded it?
   * If so, fire it now and advance the state. Runs every TICK_INTERVAL_MS
   * while the server is alive.
   */
  private async tick(): Promise<void> {
    const state = this.loadState();
    const now = new Date();
    let dirty = false;

    for (const trigger of this.triggers) {
      try {
        // cron-parser's .prev() returns the theoretical most-recent past
        // firing of this expression, relative to now. (croner's
        // previousRun() returns only actual-fires of the instance — not
        // what we want for reconciliation.)
        const parser = CronExpressionParser.parse(trigger.expression, { currentDate: now });
        const previousRun = parser.prev().toDate();
        if (!previousRun) continue;

        const lastFired = state.last_fired[trigger.key]
          ? new Date(state.last_fired[trigger.key]!)
          : null;

        if (!lastFired) {
          // First time we've seen this trigger — record "now" as its
          // last-fired so we don't retroactively fire for any
          // pre-install history. Conservative by design.
          state.last_fired[trigger.key] = now.toISOString();
          dirty = true;
          continue;
        }

        if (lastFired < previousRun) {
          // Missed one or more runs. Fire exactly once (collapsed) and
          // advance state to the most-recent-previous-run so tomorrow's
          // tick doesn't re-fire this one.
          await this.fire(trigger, previousRun, lastFired);
          state.last_fired[trigger.key] = previousRun.toISOString();
          dirty = true;
        }
      } catch (err) {
        this.logger.warn("trigger tick failed", {
          key: trigger.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (dirty) this.saveState(state);
  }

  /**
   * Enqueue the wake event for this trigger. The outer tick handles state
   * advancement; this method is just the event-emission concern.
   */
  private async fire(trigger: Trigger, previousRun: Date, lastFired: Date): Promise<void> {
    const missedByMs = previousRun.getTime() - lastFired.getTime();
    const label = trigger.sopId ? `sop:${trigger.sopId}` : "global";

    this.logger.info("scheduler trigger firing", {
      label,
      cron: trigger.expression,
      previousRun: previousRun.toISOString(),
      lastFired: lastFired.toISOString(),
      missed_by_ms: missedByMs,
      caught_up: missedByMs > TICK_INTERVAL_MS * 2,
    });

    if (trigger.source === "sop" && trigger.sopId) {
      await enqueueWake(this.gp, {
        source: "sop",
        sop_id: trigger.sopId,
        cron: trigger.expression,
      });
    } else {
      await enqueueWake(this.gp, {
        source: "scheduled",
        cron: trigger.expression,
      });
    }
  }

  // ----------------------------------------------------------------------
  // State persistence
  // ----------------------------------------------------------------------

  private get statePath(): string {
    // State is per-machine, stays in the state dir (never synced). Dovai
    // instances on different machines have independent reconciler state —
    // a firing that happened on the work Mac shouldn't silence a firing
    // on the Mac mini, because they have their own local triggers.
    return path.join(this.gp.state, "cron_state.json");
  }

  private loadState(): CronState {
    try {
      const raw = fs.readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.last_fired) {
        return { last_fired: parsed.last_fired };
      }
    } catch {
      // file missing or corrupt — fall through to fresh state
    }
    return { last_fired: {} };
  }

  private saveState(state: CronState): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    } catch (err) {
      this.logger.warn("failed to persist scheduler state", {
        path: this.statePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
