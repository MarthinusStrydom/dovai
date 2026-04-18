/**
 * Office document extraction via pandoc.
 * Handles docx, doc, odt, rtf, xlsx, xls, ods, pptx, ppt.
 * For xlsx/xls/ods we try xlsx2csv first (preserves sheet structure),
 * falling back to pandoc.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { Extraction } from "./index.ts";
import type { Logger } from "../../lib/logger.ts";

function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: "spawn error", code: -1 });
    });
  });
}

const SHEET_EXTS = new Set([".xlsx", ".xls", ".ods"]);

export async function extractOffice(filePath: string, logger: Logger): Promise<Extraction | null> {
  const ext = path.extname(filePath).toLowerCase();

  if (SHEET_EXTS.has(ext)) {
    // Try xlsx2csv if available
    const xlsx = await run("xlsx2csv", ["-a", filePath], 60_000);
    if (xlsx.code === 0 && xlsx.stdout.trim().length > 0) {
      return { text: xlsx.stdout, method: "xlsx2csv" };
    }
  }

  // Fall back to pandoc → plain text
  const pandoc = await run("pandoc", [filePath, "-t", "plain"], 2 * 60_000);
  if (pandoc.code === 0 && pandoc.stdout.trim().length > 0) {
    return { text: pandoc.stdout, method: "pandoc" };
  }

  logger.debug("office extraction failed", {
    file: filePath,
    stderr: pandoc.stderr.slice(0, 500),
  });
  return null;
}
