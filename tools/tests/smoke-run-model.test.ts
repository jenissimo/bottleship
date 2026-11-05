// The dev smoke-run checklist's pure model: run state, "next unchecked", comparison with
// the previous run, the per-source store and the Markdown / JSON exports.

import { describe, expect, test } from "bun:test";
import {
  buildId,
  catalogItems,
  compareRuns,
  countRun,
  createRun,
  defaultLocalFolder,
  diffStatus,
  filterItems,
  itemMatchesLocation,
  launchUrl,
  localFolders,
  localItems,
  nextUnchecked,
  parseStore,
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
  emptyStore,
  type LocalEntry,
  type SmokeItem,
  type SmokeRun,
  type SmokeSource,
} from "../../src/debug/smoke/smoke-model";

const T0 = Date.UTC(2026, 10, 5, 12, 0);
const LIB: SmokeSource = { kind: "library" };

function items(...names: string[]): SmokeItem[] {
  return names.map((n) => ({ key: n, name: n.toUpperCase(), launch: { kind: "catalog", id: n } }));
}

function run(names: string[], build = "abc1234"): SmokeRun {
  return createRun({ source: LIB, items: items(...names), build, appVersion: "0.9.0", now: T0, id: "r1" });
}

describe("run state", () => {
  test("verdicts and notes are independent and default to unchecked", () => {
    let r = run(["a", "b"]);
    expect(statusOf(r, "a")).toBe("untested");
    r = setNote(r, "a", "black screen", T0);
    expect(statusOf(r, "a")).toBe("untested");
    r = setStatus(r, "a", "regression", T0);
    expect(r.results.a).toEqual({ status: "regression", note: "black screen", at: T0 });
    expect(setNote(r, "a", "black screen", T0 + 1)).toBe(r); // unchanged note = same object
  });

  test("counts follow the current item list, not stale verdicts", () => {
    let r = run(["a", "b", "c"]);
    r = setStatus(r, "a", "ok", T0);
    r = setStatus(r, "b", "skip", T0);
    expect(countRun(r)).toEqual({ total: 3, ok: 1, regression: 0, skip: 1, untested: 1, done: 2 });
    r = syncItems(r, items("b", "c"));
    expect(countRun(r)).toEqual({ total: 2, ok: 0, regression: 0, skip: 1, untested: 1, done: 1 });
    expect(r.results.a?.status).toBe("ok"); // kept in case the bundle comes back
  });

  test("syncItems returns the same run when nothing changed", () => {
    const r = run(["a", "b"]);
    expect(syncItems(r, items("a", "b"))).toBe(r);
    expect(syncItems(r, items("b", "a"))).not.toBe(r);
  });

  test("filters", () => {
    let r = run(["a", "b", "c"]);
    r = setStatus(r, "a", "regression", T0);
    r = setStatus(r, "b", "ok", T0);
    expect(filterItems(r, "all").map((i) => i.key)).toEqual(["a", "b", "c"]);
    expect(filterItems(r, "unchecked").map((i) => i.key)).toEqual(["c"]);
    expect(filterItems(r, "regressions").map((i) => i.key)).toEqual(["a"]);
  });
});

describe("nextUnchecked", () => {
  test("walks forward from the current item and wraps", () => {
    let r = run(["a", "b", "c", "d"]);
    r = setStatus(r, "c", "ok", T0);
    expect(nextUnchecked(r, "b")?.key).toBe("d");
    expect(nextUnchecked(r, "d")?.key).toBe("a");
    expect(nextUnchecked(r)?.key).toBe("a");
  });

  test("never returns the current item, and skipped items count as handled", () => {
    let r = run(["a", "b"]);
    r = setStatus(r, "b", "skip", T0);
    expect(nextUnchecked(r, "a")).toBeNull();
    r = setStatus(r, "a", "ok", T0);
    expect(nextUnchecked(r, "a")).toBeNull();
    expect(nextUnchecked(run([]))).toBeNull();
  });

  test("an unknown current key starts from the top", () => {
    expect(nextUnchecked(run(["a", "b"]), "gone")?.key).toBe("a");
  });
});

describe("comparison with the previous run", () => {
  test("only OK→regression and regression→OK are flagged", () => {
    expect(diffStatus("ok", "regression")).toBe("regressed");
    expect(diffStatus("regression", "ok")).toBe("fixed");
    expect(diffStatus("untested", "regression")).toBeNull();
    expect(diffStatus("skip", "regression")).toBeNull();
    expect(diffStatus("regression", "regression")).toBeNull();
  });

  test("compareRuns lists items in run order", () => {
    let prev = run(["a", "b", "c"], "old0001");
    prev = setStatus(prev, "a", "ok", T0);
    prev = setStatus(prev, "b", "regression", T0);
    prev = setStatus(prev, "c", "ok", T0);
    let cur = run(["a", "b", "c"]);
    cur = setStatus(cur, "a", "regression", T0);
    cur = setStatus(cur, "b", "ok", T0);
    cur = setStatus(cur, "c", "regression", T0);
    const cmp = compareRuns(cur, prev);
    expect(cmp.regressed.map((i) => i.key)).toEqual(["a", "c"]);
    expect(cmp.fixed.map((i) => i.key)).toEqual(["b"]);
    expect(compareRuns(cur, null)).toEqual({ regressed: [], fixed: [] });
  });
});

describe("store", () => {
  test("runs are kept per source; new run archives only a run with verdicts", () => {
    let st = emptyStore();
    const empty = run(["a"]);
    st = putCurrent(st, empty);
    expect(st.lastSource).toBe("library");
    st = startNewRun(st, run(["a"], "b2"));
    expect(previousRun(st, "library")).toBeNull(); // the abandoned empty run is not history

    st = putCurrent(st, setStatus(st.runs.library.current, "a", "ok", T0));
    st = startNewRun(st, run(["a"], "b3"));
    expect(previousRun(st, "library")?.build).toBe("b2");
    expect(st.runs.library.current.build).toBe("b3");

    const local = createRun({ source: { kind: "local", root: "G:\\WGB", dir: "running" }, items: [], build: "b3", appVersion: "", now: T0 });
    st = putCurrent(st, local);
    expect(Object.keys(st.runs).sort()).toEqual(["library", "local:G:\\WGB|running"]);
    expect(st.runs.library.current.build).toBe("b3");
  });

  test("history is capped", () => {
    let st = emptyStore();
    for (let i = 0; i < 10; i++) {
      st = startNewRun(st, setStatus(run(["a"], `b${i}`), "a", "ok", T0));
    }
    expect(st.runs.library.history.length).toBe(5);
    expect(st.runs.library.history[0].build).toBe("b8");
  });

  test("parseStore survives garbage", () => {
    expect(parseStore(null)).toEqual(emptyStore());
    expect(parseStore("{not json")).toEqual(emptyStore());
    expect(parseStore(JSON.stringify({ version: 9 }))).toEqual(emptyStore());
    const st = putCurrent(emptyStore(), run(["a"]));
    expect(parseStore(JSON.stringify(st))).toEqual(st);
  });
});

describe("sources", () => {
  const entries: LocalEntry[] = [
    { path: "G:\\WGB\\todo\\x.wgb", name: "x.wgb", root: "G:\\WGB", dir: "todo", size: 10 },
    { path: "G:\\WGB\\running\\Zeta.wgb", name: "Zeta.wgb", root: "G:\\WGB", dir: "running", size: 5 * 1024 ** 2 },
    { path: "G:\\WGB\\running\\alpha.wgb", name: "alpha.wgb", root: "G:\\WGB", dir: "running", size: 2048 },
    { path: "G:\\WGB\\running\\old\\o.wgb", name: "o.wgb", root: "G:\\WGB", dir: "running\\old", size: 1 },
  ];

  test("the `running` folder is the default local source; items are that folder only", () => {
    const folders = localFolders(entries);
    expect(folders.map((f) => f.label)).toEqual(["G:/WGB/running", "G:/WGB/running/old", "G:/WGB/todo"]);
    expect(defaultLocalFolder(folders)?.dir).toBe("running");
    expect(defaultLocalFolder([])).toBeNull();
    const its = localItems(entries, "G:\\WGB", "running");
    expect(its.map((i) => i.name)).toEqual(["alpha", "Zeta"]);
    expect(its[1]).toMatchObject({ key: "G:\\WGB\\running\\Zeta.wgb", detail: "5 MB", launch: { kind: "disk", path: "G:\\WGB\\running\\Zeta.wgb" } });
  });

  test("first folder when nothing is called running", () => {
    expect(defaultLocalFolder(localFolders(entries.slice(0, 1)))?.dir).toBe("todo");
  });

  test("catalog items disambiguate same-named titles by subtitle", () => {
    const its = catalogItems([
      { id: "hl-uplink-demo", name: "Half-Life", subtitle: "Uplink" },
      { id: "hl-day-one-demo", name: "Half-Life", subtitle: "Day One", status: "setup" },
    ]);
    expect(its.map((i) => i.name)).toEqual(["Half-Life — Uplink", "Half-Life — Day One"]);
    expect(its[1].detail).toContain("needs install");
  });

  test("source keys", () => {
    expect(sourceKey(LIB)).toBe("library");
    expect(sourceKey({ kind: "local", root: "G:\\WGB", dir: "running" })).toBe("local:G:\\WGB|running");
  });

  test("build id falls back to the date", () => {
    expect(buildId("abc1234", T0)).toBe("abc1234");
    expect(buildId("dev", T0)).toBe("date-2026-11-05");
    expect(buildId(undefined, T0)).toBe("date-2026-11-05");
  });

  test("launch URLs and matching the open page", () => {
    const cat = items("revolt")[0];
    expect(launchUrl(cat, null)).toBe("?game=revolt");
    expect(itemMatchesLocation(cat, "?game=revolt")).toBe(true);
    expect(itemMatchesLocation(cat, "?game=homm3")).toBe(false);

    const disk: SmokeItem = { key: "G:\\WGB\\running\\a b.wgb", name: "a b", launch: { kind: "disk", path: "G:\\WGB\\running\\a b.wgb" } };
    for (const bundle of [
      `/__wgb/?path=${encodeURIComponent(disk.key)}`,
      `http://localhost:3001/wgb?path=${encodeURIComponent(disk.key)}`,
    ]) {
      const url = launchUrl(disk, bundle);
      expect(itemMatchesLocation(disk, url)).toBe(true);
    }
    expect(itemMatchesLocation(disk, launchUrl(disk, `/__wgb/?path=${encodeURIComponent("G:\\other.wgb")}`))).toBe(false);
    expect(itemMatchesLocation(disk, "?game=dev")).toBe(false);
  });
});

describe("export", () => {
  function scenario() {
    let prev = run(["a", "b", "c"], "old0001");
    prev = setStatus(prev, "a", "ok", T0);
    prev = setStatus(prev, "b", "regression", T0);
    let cur = run(["a", "b", "c"]);
    cur = setStatus(cur, "a", "regression", T0);
    cur = setNote(cur, "a", "crash | on\nintro", T0);
    cur = setStatus(cur, "b", "ok", T0);
    return { prev, cur };
  }

  test("markdown has the header, counters, comparison and an escaped table", () => {
    const { prev, cur } = scenario();
    const md = toMarkdown(cur, prev, T0 + 3_600_000);
    expect(md).toContain("### Smoke run — Library catalog");
    expect(md).toContain("- Build: `abc1234` (v0.9.0)");
    expect(md).toContain("- Source: Library catalog");
    expect(md).toContain("- Started: 2026-11-05 12:00 UTC · exported: 2026-11-05 13:00 UTC");
    expect(md).toContain("Checked **2/3** — OK 1 · Regression 1 · Skipped 0 · Unchecked 1");
    expect(md).toContain("Compared with the run on `old0001` (2026-11-05 12:00 UTC): 1 new regression(s), 1 fixed");
    expect(md).toContain("- New regressions: A");
    expect(md).toContain("| # | Game | Status | Previous | Note |");
    expect(md).toContain("| 1 | A | ❌ Regression **(new)** | OK | crash \\| on intro |");
    expect(md).toContain("| 2 | B | ✅ OK **(fixed)** | Regression |  |");
    expect(md).toContain("| 3 | C | ⬜ Unchecked | — |  |");
  });

  test("markdown without a previous run has no Previous column", () => {
    const md = toMarkdown(setStatus(run(["a"]), "a", "skip", T0), null, T0);
    expect(md).toContain("| # | Game | Status | Note |");
    expect(md).toContain("| 1 | A | ⏭️ Skipped |  |");
    expect(md).not.toContain("Compared with");
  });

  test("json export carries statuses, previous and diff", () => {
    const { prev, cur } = scenario();
    const j = toJsonExport(cur, prev, T0);
    expect(j.format).toBe("bottleship-smoke-run");
    expect(j.previous).toEqual({ build: "old0001", startedAt: new Date(T0).toISOString() });
    expect(j.run.counts.done).toBe(2);
    expect(j.run.items[0]).toEqual({ key: "a", name: "A", status: "regression", note: "crash | on\nintro", previous: "ok", diff: "regressed" });
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
  });
});
