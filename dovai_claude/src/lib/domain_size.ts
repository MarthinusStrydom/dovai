/**
 * Domain size classification.
 *
 * Purely descriptive: we show file count + bytes + a subjective "band" to help
 * the user understand what they're about to ask Dovai to do. We deliberately
 * do NOT predict how long indexing will take — too many variables (hardware,
 * LM Studio model, file-type mix) to do honestly.
 *
 * Bands are tuned for the Dovai target: focused, scoped domains on a single
 * Mac. A "very large" domain isn't forbidden; the product is simply opinionated
 * that splitting it usually produces better results from Sarah.
 */

export type SizeBand = "compact" | "moderate" | "large" | "very_large";

export interface DomainSize {
  file_count: number;
  total_bytes: number;
  band: SizeBand;
  /** Short one-line description shown on the indexing card. */
  summary: string;
  /** Extra sentence for large / very_large bands. */
  advice?: string;
}

export interface SizeBandConfig {
  /** Upper bound (exclusive) for compact band. */
  compact_max: number;
  /** Upper bound (exclusive) for moderate band. */
  moderate_max: number;
  /** Upper bound (exclusive) for large band; anything ≥ this is very_large. */
  large_max: number;
}

export const DEFAULT_BAND_CONFIG: SizeBandConfig = {
  compact_max: 500,
  moderate_max: 2500,
  large_max: 7500,
};

export function classifyDomain(
  fileCount: number,
  totalBytes: number,
  config: SizeBandConfig = DEFAULT_BAND_CONFIG,
): DomainSize {
  let band: SizeBand;
  let summary: string;
  let advice: string | undefined;

  if (fileCount < config.compact_max) {
    band = "compact";
    summary = "Small, indexes quickly.";
  } else if (fileCount < config.moderate_max) {
    band = "moderate";
    summary = "Typical size for Dovai.";
  } else if (fileCount < config.large_max) {
    band = "large";
    summary = "Sizeable — may take a long time on slower models.";
    advice =
      "Indexing this domain will run for a while. You can still start it, but consider whether a smaller, more focused domain would serve you better.";
  } else {
    band = "very_large";
    summary = "Consider splitting into sub-domains.";
    advice =
      "Dovai works best on focused, scoped domains. Sarah reasons more coherently across a tighter set of files. You can proceed, but splitting by year, project, or entity usually gives better answers.";
  }

  return { file_count: fileCount, total_bytes: totalBytes, band, summary, advice };
}

/**
 * Format bytes as a short human string (e.g. "8.2 GB", "420 MB").
 * Used by the Web UI and TUI welcome message.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unitIdx = 0;
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024;
    unitIdx++;
  }
  return size < 10 ? `${size.toFixed(1)} ${units[unitIdx]}` : `${Math.round(size)} ${units[unitIdx]}`;
}
