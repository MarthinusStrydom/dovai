/**
 * Triage verdicts produced by Smart Folders (or by the user via overrides).
 *
 * A verdict tells the filing clerk what to do with a file:
 *   - keep   → index normally (full extract + summary + entities)
 *   - skip   → do not index; file stays in place, never deleted
 *   - defer  → record path + metadata only, skip full summarisation
 *
 * This type is shared between src/smart_folders/ (which produces it) and
 * src/filing_clerk/ (which honours it). Keep it narrow — any richer data
 * belongs in the producing subsystem's own types.
 */

export type TriageDecision = "keep" | "skip" | "defer";

export interface TriageVerdict {
  verdict: TriageDecision;
  /** Short human-readable reason. Shown in the per-domain triage table. */
  reason?: string;
}
