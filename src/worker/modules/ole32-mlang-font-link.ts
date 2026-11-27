import type { Process } from '../core/process';
import type { ThunkImplementation } from '../core/thunking/thunk-dispatcher';
import { installComVtable } from '../core/com/install-com-vtable';
import { allocateComObject, freeComObject } from '../core/com/com-memory';
import { readGuidFromMem } from '../core/com/typelib/typelib-types';
import { Mem } from '../core/memory/mem-accessor';
import { System } from '../core/system';
import { installedFontCoverage, installedFontForCodePages } from './gdi32/font-resource';
import { CODEPAGES, charCodePages, codePageBit, MULTILANGUAGE_METHODS, FONTLINK_METHODS } from './ole32/mlang-codepages.mjs';

const CLASS = '275c23e2-3747-11d0-9fea-00aa003f8646';
const MULTI = '275c23e1-3747-11d0-9fea-00aa003f8646';
const LINK = '359f3441-bd4a-11d0-b188-00aa0038c969';
const PAGES = '359f3443-bd4a-11d0-b188-00aa0038c969';
const UNKNOWN = '00000000-0000-0000-c000-000000000046';
const E_POINTER = 0x80004003, E_NOINTERFACE = 0x80004002, E_FAIL = 0x80004005;
const E_NOTIMPL = 0x80004001, E_INVALIDARG = 0x80070057;
interface Instance { primary: number; link: number; refs: number; fonts: Set<number> }
interface Runtime { generation: number; primaryVtable: number; linkVtable: number; instances: Map<number, Instance> }
// @transient(a capture is refused while an MLang instance is live, see liveMlangInstances; a resetGeneration change discards the tables)
const runtimes = new WeakMap<Process, Runtime>();

export function liveMlangInstances(process: Process): number {
    const r = runtimes.get(process);
    if (!r || r.generation !== process.resetGeneration) return 0;
    return new Set([...r.instances.values()].filter(object => object.refs > 0)).size;
}
const supports = (iid: string) => [UNKNOWN, MULTI, LINK, PAGES].includes(iid);

function runtime(process: Process): Runtime | null {
    const cached = runtimes.get(process);
    if (cached?.generation === process.resetGeneration) return cached;
    runtimes.delete(process);
    const r: Runtime = { generation: process.resetGeneration, primaryVtable: 0, linkVtable: 0, instances: new Map() };
    const valid = (mem: Uint8Array, p: number, size: number) => p > 0 && p + size <= mem.length;
    const releaseMappedFont = (object: Instance, font: number): boolean => {
        if (!object.fonts.has(font)) return false;
        const gdi = System.getInstance().gdiContext;
        if ([...gdi.hdcStates.values()].some(dc => dc.hFont === font)) return false;
        if (!gdi.deleteObject(font)) return false;
        object.fonts.delete(font); return true;
    };
    const call = (method: string): ThunkImplementation => (_ctx, mem, a) => {
        const object = r.instances.get(a[0] >>> 0);
        if (!object || object.refs <= 0) return E_POINTER;
        switch (method) {
            case 'QueryInterface': {
                if (!valid(mem, a[2], 4)) return E_POINTER;
                if (!Mem.writeUint32(a[2], 0)) return E_POINTER;
                if (!valid(mem, a[1], 16)) return E_POINTER;
                const iid = readGuidFromMem(mem, a[1]).toLowerCase();
                if (!supports(iid)) return E_NOINTERFACE;
                if (!Mem.writeUint32(a[2], iid === LINK || iid === PAGES ? object.link : object.primary)) return E_POINTER;
                object.refs++; return 0;
            }
            case 'AddRef': return ++object.refs;
            case 'Release': {
                if (--object.refs) return object.refs;
                for (const font of [...object.fonts]) releaseMappedFont(object, font);
                r.instances.delete(object.primary); r.instances.delete(object.link);
                freeComObject(process.memory, object.primary); freeComObject(process.memory, object.link);
                return 0;
            }
            case 'GetNumberOfCodePageInfo':
                return valid(mem, a[1], 4) && Mem.writeUint32(a[1], CODEPAGES.length) ? 0 : E_POINTER;
            case 'GetFamilyCodePage':
                if (!valid(mem, a[2], 4)) return E_POINTER;
                if (!codePageBit(a[1])) return E_INVALIDARG;
                return Mem.writeUint32(a[2], a[1]) ? 0 : E_POINTER;
            case 'GetCharCodePages':
                return valid(mem, a[2], 4) && Mem.writeUint32(a[2], charCodePages(a[1] & 0xffff)) ? 0 : E_POINTER;
            case 'CodePageToCodePages': {
                if (!valid(mem, a[2], 4)) return E_POINTER;
                const bits = codePageBit(a[1]);
                if (!bits) { Mem.writeUint32(a[2], 0); return E_INVALIDARG; }
                return Mem.writeUint32(a[2], bits) ? 0 : E_POINTER;
            }
            case 'CodePagesToCodePage': {
                if (!valid(mem, a[3], 4)) return E_POINTER;
                const page = codePageBit(a[2]) & a[1] ? a[2] : CODEPAGES.find(([, bit]) => (2 ** bit & a[1]) !== 0)?.[0];
                if (!page) { Mem.writeUint32(a[3], 0); return E_FAIL; }
                return Mem.writeUint32(a[3], page) ? 0 : E_POINTER;
            }
            case 'GetFontCodePages': {
                if (a[3] && (!valid(mem, a[3], 4) || !Mem.writeUint32(a[3], 0))) return E_POINTER;
                const gdi = System.getInstance().gdiContext, dc = gdi.hdcStates.get(a[1]);
                if (!dc || !a[2]) return E_FAIL;
                const font = gdi.objects.get(a[2]);
                const coverage = font?.type === 'FONT' && font.faceName ? installedFontCoverage(font.faceName) : null;
                if (coverage?.codePages == null) return E_FAIL;
                return !a[3] || Mem.writeUint32(a[3], coverage.codePages) ? 0 : E_POINTER;
            }
            case 'MapFont': {
                if (!valid(mem, a[4], 4) || !Mem.writeUint32(a[4], 0)) return E_POINTER;
                const gdi = System.getInstance().gdiContext, source = gdi.objects.get(a[3]);
                if (!gdi.hdcStates.has(a[1]) || source?.type !== 'FONT' || !source.faceName) return E_INVALIDARG;
                const originalCoverage = installedFontCoverage(source.faceName);
                const family = ((originalCoverage?.codePages ?? 0) & a[2]) ? source.faceName : installedFontForCodePages(a[2]);
                if (!family) return E_FAIL;
                const handle = gdi.nextHgdiobj++;
                const style = source.lfItalic ? 'italic' : 'normal', weight = (source.lfWeight ?? 400) >= 600 ? 'bold' : 'normal';
                gdi.objects.set(handle, { ...source, handle, faceName: family,
                    data: `${style} ${weight} ${source.fontSize ?? 16}px ${JSON.stringify(family)}, sans-serif` });
                if (!Mem.writeUint32(a[4], handle)) {
                    gdi.deleteObject(handle);
                    return E_POINTER;
                }
                object.fonts.add(handle);
                return 0;
            }
            case 'ReleaseFont': return releaseMappedFont(object, a[1]) ? 0 : E_INVALIDARG;
            case 'ResetFontMapping': {
                let ok = true;
                for (const font of [...object.fonts]) if (!releaseMappedFont(object, font)) ok = false;
                return ok ? 0 : E_FAIL;
            }
            default: return E_NOTIMPL;
        }
    };
    const handlers: Record<string, ThunkImplementation> = {};
    for (const [prefix, layout] of [['IMultiLanguage', MULTILANGUAGE_METHODS], ['IMLangFontLink', FONTLINK_METHODS]] as const)
        for (const [name] of layout) handlers[`${prefix}_${name}`] = call(name);
    const install = (prefix: string, layout: [string, number][]) => installComVtable(process, {
        moduleName: 'mlang', handlers,
        methods: layout.map(([name, count]) => ({ name: `${prefix}_${name}`, argCount: count, stackCleanupBytes: count * 4 })),
        logLabel: prefix,
    });
    const primary = install('IMultiLanguage', MULTILANGUAGE_METHODS), link = install('IMLangFontLink', FONTLINK_METHODS);
    if (!primary || !link) return null;
    r.primaryVtable = primary.vtableAddr; r.linkVtable = link.vtableAddr;
    runtimes.set(process, r); return r;
}

export function coCreateMlang(process: Process, clsid: string, iid: string, out: number): number | null {
    if (clsid !== CLASS) return null;
    const mem = process.getCurrentMemory();
    if (!out || out + 4 > mem.length) return E_POINTER;
    Mem.writeUint32(out, 0);
    if (!supports(iid)) return E_NOINTERFACE;
    const r = runtime(process); if (!r) return E_FAIL;
    const primary: number = allocateComObject(process.memory, process.getCurrentMemory(), r.primaryVtable);
    const link: number = allocateComObject(process.memory, process.getCurrentMemory(), r.linkVtable);
    const object: Instance = { primary, link, refs: 1, fonts: new Set() };
    r.instances.set(primary, object); r.instances.set(link, object);
    if (!Mem.writeUint32(out, iid === LINK || iid === PAGES ? link : primary)) {
        r.instances.delete(primary); r.instances.delete(link);
        freeComObject(process.memory, primary); freeComObject(process.memory, link); return E_POINTER;
    }
    return 0;
}
