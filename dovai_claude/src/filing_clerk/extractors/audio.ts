/**
 * Audio extraction via whisper.cpp (local speech-to-text).
 *
 * Handles .ogg (Telegram voice), .mp3, .wav, .flac, .m4a files.
 * Falls back gracefully if whisper-cli is not installed — the file is
 * skipped rather than crashing the compiler pipeline.
 */
import { transcribe } from "../../lib/transcribe.ts";
import { loadProviderSettings } from "../../lib/config.ts";
import type { GlobalPaths } from "../../lib/global_paths.ts";
import type { Extraction } from "./index.ts";
import type { Logger } from "../../lib/logger.ts";

export async function extractAudio(
  filePath: string,
  gp: GlobalPaths,
  logger: Logger,
): Promise<Extraction | null> {
  const { data: providers } = loadProviderSettings(gp);
  const result = await transcribe(filePath, providers.whisper_model_path, logger);

  if (!result) {
    logger.debug("audio transcription unavailable, skipping", { file: filePath });
    return null;
  }

  if (!result.text) {
    return { text: "", method: "whisper_silent" };
  }

  return { text: result.text, method: "whisper" };
}
