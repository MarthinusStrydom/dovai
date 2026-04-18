/**
 * Broker lifecycle: start, discover, health-check.
 *
 * Called by each dovai-server on startup to ensure the global LM Studio
 * broker is running. If no broker is alive, we spawn one as a detached
 * background process.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { PROJECT_ROOT } from "../lib/paths.ts";

const GLOBAL_DIR = path.join(os.homedir(), ".dovai/state");
const PID_FILE = path.join(GLOBAL_DIR, "broker.pid");
const PORT_FILE = path.join(GLOBAL_DIR, "broker.port");

export interface BrokerInfo {
  url: string;
  pid: number;
  port: number;
}

/**
 * Check if the broker process is alive.
 */
function isBrokerAlive(): boolean {
  try {
    const pidStr = fs.readFileSync(PID_FILE, "utf8").trim();
    const pid = parseInt(pidStr, 10);
    if (Number.isNaN(pid)) return false;
    // Signal 0 checks if the process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read broker connection info from the global discovery files.
 * Returns null if the broker isn't running or files are missing.
 */
export function discoverBroker(): BrokerInfo | null {
  if (!isBrokerAlive()) return null;
  try {
    const port = parseInt(fs.readFileSync(PORT_FILE, "utf8").trim(), 10);
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    if (Number.isNaN(port) || Number.isNaN(pid)) return null;
    return { url: `http://127.0.0.1:${port}`, pid, port };
  } catch {
    return null;
  }
}

/**
 * Ensure the global LM Studio broker is running.
 *
 * If a broker is already alive, returns its info. Otherwise, spawns a new
 * broker as a detached background process and waits for it to be ready.
 *
 * @param lmStudioUrl - The LM Studio URL to proxy to.
 * @returns Broker connection info, or null if startup failed.
 */
export async function ensureBroker(lmStudioUrl: string): Promise<BrokerInfo | null> {
  // Check if already running
  const existing = discoverBroker();
  if (existing) {
    // Quick health check to make sure it's really responsive
    try {
      const res = await fetch(`${existing.url}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return existing;
    } catch {
      // Stale broker — clean up and start a new one
      cleanupStaleFiles();
    }
  }

  // Spawn a new broker
  fs.mkdirSync(GLOBAL_DIR, { recursive: true });

  const brokerMain = path.join(PROJECT_ROOT, "src", "broker", "main.ts");
  const logDir = path.join(os.homedir(), ".dovai", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "broker.log");

  // Open a log file for the broker's stderr
  const logFd = fs.openSync(logFile, "a");

  const child = spawn(
    process.execPath, // node or tsx
    [
      "--import", "tsx",
      brokerMain,
      "--lm-studio-url", lmStudioUrl,
    ],
    {
      detached: true,
      stdio: ["ignore", "ignore", logFd],
      env: { ...process.env },
    },
  );
  child.unref();
  fs.closeSync(logFd);

  // Wait for the broker to write its port file (up to 5 seconds)
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await sleep(200);
    const info = discoverBroker();
    if (info) {
      // Verify it responds
      try {
        const res = await fetch(`${info.url}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) return info;
      } catch {
        // Not ready yet — keep waiting
      }
    }
  }

  // Startup failed
  return null;
}

/**
 * Stop the global broker (if running).
 */
export function stopBroker(): boolean {
  try {
    const pidStr = fs.readFileSync(PID_FILE, "utf8").trim();
    const pid = parseInt(pidStr, 10);
    if (Number.isNaN(pid)) return false;
    process.kill(pid, "SIGTERM");
    cleanupStaleFiles();
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleFiles(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  try { fs.unlinkSync(PORT_FILE); } catch { /* ignore */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
