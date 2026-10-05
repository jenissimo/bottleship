/**
 * The root set a dev bundle path is confined to, plus the walk that enumerates the
 * bundles inside it.
 *
 * Two dev servers deliver `.wgb` off disk — the sidecar (`GET /wgb?path=`) and Vite's
 * fallback (`GET /__wgb/?path=`) — and both must answer "is this path allowed?" the same
 * way, or the confinement is only as strong as whichever one a caller happens to hit.
 * That answer lives here once. The listing route (`GET /__wgb/list`) walks the SAME set,
 * so the dev browser can never offer a bundle the delivery route would then refuse.
 *
 * Callers pass their own repoRoot: Vite bundles its config (and everything it imports)
 * into a temp file next to it, so `import.meta.url` here would resolve to the wrong
 * directory.
 */
import fs from "node:fs";
import path from "node:path";

export interface WgbEntry {
  /** Absolute path — what `?path=` takes. */
  path: string;
  /** File name including the .wgb extension. */
  name: string;
  /** Root this was found under (absolute). */
  root: string;
  /** Directory holding it, relative to `root` ("" when directly in the root). */
  dir: string;
  size: number;
  mtimeMs: number;
}

export interface WgbListing {
  roots: string[];
  entries: WgbEntry[];
  /** Directories skipped because the walk hit its depth/entry bound — a truncated
   *  listing must say so rather than read as a complete one. */
  truncated: string[];
}

/** Windows will authenticate to a remote share when asked to stat a UNC path, so a
 *  `path=` a page can choose must never be one. */
export const isUnc = (p: string): boolean => /^(\\\\|\/\/)/.test(p.trim());

/** `public/apps/external-wgb` is the checkout's own pointer at the local drop folder —
 *  the tree it is already configured to load bundles from, so its PARENT is a root by
 *  definition (siblings of `running/` are the same drop area). */
function dropFolderRoot(repoRoot: string): string[] {
  const link = path.join(repoRoot, "public", "apps", "external-wgb");
  try { return [path.dirname(fs.realpathSync(link))]; } catch { return []; }
}

function envRoots(): string[] {
  return (process.env.BS_WGB_ROOTS ?? "")
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

function dedupe(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((p) => {
    const key = process.platform === "win32" ? p.toLowerCase() : p;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Roots a `?path=` may resolve under. The repo is included so a freshly built bundle
 *  (make-wgb writes inside the tree) loads without configuration. */
export function wgbRoots(repoRoot: string): string[] {
  return dedupe([path.resolve(repoRoot), ...dropFolderRoot(repoRoot), ...envRoots()]);
}

/**
 * Roots the dev browser ENUMERATES. Deliberately not `wgbRoots()`: that includes the
 * whole repo, and walking node_modules/vendor/dist to find a handful of bundles costs
 * seconds for nothing. Only the two places bundles actually live.
 */
export function wgbListRoots(repoRoot: string): string[] {
  return dedupe([
    ...dropFolderRoot(repoRoot),
    ...envRoots(),
    path.join(path.resolve(repoRoot), "public", "apps"),
  ]).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

export function underAnyRoot(file: string, roots: string[]): boolean {
  const f = process.platform === "win32" ? file.toLowerCase() : file;
  return roots.some((r) => {
    const root = process.platform === "win32" ? r.toLowerCase() : r;
    return f === root || f.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "vendor", ".vite", "logs", "tmp"]);

/**
 * Depth- and count-bounded walk for `.wgb` files. A drop folder sits next to extracted
 * game trees (tens of thousands of files), so an unbounded walk would stall the dev
 * server; anything the bounds cut is reported in `truncated` instead of silently missing.
 * Symlinked directories are not followed — `public/apps/external-wgb` points back into
 * the drop folder and would list every bundle twice.
 */
export function listWgb(
  roots: string[],
  opts: { maxDepth?: number; maxEntries?: number } = {},
): WgbListing {
  const maxDepth = opts.maxDepth ?? 4;
  const maxEntries = opts.maxEntries ?? 1000;
  const entries: WgbEntry[] = [];
  const truncated: string[] = [];

  const walk = (root: string, dirAbs: string, depth: number): void => {
    let dirents: fs.Dirent[];
    try { dirents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      if (entries.length >= maxEntries) { truncated.push(dirAbs); return; }
      const abs = path.join(dirAbs, d.name);
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || d.name.startsWith(".")) continue;
        if (depth >= maxDepth) { truncated.push(abs); continue; }
        walk(root, abs, depth + 1);
      } else if (d.isFile() && d.name.toLowerCase().endsWith(".wgb")) {
        let st: fs.Stats;
        try { st = fs.statSync(abs); } catch { continue; }
        entries.push({
          path: abs,
          name: d.name,
          root,
          dir: path.relative(root, dirAbs).replace(/\\/g, "/"),
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
    }
  };

  for (const root of roots) walk(root, root, 0);
  entries.sort((a, b) => (a.dir + "/" + a.name).localeCompare(b.dir + "/" + b.name));
  return { roots, entries, truncated };
}
