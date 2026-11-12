import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../ui/cx";
import { ActionButton } from "../../ui/ActionButton";
import ms from "../../ui/Modal/Modal.module.css";
import type { GameEntry } from "../../library/GameSelectScreen";
import {
  STATUS_GLYPH,
  STATUS_LABEL,
  catalogItems,
  compareRuns,
  countRun,
  createRun,
  defaultLocalFolder,
  exportFileName,
  filterItems,
  itemDiff,
  localFolders,
  localItems,
  noteOf,
  previousRun,
  putCurrent,
  setNote,
  setStatus,
  sourceKey,
  startNewRun,
  statusOf,
  syncItems,
  toJsonExport,
  toMarkdown,
  type LocalEntry,
  type SmokeFilter,
  type SmokeItem,
  type SmokeSource,
  type SmokeStatus,
} from "./smoke-model";
import { getActive, launchSmokeItem, updateSmokeStore, useSmokeStore } from "./smoke-store";
import { currentAppVersion, currentBuild } from "./smoke-env";
import { NoteInput } from "./NoteInput";
import s from "./SmokeRun.module.css";
import { clearBundleCache } from "../../worker/runtime/filesystem/wgb-cache-policy";

/**
 * Dev "Smoke run" checklist: walk every title of one source (the library catalog, or one
 * local folder from `GET /__wgb/list`), launch each, and record OK / regression / skipped
 * with a note. State lives in localStorage per source; the run is pinned to the dev
 * server's commit and the previous run on the same source is shown alongside.
 */

interface SmokeRunModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Library catalog as App loaded it; null while it is still fetching. */
  catalog: GameEntry[] | null;
}

interface Listing {
  roots: string[];
  entries: LocalEntry[];
}

const FILTERS: { id: SmokeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unchecked", label: "Unchecked" },
  { id: "regressions", label: "Regressions" },
];

const STATUS_KEYS: Record<string, SmokeStatus> = { "1": "ok", "2": "regression", "3": "skip", "0": "untested" };

function parseSourceKey(key: string | undefined): SmokeSource | null {
  if (!key) return null;
  if (key === "library") return { kind: "library" };
  const m = /^local:(.*)\|(.*)$/.exec(key);
  return m ? { kind: "local", root: m[1], dir: m[2] } : null;
}

function isTextTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
}

const SmokeRunModal: React.FC<SmokeRunModalProps> = ({ isOpen, onClose, catalog }) => {
  const store = useSmokeStore();
  const [listing, setListing] = useState<Listing | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const [scanTick, setScanTick] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const [filter, setFilter] = useState<SmokeFilter>("all");
  const [selected, setSelected] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const build = useMemo(() => currentBuild(), []);
  const appVersion = useMemo(() => currentAppVersion(), []);

  const rescan = useCallback(() => {
    setScanning(true);
    setScanTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    fetch("/__wgb/list")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as Listing;
      })
      .then(
        (l) => { if (alive) { setListing(l); setListingError(null); } },
        (e: unknown) => {
          if (!alive) return;
          setListingError(e instanceof Error ? e.message : String(e));
          setListing({ roots: [], entries: [] });
        },
      )
      .finally(() => { if (alive) setScanning(false); });
    return () => { alive = false; };
  }, [isOpen, scanTick]);

  useEffect(() => {
    if (!isOpen) return;
    // Focus after mount so the arrow keys work without a click.
    const t = setTimeout(() => rootRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [isOpen]);

  const folders = useMemo(() => localFolders(listing?.entries ?? []), [listing]);

  // Source: explicit pick → last used (if it still exists) → the `running` folder → Library.
  const source = useMemo<SmokeSource | null>(() => {
    const valid = (src: SmokeSource | null): src is SmokeSource =>
      !!src && (src.kind === "library" || folders.some((f) => f.root === src.root && f.dir === src.dir));
    const pick = parseSourceKey(chosen ?? undefined);
    if (valid(pick)) return pick;
    if (!listing) return null; // wait for the scan before guessing
    const last = parseSourceKey(store.lastSource);
    if (valid(last)) return last;
    const def = defaultLocalFolder(folders);
    return def ? { kind: "local", root: def.root, dir: def.dir } : { kind: "library" };
  }, [chosen, folders, listing, store.lastSource]);

  const srcKey = source ? sourceKey(source) : null;

  const items = useMemo<SmokeItem[] | null>(() => {
    if (!source) return null;
    if (source.kind === "library") return catalog ? catalogItems(catalog) : null;
    return listing ? localItems(listing.entries, source.root, source.dir) : null;
  }, [source, catalog, listing]);

  // Keep the stored run's item list in step with what the source holds right now.
  useEffect(() => {
    if (!isOpen || !source || !items) return;
    updateSmokeStore((st) => {
      const k = sourceKey(source);
      const cur = st.runs[k]?.current;
      if (!cur) return putCurrent(st, createRun({ source, items, build, appVersion, now: Date.now() }));
      const synced = syncItems(cur, items);
      return synced === cur && st.lastSource === k ? st : putCurrent(st, synced);
    });
  }, [isOpen, source, items, build, appVersion]);

  const run = srcKey ? store.runs[srcKey]?.current ?? null : null;
  const prev = srcKey ? previousRun(store, srcKey) : null;
  const counts = run ? countRun(run) : null;
  const cmp = useMemo(() => (run ? compareRuns(run, prev) : null), [run, prev]);
  const rows = useMemo(() => (run ? filterItems(run, filter) : []), [run, filter]);
  const activeKey = getActive()?.key ?? null;
  // Clamped at render: a verdict can drop the selected row out of a filtered view.
  const sel = Math.min(selected, Math.max(0, rows.length - 1));

  const mutate = useCallback((fn: (r: NonNullable<typeof run>) => NonNullable<typeof run>) => {
    if (!srcKey) return;
    updateSmokeStore((st) => {
      const cur = st.runs[srcKey]?.current;
      return cur ? putCurrent(st, fn(cur)) : st;
    });
  }, [srcKey]);

  const mark = useCallback((key: string, status: SmokeStatus) => {
    mutate((r) => setStatus(r, key, status, Date.now()));
  }, [mutate]);

  const launch = useCallback((it: SmokeItem) => {
    if (srcKey) void launchSmokeItem(srcKey, it);
  }, [srcKey]);

  const newRun = useCallback(() => {
    if (!source || !items || !run) return;
    const recorded = countRun(run).done;
    if (recorded > 0 && !window.confirm(`Start a new run? The current one (${recorded} verdicts on ${run.build}) becomes the previous run for comparison.`)) return;
    updateSmokeStore((st) => startNewRun(st, createRun({ source, items, build, appVersion, now: Date.now() })));
    setFilter("all");
    setSelected(0);
  }, [source, items, run, build, appVersion]);

  const say = useCallback((msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 1600);
  }, []);

  const copyReport = useCallback(() => {
    if (!run) return;
    const md = toMarkdown(run, prev, Date.now());
    navigator.clipboard?.writeText(md).then(() => say("Report copied"), () => say("Clipboard blocked — use Download"));
  }, [run, prev, say]);

  const downloadJson = useCallback(() => {
    if (!run) return;
    const now = Date.now();
    const blob = new Blob([JSON.stringify(toJsonExport(run, prev, now), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = exportFileName(run, now);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, [run, prev]);

  const clearCache = useCallback(() => {
    if (!window.confirm("Clear the bundle cache? Removes streamed/downloaded copies of URL bundles from browser storage. Imported games, saves and overlays are kept.")) return;
    void clearBundleCache().then(
      (r) => say(`Freed ${(r.freedBytes / 1048576).toFixed(0)} MB${r.failed.length ? ` · ${r.failed.length} in use` : ""}`),
      (e: unknown) => say(`Clear failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }, [say]);

  const onKeyDown = useCallback((ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") {
      if (isTextTarget(ev.target)) { (ev.target as HTMLElement).blur(); rootRef.current?.focus(); return; }
      onClose();
      return;
    }
    if (isTextTarget(ev.target)) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const next = Math.min(rows.length - 1, Math.max(0, sel + (ev.key === "ArrowDown" ? 1 : -1)));
      listRef.current?.querySelectorAll("[data-row]")[next]?.scrollIntoView({ block: "nearest" });
      setSelected(next);
      return;
    }
    const row = rows[sel];
    if (!row) return;
    if (ev.key === "Enter") { ev.preventDefault(); launch(row); return; }
    const st = STATUS_KEYS[ev.key];
    if (st) { ev.preventDefault(); mark(row.key, st); }
  }, [rows, sel, launch, mark, onClose]);

  if (!isOpen) return null;

  const pct = (n: number) => (counts && counts.total ? `${(n / counts.total) * 100}%` : "0%");
  const filterCount = (f: SmokeFilter) => (run ? filterItems(run, f).length : 0);

  const emptyHint = (() => {
    if (!source || !items) return scanning ? "Scanning…" : "Loading…";
    if (items.length > 0) return null;
    if (source.kind === "library") return "The library catalog (public/games-catalog.json) has no enabled titles.";
    return "This folder has no .wgb bundles.";
  })();

  return (
    <div className={ms["modal-overlay"]} onClick={onClose}>
      <div
        ref={rootRef}
        className={`${cx(ms, "modal-content")} ${s["modal"]}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        tabIndex={-1}
        // Keys typed here are the tool's, not the guest's (see App's handleKey).
        data-host-keys
      >
        <div className={ms["modal-header"]}>
          <h2>Smoke run</h2>
          <button className={ms["modal-close"]} onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className={s["toolbar"]}>
          <label className={s["field"]}>
            <span className={s["field-label"]}>Source</span>
            <select
              className={s["select"]}
              value={srcKey ?? ""}
              onChange={(e) => { setChosen(e.target.value); setSelected(0); setFilter("all"); }}
            >
              <option value="library">Library catalog{catalog ? ` (${catalog.length})` : ""}</option>
              {folders.length > 0 && (
                <optgroup label="Local folders">
                  {folders.map((f) => (
                    <option key={`${f.root}|${f.dir}`} value={sourceKey({ kind: "local", root: f.root, dir: f.dir })}>
                      {f.label} ({f.count})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <ActionButton size="small" onClick={rescan} disabled={scanning}>
            {scanning ? "Scanning…" : "Rescan"}
          </ActionButton>
          <span className={s["build"]} title="Runs are pinned to the commit the dev server was started from">
            build <code>{build}</code>
          </span>
        </div>

        {folders.length === 0 && listing && (
          <div className={s["notice"]}>
            No local bundles found{listingError ? ` (${listingError})` : ""}. Smoke the <b>Library catalog</b>, or drop
            {" "}<code>.wgb</code> files into <code>public/apps/external-wgb</code> (or point <code>BS_WGB_ROOTS</code>
            {" "}at a folder) and press Rescan.
          </div>
        )}

        {run && run.build !== build && (
          <div className={cx(s, "notice", "notice--warn")}>
            <span>This run was started on <code>{run.build}</code>; the dev server is on <code>{build}</code>.</span>
            <ActionButton size="small" variant="primary" onClick={newRun}>New run on {build}</ActionButton>
          </div>
        )}

        {run && counts && (
          <div className={s["summary"]}>
            <div className={s["progress-line"]}>
              <span className={s["progress-num"]}>{counts.done}/{counts.total}</span>
              <span className={s["progress-cap"]}>checked</span>
              <span className={s["counts"]}>
                <span className={cx(s, "count", "is-ok")}>{STATUS_GLYPH.ok} {counts.ok}</span>
                <span className={cx(s, "count", "is-regression")}>{STATUS_GLYPH.regression} {counts.regression}</span>
                <span className={cx(s, "count", "is-skip")}>{STATUS_GLYPH.skip} {counts.skip}</span>
              </span>
            </div>
            <div className={s["bar"]} aria-hidden>
              <span className={cx(s, "bar-seg", "is-ok")} style={{ width: pct(counts.ok) }} />
              <span className={cx(s, "bar-seg", "is-regression")} style={{ width: pct(counts.regression) }} />
              <span className={cx(s, "bar-seg", "is-skip")} style={{ width: pct(counts.skip) }} />
            </div>
            <div className={s["prev-line"]}>
              {prev && cmp
                ? <>Previous run: <code>{prev.build}</code> · {new Date(prev.startedAt).toLocaleDateString()} ·{" "}
                    <span className={cmp.regressed.length ? s["txt-bad"] : undefined}>{cmp.regressed.length} new regression{cmp.regressed.length === 1 ? "" : "s"}</span>
                    {" "}· <span className={cmp.fixed.length ? s["txt-good"] : undefined}>{cmp.fixed.length} fixed</span></>
                : "No previous run on this source — “New run” keeps this one for comparison."}
            </div>
          </div>
        )}

        <div className={s["filters"]} role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              className={cx(s, "seg", filter === f.id && "is-on")}
              onClick={() => { setFilter(f.id); setSelected(0); }}
            >
              {f.label} <span className={s["seg-count"]}>{filterCount(f.id)}</span>
            </button>
          ))}
        </div>

        <div className={`${ms["modal-body"]} ${s["list"]}`} ref={listRef}>
          {emptyHint && <div className={s["empty"]}>{emptyHint}</div>}
          {run && !emptyHint && rows.length === 0 && (
            <div className={s["empty"]}>{filter === "unchecked" ? "Everything has a verdict." : "No regressions recorded."}</div>
          )}
          {run && rows.map((it, idx) => {
            const st = statusOf(run, it.key);
            const d = itemDiff(run, prev, it.key);
            const prevSt = prev ? statusOf(prev, it.key) : null;
            return (
              <div
                key={it.key}
                data-row
                className={cx(s, "row", idx === sel && "is-selected", d === "regressed" && "is-regressed", `st-${st}`)}
                onMouseEnter={() => setSelected(idx)}
                title={it.launch.kind === "disk" ? it.launch.path : it.launch.id}
              >
                <span className={cx(s, "glyph", `is-${st}`)} aria-label={STATUS_LABEL[st]}>{STATUS_GLYPH[st]}</span>
                <span className={s["name-cell"]}>
                  <span className={s["name"]}>
                    <span className={s["name-text"]}>{it.name}</span>
                    {it.key === activeKey && <span className={cx(s, "tag", "tag--live")}>last launched</span>}
                    {d === "regressed" && <span className={cx(s, "tag", "tag--bad")}>new regression</span>}
                    {d === "fixed" && <span className={cx(s, "tag", "tag--good")}>fixed</span>}
                  </span>
                  <span className={s["detail"]}>
                    {it.detail}
                    {prevSt && prevSt !== "untested" && <> · prev: {STATUS_LABEL[prevSt]}</>}
                  </span>
                </span>
                <NoteInput
                  className={s["note"]}
                  value={noteOf(run, it.key)}
                  onCommit={(note) => mutate((r) => setNote(r, it.key, note, Date.now()))}
                />
                <span className={s["actions"]}>
                  <button className={cx(s, "mark", "is-ok", st === "ok" && "is-on")} onClick={() => mark(it.key, st === "ok" ? "untested" : "ok")} title="OK (1)">{STATUS_GLYPH.ok}</button>
                  <button className={cx(s, "mark", "is-regression", st === "regression" && "is-on")} onClick={() => mark(it.key, st === "regression" ? "untested" : "regression")} title="Regression (2)">{STATUS_GLYPH.regression}</button>
                  <button className={cx(s, "mark", "is-skip", st === "skip" && "is-on")} onClick={() => mark(it.key, st === "skip" ? "untested" : "skip")} title="Skip — no time (3)">{STATUS_GLYPH.skip}</button>
                  <button className={s["play"]} onClick={() => launch(it)} title="Launch (Enter)">▶</button>
                </span>
              </div>
            );
          })}
        </div>

        <div className={s["footer"]}>
          <span className={s["keys"]}>↑↓ move · Enter launch · 1 OK · 2 regression · 3 skip · 0 clear</span>
          {flash && <span className={s["flash"]}>{flash}</span>}
          <ActionButton size="small" onClick={clearCache} title="Free browser storage held by cached bundle copies">Clear bundle cache</ActionButton>
          <ActionButton size="small" onClick={newRun} disabled={!run}>New run</ActionButton>
          <ActionButton size="small" onClick={downloadJson} disabled={!run}>Download JSON</ActionButton>
          <ActionButton size="small" variant="primary" onClick={copyReport} disabled={!run}>Copy report</ActionButton>
        </div>
      </div>
    </div>
  );
};

export default SmokeRunModal;
