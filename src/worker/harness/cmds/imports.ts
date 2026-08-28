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
 * (core/thunking/export-resolver.ts). NOTE it is not yet what GetProcAddress-BY-NAME
 * answers for an HLE module: that path still resolves to the arena stub, so the two
 * agree only for a data export. This audit measures the IAT against the image, which
 * is what an export-directory-walking wrapper compares against.
 *
 * The audit classifies each thunked import instead of just counting mismatches:
 * a guest hook is a mismatch we WANT (the wrapper is doing its job), and our own
 * inline fast paths (heap slab, CRT math, case fold) are deliberate. `diverged`
 * is the bug class only: our stub for the export in the IAT, our OTHER stub for
 * the same export everywhere else.
 */

import type { HarnessService } from "../service";
import { sys } from "../serialize";
import { hleExportBindingAddress, resolveHleExportAddress } from "../../core/thunking/export-resolver";
import { APIRegistry } from "../../core/api-registry";
import { resolveThunkedDllAlias } from "../../core/dll-aliases";

interface ImportRow {
    module: string;
    dll: string;
    name: string;
    iat: string;
    expected: string;
}

/** Walk one image's import table, calling `visit` per named import. */
function walkImports(
    view: DataView,
    base: number,
    visit: (dll: string, name: string, iatAddr: number) => void,
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
            if (entry & 0x80000000) continue; // by ordinal — no name to compare on
            visit(dll, str(base + entry + 2), iat);
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
            const ok = walkImports(view, image.base, (rawDll, name, iatAddr) => {
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
                if (iatValue === expected) { matching++; return; }
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
