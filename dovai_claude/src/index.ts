/**
 * dovai-server entry point.
 *
 * Usage:
 *   dovai-server [--port 0] [--no-open]
 *
 * On start:
 *   1. Parse args (no --workspace needed — single-Sarah architecture)
 *   2. Initialize ~/.dovai/ structure from templates
 *   3. Acquire server.lock (prevents dual servers)
 *   4. Start logger
 *   5. Start filing clerk (one DomainClerk per registered domain)
 *   6. Start email poller, telegram bot, outbox dispatcher
 *   7. Start wake dispatcher + scheduler
 *   8. Start web server
 *   9. Open browser (optional, first run)
 *  10. Wait for SIGINT/SIGTERM; on shutdown, stop everything cleanly.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { globalPaths } from "./lib/global_paths.ts";
import { initGlobalDovai } from "./lib/workspace.ts";
import { migrateV1ToV2 as migratePlaygroundV1ToV2 } from "./lib/playground.ts";
import { Logger } from "./lib/logger.ts";
import { acquireLock, refreshLock, releaseLock } from "./lib/lock.ts";
import { acquireOwnership, refreshOwnership, releaseOwnership } from "./lib/owner_lock.ts";
import { loadProviderSettings } from "./lib/config.ts";
import { FilingClerk } from "./filing_clerk/index.ts";
import { EmailPoller } from "./filing_clerk/email_poller.ts";
import { TelegramService } from "./filing_clerk/telegram_bot.ts";
import { OutboxDispatcher } from "./filing_clerk/outbox_dispatcher.ts";
import { WakeDispatcher } from "./wake/dispatcher.ts";
import { Scheduler } from "./wake/scheduler.ts";
import { startWebServer } from "./web/server.ts";
import type { ServerContext } from "./web/types.ts";
import { ensureBroker } from "./broker/lifecycle.ts";
import { writeConversationLog } from "./wake/conversation_history.ts";

interface Args {
  port: number;
  open: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 0, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") {
      args.port = parseInt(argv[++i] || "0", 10) || 0;
    } else if (a === "--no-open") {
      args.open = false;
    } else if (a === "--help" || a === "-h") {
      printUsageAndExit(0);
    }
  }
  return args;
}

function printUsageAndExit(code: number): never {
  console.log(
    [
      "Usage: dovai-server [options]",
      "",
      "Options:",
      "  --port, -p PORT         HTTP port (default: random)",
      "  --no-open               Don't open browser on start",
      "  --help, -h              Print this help",
    ].join("\n"),
  );
  process.exit(code);
}

function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" });
    } else if (platform === "win32") {
      spawn("cmd", ["/c", "start", url], { detached: true, stdio: "ignore" });
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
  } catch {
    // ignore — user can open manually
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 1. Build global paths
  const gp = globalPaths();

  // 2. Init ~/.dovai/ structure from templates
  initGlobalDovai(gp);
  // Playground v1 → v2 migration: rename presets/ → characters/ and move
  // learned/memories.jsonl → learned/_shared/memories.jsonl. Idempotent.
  migratePlaygroundV1ToV2(gp);

  // 3. Logger (now that logs dir exists)
  const rootLogger = new Logger(gp, "server");
  rootLogger.info("starting dovai-server", { home: gp.dovaiHome, pid: process.pid });

  // 3a. LM Studio preflight — hard requirement, no fallback
  const { data: providers } = loadProviderSettings(gp);
  const lmUrl = providers.lm_studio_url.replace(/\/+$/, "");
  try {
    const res = await fetch(`${lmUrl}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`${lmUrl} returned HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (json.data ?? []).map((m) => m.id).filter(Boolean);
    if (models.length === 0) {
      rootLogger.error("LM Studio reachable but no models loaded", { url: lmUrl });
      console.error(`\nERROR: LM Studio is reachable at ${lmUrl} but has no models loaded.\n`);
      console.error("Dovai requires a local LLM to summarise files. Please:");
      console.error("  1. Open LM Studio");
      console.error("  2. Load a model (any chat-capable model will work)");
      console.error("  3. Run dovai again\n");
      process.exit(4);
    }
    rootLogger.info("LM Studio preflight ok", { url: lmUrl, models });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    rootLogger.error("LM Studio preflight failed", { url: lmUrl, error: msg });
    console.error(`\nERROR: LM Studio is not reachable at ${lmUrl}`);
    console.error(`Reason: ${msg}\n`);
    console.error("Dovai requires a local LLM server to run — there is no fallback.");
    console.error("Please either:");
    console.error("  • Start LM Studio and load a model, then run dovai again");
    console.error(`  • OR edit ${path.join(gp.settings, "providers.md")}`);
    console.error("    and set lm_studio_url to a reachable server (e.g. another machine on");
    console.error("    your LAN running LM Studio or an OpenAI-compatible endpoint)\n");
    process.exit(4);
  }

  // 3b. Ensure the global LM Studio broker is running
  const brokerInfo = await ensureBroker(lmUrl);
  if (brokerInfo) {
    rootLogger.info("LM broker ready", { url: brokerInfo.url, pid: brokerInfo.pid });
  } else {
    rootLogger.warn("LM broker failed to start — falling back to direct LM Studio");
  }

  // 4a. Cross-machine ownership lock (data dir)
  // Only meaningful if the data dir is separate from the state dir — i.e.
  // the user has migrated to a shared location like Drive. Pre-migration,
  // this no-ops. See docs/PLAN_DATA_DIR_SPLIT.md (Phase 4).
  const ownership = acquireOwnership(gp.dataRoot, gp.stateRoot);
  if (!ownership.ok) {
    const e = ownership.existing;
    const ageMin = Math.round((Date.now() - e.heartbeat) / 60_000);
    if (ownership.reason === "other_host_live") {
      console.error(
        `\nERROR: Dovai is running on another machine ('${e.hostname}', pid ${e.pid},\n` +
        `last heartbeat ${ageMin} min ago), and its data dir is shared with this\n` +
        `machine via the data-dir split. Stop it there first:\n\n` +
        `  ssh ${e.hostname}   # or go to that machine\n` +
        `  dovai stop\n\n` +
        `Then run 'dovai start' here.\n`
      );
      process.exit(5);
    }
    // same_host_live — this case is already caught below by serverLock,
    // but surface the clearer message first.
    console.error(
      `\nERROR: Dovai is already running on this machine (pid ${e.pid}).\n` +
      `Run 'dovai stop' first.\n`
    );
    process.exit(3);
  }
  if ("takeover" in ownership && ownership.takeover) {
    const prev = ownership.previous;
    rootLogger.warn("took over stale ownership lock", {
      previous_host: prev.hostname,
      previous_pid: prev.pid,
      previous_heartbeat_age_ms: Date.now() - prev.heartbeat,
      takeover_reason: ownership.takeover,
    });
  }

  // 4b. Same-machine process lock
  if (!acquireLock(gp.serverLock, "server")) {
    releaseOwnership(gp.dataRoot, gp.stateRoot);
    rootLogger.error("another dovai-server is already running");
    process.exit(3);
  }
  const serverHeartbeat = setInterval(() => {
    refreshLock(gp.serverLock);
    refreshOwnership(gp.dataRoot, gp.stateRoot);
  }, 30_000);

  // 5. Filing clerk (one DomainClerk per registered domain)
  const clerk = new FilingClerk(gp, rootLogger);

  // 6. Scheduler
  const scheduler = new Scheduler(gp, rootLogger.child("sched"));

  // 7. Web server
  const ctx: ServerContext = {
    global: gp,
    clerk,
    scheduler,
    logger: rootLogger,
  };
  const { server: webServer, port } = await startWebServer(ctx, args.port);
  rootLogger.info("web server listening", {
    url: `http://localhost:${port}/`,
    lan_url: `http://${os.hostname()}.local:${port}/`,
  });

  // Publish server info so `dovai status` can find us
  fs.writeFileSync(
    gp.serverInfo,
    JSON.stringify(
      {
        pid: process.pid,
        port,
        home: gp.dovaiHome,
        url: `http://localhost:${port}/`,
        lan_url: `http://${os.hostname()}.local:${port}/`,
        started_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  // 8. Start filing clerk (async scan kicks off per domain)
  await clerk.start();

  // 9. Email, telegram, outbox
  const telegram = new TelegramService(gp, rootLogger);
  const outbox = new OutboxDispatcher(gp, rootLogger, telegram);
  const emailPoller = new EmailPoller(gp, rootLogger);

  await telegram.start();
  await outbox.start();
  emailPoller.start();

  // 10. Scheduler + wake dispatcher
  scheduler.reload();
  const wakeDispatcher = new WakeDispatcher(gp, rootLogger.child("wake"), clerk);
  wakeDispatcher.start();

  // 10a. Write initial conversation log for CLI sessions
  writeConversationLog(gp, rootLogger).catch(() => {});

  // 11. Open browser
  if (args.open) {
    setTimeout(() => openBrowser(`http://localhost:${port}/`), 1000);
  }

  console.log("");
  console.log("┌─────────────────────────────────────────────────────────────┐");
  console.log("│  dovai-server started                                       │");
  console.log("├─────────────────────────────────────────────────────────────┤");
  console.log(`│  Home:      ${gp.dovaiHome}`);
  console.log(`│  Web UI:    http://localhost:${port}/`);
  console.log(`│  LAN URL:   http://${os.hostname()}.local:${port}/`);
  console.log(`│  PID:       ${process.pid}`);
  console.log(`│  Stop with: dovai stop                                      │`);
  console.log("└─────────────────────────────────────────────────────────────┘");
  console.log("");

  // Shutdown handling
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    rootLogger.info("shutting down", { signal });

    clearInterval(serverHeartbeat);
    wakeDispatcher.stop();
    scheduler.stop();
    emailPoller.stop();
    await telegram.stop();
    await outbox.stop();
    await clerk.stop();

    try {
      await new Promise<void>((resolve) => {
        webServer.close(() => resolve());
      });
    } catch {
      // ignore
    }

    try { fs.unlinkSync(gp.serverInfo); } catch { /* ignore */ }
    releaseLock(gp.serverLock);
    releaseOwnership(gp.dataRoot, gp.stateRoot);
    rootLogger.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    rootLogger.error("uncaughtException", { error: err.message, stack: err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    rootLogger.error("unhandledRejection", { reason: String(reason) });
  });
}

main().catch((err) => {
  console.error("Fatal error starting dovai-server:", err);
  process.exit(1);
});
