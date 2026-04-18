/**
 * Eezifin Anchor API client.
 *
 * Thin HTTP wrapper — just get(), post(), and describe(). All typed per-action
 * methods are gone; the MCP server discovers actions dynamically from the
 * describe endpoint and calls get/post directly.
 */

export interface EezifinConfig {
  baseUrl: string;
  apiKey: string;
}

/** A single action from the describe response. */
export interface ActionMeta {
  name: string;
  description: string;
  method: string;
  params: Record<string, string> | [];
  example: string;
}

/** The full describe response. */
export interface DescribeResponse {
  api: string;
  version: string;
  base_url: string;
  count: number;
  actions: ActionMeta[];
}

export class EezifinClient {
  constructor(private readonly config: EezifinConfig) {}

  /** Fetch the API's self-description — the single source of truth for available actions. */
  async describe(): Promise<DescribeResponse> {
    return (await this.get("describe")) as DescribeResponse;
  }

  /** GET request with action + query params. */
  async get(
    action: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    const url = new URL(this.config.baseUrl);
    url.searchParams.set("action", action);
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        if (val !== undefined && val !== null && val !== "") {
          url.searchParams.set(key, String(val));
        }
      }
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-API-Key": this.config.apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Eezifin API ${action} returned ${res.status}: ${body}`);
    }

    return res.json();
  }

  /** POST request with action + query params + JSON body. */
  async post(
    action: string,
    params?: Record<string, string | number | undefined>,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const url = new URL(this.config.baseUrl);
    url.searchParams.set("action", action);
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        if (val !== undefined && val !== null && val !== "") {
          url.searchParams.set(key, String(val));
        }
      }
    }

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "X-API-Key": this.config.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Eezifin API ${action} returned ${res.status}: ${text}`);
    }

    return res.json();
  }
}
