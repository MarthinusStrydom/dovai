/**
 * Settings are markdown files with frontmatter, one per concern, in
 * <workspace>/.dovai/settings/. This module reads and writes them and exposes
 * a typed view. The markdown body is free-form notes; the frontmatter holds
 * machine-readable keys.
 *
 * We use gray-matter to parse/serialize YAML frontmatter.
 */
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { GlobalPaths } from "./global_paths.ts";

export interface WorkspaceSettings {
  workspace_name: string;
  user_name: string;
  user_email: string;
  ai_name: string;
  ai_job_description: string;
  /** Which AI CLI to use: "claude" (default) or "gemini". */
  ai_cli: string;
}

export interface ProviderSettings {
  lm_studio_url: string;
  lm_studio_model: string;
  email_imap_host: string;
  email_imap_port: number;
  email_imap_user: string;
  email_imap_password: string;
  email_smtp_host: string;
  email_smtp_port: number;
  email_smtp_user: string;
  email_smtp_password: string;
  email_smtp_from: string;
  telegram_bot_token: string;
  telegram_allowed_chat_ids: string[];
  telegram_default_chat_id: string;
  eezifin_api_url: string;
  eezifin_api_key: string;
  whisper_model_path: string;
}

export interface WakeSettings {
  wake_times: string[]; // cron expressions
}

const DEFAULT_WORKSPACE: WorkspaceSettings = {
  workspace_name: "",
  user_name: "",
  user_email: "",
  ai_name: "Sarah",
  ai_job_description: "Manager",
  ai_cli: "claude",
};

const DEFAULT_PROVIDERS: ProviderSettings = {
  lm_studio_url: "http://127.0.0.1:1234",
  lm_studio_model: "",
  email_imap_host: "",
  email_imap_port: 993,
  email_imap_user: "",
  email_imap_password: "",
  email_smtp_host: "",
  email_smtp_port: 587,
  email_smtp_user: "",
  email_smtp_password: "",
  email_smtp_from: "",
  telegram_bot_token: "",
  telegram_allowed_chat_ids: [],
  telegram_default_chat_id: "",
  eezifin_api_url: "",
  eezifin_api_key: "",
  whisper_model_path: "",
};

const DEFAULT_WAKES: WakeSettings = {
  wake_times: [],
};

function readSettingsFile<T>(filepath: string, defaults: T): { data: T; body: string } {
  if (!fs.existsSync(filepath)) {
    return { data: { ...defaults }, body: "" };
  }
  const raw = fs.readFileSync(filepath, "utf8");
  const parsed = matter(raw);
  const data = { ...defaults, ...(parsed.data as Partial<T>) };
  return { data, body: parsed.content };
}

function writeSettingsFile<T>(filepath: string, data: T, body: string): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const out = matter.stringify(body || "", data as Record<string, unknown>);
  fs.writeFileSync(filepath, out);
}

export function loadWorkspaceSettings(gp: GlobalPaths): { data: WorkspaceSettings; body: string } {
  return readSettingsFile(path.join(gp.settings, "workspace.md"), DEFAULT_WORKSPACE);
}

export function saveWorkspaceSettings(
  gp: GlobalPaths,
  data: WorkspaceSettings,
  body: string,
): void {
  writeSettingsFile(path.join(gp.settings, "workspace.md"), data, body);
}

export function loadProviderSettings(gp: GlobalPaths): { data: ProviderSettings; body: string } {
  return readSettingsFile(path.join(gp.settings, "providers.md"), DEFAULT_PROVIDERS);
}

export function saveProviderSettings(
  gp: GlobalPaths,
  data: ProviderSettings,
  body: string,
): void {
  writeSettingsFile(path.join(gp.settings, "providers.md"), data, body);
}

export function loadWakeSettings(gp: GlobalPaths): { data: WakeSettings; body: string } {
  return readSettingsFile(path.join(gp.settings, "wakes.md"), DEFAULT_WAKES);
}

export function saveWakeSettings(gp: GlobalPaths, data: WakeSettings, body: string): void {
  writeSettingsFile(path.join(gp.settings, "wakes.md"), data, body);
}

// ---------- Identity ----------
// identity.md is a free-form markdown file, not frontmatter. We just want
// to know whether the user has personalised it yet. We compare against the
// template shipped with dovai_claude — if they're byte-identical, the
// user hasn't touched it.

import crypto from "node:crypto";
import { TEMPLATES_DIR } from "./paths.ts";

export function loadIdentity(gp: GlobalPaths): string {
  if (!fs.existsSync(gp.identityMd)) return "";
  return fs.readFileSync(gp.identityMd, "utf8");
}

export function saveIdentity(gp: GlobalPaths, content: string): void {
  fs.mkdirSync(path.dirname(gp.identityMd), { recursive: true });
  fs.writeFileSync(gp.identityMd, content);
}

function hashString(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function identityIsStillTemplate(gp: GlobalPaths): boolean {
  const templatePath = path.join(TEMPLATES_DIR, "identity.md");
  if (!fs.existsSync(templatePath)) return false;
  const template = fs.readFileSync(templatePath, "utf8");
  const current = loadIdentity(gp);
  if (!current) return true;
  return hashString(template) === hashString(current);
}

// ---------- Setup status ----------
// Surfaces which pieces of the workspace the user still needs to configure.
// Used by /api/status so the web UI can show a wizard and Claude (Mode 2)
// can refuse to do real work until setup is complete.

export interface SetupStatus {
  identity_configured: boolean;
  workspace_configured: boolean; // user_name + user_email + workspace_name
  email_configured: boolean;     // both IMAP and SMTP host+user set
  telegram_configured: boolean;  // bot token set
  wakes_configured: boolean;     // at least one wake time
  ready: boolean;                // true = Sarah can work
  missing: string[];             // human-readable list of what's still needed
}

function nonEmpty(s: string | undefined | null): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

export function computeSetupStatus(gp: GlobalPaths): SetupStatus {
  const { data: ws } = loadWorkspaceSettings(gp);
  const { data: pr } = loadProviderSettings(gp);
  const { data: wk } = loadWakeSettings(gp);

  const identity_configured = !identityIsStillTemplate(gp);
  const workspace_configured =
    nonEmpty(ws.workspace_name) &&
    nonEmpty(ws.user_name) &&
    nonEmpty(ws.user_email);
  const email_configured =
    nonEmpty(pr.email_imap_host) &&
    nonEmpty(pr.email_imap_user) &&
    nonEmpty(pr.email_smtp_host) &&
    nonEmpty(pr.email_smtp_user);
  const telegram_configured = nonEmpty(pr.telegram_bot_token);
  const wakes_configured = Array.isArray(wk.wake_times) && wk.wake_times.length > 0;

  // "ready" means the minimum for Sarah to be useful: she knows who she
  // works for, knows who you are, and has at least one communication
  // channel configured (email OR telegram). Wakes can be empty (she can
  // still respond to user-triggered approvals and interactive sessions).
  const ready =
    identity_configured &&
    workspace_configured &&
    (email_configured || telegram_configured);

  const missing: string[] = [];
  if (!identity_configured) missing.push("identity (who Sarah works for)");
  if (!workspace_configured) missing.push("your name, email, and workspace name");
  if (!email_configured && !telegram_configured) {
    missing.push("at least one channel (email or telegram)");
  }

  return {
    identity_configured,
    workspace_configured,
    email_configured,
    telegram_configured,
    wakes_configured,
    ready,
    missing,
  };
}

// ---------- Domain context ----------

import type { DomainPaths } from "./global_paths.ts";

/** Read a domain's context.md (free-form markdown describing the domain). */
export function loadDomainContext(dp: DomainPaths): string {
  if (!fs.existsSync(dp.contextMd)) return "";
  return fs.readFileSync(dp.contextMd, "utf8");
}

/** Write a domain's context.md. */
export function saveDomainContext(dp: DomainPaths, content: string): void {
  fs.mkdirSync(path.dirname(dp.contextMd), { recursive: true });
  fs.writeFileSync(dp.contextMd, content);
}
