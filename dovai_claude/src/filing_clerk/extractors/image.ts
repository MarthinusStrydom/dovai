/**
 * Image extraction via tesseract OCR.
 * If tesseract can't find any text, returns an empty extraction marked as
 * "visual_content" — Sarah can still learn that a file exists, even if it has
 * no extractable text.
 */
import { spawn } from "node:child_process";
import type { Extraction } from "./index.ts";
import type { Logger } from "../../lib/logger.ts";

function runTesseract(filePath: string): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("tesseract", [filePath, "-", "-l", "eng"]);
    let stdout = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 60_000);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, code });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout: "", code: -1 });
    });
  });
}

export async function extractImage(filePath: string, logger: Logger): Promise<Extraction | null> {
  const result = await runTesseract(filePath);
  if (result.code === 0 && result.stdout.trim().length > 0) {
    return { text: result.stdout, method: "tesseract" };
  }
  logger.debug("image has no extractable text", { file: filePath });
  return { text: "", method: "visual_content" };
}
