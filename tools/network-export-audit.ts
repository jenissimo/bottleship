import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { ModuleDescriptor } from '../src/worker/api/types';

const sourceRoot = resolve(process.argv[2] ?? 'G:/sources/nt5src/Source/XPSP1/NT');
const specifications = [
    ['ws2_32', 'net/sockets/winsock2/ws2_32/src/ws2_32.src'],
    ['wsock32', 'net/sockets/winsock2/wsock32/wsock32.def'],
    ['dplayx', 'multimedia/directx/dplay/dplay/dplay/dplayx.def'],
    ['dpnet', 'multimedia/directx/dplay/dnet/core/dnet.def'],
    ['dpnlobby', 'multimedia/directx/dplay/dnet/lobby/dplobby.def'],
] as const;

/** Read the Win32 export branch. Debug aliases do not change the public name. */
function exportNames(source: string): Array<{ name: string; ordinal?: number }> {
    const result: Array<{ name: string; ordinal?: number }> = [];
    let exports = false, win64Depth = 0;
    for (const raw of source.split(/\r?\n/)) {
        const line = raw.replace(/;.*/, '').trim();
        if (/^#ifdef\s+_WIN64/.test(line)) { win64Depth = 1; continue; }
        if (win64Depth) {
            if (/^#if/.test(line)) win64Depth++;
            if (/^#endif/.test(line)) win64Depth--;
            continue;
        }
        if (!line || line.startsWith('#')) continue;
        if (/^EXPORTS\b/i.test(line)) { exports = true; continue; }
        if (!exports) continue;
        const match = /^(?:DECLARE_HOOKABLE_EXPORT\((\w+)\)|(\w+))/.exec(line);
        const name = match?.[1] ?? match?.[2];
        if (!name) continue;
        const ordinal = /@(\d+)/.exec(line);
        result.push({ name, ...(ordinal ? { ordinal: Number(ordinal[1]) } : {}) });
    }
    return result;
}
const modules: unknown[] = [];
for (const [name, spec] of specifications) {
    const apiFile = resolve('src/worker/api/' + name + '.api.ts');
    const imported = existsSync(apiFile) ? await import(apiFile) : {};
    const descriptor = Object.values(imported).find(value =>
        value && typeof value === 'object' && (value as ModuleDescriptor).name === name) as ModuleDescriptor | undefined;
    const declared = new Set(descriptor?.functions.map(fn => fn.name) ?? []);
    const entries = exportNames(readFileSync(join(sourceRoot, spec), 'utf8'));
    modules.push({
        name, reference: spec, nativeExports: entries.length,
        descriptorExports: [...declared].filter(value => !value.startsWith('ord_')).length,
        missingDeclarations: entries.filter(entry => !declared.has(entry.name)),
        ordinalMismatches: entries.filter(entry => entry.ordinal !== undefined).flatMap(entry => {
            const actual = descriptor?.functions.find(fn => fn.name === entry.name || fn.name === 'ord_' + entry.ordinal);
            return actual && actual.ordinal !== undefined && actual.ordinal !== entry.ordinal
                ? [{ name: entry.name, native: entry.ordinal, declared: actual.ordinal }] : [];
        }),
        interfaces: descriptor?.interfaces?.map(iface => ({ name: iface.name, iid: iface.iid, slots: iface.methods.length })) ?? [],
    });
}
const report = {
    baseline: 'NT5 x86 public DLL exports',
    meaning: 'Declarations and ordinals only. Presence does not prove implementation or behavioral parity.',
    modules,
};
const output = resolve('logs/lan-conformance/export-audit.json');
await Bun.write(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
