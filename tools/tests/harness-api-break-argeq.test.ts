/**
 * breakOnApi's argument filter.
 *
 * A breakpoint on a hot API is useless without it: TLJ preloads its whole
 * STRINGTABLE, so `breakOnApi('user32:LoadStringA')` resolves on id 1 and the
 * one call that matters (the frame title's id) is never seen. With
 * `argEq:{index,value}` the same breakpoint answers "who asked for THAT id".
 * The filter must not consume a hit (`hits`) for a non-matching call, or a
 * one-shot breakpoint disarms on the wrong one.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { apiBreaks } from "../../src/worker/harness/api-breaks";

/** Drive the dispatcher hot-path entry point directly; readCallSnapshot reads
 *  guest memory that does not exist under bun test, so args come back as zeros —
 *  enough to prove the *filtering* contract, which is what this pins. */
function fire(name: string): void {
    apiBreaks.check(name, 0x401000, 0x10000);
}

describe("breakOnApi argEq", () => {
    beforeEach(() => { apiBreaks.clear(); });

    test("an unfiltered breakpoint fires on the first matching call", () => {
        let hits = 0;
        apiBreaks.arm("user32:LoadStringA", { continuous: true, onHit: () => { hits++; } });
        fire("user32:LoadStringA");
        expect(hits).toBe(1);
    });

    test("a name mismatch never fires", () => {
        let hits = 0;
        apiBreaks.arm("user32:LoadStringA", { continuous: true, onHit: () => { hits++; } });
        fire("user32:LoadStringW");
        expect(hits).toBe(0);
    });

    test("argEq that cannot match suppresses the hit entirely", () => {
        let hits = 0;
        const id = apiBreaks.arm("user32:LoadStringA", {
            continuous: true,
            argEq: { index: 1, value: 137 },
            onHit: () => { hits++; },
        });
        fire("user32:LoadStringA");
        expect(hits).toBe(0);
        // A filtered-out call must not be counted, or a one-shot breakpoint would
        // have disarmed itself on a call the caller never asked to stop at.
        expect(apiBreaks.list().find((e) => e.id === id)?.hits).toBe(0);
    });

    test("argEq matching the (zeroed) arg still fires — the compare is on the arg, not the name", () => {
        let hits = 0;
        apiBreaks.arm("user32:LoadStringA", {
            continuous: true,
            argEq: { index: 1, value: 0 },
            onHit: () => { hits++; },
        });
        fire("user32:LoadStringA");
        expect(hits).toBe(1);
    });

    test("a suppressed one-shot breakpoint stays armed for the call it is hunting", () => {
        let seen = 0;
        apiBreaks.arm("user32:LoadStringA", {
            argEq: { index: 1, value: 0 },
            onHit: () => { seen++; },
        });
        fire("user32:LoadStringW");        // wrong name — ignored
        expect(apiBreaks.list().length).toBe(1);
        fire("user32:LoadStringA");        // matches name + arg — fires and disarms
        expect(seen).toBe(1);
        expect(apiBreaks.list().length).toBe(0);
    });

    test("clear() disarms the hot-path gate", () => {
        apiBreaks.arm("user32:*", { continuous: true });
        expect(apiBreaks.active).toBe(true);
        apiBreaks.clear();
        expect(apiBreaks.active).toBe(false);
    });
});
