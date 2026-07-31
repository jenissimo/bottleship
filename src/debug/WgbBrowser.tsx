import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../ui/cx';
import { ActionButton } from '../ui/ActionButton';
import { diskBundleUrl, sidecarAvailable } from '../utils/bundle-url';
import ms from '../ui/Modal/Modal.module.css';
import s from './WgbBrowser.module.css';

/**
 * Dev bundle browser — launch any `.wgb` sitting in a local drop folder without first
 * registering it in the library catalog (src/games-catalog.ts).
 *
 * The listing comes from Vite's `GET /__wgb/list` (dev only), which walks the same roots
 * the delivery routes confine `?path=` to — repo `public/apps`, the `public/apps/external-wgb`
 * drop folder, and `BS_WGB_ROOTS`. Launching hands the absolute path to `window.loadApp`
 * through diskBundleUrl, so a bundle opened here streams over exactly the route a harness
 * `openWgb` would have picked.
 */

interface WgbEntry {
  path: string;
  name: string;
  root: string;
  dir: string;
  size: number;
  mtimeMs: number;
}

interface WgbListing {
  roots: string[];
  entries: WgbEntry[];
  truncated: string[];
}

interface WgbBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  onLaunch: (url: string) => void;
}

const RECENTS_KEY = 'bs.wgb-browser.recents';
const MAX_RECENTS = 8;

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatAge(mtimeMs: number): string {
  const days = (Date.now() - mtimeMs) / 86_400_000;
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 30) return `${Math.round(days)}d ago`;
  return new Date(mtimeMs).toISOString().slice(0, 10);
}

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}

function pushRecent(path: string): void {
  try {
    const next = [path, ...loadRecents().filter((p) => p !== path)].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch { /* private mode / quota — recents are a nicety */ }
}

/** Group label for an entry: the folder it lives in, root-qualified so two `todo/`s from
 *  different roots don't merge into one section. */
function groupOf(e: WgbEntry): string {
  const rootLeaf = e.root.replace(/[\\/]+$/, '').split(/[\\/]/).slice(-2).join('/');
  return e.dir ? `${rootLeaf}/${e.dir}` : rootLeaf;
}

const WgbBrowser: React.FC<WgbBrowserProps> = ({ isOpen, onClose, onLaunch }) => {
  const [listing, setListing] = useState<WgbListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [via, setVia] = useState<'sidecar' | 'vite' | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/__wgb/list');
      if (!r.ok) throw new Error(`HTTP ${r.status} — the listing route is dev-server only`);
      setListing((await r.json()) as WgbListing);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
    void sidecarAvailable().then((up) => setVia(up ? 'sidecar' : 'vite'));
    setSelected(0);
    // Focus after the modal is in the DOM so typing goes straight to the filter.
    const t = setTimeout(() => filterRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [isOpen, refresh]);

  const recents = useMemo(() => loadRecents(), [isOpen]);

  /** Flat, filtered, recents-first order — the same order the arrow keys walk, so the
   *  keyboard selection and what is on screen cannot disagree. */
  const rows = useMemo(() => {
    const all = listing?.entries ?? [];
    const q = filter.trim().toLowerCase();
    const hit = q
      ? all.filter((e) => (e.dir + '/' + e.name).toLowerCase().includes(q))
      : all;
    const rank = (e: WgbEntry) => {
      const i = recents.indexOf(e.path);
      return i === -1 ? MAX_RECENTS : i;
    };
    return [...hit].sort((a, b) => rank(a) - rank(b) || groupOf(a).localeCompare(groupOf(b)) || a.name.localeCompare(b.name));
  }, [listing, filter, recents]);

  /** Sections in row order; a recent bundle is pulled into its own leading section so the
   *  grouping never has to repeat a folder header. */
  const sections = useMemo(() => {
    const out: { label: string; entries: WgbEntry[] }[] = [];
    for (const e of rows) {
      const label = recents.includes(e.path) && !filter.trim() ? 'Recent' : groupOf(e);
      const last = out[out.length - 1];
      if (last && last.label === label) last.entries.push(e);
      else out.push({ label, entries: [e] });
    }
    return out;
  }, [rows, recents, filter]);

  const launch = useCallback(async (e: WgbEntry) => {
    pushRecent(e.path);
    const { url, via: route } = await diskBundleUrl(e.path);
    setVia(route);
    onLaunch(url);
    onClose();
  }, [onLaunch, onClose]);

  const copyPath = useCallback((e: WgbEntry) => {
    void navigator.clipboard?.writeText(e.path).then(() => {
      setCopied(e.path);
      setTimeout(() => setCopied(null), 1200);
    });
  }, []);

  const onKeyDown = useCallback((ev: React.KeyboardEvent) => {
    if (ev.key === 'Escape') { onClose(); return; }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      setSelected((i) => {
        const next = Math.min(rows.length - 1, Math.max(0, i + (ev.key === 'ArrowDown' ? 1 : -1)));
        listRef.current?.querySelectorAll('[data-row]')[next]?.scrollIntoView({ block: 'nearest' });
        return next;
      });
      return;
    }
    if (ev.key === 'Enter' && rows[selected]) { ev.preventDefault(); void launch(rows[selected]); }
  }, [rows, selected, launch, onClose]);

  const toggleSection = useCallback((label: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  }, []);

  if (!isOpen) return null;

  let rowIndex = -1;

  return (
    <div className={ms['modal-overlay']} onClick={onClose}>
      <div
        className={`${cx(ms, 'modal-content')} ${s['wgb-modal']}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        <div className={ms['modal-header']}>
          <h2>Bundles</h2>
          <button className={ms['modal-close']} onClick={onClose}>×</button>
        </div>

        <div className={s['wgb-toolbar']}>
          <input
            ref={filterRef}
            className={s['wgb-filter']}
            placeholder="Filter… (↑↓ to move, Enter to launch, Esc to close)"
            value={filter}
            onChange={(e) => { setFilter(e.target.value); setSelected(0); }}
          />
          <ActionButton size="small" variant="secondary" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Scanning…' : 'Rescan'}
          </ActionButton>
          <span className={cx(s, 'wgb-route', via === 'vite' && 'warn')}>
            {via === 'sidecar' ? 'via sidecar :3001' : via === 'vite' ? 'via Vite (start dev:sidecar — faster)' : ''}
          </span>
        </div>

        {error && (
          <div className={s['wgb-error']}>
            {error}
            <div className={s['wgb-error-hint']}>
              Bundles are listed from <code>public/apps</code>, the <code>public/apps/external-wgb</code>{' '}
              drop folder and <code>BS_WGB_ROOTS</code>.
            </div>
          </div>
        )}

        {listing && listing.truncated.length > 0 && (
          <div className={s['wgb-warn']}>
            Walk stopped early in {listing.truncated.length} folder(s) — this list is incomplete.
          </div>
        )}

        <div className={`${ms['modal-body']} ${s['wgb-list']}`} ref={listRef}>
          {listing && rows.length === 0 && !loading && (
            <div className={s['wgb-empty']}>
              {filter ? `Nothing matches “${filter}”.` : `No .wgb found under ${listing.roots.join(', ') || '(no roots)'}.`}
            </div>
          )}

          {sections.map((section) => {
            const isCollapsed = collapsed.has(section.label);
            return (
              <div key={section.label} className={s['wgb-section']}>
                <button className={s['wgb-section-head']} onClick={() => toggleSection(section.label)}>
                  <span className={s['wgb-caret']}>{isCollapsed ? '▸' : '▾'}</span>
                  <span className={s['wgb-section-label']}>{section.label}</span>
                  <span className={s['wgb-section-count']}>{section.entries.length}</span>
                </button>
                {!isCollapsed && section.entries.map((e) => {
                  rowIndex += 1;
                  const idx = rowIndex;
                  return (
                    <div
                      key={e.path}
                      data-row
                      className={cx(s, 'wgb-row', idx === selected && 'selected')}
                      onMouseEnter={() => setSelected(idx)}
                      onClick={() => void launch(e)}
                      title={e.path}
                    >
                      <span className={s['wgb-name']}>{e.name.replace(/\.wgb$/i, '')}</span>
                      <span className={s['wgb-meta']}>{formatSize(e.size)}</span>
                      <span className={s['wgb-meta']}>{formatAge(e.mtimeMs)}</span>
                      <button
                        className={s['wgb-copy']}
                        onClick={(ev) => { ev.stopPropagation(); copyPath(e); }}
                        title="Copy absolute path (for harness openWgb)"
                      >
                        {copied === e.path ? 'copied' : 'path'}
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default WgbBrowser;
