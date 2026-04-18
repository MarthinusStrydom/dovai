/**
 * /api/setup/data-dir — pick the user's data folder during first-run setup.
 *
 * Used by the wizard's first step. Returns the current pointer state and a
 * list of detected cloud-sync folders (Google Drive, iCloud, Dropbox) so
 * the wizard can offer smart one-click options. POSTing a path writes the
 * pointer file, creates the target subtree, and copies the starter
 * templates — a subsequent server restart then picks up the new path.
 *
 * See: docs/PLAN_DATA_DIR_SPLIT.md (Phase 2).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Hono } from "hono";
import type { ServerContext } from "../types.ts";
import { dataDirPointerPath } from "../../lib/global_paths.ts";
import { TEMPLATES_DIR } from "../../lib/paths.ts";

interface CloudSuggestion {
  label: string;
  path: string;
  default_target: string; // full path including /Dovai
}

function detectCloudFolders(): CloudSuggestion[] {
  const home = os.homedir();
  const out: CloudSuggestion[] = [];

  const cloudStorage = path.join(home, "Library", "CloudStorage");
  if (fs.existsSync(cloudStorage)) {
    for (const entry of fs.readdirSync(cloudStorage)) {
      if (entry.startsWith("GoogleDrive-")) {
        const myDrive = path.join(cloudStorage, entry, "My Drive");
        if (fs.existsSync(myDrive)) {
          const account = entry.slice("GoogleDrive-".length);
          out.push({
            label: `Google Drive (${account})`,
            path: myDrive,
            default_target: path.join(myDrive, "Dovai"),
          });
        }
      } else if (entry.startsWith("Dropbox")) {
        const dbx = path.join(cloudStorage, entry);
        out.push({
          label: "Dropbox",
          path: dbx,
          default_target: path.join(dbx, "Dovai"),
        });
      }
    }
  }

  const icloud = path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
  if (fs.existsSync(icloud)) {
    out.push({
      label: "iCloud Drive",
      path: icloud,
      default_target: path.join(icloud, "Dovai"),
    });
  }

  const legacyDropbox = path.join(home, "Dropbox");
  if (fs.existsSync(legacyDropbox) && !out.some((s) => s.label === "Dropbox")) {
    out.push({
      label: "Dropbox (legacy)",
      path: legacyDropbox,
      default_target: path.join(legacyDropbox, "Dovai"),
    });
  }

  // Always offer a local fallback
  out.push({
    label: "Local only (~/Documents/Dovai)",
    path: path.join(home, "Documents"),
    default_target: path.join(home, "Documents", "Dovai"),
  });

  return out;
}

export function registerSetupRoute(app: Hono, ctx: ServerContext): void {
  app.get("/api/setup/data-dir", (c) => {
    const stateRoot = ctx.global.stateRoot;
    const pointer = dataDirPointerPath(stateRoot);
    const configured = fs.existsSync(pointer);
    const current = configured ? fs.readFileSync(pointer, "utf8").trim() : null;

    return c.json({
      configured,
      current,
      state_root: stateRoot,
      data_root: ctx.global.dataRoot,
      suggestions: detectCloudFolders(),
    });
  });

  app.post("/api/setup/data-dir", async (c) => {
    const payload = (await c.req.json()) as { path?: string };
    const raw = (payload.path || "").trim();
    if (!raw) {
      return c.json({ ok: false, error: "path is required" }, 400);
    }

    // Expand ~
    const target = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
    if (!path.isAbsolute(target)) {
      return c.json({ ok: false, error: "path must be absolute" }, 400);
    }

    // If the user gave us a parent (e.g. "My Drive"), append /Dovai
    const finalTarget =
      path.basename(target) === "Dovai" ? target : path.join(target, "Dovai");

    const stateRoot = ctx.global.stateRoot;
    const pointer = dataDirPointerPath(stateRoot);

    if (fs.existsSync(pointer)) {
      return c.json({
        ok: false,
        error: "data dir is already configured — edit ~/.dovai/data_dir manually if you need to change it",
      }, 409);
    }

    // Parent must exist (is Drive mounted? etc.)
    const parent = path.dirname(finalTarget);
    if (!fs.existsSync(parent)) {
      return c.json({
        ok: false,
        error: `parent directory does not exist: ${parent}. Is the cloud folder mounted?`,
      }, 400);
    }

    // Target must be empty if it exists
    if (fs.existsSync(finalTarget)) {
      const entries = fs.readdirSync(finalTarget).filter((e) => !e.startsWith("."));
      if (entries.length > 0) {
        return c.json({
          ok: false,
          error: `target is not empty: ${finalTarget}`,
        }, 400);
      }
    } else {
      fs.mkdirSync(finalTarget, { recursive: true });
    }

    // Scaffold the data-dir subtree
    const dirs = [
      "settings",
      "contacts",
      "sops",
      "tasks",
      path.join("tasks", "active"),
      path.join("tasks", "done"),
      "drafts",
      "memory",
      path.join("dovai_files", "email", "inbox"),
      path.join("dovai_files", "email", "outbox"),
      path.join("dovai_files", "email", "sent"),
      path.join("dovai_files", "email", "failed"),
      path.join("dovai_files", "email", "blocked"),
      path.join("dovai_files", "telegram", "inbox"),
      path.join("dovai_files", "telegram", "outbox"),
      path.join("dovai_files", "telegram", "sent"),
      path.join("dovai_files", "telegram", "failed"),
      "state",
    ];
    for (const d of dirs) {
      fs.mkdirSync(path.join(finalTarget, d), { recursive: true });
    }

    // Copy starter templates (CLAUDE.md, identity.md, settings/*, sops/*,
    // contacts/*) so the wizard has something to prefill from. We never
    // overwrite — if any of these already exist (because the running server
    // wrote them to the state dir on startup), leave them.
    copyTemplateIfMissing(
      path.join(TEMPLATES_DIR, "CLAUDE.md"),
      path.join(finalTarget, "CLAUDE.md"),
    );
    copyTemplateIfMissing(
      path.join(TEMPLATES_DIR, "identity.md"),
      path.join(finalTarget, "identity.md"),
    );
    copyTemplateDirIfMissing(
      path.join(TEMPLATES_DIR, "settings"),
      path.join(finalTarget, "settings"),
    );
    copyTemplateDirIfMissing(
      path.join(TEMPLATES_DIR, "sops"),
      path.join(finalTarget, "sops"),
    );
    copyTemplateDirIfMissing(
      path.join(TEMPLATES_DIR, "contacts"),
      path.join(finalTarget, "contacts"),
    );

    // Write the pointer
    fs.writeFileSync(pointer, finalTarget + "\n");

    return c.json({
      ok: true,
      data_root: finalTarget,
      restart_required: true,
      message:
        `Data dir set to ${finalTarget}. Restart Dovai (dovai stop && dovai start) ` +
        `for all components to pick up the new location.`,
    });
  });
}

function copyTemplateIfMissing(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dst)) return;
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
