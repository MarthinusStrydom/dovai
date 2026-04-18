/**
 * LM Studio Broker — priority-aware proxy for LM Studio requests.
 *
 * Sits between all Dovai workspace servers and a single LM Studio instance.
 * Serialises access to LM Studio with priority ordering so that real-time
 * operations (email dedup, incremental compiles) always jump ahead of bulk
 * indexing and digest generation.
 *
 * Exposes the same OpenAI-compatible API as LM Studio. Callers set the
 * `X-Dovai-Priority` header to indicate urgency.
 *
 * Endpoints:
 *   POST /v1/chat/completions   — queued by priority
 *   GET  /v1/models             — passthrough (no queue)
 *   GET  /health                — queue stats + status
 */
import http from "node:http";
import { PriorityQueue, type Priority } from "./queue.ts";

interface PendingRequest {
  resolve: (response: ProxyResponse) => void;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  clientAlive: () => boolean;
}

interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class LmBroker {
  private queue = new PriorityQueue<PendingRequest>();
  private processing = false;
  private server: http.Server | null = null;
  private lmStudioUrl: string;
  private totalProcessed = 0;
  private startedAt = new Date().toISOString();

  constructor(lmStudioUrl: string) {
    this.lmStudioUrl = lmStudioUrl.replace(/\/+$/, "");
  }

  async start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server!.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve(actualPort);
      });
      this.server.on("error", reject);
    });
  }

  stop(): void {
    this.server?.close();
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Health / stats endpoint
    if (req.url === "/health") {
      const stats = this.queue.stats();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        lm_studio_url: this.lmStudioUrl,
        queue: stats,
        queue_total: this.queue.length,
        processing: this.processing,
        total_processed: this.totalProcessed,
        started_at: this.startedAt,
      }));
      return;
    }

    // Passthrough for /v1/models (no queuing needed, it's a quick probe)
    if (req.url === "/v1/models") {
      this.passthrough(req, res);
      return;
    }

    // Everything else goes through the priority queue
    const priority = parsePriority(req.headers["x-dovai-priority"] as string);

    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        // Don't forward internal headers or hop-by-hop headers
        if (k === "x-dovai-priority" || k === "host" || k === "connection") continue;
        if (typeof v === "string") headers[k] = v;
      }

      const pending: PendingRequest = {
        resolve: (response) => {
          if (res.destroyed) return;
          res.writeHead(response.status, response.headers);
          res.end(response.body);
        },
        method: req.method || "POST",
        path: req.url || "/v1/chat/completions",
        headers,
        body,
        clientAlive: () => !res.destroyed,
      };

      this.queue.enqueue(priority, pending);
      this.processNext();
    });
  }

  /**
   * Direct passthrough to LM Studio — no queuing.
   * Used for /v1/models preflight checks.
   */
  private async passthrough(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const upstream = await fetch(`${this.lmStudioUrl}${req.url}`, {
        method: req.method || "GET",
        signal: AbortSignal.timeout(5_000),
      });
      const body = await upstream.text();
      const headers: Record<string, string> = {};
      upstream.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(upstream.status, headers);
      res.end(body);
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /**
   * Process the next item in the queue. Serialises access to LM Studio —
   * only one request at a time.
   */
  private async processNext(): Promise<void> {
    if (this.processing) return;

    const item = this.queue.dequeue();
    if (!item) return;

    this.processing = true;
    const pending = item.data;

    // Skip if the client already disconnected (timed out waiting in queue)
    if (!pending.clientAlive()) {
      this.processing = false;
      this.processNext();
      return;
    }

    try {
      const response = await fetch(`${this.lmStudioUrl}${pending.path}`, {
        method: pending.method,
        headers: pending.headers,
        body: pending.method !== "GET" ? pending.body : undefined,
        // No timeout here — the client's own timeout controls when it gives up.
        // If the client disconnects, we'll notice on the next processNext call.
        // But add a generous ceiling to prevent zombie requests.
        signal: AbortSignal.timeout(5 * 60_000),
      });

      const responseBody = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => { responseHeaders[k] = v; });

      pending.resolve({ status: response.status, headers: responseHeaders, body: responseBody });
    } catch (err) {
      pending.resolve({
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          error: `Broker: LM Studio request failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      });
    }

    this.totalProcessed++;
    this.processing = false;

    // Process next item in queue (if any)
    this.processNext();
  }
}

function parsePriority(header: string | undefined): Priority {
  if (header === "critical" || header === "high" || header === "normal" || header === "low") {
    return header;
  }
  return "normal";
}
