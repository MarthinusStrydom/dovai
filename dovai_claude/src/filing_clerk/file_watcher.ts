/**
 * File watcher using chokidar. Watches the workspace for files added / changed
 * / deleted AFTER initial scan-and-compile completes. Each event becomes a
 * compile job enqueued on the filing clerk's in-memory queue.
 */
import chokidar from "chokidar";
import path from "node:path";
import type { DomainPaths } from "../lib/global_paths.ts";
import type { Logger } from "../lib/logger.ts";

export type FileEvent = { kind: "add" | "change" | "unlink"; relPath: string };
export type FileEventHandler = (ev: FileEvent) => void;

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;

  constructor(
    private readonly dp: DomainPaths,
    private readonly logger: Logger,
  ) {}

  start(onEvent: FileEventHandler): void {
    if (this.watcher) return;

    this.watcher = chokidar.watch(this.dp.domainRoot, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      ignored: [
        (p: string) => {
          const rel = path.relative(this.dp.domainRoot, p).split(path.sep).join("/");
          if (rel.startsWith(".dovai") || rel.startsWith(".Trash")) return true;
          // Under dovai_files/, only the inbox folders are watched (must mirror
          // the scanner's shouldDescend rule so a full rescan and a live event
          // see the same set of files).
          if (rel === "dovai_files" || rel.startsWith("dovai_files/")) {
            const allowed = [
              "dovai_files/email/inbox",
              "dovai_files/telegram/inbox",
            ];
            const inAllowed = allowed.some(
              (a) => rel === a || rel.startsWith(a + "/") || a.startsWith(rel + "/"),
            );
            if (!inAllowed) return true;
          }
          if (rel.split("/").some((seg) => seg === ".git" || seg === "node_modules")) return true;
          const basename = path.basename(p);
          if (basename === ".DS_Store" || basename.startsWith("._") || basename.startsWith("~$")) return true;
          if (basename.endsWith(".eml") || basename.endsWith(".tmp") || basename.endsWith(".part") || basename.endsWith(".crdownload")) return true;
          return false;
        },
      ],
      // Wait for file writes to settle before firing
      awaitWriteFinish: {
        stabilityThreshold: 1500,
        pollInterval: 250,
      },
    });

    const wrap = (kind: FileEvent["kind"]) => (filePath: string) => {
      const rel = path.relative(this.dp.domainRoot, filePath).split(path.sep).join("/");
      if (!rel || rel.startsWith("..")) return;
      onEvent({ kind, relPath: rel });
    };

    this.watcher.on("add", wrap("add"));
    this.watcher.on("change", wrap("change"));
    this.watcher.on("unlink", wrap("unlink"));
    this.watcher.on("error", (err) => {
      this.logger.error("file watcher error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.logger.info("file watcher started", { root: this.dp.domainRoot });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.logger.info("file watcher stopped");
    }
  }
}
