/**
 * Path resolution helpers. Everything path-related goes through here so the
 * project remains portable — no absolute paths hardcoded anywhere in source.
 *
 * For the full ~/.dovai/ path structure, see src/lib/global_paths.ts.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Absolute path to the dovai_claude project root (the folder containing package.json).
 * Computed from this file's location so it survives the project being moved.
 */
export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const TEMPLATES_DIR = path.join(PROJECT_ROOT, "templates");
export const STATIC_DIR = path.join(PROJECT_ROOT, "src", "web", "static");
