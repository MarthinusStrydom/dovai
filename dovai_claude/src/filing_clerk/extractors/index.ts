/**
 * Extractor dispatch. Given a file path, return its extracted plain text.
 * Each extractor shells out to a proven tool (pdftotext, tesseract, pandoc, etc.).
 * A file that can't be extracted returns null — the compiler will skip it.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { extractText } from "./text.ts";
import { extractPdf } from "./pdf.ts";
import { extractImage } from "./image.ts";
import { extractOffice } from "./office.ts";
import { extractAudio } from "./audio.ts";
import { extractInboxMeta, isInboxMetaPath } from "./inbox_meta.ts";
import type { GlobalPaths } from "../../lib/global_paths.ts";
import type { Logger } from "../../lib/logger.ts";

export interface Extraction {
  text: string;
  method: string;
}

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".html",
  ".htm",
  ".xml",
  ".log",
]);

const PDF_EXTENSIONS = new Set([".pdf"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".gif", ".webp", ".heic"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".doc", ".odt", ".rtf", ".xlsx", ".xls", ".ods", ".pptx", ".ppt"]);
const AUDIO_EXTENSIONS = new Set([".ogg", ".oga", ".mp3", ".wav", ".flac", ".m4a", ".opus", ".webm"]);

export async function extract(
  filePath: string,
  relPath: string,
  logger: Logger,
  gp?: GlobalPaths,
): Promise<Extraction | null> {
  const ext = path.extname(filePath).toLowerCase();

  try {
    const stat = await fs.stat(filePath);
    // Skip files larger than 50 MB — these are almost always media we can't summarize cheaply
    if (stat.size > 50 * 1024 * 1024) {
      logger.warn("skipping large file", { file: filePath, size: stat.size });
      return null;
    }
    // Skip empty files
    if (stat.size === 0) {
      return { text: "", method: "empty" };
    }
  } catch {
    return null;
  }

  // Email/telegram inbox meta.json — render as a clean message, not raw JSON.
  // Must come before the generic .json text handler below.
  if (isInboxMetaPath(relPath)) {
    return extractInboxMeta(filePath, relPath);
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    return extractText(filePath);
  }
  if (PDF_EXTENSIONS.has(ext)) {
    return extractPdf(filePath, logger);
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return extractImage(filePath, logger);
  }
  if (OFFICE_EXTENSIONS.has(ext)) {
    return extractOffice(filePath, logger);
  }
  if (AUDIO_EXTENSIONS.has(ext) && gp) {
    return extractAudio(filePath, gp, logger);
  }

  // Unknown type — skip
  return null;
}
