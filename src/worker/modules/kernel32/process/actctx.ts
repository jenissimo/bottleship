/**
 * Side-by-Side (SXS) activation context support for MSVC CRT startup.
 *
 * VC9+ apps (e.g. Worms Armageddon / WA.exe) embed an RT_MANIFEST dependency on
 * Microsoft.VC90.CRT. The CRT calls CreateActCtx → ActivateActCtx →
 * FindActCtxSectionString to resolve redirected DLL paths before LoadLibrary.
 */

import { ThunkImplementation } from '../../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../../core/logger';
import { System } from '../../../core/system';
import { Mem } from '../../../core/memory/mem-accessor';
import { Marshaler } from '../../../core/memory/marshaler';
import { APIRegistry } from '../../../core/api-registry';
import { hleImageBase } from '../../../core/hle-module-images';
import { resolveThunkedDllAlias } from '../../../core/dll-aliases';
import { findResourceInPE, getFirstResourceId } from '../resource';

const ERROR_INVALID_PARAMETER = 87;
const ERROR_SXS_SECTION_NOT_FOUND = 14100;
const INVALID_HANDLE_VALUE = 0xFFFFFFFF;

const ACTCTX_FLAG_APPLICATION_NAME_VALID = 0x00000001;
const ACTCTX_FLAG_ASSEMBLY_DIRECTORY_VALID = 0x00000002;
const ACTCTX_FLAG_RESOURCE_NAME_VALID = 0x00000008;
const ACTCTX_FLAG_SET_PROCESS_DEFAULT = 0x00000010;
const ACTCTX_FLAG_HMODULE_VALID = 0x00000020;

const RT_MANIFEST = 24;
const CREATEPROCESS_MANIFEST_RESOURCE_ID = 1;
const ISOLATIONAWARE_MANIFEST_RESOURCE_ID = 2;

const ACTIVATION_CONTEXT_SECTION_ASSEMBLY_INFORMATION = 1;
const ACTIVATION_CONTEXT_SECTION_DLL_REDIRECTION = 2;

const ACTCTX_SECTION_KEYED_DATA_SIZE = 64;
const ACTCTX_SECTION_KEYED_DATA_FORMAT_VERSION = 1;

const TEB_ACTIVATION_CONTEXT_STACK = 0x94;
const PEB_ACTIVATION_CONTEXT_DATA = 0x78;
const ACTCTX_STACK_FRAME_SIZE = 12;
const ACTCTX_STACK_SIZE = 8;

const ACTCTX_MAGIC = 0xac7c0001;

function readU32(addr: number): number {
    return Mem.readUint32(addr) ?? 0;
}

interface ParsedAssembly {
    name: string;
    version: string;
    publicKeyToken: string;
    processorArchitecture: string;
    type: string;
}

interface DllRedirect {
    dllBaseName: string;
    redirectPath: string;
    guestBlob: number;
    guestBlobSize: number;
}

interface ActivationContextRecord {
    handle: number;
    refcount: number;
    assemblies: ParsedAssembly[];
    assemblyKeys: string[];
    dllRedirects: DllRedirect[];
    assemblySectionBlob: number;
    assemblySectionSize: number;
}

const contextsByHandle = new Map<number, ActivationContextRecord>();
let processDefaultActCtx: number | null = null;
let nextActCtxCookie = 1;

/** Per-thread activation stack top frames: tid -> { cookie, handle }[] */
const threadActCtxFrames = new Map<number, Array<{ cookie: number; handle: number }>>();

export function resetActCtxState(): void {
    contextsByHandle.clear();
    processDefaultActCtx = null;
    nextActCtxCookie = 1;
    threadActCtxFrames.clear();
}

const ASSEMBLY_DLL_MAP: Record<string, string[]> = {
    'microsoft.windows.common-controls': ['comctl32.dll'],
    'microsoft.vc90.crt': ['msvcr90.dll'],
    'microsoft.vc90.cpp': ['msvcp90.dll'],
    'microsoft.vc90.mfc': ['mfc90.dll', 'mfcm90.dll'],
    'microsoft.vc90.mfcloc': ['mfc90enu.dll'],
    'microsoft.vc90.openmp': ['vcomp90.dll'],
    'microsoft.vc90.atl': ['atl90.dll'],
    'microsoft.vc80.crt': ['msvcr80.dll'],
    'microsoft.vc80.cpp': ['msvcp80.dll'],
    'microsoft.vc80.mfc': ['mfc80.dll', 'mfcm80.dll'],
    'microsoft.vc80.mfcloc': ['mfc80enu.dll'],
    'microsoft.vc80.openmp': ['vcomp80.dll'],
    'microsoft.vc71.crt': ['msvcr71.dll'],
    'microsoft.vc71.mfc': ['mfc71.dll'],
};

function isIntResource(ptr: number): boolean {
    const p = ptr >>> 0;
    return p > 0 && p <= 0xffff;
}

function buildAssemblyKey(asm: ParsedAssembly): string {
    const parts: string[] = [asm.name];
    if (asm.processorArchitecture) parts.push(`processorArchitecture="${asm.processorArchitecture}"`);
    if (asm.publicKeyToken) parts.push(`publicKeyToken="${asm.publicKeyToken}"`);
    if (asm.type) parts.push(`type="${asm.type}"`);
    if (asm.version) parts.push(`version="${asm.version}"`);
    return parts.join(',');
}

function buildSxSRedirectPath(asm: ParsedAssembly, dllFile: string): string {
    const arch = asm.processorArchitecture || 'x86';
    const token = asm.publicKeyToken || '1fc8b3b9a1e18e3b';
    const version = asm.version || '9.0.21022.8';
    const folder = `${arch}_${asm.name}_${token}_${version}_x-ww_0`;
    return `C:\\WINDOWS\\WinSxS\\${folder}\\${dllFile}`;
}

function parseAssemblyIdentityAttributes(attrs: string): ParsedAssembly {
    const read = (key: string): string => {
        const m = attrs.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i'));
        return m?.[1] ?? '';
    };
    return {
        name: read('name'),
        version: read('version'),
        publicKeyToken: read('publicKeyToken'),
        processorArchitecture: read('processorArchitecture'),
        type: read('type'),
    };
}

function parseManifestDependencies(xml: string): ParsedAssembly[] {
    const deps: ParsedAssembly[] = [];
    const depRe = /<dependentAssembly>[\s\S]*?<\/dependentAssembly>/gi;
    let block: RegExpExecArray | null;
    while ((block = depRe.exec(xml)) !== null) {
        const idMatch = block[0].match(/<assemblyIdentity\s+([^>/]+)\/?>/i);
        if (!idMatch) continue;
        const asm = parseAssemblyIdentityAttributes(idMatch[1]);
        if (asm.name) deps.push(asm);
    }
    return deps;
}

function readManifestFromModule(mem: Uint8Array, moduleBase: number, resourceId?: number): string | null {
    const tryIds: number[] = [];
    if (resourceId !== undefined) tryIds.push(resourceId);
    if (!tryIds.includes(CREATEPROCESS_MANIFEST_RESOURCE_ID)) {
        tryIds.push(CREATEPROCESS_MANIFEST_RESOURCE_ID);
    }
    if (!tryIds.includes(ISOLATIONAWARE_MANIFEST_RESOURCE_ID)) {
        tryIds.push(ISOLATIONAWARE_MANIFEST_RESOURCE_ID);
    }
    const first = getFirstResourceId(mem, moduleBase, RT_MANIFEST);
    if (first !== null && !tryIds.includes(first)) tryIds.push(first);

    for (const id of tryIds) {
        const entry = findResourceInPE(mem, moduleBase, RT_MANIFEST, id);
        if (!entry) continue;
        const start = entry.moduleBase + entry.dataRVA;
        const bytes = mem.subarray(start, start + entry.size);
        let text = new TextDecoder('utf-8').decode(bytes);
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        text = text.replace(/^\uFEFF/, '').trim();
        if (text.length > 0) return text;
    }
    return null;
}

function resolveModuleBaseFromActCtx(mem: Uint8Array, wide: boolean, pActCtx: number): number {
    const cbSize = readU32(pActCtx);
    if (cbSize < 28) return 0;

    const dwFlags = readU32(pActCtx + 4);
    const lpSource = readU32(pActCtx + 8);
    const hModule = readU32(pActCtx + 28);

    if ((dwFlags & ACTCTX_FLAG_HMODULE_VALID) && hModule !== 0) {
        return hModule >>> 0;
    }

    const system = System.getInstance();
    const registry = system.process?.moduleRegistry;
    if (registry) {
        if (lpSource !== 0) {
            const path = wide
                ? Marshaler.readStringW(mem, lpSource)
                : Marshaler.readString(mem, lpSource);
            const mod = registry.getByName(path);
            if (mod) return mod.baseAddress;
        }
        const exe = registry.getByBase(0x00400000);
        if (exe) return exe.baseAddress;
    }
    return 0x00400000;
}

function readActCtxResourceId(mem: Uint8Array, wide: boolean, pActCtx: number): number | undefined {
    const dwFlags = readU32(pActCtx + 4);
    if ((dwFlags & ACTCTX_FLAG_RESOURCE_NAME_VALID) === 0) return undefined;

    const lpResourceName = readU32(pActCtx + 20);
    if (lpResourceName === 0) return undefined;
    if (isIntResource(lpResourceName)) return lpResourceName & 0xffff;

    const name = wide
        ? Marshaler.readStringW(mem, lpResourceName)
        : Marshaler.readString(mem, lpResourceName);
    const parsed = parseInt(name, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function assembliesToRedirects(assemblies: ParsedAssembly[]): DllRedirect[] {
    const redirects: DllRedirect[] = [];
    const seen = new Set<string>();

    for (const asm of assemblies) {
        const dlls = ASSEMBLY_DLL_MAP[asm.name.toLowerCase()];
        if (!dlls) {
            Logger.warn(LogCategory.KERNEL32, `ActCtx: unknown dependent assembly "${asm.name}"`);
            continue;
        }
        for (const dll of dlls) {
            const base = dll.toLowerCase();
            if (seen.has(base)) continue;
            seen.add(base);
            redirects.push({
                dllBaseName: base,
                redirectPath: buildSxSRedirectPath(asm, dll),
                guestBlob: 0,
                guestBlobSize: 0,
            });
        }
    }
    return redirects;
}

function writeUtf16(mem: Uint8Array, addr: number, text: string): number {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    for (let i = 0; i < text.length; i++) {
        view.setUint16(addr + i * 2, text.charCodeAt(i), true);
    }
    view.setUint16(addr + text.length * 2, 0, true);
    return (text.length + 1) * 2;
}

function allocGuest(size: number): number {
    const process = System.getInstance().process;
    if (!process) return 0;
    return process.memory.alloc(size, 'THUNK_DATA', 'rw');
}

function buildDllRedirectBlob(mem: Uint8Array, redirect: DllRedirect): number {
    const original = redirect.dllBaseName;
    const target = redirect.redirectPath;
    const headerSize = 0x18;
    const originalBytes = (original.length + 1) * 2;
    const targetBytes = (target.length + 1) * 2;
    const total = headerSize + originalBytes + targetBytes;
    const base = allocGuest(total);
    if (!base) return 0;

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const nameOffset = headerSize;
    const redirectOffset = headerSize + originalBytes;

    view.setUint32(base + 0x00, headerSize, true);
    view.setUint32(base + 0x04, 0, true);
    view.setUint32(base + 0x08, nameOffset, true);
    view.setUint32(base + 0x0c, originalBytes, true);
    view.setUint32(base + 0x10, redirectOffset, true);
    view.setUint32(base + 0x14, targetBytes, true);

    writeUtf16(mem, base + nameOffset, original);
    writeUtf16(mem, base + redirectOffset, target);

    redirect.guestBlob = base;
    redirect.guestBlobSize = total;
    return base;
}

function buildAssemblySectionBlob(
    mem: Uint8Array,
    assemblies: ParsedAssembly[],
    keys: string[]
): { base: number; size: number } {
    if (assemblies.length === 0) return { base: 0, size: 0 };

    let stringBytes = 0;
    const stringOffsets: number[] = [];
    for (const key of keys) {
        stringOffsets.push(stringBytes);
        stringBytes += (key.length + 1) * 2;
    }

    const entrySize = 0x18;
    const headerSize = 0x10;
    const total = headerSize + assemblies.length * entrySize + stringBytes;
    const base = allocGuest(total);
    if (!base) return { base: 0, size: 0 };

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint32(base + 0x00, total, true);
    view.setUint32(base + 0x04, assemblies.length, true);
    view.setUint32(base + 0x08, headerSize, true);
    view.setUint32(base + 0x0c, entrySize, true);

    const stringBase = base + headerSize + assemblies.length * entrySize;
    for (let i = 0; i < keys.length; i++) {
        writeUtf16(mem, stringBase + stringOffsets[i], keys[i]);
    }

    for (let i = 0; i < assemblies.length; i++) {
        const entry = base + headerSize + i * entrySize;
        view.setUint32(entry + 0x00, entrySize, true);
        view.setUint32(entry + 0x04, 0, true);
        view.setUint32(entry + 0x08, stringBase + stringOffsets[i], true);
        view.setUint32(entry + 0x0c, (keys[i].length + 1) * 2, true);
        view.setUint32(entry + 0x10, 0, true);
        view.setUint32(entry + 0x14, 0, true);
    }

    return { base, size: total };
}

async function ensureDllLoaded(dllPathOrName: string): Promise<number> {
    const system = System.getInstance();
    const registry = system.process?.moduleRegistry;
    const loader = system.process?.loader;

    const leaf = dllPathOrName.split('\\').pop() ?? dllPathOrName;
    const thunkedName = resolveThunkedDllAlias(leaf);

    if (registry) {
        const existing = registry.getByName(leaf) ?? registry.getByName(thunkedName);
        if (existing) return existing.baseAddress;
    }

    // Must be the same handle GetModuleHandle/LoadLibrary hand out — a second, privately
    // derived base means two HMODULEs for one module, and GetProcAddress resolves against
    // whichever one the caller happens to hold.
    const hleBase = hleImageBase(thunkedName);
    if (hleBase !== undefined) return hleBase;

    if (loader) {
        try {
            const mod = await loader.loadDll(leaf, true);
            if (mod) return mod.baseAddress;
        } catch {
            // fall through
        }
        try {
            const mod = await loader.loadDll(thunkedName + '.dll', true);
            if (mod) return mod.baseAddress;
        } catch {
            // fall through
        }
    }

    return 0;
}

async function preloadRedirectDlls(redirects: DllRedirect[]): Promise<void> {
    for (const redirect of redirects) {
        const base = await ensureDllLoaded(redirect.redirectPath);
        if (base) {
            Logger.log(
                LogCategory.KERNEL32,
                `ActCtx: preloaded ${redirect.dllBaseName} -> 0x${base.toString(16)} (${redirect.redirectPath})`
            );
        } else {
            Logger.warn(
                LogCategory.KERNEL32,
                `ActCtx: failed to preload ${redirect.dllBaseName} (${redirect.redirectPath})`
            );
        }
    }
}

function getCurrentThreadId(): number {
    return System.getInstance().scheduler?.getCurrentThreadId?.() ?? 1;
}

function getTebAddress(threadId: number): number {
    return System.getInstance().scheduler?.tebManager?.getTebAddress(threadId) ?? 0;
}

function getPebAddress(): number {
    return System.getInstance().scheduler?.tebManager?.getPebAddress() ?? 0;
}

function ensureTebActivationStack(mem: Uint8Array, teb: number): number {
    let stack = readU32(teb + TEB_ACTIVATION_CONTEXT_STACK);
    if (stack) return stack;

    stack = allocGuest(ACTCTX_STACK_SIZE);
    if (!stack) return 0;
    mem.fill(0, stack, stack + ACTCTX_STACK_SIZE);
    Mem.writeUint32(teb + TEB_ACTIVATION_CONTEXT_STACK, stack);
    return stack;
}

function resolveActiveActCtxHandle(): number | null {
    const tid = getCurrentThreadId();
    const frames = threadActCtxFrames.get(tid);
    if (frames && frames.length > 0) {
        return frames[frames.length - 1].handle;
    }

    const teb = getTebAddress(tid);
    if (teb) {
        const stack = readU32(teb + TEB_ACTIVATION_CONTEXT_STACK);
        if (stack) {
            const activeFrame = readU32(stack);
            if (activeFrame) {
                const handle = readU32(activeFrame + 4);
                if (handle && contextsByHandle.has(handle)) return handle;
            }
        }
    }

    const peb = getPebAddress();
    if (peb) {
        const handle = readU32(peb + PEB_ACTIVATION_CONTEXT_DATA);
        if (handle && contextsByHandle.has(handle)) return handle;
    }

    return processDefaultActCtx;
}

function writeSectionKeyedData(
    mem: Uint8Array,
    outPtr: number,
    actCtxHandle: number,
    lpData: number,
    ulLength: number,
    sectionBase: number,
    sectionTotalLength: number,
    rosterIndex: number
): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint32(outPtr + 0x00, ACTCTX_SECTION_KEYED_DATA_SIZE, true);
    view.setUint32(outPtr + 0x04, ACTCTX_SECTION_KEYED_DATA_FORMAT_VERSION, true);
    view.setUint32(outPtr + 0x08, lpData, true);
    view.setUint32(outPtr + 0x0c, ulLength, true);
    view.setUint32(outPtr + 0x10, sectionBase, true);
    view.setUint32(outPtr + 0x14, sectionTotalLength, true);
    view.setUint32(outPtr + 0x18, sectionBase, true);
    view.setUint32(outPtr + 0x1c, sectionTotalLength, true);
    view.setUint32(outPtr + 0x20, actCtxHandle, true);
    view.setUint32(outPtr + 0x24, rosterIndex, true);
    view.setUint32(outPtr + 0x28, 0, true);
    view.setUint32(outPtr + 0x2c, lpData, true);
    view.setUint32(outPtr + 0x30, sectionBase, true);
    view.setUint32(outPtr + 0x34, sectionTotalLength, true);
    view.setUint32(outPtr + 0x38, sectionBase, true);
    view.setUint32(outPtr + 0x3c, sectionTotalLength, true);
}

function assemblyLookupIndex(record: ActivationContextRecord, query: string): number {
    const q = query.toLowerCase();
    for (let i = 0; i < record.assemblyKeys.length; i++) {
        const key = record.assemblyKeys[i].toLowerCase();
        if (key === q || key.startsWith(q + ',') || q.startsWith(key)) return i;
        const name = record.assemblies[i]?.name.toLowerCase() ?? '';
        if (name && (q === name || q.startsWith(name + ','))) return i;
    }
    return -1;
}

function findActCtxSectionString(
    mem: Uint8Array,
    wide: boolean,
    actCtxHandle: number,
    sectionId: number,
    query: string,
    outPtr: number
): boolean {
    const record = contextsByHandle.get(actCtxHandle);
    if (!record) return false;

    if (sectionId === ACTIVATION_CONTEXT_SECTION_DLL_REDIRECTION) {
        const q = query.toLowerCase();
        for (let i = 0; i < record.dllRedirects.length; i++) {
            const redirect = record.dllRedirects[i];
            if (redirect.dllBaseName !== q && redirect.dllBaseName !== q.replace(/\.dll$/i, '') + '.dll') {
                continue;
            }
            if (!redirect.guestBlob) continue;
            writeSectionKeyedData(
                mem,
                outPtr,
                actCtxHandle,
                redirect.guestBlob,
                redirect.guestBlobSize,
                redirect.guestBlob,
                redirect.guestBlobSize,
                i
            );
            return true;
        }
        return false;
    }

    if (sectionId === ACTIVATION_CONTEXT_SECTION_ASSEMBLY_INFORMATION) {
        const index = assemblyLookupIndex(record, query);
        if (index < 0 || !record.assemblySectionBlob) return false;
        const entryPtr = record.assemblySectionBlob + 0x10 + index * 0x18;
        writeSectionKeyedData(
            mem,
            outPtr,
            actCtxHandle,
            entryPtr,
            0x18,
            record.assemblySectionBlob,
            record.assemblySectionSize,
            index
        );
        return true;
    }

    return false;
}

async function createActivationContext(
    mem: Uint8Array,
    pActCtx: number,
    wide: boolean
): Promise<number> {
    const cbSize = readU32(pActCtx);
    if (cbSize < 28) {
        System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
        return INVALID_HANDLE_VALUE;
    }

    const dwFlags = readU32(pActCtx + 4);
    const moduleBase = resolveModuleBaseFromActCtx(mem, wide, pActCtx);
    const resourceId = readActCtxResourceId(mem, wide, pActCtx);

    let manifestXml = readManifestFromModule(mem, moduleBase, resourceId);
    if (!manifestXml) {
        Logger.warn(
            LogCategory.KERNEL32,
            `ActCtx: no embedded manifest in module 0x${moduleBase.toString(16)}`
        );
        manifestXml = '';
    }

    const assemblies = manifestXml ? parseManifestDependencies(manifestXml) : [];
    const assemblyKeys = assemblies.map(buildAssemblyKey);
    const dllRedirects = assembliesToRedirects(assemblies);

    const guestHeader = allocGuest(8);
    if (!guestHeader) {
        System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
        return INVALID_HANDLE_VALUE;
    }
    Mem.writeUint32(guestHeader + 0, ACTCTX_MAGIC);
    Mem.writeUint32(guestHeader + 4, dwFlags);

    const assemblySection = buildAssemblySectionBlob(mem, assemblies, assemblyKeys);

    for (const redirect of dllRedirects) {
        buildDllRedirectBlob(mem, redirect);
    }

    await preloadRedirectDlls(dllRedirects);

    const record: ActivationContextRecord = {
        handle: guestHeader,
        refcount: 1,
        assemblies,
        assemblyKeys,
        dllRedirects,
        assemblySectionBlob: assemblySection.base,
        assemblySectionSize: assemblySection.size,
    };
    contextsByHandle.set(guestHeader, record);

    if (dwFlags & ACTCTX_FLAG_SET_PROCESS_DEFAULT) {
        processDefaultActCtx = guestHeader;
        const peb = getPebAddress();
        if (peb) Mem.writeUint32(peb + PEB_ACTIVATION_CONTEXT_DATA, guestHeader);
    }

    Logger.log(
        LogCategory.KERNEL32,
        `ActCtx: created 0x${guestHeader.toString(16)} assemblies=${assemblies.length} redirects=${dllRedirects.length} module=0x${moduleBase.toString(16)}`
    );
    for (const asm of assemblies) {
        Logger.verbose(LogCategory.KERNEL32, `ActCtx dependency: ${buildAssemblyKey(asm)}`);
    }

    return guestHeader;
}

export async function ensureProcessDefaultActivationContext(
    mem: Uint8Array,
    exeBase: number
): Promise<void> {
    if (processDefaultActCtx && contextsByHandle.has(processDefaultActCtx)) return;

    const manifestXml = readManifestFromModule(mem, exeBase);
    if (!manifestXml) return;

    const assemblies = parseManifestDependencies(manifestXml);
    if (assemblies.length === 0) return;

    const fakeActCtx = allocGuest(32);
    if (!fakeActCtx) return;
    Mem.writeUint32(fakeActCtx + 0, 32);
    Mem.writeUint32(fakeActCtx + 4, ACTCTX_FLAG_HMODULE_VALID | ACTCTX_FLAG_SET_PROCESS_DEFAULT);
    Mem.writeUint32(fakeActCtx + 28, exeBase);

    await createActivationContext(mem, fakeActCtx, false);
}

export function createActCtxExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['CreateActCtxW'] = async (ctx, mem, args) => {
        const pActCtx = args[0] >>> 0;
        if (pActCtx === 0) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: INVALID_HANDLE_VALUE, stackCleanup: 4 };
        }
        const handle = await createActivationContext(mem, pActCtx, true);
        return { value: handle, stackCleanup: 4 };
    };

    exports['CreateActCtxA'] = async (ctx, mem, args) => {
        const pActCtx = args[0] >>> 0;
        if (pActCtx === 0) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: INVALID_HANDLE_VALUE, stackCleanup: 4 };
        }
        const handle = await createActivationContext(mem, pActCtx, false);
        return { value: handle, stackCleanup: 4 };
    };

    exports['ReleaseActCtx'] = (ctx, mem, args) => {
        const hActCtx = args[0] >>> 0;
        const record = contextsByHandle.get(hActCtx);
        if (!record) return { value: 0, stackCleanup: 4 };
        record.refcount--;
        if (record.refcount <= 0) {
            contextsByHandle.delete(hActCtx);
            if (processDefaultActCtx === hActCtx) processDefaultActCtx = null;
        }
        return { value: 0, stackCleanup: 4 };
    };

    exports['ActivateActCtx'] = (ctx, mem, args) => {
        const hActCtx = args[0] >>> 0;
        const lpCookie = args[1] >>> 0;
        if (!contextsByHandle.has(hActCtx) || lpCookie === 0) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 8 };
        }

        const tid = getCurrentThreadId();
        const teb = getTebAddress(tid);
        if (teb) {
            const stack = ensureTebActivationStack(mem, teb);
            if (stack) {
                const frame = allocGuest(ACTCTX_STACK_FRAME_SIZE);
                const prev = readU32(stack);
                Mem.writeUint32(frame + 0, prev);
                Mem.writeUint32(frame + 4, hActCtx);
                Mem.writeUint32(frame + 8, 0);
                Mem.writeUint32(stack, frame);
            }
        }

        const cookie = (nextActCtxCookie++ >>> 0) || 1;
        Mem.writeUint32(lpCookie, cookie);

        const frames = threadActCtxFrames.get(tid) ?? [];
        frames.push({ cookie, handle: hActCtx });
        threadActCtxFrames.set(tid, frames);

        return { value: 1, stackCleanup: 8 };
    };

    exports['DeactivateActCtx'] = (ctx, mem, args) => {
        const dwFlags = args[0] >>> 0;
        const ulCookie = args[1] >>> 0;
        const tid = getCurrentThreadId();
        const frames = threadActCtxFrames.get(tid);
        if (!frames || frames.length === 0) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 8 };
        }

        let index = frames.length - 1;
        if (dwFlags === 0) {
            index = frames.findIndex((f) => f.cookie === ulCookie);
            if (index < 0) {
                System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return { value: 0, stackCleanup: 8 };
            }
        }

        const teb = getTebAddress(tid);
        if (teb) {
            const stack = readU32(teb + TEB_ACTIVATION_CONTEXT_STACK);
            if (stack) {
                const activeFrame = readU32(stack);
                if (activeFrame) {
                    const prev = readU32(activeFrame);
                    Mem.writeUint32(stack, prev);
                }
            }
        }

        frames.splice(index, 1);
        return { value: 1, stackCleanup: 8 };
    };

    exports['GetCurrentActCtx'] = (ctx, mem, args) => {
        const lphActCtx = args[0] >>> 0;
        if (lphActCtx === 0) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 4 };
        }
        const handle = resolveActiveActCtxHandle();
        if (!handle) {
            Mem.writeUint32(lphActCtx, 0);
            return { value: 0, stackCleanup: 4 };
        }
        Mem.writeUint32(lphActCtx, handle);
        return { value: 1, stackCleanup: 4 };
    };

    exports['FindActCtxSectionStringW'] = (ctx, mem, args) => {
        const dwFlags = args[0] >>> 0;
        const ulSectionId = args[2] >>> 0;
        const lpString = args[3] >>> 0;
        const pData = args[4] >>> 0;
        if (lpString === 0 || pData === 0) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 20 };
        }

        const actCtxHandle = resolveActiveActCtxHandle();
        if (!actCtxHandle) {
            System.getInstance().scheduler.setLastError(ERROR_SXS_SECTION_NOT_FOUND);
            return { value: 0, stackCleanup: 20 };
        }

        const query = Marshaler.readStringW(mem, lpString);
        const ok = findActCtxSectionString(mem, true, actCtxHandle, ulSectionId, query, pData);
        if (!ok) {
            Logger.verbose(
                LogCategory.KERNEL32,
                `FindActCtxSectionStringW(section=${ulSectionId}, "${query}", flags=0x${dwFlags.toString(16)}) -> NOT FOUND`
            );
            System.getInstance().scheduler.setLastError(ERROR_SXS_SECTION_NOT_FOUND);
            return { value: 0, stackCleanup: 20 };
        }

        Logger.verbose(
            LogCategory.KERNEL32,
            `FindActCtxSectionStringW(section=${ulSectionId}, "${query}") -> OK`
        );
        return { value: 1, stackCleanup: 20 };
    };

    exports['FindActCtxSectionStringA'] = (ctx, mem, args) => {
        const dwFlags = args[0] >>> 0;
        const ulSectionId = args[2] >>> 0;
        const lpString = args[3] >>> 0;
        const pData = args[4] >>> 0;
        if (lpString === 0 || pData === 0) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return { value: 0, stackCleanup: 20 };
        }

        const actCtxHandle = resolveActiveActCtxHandle();
        if (!actCtxHandle) {
            System.getInstance().scheduler.setLastError(ERROR_SXS_SECTION_NOT_FOUND);
            return { value: 0, stackCleanup: 20 };
        }

        const query = Marshaler.readString(mem, lpString);
        const ok = findActCtxSectionString(mem, false, actCtxHandle, ulSectionId, query, pData);
        if (!ok) {
            Logger.verbose(
                LogCategory.KERNEL32,
                `FindActCtxSectionStringA(section=${ulSectionId}, "${query}", flags=0x${dwFlags.toString(16)}) -> NOT FOUND`
            );
            System.getInstance().scheduler.setLastError(ERROR_SXS_SECTION_NOT_FOUND);
            return { value: 0, stackCleanup: 20 };
        }
        return { value: 1, stackCleanup: 20 };
    };

    exports['FindActCtxSectionGuid'] = (ctx, mem, args) => {
        System.getInstance().scheduler.setLastError(ERROR_SXS_SECTION_NOT_FOUND);
        return { value: 0, stackCleanup: 20 };
    };

    return exports;
}
