/**
 * Global Dovai home lifecycle: init, validate.
 *
 * Scaffolds both the state dir (~/.dovai/) and the data dir (user-picked,
 * possibly Drive-synced). See docs/PLAN_DATA_DIR_SPLIT.md for the split
 * rationale. Domains point to user directories from the registry.
 */
import fs from "node:fs";
import path from "node:path";
import { TEMPLATES_DIR } from "./paths.ts";
import type { GlobalPaths } from "./global_paths.ts";

/**
 * Create the Dovai directory structure (state root + data root) from templates.
 * Idempotent — safe to run on every server start.
 */
export function initGlobalDovai(gp: GlobalPaths): void {
  // Ensure every expected folder exists.
  // Parent dirs (stateRoot, dataRoot) come first; subfolders below them.
  const dirs = [
    gp.stateRoot,
    gp.dataRoot,
    gp.settings,
    gp.sops,
    gp.tasks,
    gp.tasksActive,
    gp.tasksDone,
    gp.drafts,
    gp.contacts,
    gp.memory,
    gp.domainsDir,
    gp.wakeQueue,
    gp.state,
    gp.sessions,
    gp.logs,
    gp.dovaiFiles,
    gp.emailInbox,
    gp.emailOutbox,
    gp.emailSent,
    gp.emailFailed,
    gp.emailBlocked,
    gp.telegramInbox,
    gp.telegramOutbox,
    gp.telegramSent,
    gp.telegramFailed,
    path.dirname(gp.activityLedger), // <dataRoot>/state/ for activity.jsonl
  ];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Copy template files if they don't already exist (never overwrite)
  copyTemplateIfMissing(path.join(TEMPLATES_DIR, "CLAUDE.md"), gp.claudeMd);
  copyTemplateIfMissing(path.join(TEMPLATES_DIR, "identity.md"), gp.identityMd);

  copyTemplateDirIfMissing(path.join(TEMPLATES_DIR, "settings"), gp.settings);
  copyTemplateDirIfMissing(path.join(TEMPLATES_DIR, "sops"), gp.sops);
  copyTemplateDirIfMissing(path.join(TEMPLATES_DIR, "contacts"), gp.contacts);
}

function copyTemplateIfMissing(src: string, dst: string): void {
  if (fs.existsSync(dst)) return;
  if (!fs.existsSync(src)) return;
  fs.copyFileSync(src, dst);
}

function copyTemplateDirIfMissing(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, entry);
    const dst = path.join(dstDir, entry);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyTemplateDirIfMissing(src, dst);
    } else if (!fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }
}
