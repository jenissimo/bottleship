/**
 * importAudit() — does a bound import point at the SAME address GetProcAddress
 * hands out for that export?
 *
 * On Windows those two are one address: the export's body inside the exporting
 * image. Wrappers this era's games ship (ASI/mod loaders, ddraw and d3d shims)
 * install their hooks by scanning an IAT for the value GetProcAddress just gave
 * them, so a second address for one export makes every such hook install NOTHING
 * — no error, no log line, the plugin ecosystem of the title simply never runs.
 * That is invisible from the outside, which is why it is worth a verb.
 *
 * The audit classifies each thunked import instead of just counting mismatches:
 * a guest hook is a mismatch we WANT (the wrapper is doing its job), and our own
 * inline fast paths (heap slab, CRT math, case fold) are deliberate. `diverged`
 * is the bug class only: our stub for the export in the IAT, our OTHER stub for
 * the same export from GetProcAddress.
 */

import type { HarnessService } from "../service";
import { sys } from "../serialize";
import { hleImageExportAddress } from "../../core/hle-module-images";
import { resolveHleExportAddress } from "../../core/thunking/export-resolver";
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
                // What GetProcAddress answers for the same export, resolved through the
                // very functions it uses — so the audit cannot drift from the real answer.
                const expected = hleImageExportAddress(dll, name)
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
                ? "every thunked import points at the address GetProcAddress hands out — an IAT-hooking wrapper can find its slot"
                : "these imports are bound to a DIFFERENT stub of the same export than GetProcAddress returns; "
                    + "an IAT hook that matches by address installs nothing and says nothing",
        };
    });
}
