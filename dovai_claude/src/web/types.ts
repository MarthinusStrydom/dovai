/**
 * Shared types used by web API handlers.
 */
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { FilingClerk } from "../filing_clerk/index.ts";
import type { Scheduler } from "../wake/scheduler.ts";
import type { Logger } from "../lib/logger.ts";

/**
 * Manages the pool of Telegram bots — one per Character with a configured
 * token. Wired in at server startup and reloaded whenever character CRUD
 * happens. Kept as an optional slot on ServerContext so the playground API
 * can trigger reloads without importing the manager directly.
 */
export interface CharacterBotManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  reload(): Promise<void>;
}

export interface ServerContext {
  global: GlobalPaths;
  clerk: FilingClerk;
  scheduler: Scheduler;
  logger: Logger;
  /** Set by server startup after CharacterBotManager is constructed. */
  characterBots?: CharacterBotManager;
}
