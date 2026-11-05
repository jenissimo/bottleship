import React, { useState, useEffect, useMemo } from 'react';
import {
  type StorageEstimate,
  formatBytes,
  getStorageEstimate,
  requestPersistentStorage,
} from '../storage-manager';
import { cx } from '../ui/cx';
import s from './OpfsTool.module.css';
import ms from '../ui/Modal/Modal.module.css';
import { ActionButton } from '../ui/ActionButton';
import { bundleCacheClearPlan, clearBundleCache } from '../worker/runtime/filesystem/wgb-cache-policy';

/**
 * OPFS Raw Browser — dev-only, file-level escape hatch.
 *
 * The whole emulator lives under one OPFS root: `navigator.storage / "bottleship"`.
 * Two very different kinds of data share it:
 *
 *   bottleship/
 *     wgb-cache/<name>.wgb   ← BUNDLE copies. Big (Discworld Noir ≈ 1.5GB), but
 *                              re-derivable: re-downloaded from URL or re-mounted from
 *                              the user's local file. Safe to evict to reclaim space.
 *     games/ C/ D/ ...       ← per-game containers + VFS overlays: precious USER DATA
 *                              (saves, configs) mixed with EPHEMERAL writes (logs, temp,
 *                              caches).
 *
 * This is the only FILE-level view (list/preview/download/delete/nuke individual OPFS
 * entries). The container-aware, user-facing storage view is StorageManagerBody
 * (Settings → "Library & Storage" / the library Storage modal) — estimate/persist/evict
 * plumbing is shared via storage-manager.ts.
 */

const WGB_CACHE_DIR = 'wgb-cache';

/** Files in the overlay that are re-derivable scratch, not user data worth keeping. */
const EPHEMERAL_EXTS = new Set(['log', 'tmp', 'temp', 'dmp', 'bak', 'old', 'chk', 'cache']);
const EPHEMERAL_DIR_SEGMENTS = new Set(['temp', 'tmp', 'cache', 'logs']);
/** Don't try to render arbitrarily large blobs as text. */
const MAX_TEXT_VIEW_BYTES = 2 * 1024 * 1024;

type EntryCategory = 'bundle' | 'userdata' | 'ephemeral';

interface OpfsFileInfo {
  /** OPFS-relative path segments under `bottleship/` (used to navigate handles). */
  segments: string[];
  /** Human-readable path for display. */
  displayPath: string;
  /** Re-derivable bundle, precious user data, or disposable ephemeral scratch. */
  category: EntryCategory;
  size: number;
  /** True when the size couldn't be read because a running game holds an exclusive
   *  SyncAccessHandle on the file (it's "in use"). */
  locked: boolean;
}

interface OpfsToolProps {
  isOpen: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalizePath(path: string): string {
  const cleaned = path.replace(/\//g, '\\');
  const driveMatch = cleaned.match(/^([A-Za-z]):/);
  const drive = driveMatch ? driveMatch[1].toUpperCase() : 'C';
  const rest = cleaned.replace(/^[A-Za-z]:\\?/, '');
  const parts = rest.split('\\').filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `${drive}:\\${stack.join('\\')}`;
}

/** Render OPFS-relative segments under `bottleship/` as a human path. */
function describeSegments(segments: string[]): { displayPath: string; category: EntryCategory } {
  if (segments.length === 0) return { displayPath: '\\', category: 'userdata' };

  // Bundle cache lives in its own subtree, NOT under a drive letter.
  if (segments[0].toLowerCase() === WGB_CACHE_DIR) {
    return { displayPath: segments.join('/'), category: 'bundle' };
  }

  // Otherwise it's the guest virtual disk: first segment is the drive letter.
  const drive = segments[0].toUpperCase();
  const rest = segments.slice(1);
  const displayPath = `${drive}:\\${rest.join('\\')}`;
  const category = classifyOverlay(segments);
  return { displayPath, category };
}

function classifyOverlay(segments: string[]): EntryCategory {
  const lower = segments.map((s) => s.toLowerCase());
  // Anything under a temp/cache/logs directory is scratch.
  if (lower.slice(0, -1).some((s) => EPHEMERAL_DIR_SEGMENTS.has(s))) return 'ephemeral';
  const name = lower[lower.length - 1] ?? '';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  if (EPHEMERAL_EXTS.has(ext)) return 'ephemeral';
  return 'userdata';
}

/** Strip the `wgb-cache/` prefix and `.wgb` suffix to a friendly game name. */
function bundleGameName(segments: string[]): string {
  const file = segments[segments.length - 1] ?? '';
  return file.replace(/\.wgb$/i, '');
}

function isTextFile(path: string): boolean {
  const ext = path.toLowerCase().split('.').pop();
  return ['txt', 'log', 'ini', 'cfg', 'conf', 'xml', 'json', 'md', 'csv'].includes(ext || '');
}

const CATEGORY_LABEL: Record<EntryCategory, string> = {
  bundle: 'Game bundles (cache)',
  userdata: 'User data (saves & configs)',
  ephemeral: 'Ephemeral (caches, logs, temp)',
};

const CATEGORY_HINT: Record<EntryCategory, string> = {
  bundle: 'Re-downloadable copies of loaded games. Safe to evict — re-fetched on next launch.',
  userdata: 'Guest virtual disk (per-game containers). Holds saves & configs — deleting these loses progress.',
  ephemeral: 'Disposable scratch the games regenerate. Safe to clean.',
};

// ---------------------------------------------------------------------------
// OPFS access (main-thread; mirrors the worker's `bottleship` root layout)
// ---------------------------------------------------------------------------

async function getBottleshipDir(create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('bottleship', { create });
}

async function scanOpfsFiles(
  root: FileSystemDirectoryHandle,
  prefix: string[],
): Promise<OpfsFileInfo[]> {
  const files: OpfsFileInfo[] = [];
  try {
    const dirEntries = (root as any).entries();
    for await (const [name, handle] of dirEntries) {
      const nextPrefix = prefix.concat(name);
      if (handle.kind === 'file') {
        let size = 0;
        let locked = false;
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          size = file.size;
        } catch {
          // A running game holds an exclusive SyncAccessHandle on this file.
          locked = true;
        }
        const { displayPath, category } = describeSegments(nextPrefix);
        files.push({ segments: nextPrefix, displayPath, category, size, locked });
      } else {
        files.push(...(await scanOpfsFiles(handle as FileSystemDirectoryHandle, nextPrefix)));
      }
    }
  } catch (error) {
    console.error('Error scanning OPFS directory:', error);
  }
  return files;
}

async function navigateToParent(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  let dir = root;
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i]);
  }
  return { dir, name: segments[segments.length - 1] };
}

async function readOpfsFileText(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<string> {
  const { dir, name } = await navigateToParent(root, segments);
  const file = await (await dir.getFileHandle(name)).getFile();
  if (file.size > MAX_TEXT_VIEW_BYTES) {
    const head = await file.slice(0, MAX_TEXT_VIEW_BYTES).text();
    return `${head}\n\n… [truncated — ${formatBytes(file.size)} total, showing first ${formatBytes(MAX_TEXT_VIEW_BYTES)}]`;
  }
  return file.text();
}

async function downloadOpfsFile(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<void> {
  const { dir, name } = await navigateToParent(root, segments);
  const file = await (await dir.getFileHandle(name)).getFile();
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function deleteOpfsEntry(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<void> {
  const { dir, name } = await navigateToParent(root, segments);
  await dir.removeEntry(name, { recursive: true });
}

/** Translate raw OPFS errors into actionable messages. */
function explainOpfsError(err: any): string {
  if (err?.name === 'NoModificationAllowedError') {
    return 'File is in use by the running game. Unload the game (or reload the page) first.';
  }
  if (err?.name === 'NotFoundError') {
    return 'Already gone (was removed elsewhere).';
  }
  return err?.message ?? String(err);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type SortMode = 'size' | 'path';

const OpfsTool: React.FC<OpfsToolProps> = ({ isOpen, onClose }) => {
  const [files, setFiles] = useState<OpfsFileInfo[]>([]);
  const [stats, setStats] = useState<StorageEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [selectedFile, setSelectedFile] = useState<OpfsFileInfo | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState<string>('');
  const [filter, setFilter] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('size');

  const loadFiles = async () => {
    setLoading(true);
    setError('');
    try {
      const dir = await getBottleshipDir(true);
      const [scanned, st] = await Promise.all([scanOpfsFiles(dir, []), getStorageEstimate()]);
      setFiles(scanned);
      setStats(st);
    } catch (err: any) {
      setError(`Failed to load files: ${explainOpfsError(err)}`);
      console.error('Error loading OPFS files:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // --- derived: totals + grouped/filtered/sorted view ---------------------

  const totals = useMemo(() => {
    const acc = { bundle: 0, userdata: 0, ephemeral: 0, all: 0 };
    for (const f of files) {
      acc[f.category] += f.size;
      acc.all += f.size;
    }
    return acc;
  }, [files]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const visible = q
      ? files.filter((f) => f.displayPath.toLowerCase().includes(q))
      : files;
    const order: EntryCategory[] = ['bundle', 'userdata', 'ephemeral'];
    return order
      .map((cat) => {
        const items = visible
          .filter((f) => f.category === cat)
          .sort((a, b) =>
            sortMode === 'size'
              ? b.size - a.size
              : a.displayPath.localeCompare(b.displayPath),
          );
        const subtotal = items.reduce((s, f) => s + f.size, 0);
        return { cat, items, subtotal };
      })
      .filter((g) => g.items.length > 0);
  }, [files, filter, sortMode]);

  // --- actions ------------------------------------------------------------

  const withBusy = async (fn: () => Promise<void>) => {
    setBusyAction(true);
    setError('');
    try {
      await fn();
    } finally {
      setBusyAction(false);
    }
  };

  const handleViewFile = async (file: OpfsFileInfo) => {
    if (file.locked || !isTextFile(file.displayPath)) return;
    setLoadingContent(true);
    setFileContent('');
    setError('');
    try {
      const dir = await getBottleshipDir(false);
      setFileContent(await readOpfsFileText(dir, file.segments));
      setSelectedFile(file);
    } catch (err: any) {
      setError(`Failed to read file: ${explainOpfsError(err)}`);
    } finally {
      setLoadingContent(false);
    }
  };

  const handleDownloadFile = (file: OpfsFileInfo) =>
    withBusy(async () => {
      try {
        const dir = await getBottleshipDir(false);
        await downloadOpfsFile(dir, file.segments);
      } catch (err: any) {
        setError(`Failed to download file: ${explainOpfsError(err)}`);
      }
    });

  const handleDeleteFile = (file: OpfsFileInfo) => {
    const warn =
      file.category === 'userdata'
        ? `Delete ${file.displayPath}?\n\nThis is user data (a save or config) — deleting it cannot be undone.`
        : `Delete ${file.displayPath}?`;
    if (!confirm(warn)) return;
    return withBusy(async () => {
      try {
        const dir = await getBottleshipDir(false);
        await deleteOpfsEntry(dir, file.segments);
        if (selectedFile?.displayPath === file.displayPath) {
          setSelectedFile(null);
          setFileContent('');
        }
        await loadFiles();
      } catch (err: any) {
        setError(`Failed to delete: ${explainOpfsError(err)}`);
      }
    });
  };

  /** Bulk-delete every file in a category (bundles or ephemeral). */
  const handleClearCategory = (cat: EntryCategory) => {
    const items = files.filter((f) => f.category === cat);
    if (items.length === 0) return;
    const reclaim = formatBytes(items.reduce((s, f) => s + f.size, 0));
    const label =
      cat === 'bundle'
        ? `Evict all ${items.length} cached game bundle(s)? Frees ${reclaim}. Bundles re-download on next launch; saves are kept. Imported (bring-your-own) games are deleted too — use "Clear bundle cache" to keep them.`
        : `Clean all ${items.length} ephemeral file(s)? Frees ${reclaim}. Saves are kept.`;
    if (!confirm(label)) return;
    return withBusy(async () => {
      const dir = await getBottleshipDir(false);
      const failures: string[] = [];
      for (const f of items) {
        try {
          await deleteOpfsEntry(dir, f.segments);
        } catch (err: any) {
          failures.push(`${f.displayPath}: ${explainOpfsError(err)}`);
        }
      }
      if (failures.length) setError(`Some entries could not be removed:\n${failures.join('\n')}`);
      await loadFiles();
    });
  };

  /** Drop URL-bundle copies only (streamed sparse chunks, promoted archives, .part) —
   *  imported bring-your-own bundles, saves and overlays are kept. */
  const handleClearStreamCache = () => {
    const doomed = new Set(
      bundleCacheClearPlan(
        files.filter((f) => f.category === 'bundle' && f.segments.length === 2).map((f) => f.segments[1]),
      ),
    );
    const reclaim = formatBytes(
      files.filter((f) => f.segments.length === 2 && doomed.has(f.segments[1])).reduce((sum, f) => sum + f.size, 0),
    );
    if (!confirm(`Clear the bundle cache (${doomed.size} file(s), ${reclaim})?\n\nRemoves streamed/downloaded copies of URL bundles. Imported games, saves and overlays are kept.`)) return;
    return withBusy(async () => {
      try {
        const result = await clearBundleCache();
        if (result.failed.length) {
          setError(`In use by the running game, not removed:\n${result.failed.join('\n')}`);
        }
        await loadFiles();
      } catch (err: any) {
        setError(`Failed to clear bundle cache: ${explainOpfsError(err)}`);
      }
    });
  };

  const handleClearAll = () => {
    if (
      !confirm(
        'Clear ALL OPFS storage?\n\nThis deletes every cached bundle AND all saves/configs for every game. This cannot be undone.',
      )
    )
      return;
    return withBusy(async () => {
      try {
        const root = await navigator.storage.getDirectory();
        try {
          await root.removeEntry('bottleship', { recursive: true });
        } catch (err: any) {
          if (err?.name !== 'NotFoundError') throw err;
        }
        await root.getDirectoryHandle('bottleship', { create: true });
        setSelectedFile(null);
        setFileContent('');
        await loadFiles();
      } catch (err: any) {
        setError(`Failed to clear storage: ${explainOpfsError(err)}`);
      }
    });
  };

  const handleRequestPersist = () =>
    withBusy(async () => {
      try {
        await requestPersistentStorage();
        setStats(await getStorageEstimate());
      } catch (err: any) {
        setError(`Failed to request persistence: ${explainOpfsError(err)}`);
      }
    });

  if (!isOpen) return null;

  const usagePct =
    stats && stats.quotaBytes > 0 ? Math.min(100, (stats.usageBytes / stats.quotaBytes) * 100) : 0;
  const nearFull = usagePct >= 80;
  const disabled = loading || busyAction;

  return (
    <div className={ms["modal-overlay"]} onClick={onClose}>
      <div
        className={`${cx(ms, "modal-content")} ${ms["opfs-tool-modal"]}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={ms["modal-header"]}>
          <h2>OPFS Raw Browser</h2>
          <button className={ms["modal-close"]} onClick={onClose}>×</button>
        </div>

        {error && <div className={s["opfs-error"]}>{error}</div>}

        <div className={ms["modal-body"]}>
          {/* Storage overview: quota usage + breakdown by kind */}
          <div className={s["opfs-stats"]}>
            <div className={s["opfs-usage-row"]}>
              <span className={s["opfs-usage-label"]}>
                {stats
                  ? stats.quotaBytes > 0
                    ? `${formatBytes(stats.usageBytes)} of ${formatBytes(stats.quotaBytes)} used (${usagePct.toFixed(1)}%)`
                    : `${formatBytes(stats.usageBytes)} used`
                  : 'Measuring storage…'}
              </span>
              <span className={cx(s, "opfs-persist-badge", stats?.persisted ? "on" : "off")}>
                {stats?.persisted ? 'Persistent' : 'Best-effort'}
              </span>
              {stats && !stats.persisted && (
                <ActionButton size="small" onClick={handleRequestPersist} disabled={disabled}>
                  Make persistent
                </ActionButton>
              )}
            </div>
            <div className={s["opfs-usage-bar"]}>
              <div
                className={cx(s, "opfs-usage-fill", nearFull && "warn")}
                style={{ width: `${usagePct}%` }}
              />
            </div>
            {nearFull && (
              <div className={s["opfs-usage-warn"]}>
                Storage is nearly full — games may fail to cache or save. Evict bundles or clean ephemeral files below.
              </div>
            )}
            <div className={s["opfs-stat-chips"]}>
              <span className={cx(s, "opfs-chip", "bundle")}>Bundles {formatBytes(totals.bundle)}</span>
              <span className={cx(s, "opfs-chip", "userdata")}>Saves {formatBytes(totals.userdata)}</span>
              <span className={cx(s, "opfs-chip", "ephemeral")}>Ephemeral {formatBytes(totals.ephemeral)}</span>
            </div>
          </div>

          <div className={s["opfs-toolbar"]}>
            <ActionButton onClick={loadFiles} disabled={disabled}>
              {loading ? 'Loading…' : 'Refresh'}
            </ActionButton>
            <ActionButton
              onClick={() => handleClearCategory('bundle')}
              disabled={disabled || totals.bundle === 0}
            >
              Evict bundles
            </ActionButton>
            <ActionButton
              onClick={handleClearStreamCache}
              disabled={disabled || totals.bundle === 0}
            >
              Clear bundle cache
            </ActionButton>
            <ActionButton
              onClick={() => handleClearCategory('ephemeral')}
              disabled={disabled || totals.ephemeral === 0}
            >
              Clean ephemeral
            </ActionButton>
            <input
              className={s["opfs-filter"]}
              type="text"
              placeholder="Filter by path…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <select
              className={cx(s, "opfs-filter", "opfs-sort")}
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
            >
              <option value="size">Sort: size</option>
              <option value="path">Sort: path</option>
            </select>
            <ActionButton variant="secondary" onClick={handleClearAll} disabled={disabled}>
              Clear All
            </ActionButton>
          </div>

          <div className={s["opfs-content"]}>
            <div className={s["opfs-file-list-container"]}>
              <h3>Files ({files.length})</h3>
              {loading && files.length === 0 ? (
                <div className={s["opfs-loading"]}>Loading files…</div>
              ) : groups.length === 0 ? (
                <div className={s["opfs-empty"]}>
                  {files.length === 0 ? 'No files in OPFS storage' : 'No files match the filter'}
                </div>
              ) : (
                <div className={s["opfs-file-list"]}>
                  {groups.map((group) => (
                    <div key={group.cat} className={s["opfs-group"]}>
                      <div className={cx(s, "opfs-group-header", group.cat)}>
                        <div className={s["opfs-group-title"]}>
                          <span className={s["opfs-group-name"]}>{CATEGORY_LABEL[group.cat]}</span>
                          <span className={s["opfs-group-meta"]}>
                            {group.items.length} · {formatBytes(group.subtotal)}
                          </span>
                        </div>
                        <span className={s["opfs-group-hint"]}>{CATEGORY_HINT[group.cat]}</span>
                      </div>
                      {group.items.map((file, index) => (
                        <div key={index} className={cx(s, "opfs-file-item", file.category)}>
                          <div className={s["opfs-file-info"]}>
                            <span className={s["opfs-file-path"]}>
                              {file.category === 'bundle' ? bundleGameName(file.segments) : file.displayPath}
                            </span>
                            {file.locked ? (
                              <span className={cx(s, "opfs-file-size", "locked")}>in use</span>
                            ) : (
                              <span className={s["opfs-file-size"]}>{formatBytes(file.size)}</span>
                            )}
                          </div>
                          <div className={s["opfs-file-actions"]}>
                            {!file.locked && isTextFile(file.displayPath) && (
                              <ActionButton
                                size="small"
                                onClick={() => handleViewFile(file)}
                                disabled={loadingContent}
                              >
                                View
                              </ActionButton>
                            )}
                            {!file.locked && (
                              <ActionButton
                                size="small"
                                onClick={() => handleDownloadFile(file)}
                                disabled={disabled}
                              >
                                Download
                              </ActionButton>
                            )}
                            <ActionButton
                              size="small"
                              variant="secondary"
                              onClick={() => handleDeleteFile(file)}
                              disabled={disabled}
                            >
                              Delete
                            </ActionButton>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {selectedFile && (
              <div className={s["opfs-file-viewer"]}>
                <div className={s["opfs-viewer-header"]}>
                  <h3>{selectedFile.displayPath}</h3>
                  <ActionButton
                    size="small"
                    onClick={() => {
                      setSelectedFile(null);
                      setFileContent('');
                    }}
                  >
                    Close
                  </ActionButton>
                </div>
                {loadingContent ? (
                  <div className={s["opfs-loading"]}>Loading file content…</div>
                ) : (
                  <pre className={s["opfs-file-content"]}>{fileContent}</pre>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default OpfsTool;
