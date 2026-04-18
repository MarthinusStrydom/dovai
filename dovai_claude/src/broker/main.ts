#!/usr/bin/env tsx
/**
 * Standalone entry point for the LM Studio broker.
 *
 * Usage:
 *   npx tsx src/broker/main.ts --lm-studio-url http://127.0.0.1:1234
 *
 * The broker writes its port to ~/.dovai/state/broker.port and its PID
 * to ~/.dovai/state/broker.pid so workspace servers can discover it.
 *
 * Shuts down cleanly on SIGINT/SIGTERM.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LmBroker } from "./server.ts";

const GLOBAL_DIR = path.join(os.homedir(), ".dovai/state");
const PID_FILE = path.join(GLOBAL_DIR, "broker.pid");
const PORT_FILE = path.join(GLOBAL_DIR, "broker.port");

function parseArgs(): { lmStudioUrl: string } {
  const args = process.argv.slice(2);
  let url = "http://127.0.0.1:1234";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--lm-studio-url" && args[i + 1]) {
      url = args[++i]!;
    }
  }
  return { lmStudioUrl: url };
}

async function main(): Promise<void> {
  const { lmStudioUrl } = parseArgs();

  fs.mkdirSync(GLOBAL_DIR, { recursive: true });

  const broker = new LmBroker(lmStudioUrl);
  const port = await broker.start(0);

  // Write discovery files
  fs.writeFileSync(PID_FILE, String(process.pid));
  fs.writeFileSync(PORT_FILE, String(port));

  process.stderr.write(
    `[lm-broker] started on 127.0.0.1:${port} → ${lmStudioUrl} (pid ${process.pid})\n`,
  );

  const cleanup = () => {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    try { fs.unlinkSync(PORT_FILE); } catch { /* ignore */ }
    broker.stop();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[lm-broker] uncaughtException: ${err.message}\n`);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[lm-broker] unhandledRejection: ${reason}\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`[lm-broker] fatal: ${err.message || err}\n`);
  process.exit(1);
});
