// Unit tests for the census classification + ranking (src/worker/tools/import-census).
// Pure: the coverage index is a stand-in exposing only the methods buildCensus consults,
// so these pin the DECISION TABLE (which loader outcome each import maps to) and the
// work-order ordering without reading the repo or opening a bundle.
//
// Two of these encode calibration, not just behaviour: a delay-load import can never be
// an ABI gap (the loader never walks the delay directory), and an ABI-gap count must not
// drive the queue order. Both were wrong once and cost the ranking its meaning.

import { describe, it, expect } from "bun:test";
import type { ApiCoverageIndex, ExportCoverage } from "../../src/worker/tools/api-coverage";
import { buildCensus, rankQueue, type ImportRef, type ShippedDll } from "../../src/worker/tools/import-census";

/** Minimal stand-in for ApiCoverageIndex. */
function makeIndex(opts: {
    thunked?: string[];
    coverage?: Record<string, ExportCoverage>;   // "dll:export" (lowercased)
    reference?: Record<string, number>;          // "dll:export" (lowercased)
    aliases?: Record<string, string>;
    ordinals?: Record<string, string>;           // "dll:N" → declared export name
    abi?: string[];                              // "dll:export" with a derivable ABI
}): ApiCoverageIndex {
    const thunked = new Set(opts.thunked ?? []);
    const canonical = (dll: string): string => {
        const base = dll.toLowerCase().replace(/\.dll$/, "");
        return opts.aliases?.[base] ?? base;
    };
    return {
        canonicalModule: canonical,
        isThunked: (dll: string) => thunked.has(canonical(dll)),
        lookup: (dll: string, name: string) =>
            opts.coverage?.[`${canonical(dll)}:${name.toLowerCase()}`] ?? null,
        lookupOrdinal: (dll: string, ordinal: number) => {
            const named = opts.ordinals?.[`${canonical(dll)}:${ordinal}`];
            return (named ? opts.coverage?.[`${canonical(dll)}:${named.toLowerCase()}`] : null)
                ?? opts.coverage?.[`${canonical(dll)}:ord_${ordinal}`] ?? null;
        },
        referenceArgCount: (dll: string, name: string) =>
            opts.reference?.[`${canonical(dll)}:${name.toLowerCase()}`],
        resolveAbi: (dll: string, name: string) => {
            const key = `${canonical(dll)}:${name.toLowerCase()}`;
            if (opts.coverage?.[key] || opts.reference?.[key]) return 'descriptor';
            if (opts.abi?.includes(key)) return 'cross-module';
            if (/@\d+$/.test(name)) return 'decoration';
            return null;
        },
    } as unknown as ApiCoverageIndex;
}

function ref(partial: Partial<ImportRef> & { dll: string }): ImportRef {
    return {
        name: partial.name,
        ordinal: partial.ordinal,
        dll: partial.dll,
        callSites: partial.callSites ?? 0,
        fromPe: partial.fromPe ?? "rom/game.exe",
        entrypoint: partial.entrypoint ?? true,
        delayLoad: partial.delayLoad ?? false,
    };
}

const noShip = new Map<string, ShippedDll>();

describe("import classification", () => {
    const index = makeIndex({
        thunked: ["ddraw", "kernel32", "d3dx9"],
        coverage: {
            "ddraw:directdrawcreate": { status: "implemented", arity: 3, file: "src/x.ts", line: 10 },
            "ddraw:directdrawenumerateexa": { status: "declared-stub", argCount: 3 },
            "kernel32:heapvalidate": { status: "silent-stub", argCount: 3, arity: 0, file: "src/y.ts", line: 5 },
        },
        reference: { "iphlpapi:getadaptersinfo": 2 },
        aliases: { d3dx9_43: "d3dx9" },
    });

    const classifyOne = (r: ImportRef, shipped = noShip): string =>
        buildCensus("b.wgb", [r], index, shipped).workOrder[0]?.status
        ?? (buildCensus("b.wgb", [r], index, shipped).totals.implemented ? "implemented" : "guest-dll");

    it("a real handler is implemented", () => {
        expect(classifyOne(ref({ dll: "ddraw.dll", name: "DirectDrawCreate" }))).toBe("implemented");
    });

    it("a descriptor entry with no handler is unimplemented, not missing", () => {
        expect(classifyOne(ref({ dll: "ddraw.dll", name: "DirectDrawEnumerateExA" }))).toBe("unimplemented");
    });

    it("an arg-ignoring handler is its own class, never folded in with missing", () => {
        const census = buildCensus("b.wgb", [ref({ dll: "kernel32.dll", name: "HeapValidate" })], index, noShip);
        expect(census.totals["silent-stub"]).toBe(1);
        expect(census.silentStubs[0].name).toBe("HeapValidate");
        expect(census.silentStubs[0].impl).toEqual({ file: "src/y.ts", line: 5, arity: 0 });
        // It must NOT be counted as covered — a lie is not coverage.
        expect(census.covered).toBe(0);
    });

    it("an unthunked DLL with a known reference ABI is no-hle, not an ABI gap", () => {
        expect(classifyOne(ref({ dll: "iphlpapi.dll", name: "GetAdaptersInfo" }))).toBe("no-hle");
    });

    it("an import whose stdcall ABI is underivable is an ABI gap", () => {
        expect(classifyOne(ref({ dll: "msvbvm50.dll", name: "__vbaFreeObj" }))).toBe("abi-gap");
    });

    it("a decorated name carries its own stack cleanup, so it is never an ABI gap", () => {
        expect(classifyOne(ref({ dll: "glide2x.dll", name: "_grBufferClear@12" }))).toBe("no-hle");
    });

    it("a DELAY-LOAD import is never an ABI gap, however unknown its ABI", () => {
        // The loader reads data directory 1 only and never walks the delay directory, so a
        // delay-load import takes no part in stub generation: the linker's thunk resolves it
        // at first use via LoadLibrary+GetProcAddress. Counting these as load blockers put
        // 165 phantom entries on The Longest Journey, a title that boots.
        expect(classifyOne(ref({ dll: "msvbvm50.dll", name: "__vbaFreeObj", delayLoad: true })))
            .toBe("delay-gap");
        expect(classifyOne(ref({ dll: "oleacc.dll", name: "AccessibleObjectFromWindow", delayLoad: true })))
            .toBe("delay-gap");
    });

    it("an import the registry resolves from ANY module is not an ABI gap", () => {
        // APIRegistry.getArgCount falls back to a name found in any module when the DLL
        // name is imprecise - how a shipped mfc42/msvcp60 resolves its CRT imports.
        const idx = makeIndex({ abi: ["msvcrt:_purecall"] });
        const census = buildCensus("b.wgb", [ref({ dll: "msvcrt.dll", name: "_purecall" })], idx, noShip);
        expect(census.workOrder[0].status).toBe("no-hle");
        expect(census.abiGaps).toEqual([]);
    });

    it("a shipped DLL that exports the symbol satisfies the import", () => {
        const shipped = new Map<string, ShippedDll>([
            ["mss32", { names: new Set(["_ail_startup@0"]), ordinals: new Set<number>() }],
        ]);
        expect(classifyOne(ref({ dll: "mss32.dll", name: "_AIL_startup@0" }), shipped)).toBe("guest-dll");
    });

    it("resolves versioned DLL aliases to the canonical module", () => {
        const census = buildCensus("b.wgb",
            [ref({ dll: "d3dx9_43.dll", name: "D3DXCreateTextureFromFileA" })], index, noShip);
        expect(census.workOrder[0].dll).toBe("d3dx9");
        expect(census.workOrder[0].importedAs).toBe("d3dx9_43.dll");
    });

    it("classifies an import-by-ordinal under its ord_N name", () => {
        const census = buildCensus("b.wgb", [ref({ dll: "wsock32.dll", ordinal: 115 })], index, noShip);
        expect(census.workOrder[0].name).toBe("ord_115");
    });

    it("resolves an ordinal through the descriptor's {name, ordinal} pair", () => {
        // dsound.dll imports DirectSoundCreate as ordinal 1 and never spells the name;
        // matching only "ord_1" would report a fully implemented export as a blocker.
        const idx = makeIndex({
            thunked: ["dsound"],
            ordinals: { "dsound:1": "DirectSoundCreate" },
            coverage: { "dsound:directsoundcreate": { status: "implemented", arity: 3 } },
        });
        const census = buildCensus("b.wgb", [ref({ dll: "dsound.dll", ordinal: 1 })], idx, noShip);
        expect(census.totals.implemented).toBe(1);
        expect(census.abiGaps).toEqual([]);
    });
});

describe("ranking", () => {
    const index = makeIndex({ thunked: [], reference: { "user32:a": 1, "user32:b": 1, "user32:c": 1 } });

    it("weights call sites, and the entrypoint above a bundled helper DLL", () => {
        const census = buildCensus("b.wgb", [
            ref({ dll: "user32.dll", name: "B", callSites: 40, entrypoint: false, fromPe: "rom/helper.dll" }),
            ref({ dll: "user32.dll", name: "A", callSites: 20, entrypoint: true }),
            ref({ dll: "user32.dll", name: "C", callSites: 1, entrypoint: true }),
        ], index, noShip);
        // A: 20×3 = 60 beats B: 40×1 = 40 beats C: 1×3 = 3.
        expect(census.workOrder.map(e => e.name)).toEqual(["A", "B", "C"]);
    });

    it("merges the same export imported by several PEs and sums its weight", () => {
        const census = buildCensus("b.wgb", [
            ref({ dll: "user32.dll", name: "A", callSites: 2, entrypoint: false, fromPe: "rom/one.dll" }),
            ref({ dll: "user32.dll", name: "A", callSites: 3, entrypoint: false, fromPe: "rom/two.dll" }),
        ], index, noShip);
        expect(census.totals.distinct).toBe(1);
        expect(census.workOrder[0].callSites).toBe(5);
        expect(census.workOrder[0].importers).toEqual(["rom/one.dll", "rom/two.dll"]);
        expect(census.workOrder[0].fromEntrypoint).toBe(false);
    });

    it("puts silent stubs above everything, and ABI gaps below real gaps", () => {
        const idx = makeIndex({
            thunked: ["kernel32"],
            coverage: {
                "kernel32:foo": { status: "declared-stub", argCount: 1 },
                "kernel32:lies": { status: "silent-stub", argCount: 3, arity: 0 },
            },
        });
        const census = buildCensus("b.wgb", [
            ref({ dll: "kernel32.dll", name: "Foo", callSites: 500 }),
            ref({ dll: "kernel32.dll", name: "Lies", callSites: 1 }),
            ref({ dll: "weird.dll", name: "Bar", callSites: 900 }),
        ], idx, noShip);
        // A lie outranks even a 500-call-site gap; the ABI gap sinks below it despite being
        // the heaviest, because it does not predict failure.
        expect(census.workOrder.map(e => e.status)).toEqual(["silent-stub", "unimplemented", "abi-gap"]);
        expect(census.abiGaps.map(e => e.name)).toEqual(["Bar"]);
    });

    it("rolls up per DLL, heaviest first, and marks whole missing subsystems", () => {
        const idx = makeIndex({ thunked: [], reference: { "dplayx:a": 1, "dplayx:b": 1, "user32:c": 1 } });
        const census = buildCensus("b.wgb", [
            ref({ dll: "dplayx.dll", name: "A", callSites: 10 }),
            ref({ dll: "dplayx.dll", name: "B", callSites: 10 }),
            ref({ dll: "user32.dll", name: "C", callSites: 1 }),
        ], idx, noShip);
        expect(census.byDll[0]).toMatchObject({ dll: "dplayx", status: "no-hle", missing: 2 });
        expect(census.byDll[1].dll).toBe("user32");
    });

    it("scores coverage from real coverage only", () => {
        const idx = makeIndex({
            thunked: ["kernel32"],
            coverage: {
                "kernel32:a": { status: "implemented", arity: 3 },
                "kernel32:b": { status: "implemented", arity: 3 },
                "kernel32:c": { status: "implemented", arity: 3 },
                "kernel32:d": { status: "declared-stub", argCount: 1 },
            },
        });
        const census = buildCensus("b.wgb", ["A", "B", "C", "D"].map(n =>
            ref({ dll: "kernel32.dll", name: n })), idx, noShip);
        expect(census.covered).toBe(75);
    });

    it("refuses to score a bundle whose entrypoint hides its imports", () => {
        const census = buildCensus("b.wgb", [ref({ dll: "kernel32.dll", name: "A" })],
            makeIndex({ reference: { "kernel32:a": 1 } }), noShip,
            { analyzed: [{ path: "rom/game.exe", entrypoint: true, imports: 3, packer: "UPX" }] });
        expect(census.covered).toBeNull();
        expect(census.entrypointOpaque).toBe(true);
    });

    it("sums the work score from call-site-weighted actionable entries only", () => {
        const idx = makeIndex({
            thunked: ["kernel32"],
            coverage: { "kernel32:done": { status: "implemented", arity: 3 } },
            reference: { "kernel32:todo": 1 },
        });
        const census = buildCensus("b.wgb", [
            ref({ dll: "kernel32.dll", name: "Done", callSites: 100 }),   // covered => no work
            ref({ dll: "kernel32.dll", name: "Todo", callSites: 10 }),    // 10 x 3 (entrypoint)
        ], idx, noShip);
        expect(census.workScore).toBe(30);
    });
});

describe("queue ordering", () => {
    it("ranks by remaining work, with the unscorable first", () => {
        const mk = (bundle: string, covered: number | null, workScore: number) =>
            ({ bundle, covered, workScore, totals: { distinct: 10 } });
        const order = rankQueue([
            mk("light", 99, 12), mk("packed", null, 0), mk("heavy", 90, 900), mk("mid", 40, 300),
        ] as any).map(r => r.bundle);
        expect(order[0]).toBe("packed");   // "cannot tell" needs a human before any number
        expect(order.slice(1)).toEqual(["heavy", "mid", "light"]);
    });

    it("does not let an ABI-gap count drive the order", () => {
        // A bundle full of ABI gaps but little real work must not outrank one with heavy
        // missing surface: 12 of 37 known-working titles carry ABI gaps.
        const mk = (bundle: string, workScore: number, abiGaps: number) =>
            ({ bundle, covered: 90, workScore, abiGaps: new Array(abiGaps).fill({}), totals: { distinct: 10 } });
        const order = rankQueue([mk("gappy", 20, 180), mk("real-work", 800, 0)] as any).map(r => r.bundle);
        expect(order).toEqual(["real-work", "gappy"]);
    });
});
