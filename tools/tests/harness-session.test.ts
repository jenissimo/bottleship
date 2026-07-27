/**
 * Harness session naming + artifact-path isolation (src/harness/session.ts).
 *
 * These are the pure functions that decide WHICH TAB an agent drives and WHERE its
 * evidence lands. Two properties are load-bearing and asserted here rather than in a
 * browser: (a) the default session behaves exactly as before, and (b) two named
 * sessions can never resolve to each other's tab or each other's files.
 */

import { describe, it, expect } from "bun:test";
import {
    normalizeSession,
    sessionFromEnv,
    sessionFromLocation,
    sessionUrl,
    urlInSession,
    urlHasSession,
    sessionOwnsUrl,
    pickSessionTab,
    sessionRelPath,
    sessionLogPath,
    sessionArtifactPath,
    sessionLogDir,
} from "../../src/harness/session";

const DEV = "http://localhost:5174/?game=dev";
const tab = (url: string, type = "page") => ({ type, url });
const PICK = { type: "page", urlMatch: "game=dev" };

describe("session names", () => {
    it("accepts boring names and lowercases them", () => {
        expect(normalizeSession("alpha")).toBe("alpha");
        expect(normalizeSession("  Bravo-2 ")).toBe("bravo-2");
        expect(normalizeSession("a_b-9")).toBe("a_b-9");
    });

    it("rejects anything that is not a safe dir/url token", () => {
        for (const bad of ["", "  ", "-lead", "_lead", "has space", "dot.name", "a/b", "a&b=1", "x".repeat(25)]) {
            expect(normalizeSession(bad)).toBe("");
        }
    });

    it("BS_TAB unset is the default session; set-but-invalid throws rather than sharing a tab", () => {
        expect(sessionFromEnv({})).toBe("");
        expect(sessionFromEnv({ BS_TAB: "" })).toBe("");
        expect(sessionFromEnv({ BS_TAB: "Alpha" })).toBe("alpha");
        expect(() => sessionFromEnv({ BS_TAB: "two words" })).toThrow(/invalid BS_TAB/);
    });

    it("reads the page's session out of its query string", () => {
        expect(sessionFromLocation("?game=dev")).toBe("");
        expect(sessionFromLocation("?game=dev&bs=alpha")).toBe("alpha");
        expect(sessionFromLocation("?bs=alpha&game=dev")).toBe("alpha");
        expect(sessionFromLocation("?game=dev&bs=not%20valid")).toBe("");
    });
});

describe("session URLs", () => {
    it("default session leaves the dev URL byte-for-byte alone", () => {
        expect(sessionUrl(DEV, "")).toBe(DEV);
    });

    it("named session pins the tab and is idempotent", () => {
        const url = sessionUrl(DEV, "alpha");
        expect(url).toBe(`${DEV}&bs=alpha`);
        expect(sessionUrl(url, "alpha")).toBe(url);
    });

    it("matches a WHOLE token — 'alpha' never claims 'alpha2'", () => {
        expect(urlInSession(`${DEV}&bs=alpha`, "alpha")).toBe(true);
        expect(urlInSession(`${DEV}&bs=alpha2`, "alpha")).toBe(false);
        expect(urlInSession(`${DEV}&bs=alpha&x=1`, "alpha")).toBe(true);
        expect(urlInSession(`${DEV}&bs=alpha#frag`, "alpha")).toBe(true);
        expect(urlInSession(`${DEV}&notbs=alpha`, "alpha")).toBe(false);
    });

    it("knows a marked tab from an unmarked one", () => {
        expect(urlHasSession(DEV)).toBe(false);
        expect(urlHasSession(`${DEV}&bs=alpha`)).toBe(true);
        expect(sessionOwnsUrl(DEV, "")).toBe(true);
        expect(sessionOwnsUrl(`${DEV}&bs=alpha`, "")).toBe(false);
        expect(sessionOwnsUrl(`${DEV}&bs=alpha`, "bravo")).toBe(false);
    });
});

describe("tab selection", () => {
    it("default session with one plain tab picks it (unchanged behaviour)", () => {
        const list = [tab("about:blank"), tab(DEV)];
        expect(pickSessionTab(list, "", PICK)?.url).toBe(DEV);
    });

    it("named sessions each get their own tab and never the sibling's", () => {
        const list = [tab(`${DEV}&bs=alpha`), tab(`${DEV}&bs=bravo`)];
        expect(pickSessionTab(list, "alpha", PICK)?.url).toBe(`${DEV}&bs=alpha`);
        expect(pickSessionTab(list, "bravo", PICK)?.url).toBe(`${DEV}&bs=bravo`);
        expect(pickSessionTab(list, "charlie", PICK)).toBeUndefined();
    });

    it("default prefers the unmarked tab over a named sibling's", () => {
        const list = [tab(`${DEV}&bs=alpha`), tab(DEV)];
        expect(pickSessionTab(list, "", PICK)?.url).toBe(DEV);
    });

    it("default falls back to any dev tab when attaching, but never adopts one when creating", () => {
        const list = [tab(`${DEV}&bs=alpha`)];
        expect(pickSessionTab(list, "", PICK)?.url).toBe(`${DEV}&bs=alpha`);
        expect(pickSessionTab(list, "", { ...PICK, strict: true })).toBeUndefined();
    });

    it("ignores non-page targets and non-dev pages", () => {
        const list = [tab(DEV, "worker"), tab("http://localhost:5174/?game=quake2")];
        expect(pickSessionTab(list, "", PICK)).toBeUndefined();
    });
});

describe("artifact paths", () => {
    it("default session writes exactly where it always did", () => {
        expect(sessionRelPath("debug/x.png", "")).toBe("debug/x.png");
        expect(sessionLogPath("debug/x.png", "")).toBe("logs/debug/x.png");
        expect(sessionArtifactPath("logs/harness/run-1.harness.ts", "")).toBe("logs/harness/run-1.harness.ts");
        expect(sessionLogDir("logs", "")).toBe("logs");
    });

    it("a named session re-roots every artifact under its own directory", () => {
        expect(sessionRelPath("debug/x.png", "alpha")).toBe("alpha/debug/x.png");
        expect(sessionLogPath("debug/x.png", "alpha")).toBe("logs/alpha/debug/x.png");
        expect(sessionArtifactPath("logs/harness/run-1.harness.ts", "alpha")).toBe("logs/alpha/harness/run-1.harness.ts");
        expect(sessionArtifactPath("logs/trace-10s.json.gz", "alpha")).toBe("logs/alpha/trace-10s.json.gz");
        expect(sessionLogDir("logs", "alpha")).toBe("logs/alpha");
    });

    it("two sessions never collide on the same file", () => {
        const a = sessionLogPath("debug/primary.png", "alpha");
        const b = sessionLogPath("debug/primary.png", "bravo");
        expect(a).not.toBe(b);
        expect(a.startsWith("logs/alpha/")).toBe(true);
        expect(b.startsWith("logs/bravo/")).toBe(true);
    });

    it("an explicitly passed output path outside logs/ is the caller's choice", () => {
        expect(sessionArtifactPath("shots/mine.png", "alpha")).toBe("shots/mine.png");
        expect(sessionArtifactPath("C:/tmp/mine.png", "alpha")).toBe("C:/tmp/mine.png");
    });

    it("tolerates a leading slash without escaping the session dir", () => {
        expect(sessionRelPath("/debug/x.png", "alpha")).toBe("alpha/debug/x.png");
    });
});
