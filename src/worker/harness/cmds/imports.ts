/**
 * importAudit() — does a bound import point at the SAME address the export itself
 * has?
 *
 * On Windows an export has one address: its body inside the exporting image, which
 * is what the export directory publishes and what GetProcAddress returns. Wrappers
 * this era's games ship (ASI/mod loaders, ddraw and d3d shims) install their hooks
 * by scanning an IAT for that value, so a second address for one export makes every
 * such hook install NOTHING — no error, no log line, the plugin ecosystem of the
 * title simply never runs. That is invisible from the outside, which is why it is
 * worth a verb.
 *
 * Expected comes from hleExportBindingAddress, the single owner of that address
 * (core/thunking/export-resolver.ts), which is also what GetProcAddress-by-name answers,
 * so a wrapper finds the same pointer however it asks. An export served by a trap-free
 * inline stub keeps that one address too: its in-image body is patched to jump there.
 *
 * The audit classifies each thunked import instead of just counting mismatches:
 * a guest hook is a mismatch we WANT (the wrapper is doing its job). Our own inline
 * fast paths (heap slab, CRT math, case fold) are NOT mismatches any more — the
 * export's image body jumps to them — so `inlineFastPath` counts them out of
 * `matching`, and is a subset of it wherever the module has an image. `diverged`
 * is the bug class only: our stub for the export in the IAT, our OTHER stub for
 * the same export everywhere else.
 */

import type { HarnessService } from "../service";
import { sys } from "../serialize";
import { hleExportBindingAddress, resolveHleExportAddress } from "../../core/thunking/export-resolver";
import { APIRegistry } from "../../core/api-registry";
import { resolveThunkedDllAlias } from "../../core/dll-aliases";
import { hleImageRedirectTarget } from "../../core/hle-module-images";

interface ImportRow {
    module: string;
    dll: string;
    name: string;
    iat: string;
    expected: string;
}

/** Walk one image's import table, calling `visit` per import (`ord_N` when by ordinal). */
function walkImports(
    view: DataView,
    base: number,
    visit: (dll: string, name: string, iatAddr: number, byOrdinal: boolean) => void,
): boolean {
    const at = (a: number): number => view.getUint32(a, true) >>> 0;
    const str = (a: number): string => {
        let s = "";
        for (let i = 0; i < 256; i++) {
            const c = view.getUint8(a + i);
            if (c === 0) break;
            s += String.fromCharCode(c);
        }
        return s;
    };
    if (view.getUint16(base, true) !== 0x5a4d) return false; // 'MZ'
    const nt = base + (at(base + 0x3c) >>> 0);
    if (at(nt) !== 0x00004550) return false; // 'PE\0\0'
    const importRva = at(nt + 0x80); // OptionalHeader.DataDirectory[1].VirtualAddress
    if (!importRva) return true;

    for (let d = base + importRva; ; d += 20) {
        const nameRva = at(d + 12);
        if (!nameRva) break;
        const dll = str(base + nameRva);
        const iltRva = at(d);
        const iatRva = at(d + 16);
        if (!iatRva) continue;
        let ilt = base + (iltRva || iatRva);
        let iat = base + iatRva;
        for (; ; ilt += 4, iat += 4) {
            const entry = at(ilt);
            if (!entry) break;
            if (entry & 0x80000000) visit(dll, `ord_${entry & 0xffff}`, iat, true);
            else visit(dll, str(base + entry + 2), iat, false);
        }
    }
    return true;
}

export function registerImportCommands(svc: HarnessService): void {
    svc.register("importAudit", (args) => {
        const limit = typeof args[0] === "number" ? Math.max(1, args[0] as number) : 40;
        const process = sys().process;
        const mem = process?.getCurrentMemory?.();
        const registry = process?.moduleRegistry;
        if (!mem || !registry) return { error: "no process" };
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const dispatcher = process!.dispatcher as any;
        const generator = dispatcher?.thunkGenerator;
        const api = APIRegistry.getInstance();
        const hex = (v: number): string => "0x" + (v >>> 0).toString(16);

        const images: Array<{ name: string; base: number; size: number }> = (registry.getAllModules?.() ?? [])
            .map((m: any) => ({ name: m.name, base: m.baseAddress >>> 0, size: m.size >>> 0 }));

        let imports = 0, matching = 0, guestHooked = 0, inlineFastPath = 0, unreadable = 0;
        let divergedCount = 0;
        const diverged: ImportRow[] = [];

        for (const image of images) {
            const ok = walkImports(view, image.base, (rawDll, name, iatAddr, byOrdinal) => {
                if (byOrdinal) return; // no name to compare an address against
                const dll = resolveThunkedDllAlias(rawDll.toLowerCase().replace(/\.dll$/i, ""));
                if (!api.hasModule(dll)) return; // a real DLL's import — not ours to compare
                imports++;
                const iatValue = view.getUint32(iatAddr, true) >>> 0;
                // The one address this export has, resolved through the very function the
                // PE loader binds with — so the audit cannot drift from the real decision:
                // a registered data export, else the body the module's image publishes,
                // which is what a wrapper reads out of the export directory. The arena
                // stub is the fallback for an export no image holds.
                const expected = hleExportBindingAddress(generator, dll, name)
                    ?? (resolveHleExportAddress(dispatcher, dll, name) || undefined);
                if (expected === undefined) return;
                if (iatValue === expected) {
                    matching++;
                    // An inline fast path is now reached THROUGH the one address (the image
                    // body JMPs to it), so it no longer shows up as a mismatch. Without this
                    // the audit would read as if the fast paths had been removed.
                    if (hleImageRedirectTarget(iatValue) !== undefined) inlineFastPath++;
                    return;
                }
                const stub = generator?.getStubByAddress?.(iatValue);
                if (!stub) {
                    // Either the guest hooked the slot (the point of the exercise) or one
                    // of our inline trap-free stubs sits there; a stub-less address inside
                    // a loaded image is a hook, anything else is ours.
                    if (images.some((m) => iatValue >= m.base && iatValue < m.base + m.size)) guestHooked++;
                    else inlineFastPath++;
                    return;
                }
                if (stub.functionName.toLowerCase() !== name.toLowerCase()) { guestHooked++; return; }
                divergedCount++;
                if (diverged.length < limit) {
                    diverged.push({ module: image.name, dll, name, iat: hex(iatValue), expected: hex(expected) });
                }
            });
            if (!ok) unreadable++;
        }

        return {
            modules: images.length,
            unreadable,
            imports,
            matching,
            guestHooked,
            inlineFastPath,
            divergedCount,
            diverged,
            note: divergedCount === 0
                ? "every thunked import points at the one address its export has — an IAT-hooking wrapper can find its slot"
                : "these imports are bound to a DIFFERENT stub of the same export than the export itself has; "
                    + "an IAT hook that matches by address installs nothing and says nothing",
        };
    });
}

export function registerTrapImportCommand(svc: HarnessService): void {
    /**
     * trapImports() — which imports resolved to NOTHING?
     *
     * The loader binds an import it could not resolve to one shared UD2 stub, so the
     * failure is silent until the guest calls the slot — and then it is an illegal
     * instruction in whatever ran first, typically a static constructor, with the
     * unresolved name nowhere in the crash. XIII bound every `Xiii.dll` import that way
     * (the EXE owned its registry key) and died in xidpawn.dll's ctors.
     *
     * Bundle-agnostic, and cheap: one walk of every loaded image's import table. A
     * shipped title should read 0 — a real export the game imports and never gets is a
     * bug on OUR side of the loader, not a licence for the game to be careful.
     */
    svc.register("trapImports", (args) => {
        const limit = typeof args[0] === "number" ? Math.max(1, args[0] as number) : 40;
        const process = sys().process;
        const mem = process?.getCurrentMemory?.();
        const registry = process?.moduleRegistry;
        if (!mem || !registry) return { error: "no process" };
        const generator = (process!.dispatcher as any)?.thunkGenerator;
        const trap = generator?.getTrapStubAddress?.() >>> 0;
        // Without the trap address every slot compares unequal and the audit reads clean
        // for the one reason it cannot see anything.
        if (!trap) return { error: "no trap stub address — the audit would report 0 either way" };

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const images = (registry.getAllModules?.() ?? [])
            .map((m: any) => ({ name: m.name as string, base: m.baseAddress >>> 0 }));

        let imports = 0, trapped = 0, unreadable = 0;
        const byDll = new Map<string, number>();
        const rows: Array<{ module: string; dll: string; name: string }> = [];
        for (const image of images) {
            const ok = walkImports(view, image.base, (dll, name, iatAddr) => {
                imports++;
                if ((view.getUint32(iatAddr, true) >>> 0) !== trap) return;
                trapped++;
                byDll.set(dll, (byDll.get(dll) ?? 0) + 1);
                if (rows.length < limit) rows.push({ module: image.name, dll, name });
            });
            if (!ok) unreadable++;
        }

        return {
            trapStub: "0x" + trap.toString(16),
            modules: images.length,
            unreadable,
            imports,
            trapped,
            byDll: [...byDll].sort((a, b) => b[1] - a[1]),
            rows,
            note: trapped === 0
                ? "every import is bound to something — no slot answers with an illegal instruction"
                : "these slots hold the shared UD2 trap: calling one is an illegal instruction in the caller, "
                    + "with the unresolved name nowhere in the crash",
        };
    });
}

export function registerStubCleanupAuditCommand(svc: HarnessService): void {
    /**
     * stubCleanupAudit() — does every stub's BAKED `RET N` agree with what the registry
     * says its export pops, and do the stubs for one export agree with EACH OTHER?
     *
     * Three paths emit a stub for the same export (pe-loader's `generateStubDll`,
     * `export-resolver`'s on-demand allocation, and the synthetic HLE images), each
     * deciding the RET N independently. A path that reads a different source than the
     * others bakes a different number into guest code, and nothing downstream can see
     * it: the guest's ESP just drifts by the difference and its own RET lands on
     * whatever dword the drift exposed, arbitrarily far from the export involved.
     * `hle-module-images` read the static descriptor while the other two read the
     * registry, so a per-shipped-build ABI correction was invisible on exactly the path
     * a statically-imported DLL uses.
     *
     * `disagreeWithRegistry` is the whole-population check. `splitExports` is the one
     * that names the bug class directly — one `dll:export` whose stubs do not even pop
     * the same number of bytes as each other — and it is the number that would have
     * caught this without knowing which path was wrong.
     *
     * A `cdecl` stub bakes `C3` and pops nothing by design, so it is counted separately
     * rather than reported as a disagreement with the registry's argument-byte total.
     */
    svc.register("stubCleanupAudit", (args) => {
        const limit = typeof args[0] === "number" ? Math.max(1, args[0] as number) : 40;
        const process = sys().process;
        const mem = process?.getCurrentMemory?.();
        if (!mem) return { error: "no process" };
        const generator = (process!.dispatcher as unknown as { thunkGenerator?: unknown })?.thunkGenerator as {
            addressToStub?: Map<number, { address: number; dllName: string; functionName: string; stackCleanupBytes?: number; redirectedTo?: number }>;
        } | undefined;
        // Enumerated by ADDRESS, not by functionId: an alias stub (what the HLE images
        // publish) reuses its target's id and never enters the id map, so `getAllStubs()`
        // cannot see the very stubs this audit exists to compare. Refuse rather than
        // report a clean population that excluded them.
        const byAddress = generator?.addressToStub;
        if (!(byAddress instanceof Map)) {
            return { error: "thunk generator exposes no address→stub map — the alias stubs would be invisible, so 0 findings would not be evidence" };
        }
        const api = APIRegistry.getInstance();
        const hex = (v: number): string => "0x" + (v >>> 0).toString(16);

        interface Row { dll: string; name: string; baked: number | null; registry: number | null; stub: string }
        const disagree: Row[] = [];
        const redirected: Row[] = [];
        // Every stub lands in exactly one bucket, and the buckets sum to `examined` — a
        // population that does not add up is a population this audit did not fully see.
        let examined = 0, outOfRange = 0, notAStub = 0, agreeing = 0, cdecl = 0, noRegistryAnswer = 0;
        let disagreeCount = 0, redirectedCount = 0;
        /** `dll:export` -> the distinct baked RET values seen for it. */
        const bakedByExport = new Map<string, Map<number, string[]>>();
        // Counted from EVERY disagreement, not from the capped sample — a per-dll tally
        // that stops at `limit` silently under-reports exactly when it matters most.
        const byDll = new Map<string, number>();

        for (const stub of byAddress.values()) {
            const addr = stub.address >>> 0;
            // The stub is 16 bytes: MOV EAX,id (5) + MOV EDX,port (5) + OUT (1) + RET.
            if (addr === 0 || addr + 16 > mem.length) { outOfRange++; continue; }
            examined++;
            const opcode = mem[addr + 11];
            let baked: number | null = null;
            if (opcode === 0xc3) baked = 0;
            else if (opcode === 0xc2) baked = mem[addr + 12] | (mem[addr + 13] << 8);
            const row: Row = {
                dll: stub.dllName, name: stub.functionName, baked,
                registry: api.getStackCleanupBytes(stub.dllName, stub.functionName) ?? null,
                stub: hex(addr),
            };
            // A redirected stub's bytes are a JMP to a trap-free implementation, so there
            // is no RET N there to compare — reporting it as a mismatch would be noise.
            if (stub.redirectedTo !== undefined) {
                redirectedCount++;
                if (redirected.length < limit) redirected.push(row);
                continue;
            }
            // Byte 11 is neither RET nor RET N: not the stub shape this audit decodes.
            if (baked === null) { notAStub++; continue; }

            const key = `${stub.dllName.toLowerCase()}:${stub.functionName.toLowerCase()}`;
            let seen = bakedByExport.get(key);
            if (!seen) { seen = new Map<number, string[]>(); bakedByExport.set(key, seen); }
            const sites = seen.get(baked);
            if (sites) sites.push(hex(addr));
            else seen.set(baked, [hex(addr)]);

            if (row.registry === null) { noRegistryAnswer++; continue; }
            if (baked === 0 && row.registry > 0) { cdecl++; continue; }
            if (baked === row.registry) { agreeing++; continue; }
            disagreeCount++;
            byDll.set(row.dll, (byDll.get(row.dll) ?? 0) + 1);
            if (disagree.length < limit) disagree.push(row);
        }

        const split: Array<{ export: string; baked: Array<{ pops: number; stubs: string[] }> }> = [];
        for (const [name, seen] of bakedByExport) {
            if (seen.size < 2) continue;
            if (split.length < limit) {
                split.push({
                    export: name,
                    baked: [...seen].map(([pops, stubs]) => ({ pops, stubs: stubs.slice(0, 8) })),
                });
            }
        }
        const splitCount = [...bakedByExport.values()].filter((m) => m.size > 1).length;

        const classified = agreeing + cdecl + noRegistryAnswer + redirectedCount + notAStub + disagreeCount;
        return {
            stubs: byAddress.size,
            examined,
            outOfRange,
            notAStub,
            agreeing,
            cdecl,
            noRegistryAnswer,
            /** examined minus every bucket — must be 0, or the audit lost stubs it counted. */
            unclassified: examined - classified,
            redirectedCount,
            redirected,
            disagreeCount,
            disagree,
            byDll: [...byDll].sort((a, b) => b[1] - a[1]),
            splitCount,
            splitExports: split,
            note: splitCount > 0
                ? "one export has stubs that pop DIFFERENT numbers of bytes: whichever the guest reaches decides "
                    + "how far its ESP drifts, and the crash lands nowhere near this export"
                : disagreeCount > 0
                    ? "these stubs bake a RET N the registry disagrees with — the caller's stack drifts by the difference"
                    : "every stub pops what the registry says its export pops, and no export has two answers",
        };
    });
}

/** The stdcall byte count in a decorated export name, or null when undecorated. */
function decorationOf(name: string): string | null {
    const m = /@(\d+)$/.exec(name);
    return m ? m[1]! : null;
}

/** `dll:name` -> the bare name, lowercased and stripped of a leading underscore. */
function bareName(qualified: string): string {
    const name = qualified.includes(":") ? qualified.slice(qualified.indexOf(":") + 1) : qualified;
    return name.toLowerCase().replace(/^_+/, "");
}

export function registerAbiAuditCommand(svc: HarnessService): void {
    /**
     * abiAudit() — is every guest call reaching the handler written for ITS argument list?
     *
     * Two ways it might not be, both invisible from outside because the guest gets an
     * answer either way:
     *
     *   - `servedByOtherDecoration`: the guest imported `_AIL_pause_stream@8` and the
     *     handler bound to it was written as `@4` — a different function with a different
     *     argument list. This is the bug class that froze GTA III's intro cutscene, and it
     *     must read 0.
     *   - `declaredNoHandler`: an export the API registry declares that nothing implements.
     *     Harmless on its own (it answers its declared failure), but `siblingImplemented`
     *     picks out the ones where ANOTHER decoration of the same base name IS implemented
     *     — those are precisely the calls that used to be served by the wrong variant, so
     *     they are the work list for this class rather than a general TODO.
     *
     * `servedBySpelling` is the benign remainder: same argument list, different spelling
     * (`AIL_pause_stream` handling `_AIL_pause_stream@8`), which is how an undecorated
     * table is meant to serve a decorated import.
     */
    svc.register("abiAudit", (args) => {
        const limit = typeof args[0] === "number" ? Math.max(1, args[0] as number) : 40;
        const dispatcher = sys().process?.dispatcher as
            { getBindingCensus?: () => { implemented: string[]; bindings: Array<{ dll: string; stub: string; bound: string | null }> } }
            | undefined;
        const census = dispatcher?.getBindingCensus?.();
        if (!census) return { error: "no dispatcher" };

        const implemented = new Set(census.implemented.map((k) => k.toLowerCase()));
        const wrongDecoration: Array<{ dll: string; imported: string; servedBy: string }> = [];
        let servedBySpelling = 0, exact = 0, unbound = 0;

        for (const b of census.bindings) {
            if (!b.bound) { unbound++; continue; }
            const boundName = b.bound.includes(":") ? b.bound.slice(b.bound.indexOf(":") + 1) : b.bound;
            if (boundName.toLowerCase() === b.stub.toLowerCase()) { exact++; continue; }
            const want = decorationOf(b.stub);
            const got = decorationOf(boundName);
            if (want !== null && got !== null && want !== got) {
                if (wrongDecoration.length < limit) {
                    wrongDecoration.push({ dll: b.dll, imported: b.stub, servedBy: boundName });
                }
            } else {
                servedBySpelling++;
            }
        }

        // Declared-but-unimplemented, with the dangerous subset called out.
        const declaredNoHandler: Array<{ dll: string; name: string; siblingImplemented: string[] }> = [];
        let declaredTotal = 0, missingTotal = 0;
        for (const mod of APIRegistry.getInstance().getModules()) {
            const dll = mod.name.toLowerCase();
            const names = (mod.functions ?? []).map((f) => f.name);
            const implementedHere = names.filter((n) => implemented.has(`${dll}:${n}`.toLowerCase()));
            const byBase = new Map<string, string[]>();
            for (const n of implementedHere) {
                const base = bareName(n).replace(/@\d+$/, "");
                byBase.set(base, [...(byBase.get(base) ?? []), n]);
            }
            for (const n of names) {
                declaredTotal++;
                if (implemented.has(`${dll}:${n}`.toLowerCase())) continue;
                missingTotal++;
                const siblings = byBase.get(bareName(n).replace(/@\d+$/, "")) ?? [];
                if (siblings.length > 0 && declaredNoHandler.length < limit) {
                    declaredNoHandler.push({ dll, name: n, siblingImplemented: siblings });
                }
            }
        }

        return {
            stubs: census.bindings.length,
            exact,
            servedBySpelling,
            unbound,
            wrongDecorationCount: wrongDecoration.length,
            wrongDecoration,
            declaredTotal,
            declaredNoHandlerTotal: missingTotal,
            declaredNoHandlerWithImplementedSibling: declaredNoHandler,
            note: wrongDecoration.length === 0
                ? "every bound stub is served by a handler written for its own argument list"
                : "these imports are served by a handler written for a DIFFERENT argument list — it reads arguments the caller never pushed",
        };
    });
}
