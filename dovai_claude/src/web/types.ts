/**
 * Shared types used by web API handlers.
 */
import type { GlobalPaths } from "../lib/global_paths.ts";
import type { FilingClerk } from "../filing_clerk/index.ts";
import type { Scheduler } from "../wake/scheduler.ts";
import type { Logger } from "../lib/logger.ts";

export interface ServerContext {
  global: GlobalPaths;
  clerk: FilingClerk;
  scheduler: Scheduler;
  logger: Logger;
}
