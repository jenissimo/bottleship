import React, { useCallback, useState } from "react";
import { cx } from "../../ui/cx";
import {
  STATUS_GLYPH,
  STATUS_LABEL,
  countRun,
  itemDiff,
  itemMatchesLocation,
  nextUnchecked,
  noteOf,
  previousRun,
  putCurrent,
  setNote,
  setStatus,
  statusOf,
  type SmokeRun,
  type SmokeStatus,
} from "./smoke-model";
import { clearActive, getActive, launchSmokeItem, updateSmokeStore, useSmokeStore } from "./smoke-store";
import { NoteInput } from "./NoteInput";
import s from "./SmokeRun.module.css";

/**
 * In-game smoke-run panel: a small corner card over the running game with the verdict
 * buttons, a note and "Next". It never takes the keyboard from the game — the buttons
 * do not take focus on click, and only the note field (while focused) owns keys
 * (`data-host-keys`, honoured by App's key handler). Enter / Esc in the note hands
 * focus back to the game.
 */

interface SmokePanelProps {
  onOpenList: () => void;
  /** Return keyboard focus to the game canvas. */
  onReturnFocus: () => void;
  /** Hidden while the full list is open. */
  hidden?: boolean;
}

const COLLAPSED_KEY = "bs.smoke-run.panel-collapsed";

/** Keep focus where it is (the game) when a panel button is pressed. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

export function SmokePanel({ onOpenList, onReturnFocus, hidden }: SmokePanelProps): React.ReactElement | null {
  const store = useSmokeStore();
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
  });
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1"); } catch { /* cosmetic */ }
      return !c;
    });
  }, []);

  const [dismissed, setDismissed] = useState(false);
  const active = dismissed ? null : getActive();
  const run = active ? store.runs[active.source]?.current ?? null : null;
  const item = run && active ? run.items.find((it) => it.key === active.key) ?? null : null;
  if (hidden || !active || !run || !item || !itemMatchesLocation(item, window.location.search)) return null;

  const prev = previousRun(store, active.source);
  const st = statusOf(run, item.key);
  const prevSt = prev ? statusOf(prev, item.key) : "untested";
  const diff = itemDiff(run, prev, item.key);
  const c = countRun(run);
  const next = nextUnchecked(run, item.key);

  const mutate = (fn: (r: SmokeRun) => SmokeRun) =>
    updateSmokeStore((stor) => {
      const cur = stor.runs[active.source]?.current;
      return cur ? putCurrent(stor, fn(cur)) : stor;
    });
  const mark = (status: SmokeStatus) => mutate((r) => setStatus(r, item.key, statusOf(r, item.key) === status ? "untested" : status, Date.now()));

  if (collapsed) {
    return (
      <div className={cx(s, "panel", "panel--collapsed")} data-host-keys>
        <button className={s["panel-pill"]} onMouseDown={keepFocus} onClick={toggle} title="Expand smoke-run panel">
          <span className={cx(s, "glyph", `is-${st}`)}>{STATUS_GLYPH[st]}</span>
          <span className={s["panel-pill-name"]}>{item.name}</span>
          <span className={s["panel-progress"]}>{c.done}/{c.total}</span>
        </button>
      </div>
    );
  }

  return (
    <div className={s["panel"]} data-host-keys role="region" aria-label="Smoke run">
      <div className={s["panel-head"]}>
        <span className={s["panel-kicker"]}>Smoke run · {c.done}/{c.total}</span>
        <button className={s["panel-icon"]} onMouseDown={keepFocus} onClick={toggle} title="Collapse">–</button>
        <button
          className={s["panel-icon"]}
          onMouseDown={keepFocus}
          onClick={() => { clearActive(); setDismissed(true); onReturnFocus(); }}
          title="Hide the panel for this game (the run is kept — reopen it from the list)"
        >×</button>
      </div>
      <div className={s["panel-title"]} title={item.launch.kind === "disk" ? item.launch.path : item.launch.id}>{item.name}</div>
      <div className={s["panel-sub"]}>
        {prev ? <>prev: {prevSt === "untested" ? "—" : STATUS_LABEL[prevSt]}</> : "no previous run"}
        {diff === "regressed" && <span className={cx(s, "tag", "tag--bad")}>new regression</span>}
        {diff === "fixed" && <span className={cx(s, "tag", "tag--good")}>fixed</span>}
      </div>
      <div className={s["panel-marks"]}>
        <button className={cx(s, "verdict", "is-ok", st === "ok" && "is-on")} onMouseDown={keepFocus} onClick={() => mark("ok")}>
          {STATUS_GLYPH.ok} OK
        </button>
        <button className={cx(s, "verdict", "is-regression", st === "regression" && "is-on")} onMouseDown={keepFocus} onClick={() => mark("regression")}>
          {STATUS_GLYPH.regression} Regression
        </button>
        <button className={cx(s, "verdict", "is-skip", st === "skip" && "is-on")} onMouseDown={keepFocus} onClick={() => mark("skip")}>
          Skip
        </button>
      </div>
      <NoteInput
        className={s["panel-note"]}
        value={noteOf(run, item.key)}
        placeholder="Note (Enter to save)"
        onCommit={(note) => mutate((r) => setNote(r, item.key, note, Date.now()))}
        onDone={onReturnFocus}
      />
      <div className={s["panel-foot"]}>
        <button className={s["panel-link"]} onMouseDown={keepFocus} onClick={onOpenList}>List…</button>
        <button
          className={s["panel-next"]}
          onMouseDown={keepFocus}
          disabled={!next}
          onClick={() => { if (next) void launchSmokeItem(active.source, next); }}
          title={next ? `Launch ${next.name}` : "Every item has a verdict"}
        >
          {next ? "Next ▶" : "All checked"}
        </button>
      </div>
    </div>
  );
}
