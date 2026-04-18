/**
 * Gmail OAuth2 helpers.
 *
 * Dovai uses the Google Cloud **Desktop** OAuth client type with the
 * loopback redirect flow: Google accepts `http://localhost:<any_port>`
 * as the redirect URI without per-URI pre-registration, so the Dovai
 * server can receive the consent callback on whatever port it's already
 * listening on.
 *
 * Stored state lives entirely in `settings/providers.md`:
 *   - `gmail_client_id`     — public, from the Cloud Console
 *   - `gmail_client_secret` — not actually confidential for Desktop clients
 *     per Google's own docs, but we keep it private-ish alongside other creds
 *   - `gmail_refresh_token` — the long-lived token (set by the consent flow,
 *     used forever after to mint short-lived access tokens)
 *   - `gmail_user_email`    — the account email, captured on consent
 *   - `gmail_send_aliases`  — verified Send-mail-as aliases
 *
 * The googleapis client library handles access-token refresh automatically
 * when you pass an OAuth2Client with a refresh_token set.
 */
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { ProviderSettings } from "./config.ts";

/**
 * Scopes Sarah needs. `gmail.modify` covers read, label management, and
 * compose-draft. `gmail.send` is separate because Google treats sending as
 * a higher-risk scope. We ask for both.
 *
 * If the user wants to tighten: remove `gmail.send` and Sarah can only
 * draft (the user would then send from Gmail's UI manually).
 */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  // userinfo.email — so we can capture which account the user consented with
  "https://www.googleapis.com/auth/userinfo.email",
];

/**
 * Build an OAuth2 client from provider settings. The `redirectUri` argument
 * is set per-flow (the consent URL and the code-exchange call must use the
 * same URI, but after auth the refresh-token-driven client doesn't need one).
 */
export function makeOAuth2Client(pr: ProviderSettings, redirectUri?: string): OAuth2Client {
  if (!pr.gmail_client_id || !pr.gmail_client_secret) {
    throw new Error(
      "gmail_client_id / gmail_client_secret not set in providers.md — " +
        "paste them from your Google Cloud Desktop OAuth client JSON.",
    );
  }
  const client = new google.auth.OAuth2(
    pr.gmail_client_id,
    pr.gmail_client_secret,
    redirectUri,
  );
  if (pr.gmail_refresh_token) {
    client.setCredentials({ refresh_token: pr.gmail_refresh_token });
  }
  return client;
}

/**
 * Build the Google consent URL. After the user approves, Google redirects
 * back to `redirectUri` with `?code=...` (and `?state=...` we passed in).
 *
 * `access_type: "offline"` is critical — it's what makes Google include a
 * refresh token in the response. `prompt: "consent"` forces the consent
 * screen even if the user has already approved before, which guarantees we
 * get a fresh refresh token (Google sometimes omits it on re-consent).
 */
export function buildAuthUrl(
  pr: ProviderSettings,
  redirectUri: string,
  state: string,
): string {
  const client = makeOAuth2Client(pr, redirectUri);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
    state,
  });
}

export interface ExchangeResult {
  refresh_token: string;
  user_email: string;
  /** access token, valid ~1h — not usually persisted, googleapis refreshes on demand */
  access_token: string;
  expiry_date?: number;
}

/**
 * Exchange the one-time authorization code (from the callback URL) for a
 * refresh token + access token, and capture the account email.
 */
export async function exchangeCodeForTokens(
  pr: ProviderSettings,
  redirectUri: string,
  code: string,
): Promise<ExchangeResult> {
  const client = makeOAuth2Client(pr, redirectUri);
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. This usually means the " +
        "consent screen was bypassed because the user previously approved " +
        "this client. Revoke Dovai at https://myaccount.google.com/permissions " +
        "and try again — the flow uses prompt=consent which should normally " +
        "force a fresh refresh token, but aggressive browser caching can " +
        "interfere.",
    );
  }

  // Capture the account email so providers.md gets the right user.
  client.setCredentials(tokens);
  const { data: userInfo } = await google.oauth2({ version: "v2", auth: client }).userinfo.get();

  return {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token ?? "",
    expiry_date: tokens.expiry_date ?? undefined,
    user_email: userInfo.email ?? "",
  };
}

/**
 * Return a ready-to-use Gmail API client, authenticated with the stored
 * refresh token. Throws if OAuth isn't set up.
 */
export function makeGmailClient(pr: ProviderSettings) {
  if (!pr.gmail_refresh_token) {
    throw new Error(
      "Gmail is not connected. Run the Connect-Gmail flow in Settings → Providers first.",
    );
  }
  const auth = makeOAuth2Client(pr);
  return google.gmail({ version: "v1", auth });
}
