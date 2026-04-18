/**
 * Append-only JSONL logger. Writes to both:
 *   - <workspace>/.dovai/logs/<YYYY-MM-DD>.jsonl (audit trail, inspectable in web UI)
 *   - stdout (readable in the terminal where dovai-server runs)
 */
import fs from "node:fs";
import path from "node:path";
import type { GlobalPaths } from "./global_paths.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  source: string;
  msg: string;
  [key: string]: unknown;
}

export class Logger {
  private readonly logsDir: string;

  constructor(
    gp: GlobalPaths,
    private readonly source: string,
  ) {
    this.logsDir = gp.logs;
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  child(source: string): Logger {
    // Use Object.create to share logsDir without needing GlobalPaths again
    const child = Object.create(Logger.prototype) as Logger;
    (child as any).logsDir = this.logsDir;
    (child as any).source = `${this.source}:${source}`;
    return child;
  }

  private logFile(): string {
    const today = new Date().toISOString().slice(0, 10);
    return path.join(this.logsDir, `${today}.jsonl`);
  }

  log(level: LogLevel, msg: string, extra: Record<string, unknown> = {}): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      source: this.source,
      msg,
      ...extra,
    };
    const line = JSON.stringify(entry);
    try {
      fs.appendFileSync(this.logFile(), line + "\n");
    } catch {
      // swallow — logging must never crash the server
    }
    const consoleFn =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : console.log;
    consoleFn(`[${entry.ts}] [${level}] [${this.source}] ${msg}`, extra);
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this.log("debug", msg, extra);
  }
  info(msg: string, extra?: Record<string, unknown>): void {
    this.log("info", msg, extra);
  }
  warn(msg: string, extra?: Record<string, unknown>): void {
    this.log("warn", msg, extra);
  }
  error(msg: string, extra?: Record<string, unknown>): void {
    this.log("error", msg, extra);
  }
}
