/**
 * Voice transcription via whisper.cpp (whisper-cli).
 *
 * Shells out to the locally-installed whisper-cli binary with Metal GPU
 * acceleration on Apple Silicon. If the configured model isn't present,
 * downloads ggml-small.bin from Hugging Face on first use (~466 MB).
 *
 * The model path is configurable via providers.md → whisper_model_path.
 * If blank, defaults to ~/.dovai/models/ggml-small.bin.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { Logger } from "./logger.ts";

const DEFAULT_MODEL_DIR = path.join(os.homedir(), ".dovai", "models");
const DEFAULT_MODEL_NAME = "ggml-small.bin";
const MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";

/** Known locations for whisper-cli installed via Homebrew. */
const WHISPER_CLI_CANDIDATES = [
  "/opt/homebrew/bin/whisper-cli",
  "/opt/homebrew/Cellar/whisper-cpp/1.8.4/bin/whisper-cli",
  "/usr/local/bin/whisper-cli",
];

async function findWhisperCli(): Promise<string | null> {
  // Check PATH first
  try {
    const result = await runCmd("which", ["whisper-cli"]);
    if (result.code === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // fall through
  }
  // Check known Homebrew locations
  for (const candidate of WHISPER_CLI_CANDIDATES) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function runCmd(
  cmd: string,
  args: string[],
  timeoutMs = 10_000,
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
      resolve({ stdout: "", stderr: "", code: -1 });
    });
  });
}

async function ensureModel(modelPath: string, logger: Logger): Promise<boolean> {
  try {
    const stat = await fs.stat(modelPath);
    // Sanity check: ggml-small.bin should be >400 MB
    if (stat.size > 100 * 1024 * 1024) return true;
    logger.warn("whisper model file seems too small, re-downloading", {
      path: modelPath,
      size: stat.size,
    });
  } catch {
    // doesn't exist, download it
  }

  logger.info("downloading whisper model (this only happens once)", {
    url: MODEL_URL,
    dest: modelPath,
  });

  await fs.mkdir(path.dirname(modelPath), { recursive: true });
  const tmpPath = `${modelPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;

  try {
    // Use curl for the download — it handles redirects and shows progress
    const result = await runCmd(
      "curl",
      ["-fSL", "--progress-bar", "-o", tmpPath, MODEL_URL],
      600_000, // 10 minute timeout for large download
    );
    if (result.code !== 0) {
      logger.error("whisper model download failed", { stderr: result.stderr });
      await fs.rm(tmpPath, { force: true });
      return false;
    }
    await fs.rename(tmpPath, modelPath);
    logger.info("whisper model downloaded successfully", { path: modelPath });
    return true;
  } catch (err) {
    logger.error("whisper model download error", {
      error: err instanceof Error ? err.message : String(err),
    });
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    return false;
  }
}

/** Extensions that need ffmpeg conversion to WAV before whisper-cli can process them. */
const NEEDS_CONVERSION = new Set([".ogg", ".oga", ".opus", ".m4a", ".webm", ".mp3", ".flac"]);

/**
 * Convert audio to 16 kHz mono WAV (the format whisper expects).
 * Returns the path to the temp WAV, or null on failure.
 */
async function convertToWav(
  audioPath: string,
  logger: Logger,
): Promise<string | null> {
  const wavPath = path.join(
    os.tmpdir(),
    `dovai_whisper_${crypto.randomBytes(6).toString("hex")}.wav`,
  );
  const result = await runCmd(
    "ffmpeg",
    ["-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
    60_000,
  );
  if (result.code !== 0) {
    logger.error("ffmpeg conversion failed", { stderr: result.stderr.slice(-300) });
    await fs.rm(wavPath, { force: true }).catch(() => {});
    return null;
  }
  return wavPath;
}

export interface TranscribeResult {
  text: string;
  durationMs: number;
}

/**
 * Transcribe an audio file using whisper-cli.
 *
 * OGG/Opus (Telegram voice), MP3, FLAC, M4A files are automatically
 * converted to WAV via ffmpeg before transcription. WAV files are passed
 * directly.
 *
 * @param audioPath  Absolute path to the audio file
 * @param modelPath  Path to the GGML model file (empty string = use default)
 * @param logger     Logger instance
 * @returns          Transcribed text, or null if transcription failed
 */
export async function transcribe(
  audioPath: string,
  modelPath: string,
  logger: Logger,
): Promise<TranscribeResult | null> {
  const start = Date.now();

  // Find whisper-cli binary
  const cli = await findWhisperCli();
  if (!cli) {
    logger.error(
      "whisper-cli not found. Install with: brew install whisper-cpp",
    );
    return null;
  }

  // Resolve model path
  const model =
    modelPath && modelPath.trim()
      ? modelPath.trim()
      : path.join(DEFAULT_MODEL_DIR, DEFAULT_MODEL_NAME);

  // Ensure model exists (download if needed)
  const modelReady = await ensureModel(model, logger);
  if (!modelReady) return null;

  // Convert non-WAV audio to WAV (whisper-cli's OGG/Opus support is unreliable)
  const ext = path.extname(audioPath).toLowerCase();
  let inputPath = audioPath;
  let tmpWav: string | null = null;

  if (NEEDS_CONVERSION.has(ext)) {
    tmpWav = await convertToWav(audioPath, logger);
    if (!tmpWav) return null;
    inputPath = tmpWav;
  }

  // Write output to a temp file to reliably capture the transcription
  const tmpBase = path.join(
    os.tmpdir(),
    `dovai_whisper_${crypto.randomBytes(6).toString("hex")}`,
  );

  try {
    const result = await runCmd(
      cli,
      [
        "-m", model,
        "-f", inputPath,
        "-l", "auto",        // auto-detect language
        "--no-timestamps",
        "-of", tmpBase,
        "-otxt",
      ],
      120_000, // 2 minute timeout per transcription
    );

    if (result.code !== 0) {
      logger.error("whisper-cli failed", {
        code: result.code,
        stderr: result.stderr.slice(-500),
      });
      return null;
    }

    // Read the .txt output file
    const txtPath = `${tmpBase}.txt`;
    let text: string;
    try {
      text = await fs.readFile(txtPath, "utf8");
    } catch {
      // Fallback: some versions write to stdout
      text = result.stdout;
    }

    text = text.trim();
    const durationMs = Date.now() - start;

    if (!text) {
      logger.warn("whisper produced empty transcription", { file: audioPath });
      return { text: "", durationMs };
    }

    logger.info("transcription complete", {
      file: path.basename(audioPath),
      chars: text.length,
      ms: durationMs,
    });

    return { text, durationMs };
  } finally {
    // Clean up temp files
    await fs.rm(`${tmpBase}.txt`, { force: true }).catch(() => {});
    if (tmpWav) await fs.rm(tmpWav, { force: true }).catch(() => {});
  }
}
