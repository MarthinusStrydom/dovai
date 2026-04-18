#!/usr/bin/env tsx
/**
 * migrate-to-single-sarah.ts
 *
 * Migrates the EHHOA workspace from the old per-workspace .dovai/ layout
 * to the new single-Sarah architecture at ~/.dovai/.
 *
 * This script is idempotent — it checks for a MIGRATED_EHHOA marker and
 * skips steps that are already done.
 *
 * Usage:
 *   npx tsx scripts/migrate-to-single-sarah.ts [--dry-run]
 *
 * CRITICAL: No data loss is acceptable. The script creates backups before
 * any destructive operation.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import matter from "gray-matter";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DOVAI_HOME = process.env.DOVAI_HOME || path.join(os.homedir(), ".dovai");
const EHHOA_ROOT =
  "/Users/marthinusjstrydom/Library/CloudStorage/GoogleDrive-marthinus@marthinus.co.za/My Drive/EHHOA";
const EHHOA_DOVAI = path.join(EHHOA_ROOT, ".dovai");
const EHHOA_DOVAI_FILES = path.join(EHHOA_ROOT, "dovai_files");
const MARKER = path.join(DOVAI_HOME, "state", "MIGRATED_EHHOA");

const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const prefix = DRY_RUN ? "[DRY-RUN] " : "";
  console.log(`${prefix}${msg}`);
}

function ensureDir(dir: string): void {
  if (DRY_RUN) return;
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src: string, dst: string): void {
  if (DRY_RUN) {
    log(`  copy ${src} → ${dst}`);
    return;
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function copyDir(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  if (DRY_RUN) {
    log(`  copy-dir ${src} → ${dst}`);
    return;
  }
  fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
}

function addFrontmatterTag(
  filePath: string,
  tag: string,
  value: string | string[],
): void {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = matter(raw);
  if (parsed.data[tag] !== undefined) return; // already has the tag
  parsed.data[tag] = value;
  const updated = matter.stringify(parsed.content, parsed.data);
  if (DRY_RUN) {
    log(`  tag ${filePath} += ${tag}: ${JSON.stringify(value)}`);
    return;
  }
  fs.writeFileSync(filePath, updated);
}

// ---------------------------------------------------------------------------
// Step 0: Safety checks
// ---------------------------------------------------------------------------

function step0_safety(): boolean {
  if (fs.existsSync(MARKER)) {
    log("EHHOA migration already complete (marker exists). Skipping.");
    return false;
  }

  if (!fs.existsSync(EHHOA_DOVAI)) {
    console.error(`ERROR: EHHOA workspace not found at ${EHHOA_DOVAI}`);
    process.exit(1);
  }

  // Create backup
  const backup = EHHOA_DOVAI + ".bak";
  if (!fs.existsSync(backup)) {
    log(`Step 0: Creating backup at ${backup}`);
    if (!DRY_RUN) {
      fs.cpSync(EHHOA_DOVAI, backup, { recursive: true });
    }
  } else {
    log("Step 0: Backup already exists, skipping backup creation.");
  }

  return true;
}

// ---------------------------------------------------------------------------
// Step 1: Create ~/.dovai/ structure
// ---------------------------------------------------------------------------

function step1_scaffold(): void {
  log("Step 1: Scaffolding ~/.dovai/ structure");
  const dirs = [
    DOVAI_HOME,
    path.join(DOVAI_HOME, "settings"),
    path.join(DOVAI_HOME, "contacts"),
    path.join(DOVAI_HOME, "sops"),
    path.join(DOVAI_HOME, "tasks", "active"),
    path.join(DOVAI_HOME, "tasks", "done"),
    path.join(DOVAI_HOME, "drafts"),
    path.join(DOVAI_HOME, "drafts", "sent"),
    path.join(DOVAI_HOME, "memory"),
    path.join(DOVAI_HOME, "wake_queue"),
    path.join(DOVAI_HOME, "logs"),
    path.join(DOVAI_HOME, "state"),
    path.join(DOVAI_HOME, "domains", "ehhoa"),
    path.join(DOVAI_HOME, "domains", "ehhoa", "index"),
    path.join(DOVAI_HOME, "domains", "ehhoa", "finance"),
    path.join(DOVAI_HOME, "file_suppressions"),
    path.join(DOVAI_HOME, "index", "_sessions"),
    path.join(DOVAI_HOME, "dovai_files", "email", "inbox"),
    path.join(DOVAI_HOME, "dovai_files", "email", "outbox"),
    path.join(DOVAI_HOME, "dovai_files", "email", "sent"),
    path.join(DOVAI_HOME, "dovai_files", "email", "failed"),
    path.join(DOVAI_HOME, "dovai_files", "email", "blocked"),
    path.join(DOVAI_HOME, "dovai_files", "telegram", "inbox"),
    path.join(DOVAI_HOME, "dovai_files", "telegram", "outbox"),
    path.join(DOVAI_HOME, "dovai_files", "telegram", "sent"),
    path.join(DOVAI_HOME, "dovai_files", "telegram", "failed"),
  ];
  for (const d of dirs) {
    ensureDir(d);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Copy settings as-is
// ---------------------------------------------------------------------------

function step2_settings(): void {
  log("Step 2: Copying settings");
  const settingsDir = path.join(EHHOA_DOVAI, "settings");
  for (const f of ["workspace.md", "providers.md", "wakes.md"]) {
    const src = path.join(settingsDir, f);
    const dst = path.join(DOVAI_HOME, "settings", f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      copyFile(src, dst);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3: Split identity.md
// ---------------------------------------------------------------------------

function step3_identity(): void {
  log("Step 3: Splitting identity.md");
  const src = path.join(EHHOA_DOVAI, "identity.md");
  if (!fs.existsSync(src)) {
    log("  No identity.md found, skipping.");
    return;
  }

  const identityDst = path.join(DOVAI_HOME, "identity.md");
  const contextDst = path.join(DOVAI_HOME, "domains", "ehhoa", "context.md");

  // For the initial migration, copy identity.md as-is to both locations.
  // The user can later split Sarah-generic from EHHOA-specific content.
  if (!fs.existsSync(identityDst)) {
    copyFile(src, identityDst);
    log("  Copied identity.md → ~/.dovai/identity.md");
  }
  if (!fs.existsSync(contextDst)) {
    // Write a context stub that references the identity
    if (!DRY_RUN) {
      ensureDir(path.dirname(contextDst));
      const raw = fs.readFileSync(src, "utf8");
      fs.writeFileSync(
        contextDst,
        `---\nname: EHHOA\n---\n\n# EHHOA Domain Context\n\n` +
          `This domain covers the EHHOA estate. The full identity and role description\n` +
          `was migrated from the original workspace identity.md.\n\n` +
          `---\n\n${raw}`,
      );
    }
    log("  Created domains/ehhoa/context.md from identity.md");
  }
}

// ---------------------------------------------------------------------------
// Step 4: Register domain
// ---------------------------------------------------------------------------

function step4_register_domain(): void {
  log("Step 4: Registering EHHOA domain");
  const domainsJson = path.join(DOVAI_HOME, "state", "domains.json");
  const pathFile = path.join(DOVAI_HOME, "domains", "ehhoa", "path.txt");

  if (!fs.existsSync(domainsJson)) {
    const registry = {
      version: 1,
      domains: [
        {
          slug: "ehhoa",
          name: "EHHOA",
          root: EHHOA_ROOT,
          added_at: new Date().toISOString(),
          enabled: true,
        },
      ],
    };
    if (!DRY_RUN) {
      ensureDir(path.dirname(domainsJson));
      fs.writeFileSync(domainsJson, JSON.stringify(registry, null, 2));
    }
    log("  Wrote domains.json");
  }

  if (!fs.existsSync(pathFile)) {
    if (!DRY_RUN) {
      ensureDir(path.dirname(pathFile));
      fs.writeFileSync(pathFile, EHHOA_ROOT);
    }
    log("  Wrote domains/ehhoa/path.txt");
  }
}

// ---------------------------------------------------------------------------
// Step 5: Migrate contacts
// ---------------------------------------------------------------------------

function step5_contacts(): void {
  log("Step 5: Migrating contacts");
  const srcDir = path.join(EHHOA_DOVAI, "contacts");
  const dstDir = path.join(DOVAI_HOME, "contacts");
  if (!fs.existsSync(srcDir)) return;

  ensureDir(dstDir);
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".md"));
  let count = 0;
  for (const f of files) {
    const src = path.join(srcDir, f);
    const dst = path.join(dstDir, f);
    if (!fs.existsSync(dst)) {
      copyFile(src, dst);
      count++;
    }
    addFrontmatterTag(dst, "domains", ["ehhoa"]);
  }
  log(`  Migrated ${count} new contact files (${files.length} total)`);
}

// ---------------------------------------------------------------------------
// Step 6: Migrate SOPs
// ---------------------------------------------------------------------------

function step6_sops(): void {
  log("Step 6: Migrating SOPs");
  const srcDir = path.join(EHHOA_DOVAI, "sops");
  const dstDir = path.join(DOVAI_HOME, "sops");
  if (!fs.existsSync(srcDir)) return;

  ensureDir(dstDir);
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".md"));
  let count = 0;
  for (const f of files) {
    const src = path.join(srcDir, f);
    const dst = path.join(dstDir, f);
    if (!fs.existsSync(dst)) {
      copyFile(src, dst);
      count++;
    }
    addFrontmatterTag(dst, "domains", ["ehhoa"]);
  }
  log(`  Migrated ${count} new SOP files (${files.length} total)`);
}

// ---------------------------------------------------------------------------
// Step 7: Migrate tasks
// ---------------------------------------------------------------------------

function step7_tasks(): void {
  log("Step 7: Migrating tasks");
  for (const status of ["active", "done"] as const) {
    const srcDir = path.join(EHHOA_DOVAI, "tasks", status);
    const dstDir = path.join(DOVAI_HOME, "tasks", status);
    if (!fs.existsSync(srcDir)) continue;

    ensureDir(dstDir);
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const src = path.join(srcDir, entry.name);
      const dst = path.join(dstDir, entry.name);
      if (!fs.existsSync(dst)) {
        copyDir(src, dst);
        count++;
      }
      // Tag the state.md with domain
      const stateFile = path.join(dst, "state.md");
      addFrontmatterTag(stateFile, "domain", "ehhoa");
    }
    log(`  Migrated ${count} ${status} tasks`);
  }
}

// ---------------------------------------------------------------------------
// Step 8: Migrate drafts
// ---------------------------------------------------------------------------

function step8_drafts(): void {
  log("Step 8: Migrating drafts");
  const srcDir = path.join(EHHOA_DOVAI, "drafts");
  const dstDir = path.join(DOVAI_HOME, "drafts");
  if (!fs.existsSync(srcDir)) return;
  copyDir(srcDir, dstDir);
}

// ---------------------------------------------------------------------------
// Step 9: Migrate index + compile state
// ---------------------------------------------------------------------------

function step9_index(): void {
  log("Step 9: Migrating index and compile state");
  const srcIndex = path.join(EHHOA_DOVAI, "index");
  const dstIndex = path.join(DOVAI_HOME, "domains", "ehhoa", "index");

  // Copy index/ → domains/ehhoa/index/ (but sessions go to shared location)
  if (fs.existsSync(srcIndex)) {
    const entries = fs.readdirSync(srcIndex, { withFileTypes: true });
    for (const entry of entries) {
      const src = path.join(srcIndex, entry.name);
      if (entry.name === "_sessions") {
        // Sessions go to shared ~/.dovai/index/_sessions/
        const dstSessions = path.join(DOVAI_HOME, "index", "_sessions");
        copyDir(src, dstSessions);
        log("  Copied _sessions/ to shared location");
      } else {
        const dst = path.join(dstIndex, entry.name);
        if (!fs.existsSync(dst)) {
          if (entry.isDirectory()) {
            copyDir(src, dst);
          } else {
            copyFile(src, dst);
          }
        }
      }
    }
    log("  Copied index/ to domains/ehhoa/index/");
  }

  // Copy compile.json → domains/ehhoa/compile.json
  const srcCompile = path.join(EHHOA_DOVAI, "state", "compile.json");
  const dstCompile = path.join(DOVAI_HOME, "domains", "ehhoa", "compile.json");
  if (fs.existsSync(srcCompile) && !fs.existsSync(dstCompile)) {
    // Update summary_path references in compile state
    try {
      const raw = fs.readFileSync(srcCompile, "utf8");
      const state = JSON.parse(raw);
      if (state.files) {
        for (const entry of Object.values(state.files) as any[]) {
          // Old: .dovai/index/some/path.summary.md (relative to workspace root)
          // New: index/some/path.summary.md (relative to domainDir)
          if (entry.summary_path && typeof entry.summary_path === "string") {
            entry.summary_path = entry.summary_path.replace(
              /^\.dovai\/index\//,
              "index/",
            );
          }
        }
      }
      if (!DRY_RUN) {
        ensureDir(path.dirname(dstCompile));
        fs.writeFileSync(dstCompile, JSON.stringify(state, null, 2));
      }
      log("  Migrated compile.json with updated summary_path references");
    } catch (err) {
      log(`  WARNING: Could not migrate compile.json: ${err}`);
      // Fall back to plain copy
      copyFile(srcCompile, dstCompile);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 10: Migrate finance
// ---------------------------------------------------------------------------

function step10_finance(): void {
  log("Step 10: Migrating finance");
  const srcDir = path.join(EHHOA_DOVAI, "finance");
  const dstDir = path.join(DOVAI_HOME, "domains", "ehhoa", "finance");
  if (!fs.existsSync(srcDir)) return;
  if (fs.existsSync(dstDir) && fs.readdirSync(dstDir).length > 0) return;
  copyDir(srcDir, dstDir);
}

// ---------------------------------------------------------------------------
// Step 11: Migrate knowledge graph
// ---------------------------------------------------------------------------

function step11_knowledge_graph(): void {
  log("Step 11: Migrating knowledge graph");
  const src = path.join(EHHOA_DOVAI, "state", "knowledge_graph.json");
  const dst = path.join(DOVAI_HOME, "state", "knowledge_graph.json");
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dst)) {
    log("  Knowledge graph already exists at destination, skipping.");
    return;
  }

  try {
    const raw = fs.readFileSync(src, "utf8");
    const graph = JSON.parse(raw);

    // Prefix all source_files with "ehhoa:"
    if (graph.entities) {
      for (const entity of Object.values(graph.entities) as any[]) {
        if (Array.isArray(entity.source_files)) {
          entity.source_files = entity.source_files.map((f: string) =>
            f.startsWith("ehhoa:") ? f : `ehhoa:${f}`,
          );
        }
      }
    }
    if (graph.relationships) {
      for (const rel of Object.values(graph.relationships) as any[]) {
        if (rel.source_file && !rel.source_file.startsWith("ehhoa:")) {
          rel.source_file = `ehhoa:${rel.source_file}`;
        }
      }
    }

    if (!DRY_RUN) {
      ensureDir(path.dirname(dst));
      fs.writeFileSync(dst, JSON.stringify(graph, null, 2));
    }
    log("  Migrated knowledge graph with qualified paths");
  } catch (err) {
    log(`  WARNING: Could not migrate knowledge graph: ${err}`);
    copyFile(src, dst);
  }
}

// ---------------------------------------------------------------------------
// Step 12: Migrate state (activity ledger)
// ---------------------------------------------------------------------------

function step12_state(): void {
  log("Step 12: Migrating activity ledger");
  const src = path.join(EHHOA_DOVAI, "state", "activity.jsonl");
  const dst = path.join(DOVAI_HOME, "state", "activity.jsonl");
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    copyFile(src, dst);
  }
}

// ---------------------------------------------------------------------------
// Step 13: Migrate logs
// ---------------------------------------------------------------------------

function step13_logs(): void {
  log("Step 13: Migrating logs");
  const srcDir = path.join(EHHOA_DOVAI, "logs");
  const dstDir = path.join(DOVAI_HOME, "logs");
  if (!fs.existsSync(srcDir)) return;
  ensureDir(dstDir);

  const files = fs.readdirSync(srcDir);
  let count = 0;
  for (const f of files) {
    const src = path.join(srcDir, f);
    const dst = path.join(dstDir, f);
    if (fs.statSync(src).isFile() && !fs.existsSync(dst)) {
      copyFile(src, dst);
      count++;
    }
  }
  log(`  Migrated ${count} log files`);
}

// ---------------------------------------------------------------------------
// Step 14: Migrate dovai_files
// ---------------------------------------------------------------------------

function step14_dovai_files(): void {
  log("Step 14: Migrating dovai_files");
  const dstDir = path.join(DOVAI_HOME, "dovai_files");
  if (!fs.existsSync(EHHOA_DOVAI_FILES)) return;

  for (const channel of ["email", "telegram"]) {
    for (const sub of ["inbox", "outbox", "sent", "failed", "blocked"]) {
      const src = path.join(EHHOA_DOVAI_FILES, channel, sub);
      const dst = path.join(dstDir, channel, sub);
      if (!fs.existsSync(src)) continue;
      ensureDir(dst);

      const files = fs.readdirSync(src);
      let count = 0;
      for (const f of files) {
        const srcFile = path.join(src, f);
        const dstFile = path.join(dst, f);
        if (fs.statSync(srcFile).isFile() && !fs.existsSync(dstFile)) {
          copyFile(srcFile, dstFile);
          count++;
        }
      }
      if (count > 0) log(`  ${channel}/${sub}: ${count} files`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 15: Copy CLAUDE.md template
// ---------------------------------------------------------------------------

function step15_claude_md(): void {
  log("Step 15: Copying CLAUDE.md template");
  const dst = path.join(DOVAI_HOME, "CLAUDE.md");
  if (fs.existsSync(dst)) {
    log("  CLAUDE.md already exists, skipping.");
    return;
  }

  // Use the project template
  const projectRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
  );
  const template = path.join(projectRoot, "templates", "CLAUDE.md");
  if (fs.existsSync(template)) {
    copyFile(template, dst);
    log("  Copied from templates/CLAUDE.md");
  }
}

// ---------------------------------------------------------------------------
// Step 16: Write marker
// ---------------------------------------------------------------------------

function step16_marker(): void {
  log("Step 16: Writing migration marker");
  if (!DRY_RUN) {
    ensureDir(path.dirname(MARKER));
    fs.writeFileSync(
      MARKER,
      JSON.stringify(
        {
          migrated_at: new Date().toISOString(),
          source: EHHOA_DOVAI,
          domain: "ehhoa",
        },
        null,
        2,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║  Dovai: Migrate to Single-Sarah Architecture                ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`Source:      ${EHHOA_DOVAI}`);
  console.log(`Destination: ${DOVAI_HOME}`);
  if (DRY_RUN) console.log("Mode:        DRY RUN (no changes will be made)");
  console.log("");

  if (!step0_safety()) return;

  step1_scaffold();
  step2_settings();
  step3_identity();
  step4_register_domain();
  step5_contacts();
  step6_sops();
  step7_tasks();
  step8_drafts();
  step9_index();
  step10_finance();
  step11_knowledge_graph();
  step12_state();
  step13_logs();
  step14_dovai_files();
  step15_claude_md();
  step16_marker();

  console.log("");
  if (DRY_RUN) {
    console.log("Dry run complete. No changes were made.");
    console.log("Run without --dry-run to perform the actual migration.");
  } else {
    console.log("✓ Migration complete!");
    console.log("");
    console.log("The old .dovai/ folder has been backed up to:");
    console.log(`  ${EHHOA_DOVAI}.bak`);
    console.log("");
    console.log("Next steps:");
    console.log("  1. Review ~/.dovai/identity.md (Sarah-generic identity)");
    console.log("  2. Review ~/.dovai/domains/ehhoa/context.md (EHHOA-specific context)");
    console.log("  3. Run: dovai status");
    console.log("  4. Run: dovai");
  }
}

main();
