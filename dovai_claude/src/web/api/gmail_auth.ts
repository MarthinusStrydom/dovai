/**
 * /api/auth/gmail/* — OAuth consent flow for Gmail.
 *
 *   GET  /api/auth/gmail/status   → returns current connection state
 *   GET  /api/auth/gmail/start    → redirects to Google's consent screen
 *   GET  /api/auth/gmail/callback → Google redirects here after consent;
 *                                    exchanges the code for a refresh token,
 *                                    persists it to providers.md, and
 *                                    redirects back to the Settings tab
 *   POST /api/auth/gmail/disconnect → clears the refresh token
 *
 * See src/lib/gmail_auth.ts for the token-level details and docs/PLAN_DATA_DIR_SPLIT.md
 * context on why secrets live in providers.md.
 */
import crypto from "node:crypto";
import type { Hono } from "hono";
import type { ServerContext } from "../types.ts";
import { loadProviderSettings, saveProviderSettings } from "../../lib/config.ts";
import { buildAuthUrl, exchangeCodeForTokens } from "../../lib/gmail_auth.ts";

/** One in-flight auth attempt; held in memory only. Invalidated on server restart. */
interface PendingAuth {
  state: string;
  redirect_uri: string;
  created_at: number;
}

/** 5-minute TTL on a pending auth; longer than that, something went wrong. */
const PENDING_TTL_MS = 5 * 60_000;

export function registerGmailAuthRoute(app: Hono, ctx: ServerContext): void {
  let pending: PendingAuth | null = null;

  const redirectUriFor = (c: { req: { url: string } }): string => {
    // Construct the callback URI using the same host/port the request came in on.
    // Desktop OAuth clients accept any localhost port without pre-registration.
    const u = new URL(c.req.url);
    return `${u.protocol}//${u.host}/api/auth/gmail/callback`;
  };

  app.get("/api/auth/gmail/status", (c) => {
    const { data: pr } = loadProviderSettings(ctx.global);
    return c.json({
      backend: pr.email_backend,
      connected: !!pr.gmail_refresh_token && !!pr.gmail_user_email,
      user_email: pr.gmail_user_email || null,
      client_id_configured: !!pr.gmail_client_id && !!pr.gmail_client_secret,
      send_aliases: pr.gmail_send_aliases,
    });
  });

  app.get("/api/auth/gmail/start", (c) => {
    const { data: pr } = loadProviderSettings(ctx.global);
    if (!pr.gmail_client_id || !pr.gmail_client_secret) {
      return c.text(
        "Gmail client ID / secret are not set in providers.md. Paste them " +
          "from your Google Cloud Desktop OAuth client JSON first, then " +
          "click Connect Gmail again.",
        400,
      );
    }
    const state = crypto.randomBytes(16).toString("hex");
    const redirect_uri = redirectUriFor(c);
    pending = { state, redirect_uri, created_at: Date.now() };
    const url = buildAuthUrl(pr, redirect_uri, state);
    return c.redirect(url);
  });

  app.get("/api/auth/gmail/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    const redirectBack = (msg: string, ok: boolean): Response => {
      const status = ok ? "ok" : "error";
      const target = `/#settings?gmail=${status}&msg=${encodeURIComponent(msg)}`;
      return c.html(
        `<!doctype html><meta charset="utf-8"><title>Gmail connection</title>` +
          `<style>body{font-family:system-ui;padding:2em;max-width:560px;margin:auto}` +
          `h1{color:${ok ? "#1a7f37" : "#cf222e"}}code{background:#f0f0f0;padding:.1em .3em;border-radius:3px}</style>` +
          `<h1>${ok ? "✓ Gmail connected" : "✗ Gmail connection failed"}</h1>` +
          `<p>${msg}</p>` +
          `<p><a href="${target}">Return to Dovai</a></p>` +
          `<script>setTimeout(()=>location.href=${JSON.stringify(target)},1500)</script>`,
      );
    };

    if (error) {
      return redirectBack(`Google returned an error: ${error}`, false);
    }
    if (!code || !state) {
      return redirectBack("Missing code or state in callback — the consent flow didn't complete.", false);
    }
    if (!pending || pending.state !== state) {
      return redirectBack(
        "State token mismatch or expired. The consent flow takes under 5 minutes; please start it again.",
        false,
      );
    }
    if (Date.now() - pending.created_at > PENDING_TTL_MS) {
      pending = null;
      return redirectBack("Consent flow timed out. Please try again.", false);
    }

    try {
      const { data: pr, body } = loadProviderSettings(ctx.global);
      const result = await exchangeCodeForTokens(pr, pending.redirect_uri, code);
      const updated = {
        ...pr,
        email_backend: "gmail_oauth" as const,
        gmail_refresh_token: result.refresh_token,
        gmail_user_email: result.user_email,
      };
      saveProviderSettings(ctx.global, updated, body);
      pending = null;
      ctx.logger.info("gmail oauth connected", { email: result.user_email });
      return redirectBack(`Connected as ${result.user_email}.`, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error("gmail oauth exchange failed", { error: msg });
      return redirectBack(`Token exchange failed: ${msg}`, false);
    }
  });

  app.post("/api/auth/gmail/disconnect", (c) => {
    const { data: pr, body } = loadProviderSettings(ctx.global);
    const updated = {
      ...pr,
      gmail_refresh_token: "",
      gmail_user_email: "",
    };
    saveProviderSettings(ctx.global, updated, body);
    ctx.logger.info("gmail oauth disconnected");
    return c.json({ ok: true });
  });
}
