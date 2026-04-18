/**
 * Scheduled wake dispatcher. Creates cron jobs from two sources:
 *
 *   1. Global wake_times in settings/wakes.md — general-purpose proactive wakes.
 *   2. Per-SOP triggers in sops/*.md — each SOP can declare cron expressions
 *      in its frontmatter `triggers` array. When an SOP trigger fires, the
 *      wake event includes the SOP id so Claude knows which procedure to run.
 *
 * Cron syntax via `croner`. See https://croner.56k.guru/usage/pattern/
 * Examples:
 *   "0 7 * * *"          every day at 07:00 local
 *   "0 every-2h * * *"   every 2 hours
 *   "0 9,13,17 * * 1-5"  weekdays at 9, 13, 17
 */
import fs from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import matter from "gray-matter";
import { loadWakeSettings } from "../lib/config.ts";
import { enqueueWake } from "./queue.ts";
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";

export class Scheduler {
  private jobs: Cron[] = [];

  constructor(
    private readonly gp: GlobalPaths,
    private readonly logger: Logger,
  ) {}

  /**
   * Load all cron triggers (global + SOP) and create one job per expression.
   * Safe to call repeatedly — stops existing jobs before starting new ones.
   */
  reload(): void {
    this.stop();

    // ── Global wake_times ────────────────────────────────────────────
    const { data } = loadWakeSettings(this.gp);
    for (const expr of data.wake_times) {
      this.addJob(expr, "scheduled", undefined);
    }

    // ── Per-SOP cron triggers ────────────────────────────────────────
    this.loadSopTriggers();
  }

  stop(): void {
    for (const job of this.jobs) {
      try {
        job.stop();
      } catch {
        // ignore
      }
    }
    this.jobs = [];
  }

  /**
   * Scan all SOP files for frontmatter triggers with source: "scheduled"
   * and a cron expression. Each one becomes a cron job.
   */
  private loadSopTriggers(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.gp.sops).filter((f) => f.endsWith(".md"));
    } catch {
      return; // sops/ doesn't exist yet
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
            this.addJob(trigger.cron, "sop", sopId);
          }
        }
      } catch {
        // skip unreadable SOP
      }
    }
  }

  /**
   * Create a single cron job. Shared by global wakes and SOP triggers.
   */
  private addJob(expr: string, source: "scheduled" | "sop", sopId: string | undefined): void {
    if (!expr || !expr.trim()) return;
    try {
      const job = new Cron(expr, async () => {
        if (source === "sop" && sopId) {
          this.logger.info("SOP cron trigger fired", { sop: sopId, cron: expr });
          await enqueueWake(this.gp, {
            source: "sop",
            sop_id: sopId,
            cron: expr,
          });
        } else {
          this.logger.info("scheduled wake fired", { cron: expr });
          await enqueueWake(this.gp, { source: "scheduled", cron: expr });
        }
      });
      this.jobs.push(job);
      const label = sopId ? `sop:${sopId}` : "global";
      this.logger.info("cron job registered", { label, cron: expr, next: job.nextRun()?.toISOString() });
    } catch (err) {
      this.logger.warn("invalid cron expression", {
        expr,
        sop: sopId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
