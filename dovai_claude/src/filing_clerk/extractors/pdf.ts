/**
 * PDF extraction. Try pdftotext first (fast, native text). If that yields
 * basically nothing (scanned PDF), fall back to ocrmypdf + pdftotext.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Extraction } from "./index.ts";
import type { Logger } from "../../lib/logger.ts";

const MIN_TEXT_LENGTH_FOR_NATIVE = 50;

function runCommand(
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

export async function extractPdf(filePath: string, logger: Logger): Promise<Extraction | null> {
  // Attempt 1: pdftotext
  const nativeResult = await runCommand("pdftotext", ["-layout", filePath, "-"], 60_000);
  if (nativeResult.code === 0 && nativeResult.stdout.trim().length >= MIN_TEXT_LENGTH_FOR_NATIVE) {
    return { text: nativeResult.stdout, method: "pdftotext" };
  }

  // Attempt 2: OCR the pdf via ocrmypdf → pdftotext
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dovai-ocr-"));
  const ocrPath = path.join(tmpDir, "ocred.pdf");
  try {
    const ocr = await runCommand(
      "ocrmypdf",
      ["--skip-text", "--quiet", filePath, ocrPath],
      5 * 60_000,
    );
    if (ocr.code === 0) {
      const ocrText = await runCommand("pdftotext", ["-layout", ocrPath, "-"], 60_000);
      if (ocrText.code === 0 && ocrText.stdout.trim().length > 0) {
        return { text: ocrText.stdout, method: "ocrmypdf+pdftotext" };
      }
    } else {
      logger.debug("ocrmypdf non-zero", { file: filePath, stderr: ocr.stderr.slice(0, 500) });
    }
  } finally {
    // best-effort cleanup
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  // Last resort — return whatever pdftotext produced, even if minimal
  if (nativeResult.code === 0) {
    return { text: nativeResult.stdout, method: "pdftotext_minimal" };
  }
  return null;
}
