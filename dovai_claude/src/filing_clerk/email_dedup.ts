/**
 * Email dedup guard.
 *
 * Before the outbox dispatcher sends an external email, this module checks
 * the activity ledger for recent emails to the same recipient(s). If any
 * are found, it asks LM Studio whether the new email is semantically the
 * same as a previously sent one. If yes, the email is blocked.
 *
 * Emails to the workspace owner (user_email from workspace.md) are exempt
 * — duplicates to the boss are harmless, duplicates to external people are
 * not.
 *
 * If LM Studio is unreachable, we fail closed (block) to be safe.
 */
import { readLedger } from "../lib/ledger.ts";
import { loadProviderSettings, loadWorkspaceSettings } from "../lib/config.ts";
import type { GlobalPaths } from "../lib/global_paths.ts";
import { brokerFetch } from "../broker/client.ts";

/** How far back to look in the ledger for potential duplicates. */
const LOOKBACK_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Max ledger entries to scan. */
const LOOKBACK_ENTRIES = 100;

export interface DedupResult {
  blocked: boolean;
  reason: string;
  matchedEntry?: string; // description of the matched ledger entry
}

/**
 * Normalise recipients to a flat lowercase array for comparison.
 */
function normaliseRecipients(to: string | string[] | undefined): string[] {
  if (!to) return [];
  const arr = Array.isArray(to) ? to : [to];
  return arr.map((s) => s.toLowerCase().trim());
}

/**
 * Check whether any recipient in `to` overlaps with any in `other`.
 */
function recipientsOverlap(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((addr) => set.has(addr));
}

/**
 * Check whether this email should be blocked as a duplicate.
 *
 * Returns { blocked: false } if:
 *   - All recipients are the workspace owner (exempt)
 *   - No recent emails to the same recipients in the ledger
 *   - LM Studio says the emails are different
 *
 * Returns { blocked: true, reason } if:
 *   - LM Studio says the emails are semantically the same
 *   - LM Studio is unreachable (fail closed)
 */
export async function checkEmailDedup(
  gp: GlobalPaths,
  newEmail: {
    to?: string | string[];
    cc?: string | string[];
    subject?: string;
    body_text?: string;
  },
): Promise<DedupResult> {
  // 1. Resolve the owner's email — emails to them are exempt.
  const { data: ws } = loadWorkspaceSettings(gp);
  const ownerEmail = ws.user_email?.toLowerCase().trim();
  const newTo = normaliseRecipients(newEmail.to);
  const newCc = normaliseRecipients(newEmail.cc);
  const allRecipients = [...newTo, ...newCc];

  if (allRecipients.length === 0) {
    return { blocked: false, reason: "no recipients" };
  }

  // If every recipient is the owner, exempt from dedup.
  const externalRecipients = allRecipients.filter((r) => r !== ownerEmail);
  if (externalRecipients.length === 0) {
    return { blocked: false, reason: "all recipients are the workspace owner — exempt" };
  }

  // 2. Read recent email_sent entries from the ledger.
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const entries = readLedger(gp, LOOKBACK_ENTRIES);
  const recentSent = entries.filter(
    (e) => e.action === "email_sent" && e.ts >= cutoff,
  );

  if (recentSent.length === 0) {
    return { blocked: false, reason: "no recent emails in ledger" };
  }

  // 3. Find entries with overlapping recipients.
  const candidates = recentSent.filter((e) => {
    const entryTo = normaliseRecipients(e.details?.to as string | string[] | undefined);
    return recipientsOverlap(externalRecipients, entryTo);
  });

  if (candidates.length === 0) {
    return { blocked: false, reason: "no recent emails to the same external recipients" };
  }

  // 4. Ask LM Studio if any candidate is semantically the same.
  const { data: providers } = loadProviderSettings(gp);
  const baseUrl = providers.lm_studio_url?.replace(/\/+$/, "") || "http://127.0.0.1:1234";
  const model = providers.lm_studio_model || "";

  // Build a summary of the new email.
  const newSummary = [
    `To: ${allRecipients.join(", ")}`,
    `Subject: ${newEmail.subject || "(no subject)"}`,
    `Body: ${(newEmail.body_text || "").slice(0, 500)}`,
  ].join("\n");

  // Build summaries of candidates.
  const candidateSummaries = candidates.map((e, i) => {
    const to = e.details?.to || "unknown";
    const subject = e.details?.subject || "(no subject)";
    return `Previously sent email ${i + 1} (${e.ts}):\n  To: ${to}\n  Subject: ${subject}\n  Description: ${e.description}`;
  }).join("\n\n");

  const prompt = `You are a duplicate email detector. Compare this NEW email against the PREVIOUSLY SENT emails below.

NEW EMAIL:
${newSummary}

PREVIOUSLY SENT EMAILS:
${candidateSummaries}

Is the new email essentially the same message as any of the previously sent emails? Consider:
- Same recipient + same subject/topic = likely duplicate
- Same recipient + different topic = NOT a duplicate (e.g. a new invoice vs an old one)
- A follow-up or reply is NOT a duplicate
- Forwarding the same info to a different person is NOT a duplicate

Reply with exactly one line:
DUPLICATE: <one sentence explanation>
or
NOT_DUPLICATE: <one sentence explanation>`;

  try {
    const res = await brokerFetch(
      baseUrl,
      "/v1/chat/completions",
      {
        ...(model ? { model } : {}),
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 100,
      },
      "critical",
      { timeout: 15_000 },
    );

    if (!res.ok) {
      // LM Studio error — fail closed.
      return {
        blocked: true,
        reason: `LM Studio returned ${res.status} — blocking to be safe. Check LM Studio and retry.`,
      };
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const answer = data.choices?.[0]?.message?.content?.trim() || "";

    if (answer.startsWith("DUPLICATE")) {
      const explanation = answer.replace(/^DUPLICATE:?\s*/, "");
      return {
        blocked: true,
        reason: explanation || "LM Studio detected this is a duplicate email",
        matchedEntry: candidates[0]?.description,
      };
    }

    return { blocked: false, reason: answer.replace(/^NOT_DUPLICATE:?\s*/, "") || "LM Studio confirmed this is not a duplicate" };
  } catch (err) {
    // Network error, timeout, etc. — fail closed.
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      blocked: true,
      reason: `LM Studio unreachable (${errMsg}) — blocking to be safe. Check LM Studio and retry.`,
    };
  }
}
