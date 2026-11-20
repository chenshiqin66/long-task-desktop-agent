import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { NO_SAVED_TABS, parseSavedTabs, type SavedTabs } from "./browserPolicy.js";

/** A tab changes its address often while a page loads; wait for it to settle before touching the disk. */
const WRITE_DELAY_MS = 400;

/**
 * The tab list between runs, one small JSON file. No Electron here, so node can test it.
 * Loading never throws: a missing or damaged file just means no saved tabs.
 */
export class SavedTabsFile {
  private pending: SavedTabs | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly path: string) {}

  load(): SavedTabs {
    try {
      const text = readFileSync(this.path, "utf8");
      return parseSavedTabs(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
    } catch {
      return { ...NO_SAVED_TABS, tabs: [] };
    }
  }

  /** Writes soon, and only the latest list if several come in. */
  save(saved: SavedTabs): void {
    this.pending = saved;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
    // A write that is waiting must not keep the process alive.
    this.timer.unref?.();
  }

  /** Writes what is waiting right now. Call it when the app is closing. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const saved = this.pending;
    this.pending = null;
    if (!saved) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      // Write beside it and rename, so a crash never leaves half a file.
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify(saved, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, this.path);
    } catch {
      // Losing the tab list is better than failing the app.
    }
  }
}
