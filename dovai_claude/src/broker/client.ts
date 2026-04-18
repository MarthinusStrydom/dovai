/**
 * Broker client — drop-in replacement for direct LM Studio fetch() calls.
 *
 * Routes requests through the global LM Studio broker (with priority
 * headers) so multiple Dovai workspaces share LM Studio fairly.
 *
 * Falls back to direct LM Studio if the broker is not running.
 */
import { discoverBroker } from "./lifecycle.ts";
import type { Priority } from "./queue.ts";

export type { Priority } from "./queue.ts";

/**
 * Make a request to LM Studio through the priority broker.
 *
 * @param lmStudioUrl  - Direct LM Studio URL (fallback if broker is down)
 * @param endpoint     - Path, e.g. "/v1/chat/completions"
 * @param body         - JSON-serialisable request body
 * @param priority     - Queue priority: critical | high | normal | low
 * @param options.timeout - Timeout in ms (applies to the full request including queue wait)
 */
export async function brokerFetch(
  lmStudioUrl: string,
  endpoint: string,
  body: unknown,
  priority: Priority,
  options?: { timeout?: number },
): Promise<Response> {
  const timeout = options?.timeout ?? 3 * 60_000;

  // Try broker first
  const broker = discoverBroker();
  if (broker) {
    try {
      return await fetch(`${broker.url}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Dovai-Priority": priority,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      // Broker unreachable — fall through to direct
    }
  }

  // Fallback: direct to LM Studio (no priority, no queuing)
  const baseUrl = lmStudioUrl.replace(/\/+$/, "");
  return fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
}
