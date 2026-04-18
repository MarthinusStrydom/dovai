/**
 * Stale summary detection.
 *
 * After a file is recompiled, we check whether any other file's entities
 * reference it. If file A's entities.references includes "report.pdf" and
 * report.pdf just changed, then A's summary might be stale — it was written
 * when report.pdf had different content.
 *
 * Staleness is advisory: the summary is still usable, but Sarah and the
 * search endpoint can flag it for re-read or re-compile.
 */
import type { CompileState } from "../lib/compile_state.ts";
import type { Logger } from "../lib/logger.ts";

/**
 * Given a file that was just (re)compiled, mark any files that reference it
 * as potentially stale. Returns the list of paths that were marked stale.
 */
export function markDependentsStale(
  state: CompileState,
  changedRelPath: string,
  logger: Logger,
): string[] {
  const changedBasename = basename(changedRelPath);
  const markedStale: string[] = [];

  for (const [relPath, entry] of Object.entries(state.files)) {
    if (relPath === changedRelPath) continue;
    if (entry.status !== "compiled") continue;
    if (!entry.entities?.references?.length) continue;

    // Check if any of this file's references match the changed file.
    // We match by basename (case-insensitive) since documents typically
    // reference each other by filename, not full path.
    const referencesChanged = entry.entities.references.some((ref) => {
      const refBase = basename(ref);
      return (
        refBase === changedBasename ||
        ref.toLowerCase() === changedRelPath.toLowerCase()
      );
    });

    if (referencesChanged && !entry.stale) {
      entry.stale = true;
      entry.stale_reason = `Referenced file changed: ${changedRelPath}`;
      markedStale.push(relPath);
      logger.info("marked stale", { file: relPath, because: changedRelPath });
    }
  }

  return markedStale;
}

/**
 * Clear the stale flag on a file (e.g. after it's recompiled).
 */
export function clearStale(state: CompileState, relPath: string): void {
  const entry = state.files[relPath];
  if (entry) {
    entry.stale = undefined;
    entry.stale_reason = undefined;
  }
}

/**
 * List all files currently marked stale.
 */
export function listStaleFiles(state: CompileState): string[] {
  return Object.entries(state.files)
    .filter(([, e]) => e.stale)
    .map(([relPath]) => relPath);
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return (parts.pop() ?? p).toLowerCase();
}
