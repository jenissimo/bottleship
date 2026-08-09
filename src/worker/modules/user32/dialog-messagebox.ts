/**
 * User32 MessageBox family (MessageBoxA/W, MessageBoxIndirectA/W) plus the
 * guest-stack diagnostic formatters MessageBoxA logs for error boxes (Smacker/
 * MSS version errors, Quake2 Z_Free forensics). Host-side display goes through
 * the dialog bridge (requestMessageBox); no HWND is created for these.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { requestMessageBox } from '../../runtime/dialog-bridge';
import { System } from '../../core/system';

function formatGuestStackCodeRefs(ctx: { esp?: number; eip?: number }, mem: Uint8Array, maxSlots = 384): string {
    const registry = System.getInstance().process?.moduleRegistry;
    const esp = (ctx.esp ?? 0) >>> 0;
    if (!registry || !esp || esp + 4 > mem.length) return '';

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const refs: string[] = [];
    const seen = new Set<number>();
    const fmt = (addr: number): string => {
        const mod = registry.getModuleContainingAddress(addr);
        return mod ? `${mod.name}+0x${((addr - mod.baseAddress) >>> 0).toString(16)}` : `0x${addr.toString(16)}`;
    };

    const eip = (ctx.eip ?? 0) >>> 0;
    if (eip) {
        const mod = registry.getModuleContainingAddress(eip);
        refs.push(`eip=${mod ? fmt(eip) : `0x${eip.toString(16)}`}`);
    }

    for (let i = 0; i < maxSlots; i++) {
        const slot = esp + i * 4;
        if (slot + 4 > mem.length) break;
        const value = view.getUint32(slot, true) >>> 0;
        if (seen.has(value)) continue;
        const mod = registry.getModuleContainingAddress(value);
        if (!mod) continue;
        seen.add(value);
        refs.push(`[esp+0x${(i * 4).toString(16)}]=${fmt(value)}`);
        if (refs.length >= 32) break;
    }

    return refs.join(' ');
}

function formatGuestStackRaw(ctx: { esp?: number }, mem: Uint8Array, maxSlots = 32): string {
    const esp = (ctx.esp ?? 0) >>> 0;
    if (!esp || esp + 4 > mem.length) return '';

    const registry = System.getInstance().process?.moduleRegistry;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    const previewAnsi = (ptr: number): string => {
        if (!ptr || ptr >= mem.length) return '';
        const chars: string[] = [];
        const maxLen = Math.min(32, mem.length - ptr);
        let sawTerminator = false;
        for (let i = 0; i < maxLen; i++) {
            const c = mem[ptr + i];
            if (c === 0) {
                sawTerminator = true;
                break;
            }
            if (c === 0x09 || c === 0x0a || c === 0x0d) {
                chars.push(' ');
            } else if (c >= 0x20 && c <= 0x7e) {
                chars.push(String.fromCharCode(c));
            } else {
                return '';
            }
        }
        if (chars.length < 4 || (!sawTerminator && chars.length < maxLen)) return '';
        return chars.join('').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    };

    const describeValue = (value: number): string => {
        const parts: string[] = [`0x${value.toString(16)}`];
        const mod = registry?.getModuleContainingAddress(value);
        if (mod) {
            parts.push(`${mod.name}+0x${((value - mod.baseAddress) >>> 0).toString(16)}`);
        }
        const ascii = previewAnsi(value);
        if (ascii) {
            parts.push(`"${ascii}"`);
        }
        return parts.length === 1 ? parts[0] : `${parts[0]}(${parts.slice(1).join(',')})`;
    };

    const values: string[] = [`esp=0x${esp.toString(16)}`];
    for (let i = 0; i < maxSlots; i++) {
        const slot = esp + i * 4;
        if (slot + 4 > mem.length) break;
        const value = view.getUint32(slot, true) >>> 0;
        values.push(`[+0x${(i * 4).toString(16)}]=${describeValue(value)}`);
    }

    return values.join(' ');
}

function formatGuestRegisters(ctx: {
    eax?: number; ecx?: number; edx?: number; ebx?: number;
    esp?: number; ebp?: number; esi?: number; edi?: number; eip?: number;
}): string {
    const reg = (name: string, value?: number): string => `${name}=0x${((value ?? 0) >>> 0).toString(16)}`;
    return [
        reg('eip', ctx.eip),
        reg('eax', ctx.eax),
        reg('ecx', ctx.ecx),
        reg('edx', ctx.edx),
        reg('ebx', ctx.ebx),
        reg('esp', ctx.esp),
        reg('ebp', ctx.ebp),
        reg('esi', ctx.esi),
        reg('edi', ctx.edi),
    ].join(' ');
}

function formatGuestEbpChain(ctx: { ebp?: number }, mem: Uint8Array, maxFrames = 16): string {
    const registry = System.getInstance().process?.moduleRegistry;
    let ebp = (ctx.ebp ?? 0) >>> 0;
    if (!registry || !ebp || ebp + 8 > mem.length) return '';

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const frames: string[] = [];
    const seen = new Set<number>();

    const fmtAddr = (addr: number): string => {
        const mod = registry.getModuleContainingAddress(addr);
        return mod ? `${mod.name}+0x${((addr - mod.baseAddress) >>> 0).toString(16)}` : `0x${addr.toString(16)}`;
    };

    for (let i = 0; i < maxFrames; i++) {
        if (ebp + 24 > mem.length || seen.has(ebp)) break;
        seen.add(ebp);

        const nextEbp = view.getUint32(ebp, true) >>> 0;
        const ret = view.getUint32(ebp + 4, true) >>> 0;
        const args: string[] = [];
        for (let a = 0; a < 4; a++) {
            const argPtr = ebp + 8 + a * 4;
            if (argPtr + 4 > mem.length) break;
            const value = view.getUint32(argPtr, true) >>> 0;
            args.push(`a${a}=0x${value.toString(16)}`);
        }

        frames.push(`#${i} ebp=0x${ebp.toString(16)} ret=${fmtAddr(ret)} next=0x${nextEbp.toString(16)} ${args.join(' ')}`);

        if (!nextEbp || nextEbp <= ebp || nextEbp + 8 > mem.length) break;
        ebp = nextEbp;
    }

    return frames.join(' | ');
}

function formatGuestStackDataPointers(ctx: { esp?: number; ebp?: number }, mem: Uint8Array, maxBytes = 0x800): string {
    const esp = (ctx.esp ?? 0) >>> 0;
    if (!esp || esp + 4 > mem.length) return '';

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const refs: string[] = [];
    const seen = new Set<number>();
    const end = Math.min(mem.length, esp + maxBytes);

    const looksLikeQuake2Data = (value: number): boolean => value >= 0x44c000 && value < 0x1000000;
    const asciiAt = (ptr: number): string => {
        if (!ptr || ptr >= mem.length) return '';
        let out = '';
        for (let i = 0; i < 24 && ptr + i < mem.length; i++) {
            const c = mem[ptr + i];
            if (c === 0) break;
            if (c < 0x20 || c > 0x7e) return '';
            out += String.fromCharCode(c);
        }
        return out.length >= 4 ? out.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : '';
    };

    for (let ptr = esp; ptr + 4 <= end; ptr += 4) {
        const value = view.getUint32(ptr, true) >>> 0;
        if (!looksLikeQuake2Data(value) || seen.has(value)) continue;
        seen.add(value);

        const pieces = [`[esp+0x${(ptr - esp).toString(16)}]=0x${value.toString(16)}`];
        const ascii = asciiAt(value);
        if (ascii) pieces.push(`"${ascii}"`);
        if (value >= 4 && value + 4 <= mem.length) {
            try {
                pieces.push(`prev32=0x${view.getUint32(value - 4, true).toString(16)}`);
            } catch {}
        }
        refs.push(pieces.join(' '));
        if (refs.length >= 32) break;
    }

    const ebp = (ctx.ebp ?? 0) >>> 0;
    return refs.length ? `esp=0x${esp.toString(16)} ebp=0x${ebp.toString(16)} ${refs.join(' ')}` : '';
}

function formatGuestZFreeStackWindows(ctx: { esp?: number }, mem: Uint8Array, maxBytes = 0x800): string {
    const registry = System.getInstance().process?.moduleRegistry;
    const esp = (ctx.esp ?? 0) >>> 0;
    if (!esp || esp + 4 > mem.length) return '';

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const end = Math.min(mem.length, esp + maxBytes);
    const centers: number[] = [];

    const readAscii = (ptr: number, maxLen = 24): string => {
        if (!ptr || ptr >= mem.length) return '';
        let out = '';
        for (let i = 0; i < maxLen && ptr + i < mem.length; i++) {
            const c = mem[ptr + i];
            if (c === 0) break;
            if (c < 0x20 || c > 0x7e) return '';
            out += String.fromCharCode(c);
        }
        return out;
    };

    const describe = (value: number): string => {
        const parts = [`0x${value.toString(16)}`];
        const mod = registry?.getModuleContainingAddress(value);
        if (mod) parts.push(`${mod.name}+0x${((value - mod.baseAddress) >>> 0).toString(16)}`);
        const ascii = readAscii(value);
        if (ascii.length >= 4) parts.push(`"${ascii.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
        return parts.length > 1 ? `${parts[0]}(${parts.slice(1).join(',')})` : parts[0];
    };

    for (let ptr = esp; ptr + 4 <= end; ptr += 4) {
        const value = view.getUint32(ptr, true) >>> 0;
        if (readAscii(value).startsWith('Z_Free: bad magic')) {
            centers.push(ptr);
        }
        if (centers.length >= 4) break;
    }

    const windows: string[] = [];
    for (const center of centers) {
        const start = Math.max(esp, center - 10 * 4);
        const stop = Math.min(end, center + 10 * 4);
        const slots: string[] = [];
        for (let ptr = start; ptr <= stop && ptr + 4 <= mem.length; ptr += 4) {
            const marker = ptr === center ? '*' : '';
            slots.push(`${marker}[+0x${(ptr - esp).toString(16)}]=${describe(view.getUint32(ptr, true) >>> 0)}`);
        }
        windows.push(`center=+0x${(center - esp).toString(16)} ${slots.join(' ')}`);
    }

    return windows.join(' | ');
}

function formatQuake2ZFreeLiteralXrefs(mem: Uint8Array): string {
    const registry = System.getInstance().process?.moduleRegistry;
    const exe = registry?.getExecutableModule();
    if (!exe) return '';

    const needle = 'Z_Free: bad magic';
    const needleBytes = Array.from(needle, ch => ch.charCodeAt(0));
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    const sectionEnd = (rva: number, size: number): number =>
        Math.min(mem.length, exe.baseAddress + rva + size);

    const stringAddrs: number[] = [];
    for (const sec of exe.sections ?? []) {
        const start = exe.baseAddress + sec.virtualAddress;
        const end = sectionEnd(sec.virtualAddress, Math.max(sec.virtualSize, sec.rawSize));
        for (let ptr = start; ptr + needleBytes.length < end; ptr++) {
            let ok = true;
            for (let i = 0; i < needleBytes.length; i++) {
                if (mem[ptr + i] !== needleBytes[i]) {
                    ok = false;
                    break;
                }
            }
            if (ok && mem[ptr + needleBytes.length] === 0) {
                stringAddrs.push(ptr >>> 0);
            }
        }
    }

    const IMAGE_SCN_MEM_EXECUTE = 0x20000000;
    const hexAround = (addr: number): string => {
        const start = Math.max(exe.baseAddress, addr - 8);
        const end = Math.min(mem.length, addr + 12);
        const bytes: string[] = [];
        for (let p = start; p < end; p++) {
            bytes.push(mem[p].toString(16).padStart(2, '0'));
        }
        return bytes.join('');
    };
    const findEntryCandidates = (addr: number): string => {
        const lo = Math.max(exe.baseAddress, addr - 0x120);
        const candidates: string[] = [];
        const add = (label: string, at: number): void => {
            candidates.push(`${label}=quake2+0x${(at - exe.baseAddress).toString(16)} bytes=${hexAround(at)}`);
        };

        for (let p = addr; p >= lo; p--) {
            if (p + 3 <= mem.length && mem[p] === 0x55 && mem[p + 1] === 0x8b && mem[p + 2] === 0xec) {
                add('ebp', p);
                break;
            }
        }
        for (let p = addr; p >= lo; p--) {
            if (p + 5 <= mem.length &&
                mem[p] === 0x56 && mem[p + 1] === 0x8b && mem[p + 2] === 0x74 &&
                mem[p + 3] === 0x24 && mem[p + 4] === 0x08) {
                add('frameless_esi_arg0', p);
                break;
            }
        }
        for (let p = addr; p >= lo; p--) {
            if (p + 4 <= mem.length &&
                mem[p] === 0x8b && mem[p + 1] === 0x44 && mem[p + 2] === 0x24 && mem[p + 3] === 0x04) {
                add('frameless_eax_arg0', p);
                break;
            }
        }

        return candidates.length ? candidates.join(',') : 'entry=<none>';
    };

    const rows: string[] = [];
    for (const strAddr of stringAddrs) {
        let hits = 0;
        for (const sec of exe.sections ?? []) {
            if ((sec.characteristics & IMAGE_SCN_MEM_EXECUTE) === 0) continue;
            const start = exe.baseAddress + sec.virtualAddress;
            const end = sectionEnd(sec.virtualAddress, Math.max(sec.virtualSize, sec.rawSize));
            for (let ptr = start; ptr + 4 <= end; ptr++) {
                if ((view.getUint32(ptr, true) >>> 0) !== strAddr) continue;
                const instr = ptr > 0 && mem[ptr - 1] === 0x68 ? ptr - 1 : ptr;
                rows.push(`str=quake2+0x${(strAddr - exe.baseAddress).toString(16)} xref=quake2+0x${(instr - exe.baseAddress).toString(16)} immAt=+0x${(ptr - exe.baseAddress).toString(16)} ${findEntryCandidates(instr)} bytes=${hexAround(instr)}`);
                hits++;
                if (hits >= 12) break;
            }
            if (hits >= 12) break;
        }
        if (hits === 0) {
            rows.push(`str=quake2+0x${(strAddr - exe.baseAddress).toString(16)} xref=<none>`);
        }
    }

    return rows.join(' | ');
}

export function registerMessageBoxExports(exports: Record<string, ThunkImplementation>): void {
    exports['MessageBoxA'] = async (ctx, mem, args) => {
        const lpText = args[1];
        const lpCaption = args[2];
        const uType = args[3];

        const text = lpText ? Marshaler.readString(mem, lpText) : '';
        const caption = lpCaption ? Marshaler.readString(mem, lpCaption) : 'Message';

        // Log with emoji for Smacker version errors
        const isSmackerError = text.toLowerCase().includes('smacker') ||
            text.toLowerCase().includes('mss') ||
            caption.toLowerCase().includes('error');
        if (isSmackerError) {
            Logger.log(LogCategory.USER32, `MessageBoxA error: "${caption}" - "${text}"`);
            const stackRefs = formatGuestStackCodeRefs(ctx, mem);
            if (stackRefs) {
                Logger.log(LogCategory.USER32, `MessageBoxA stack: ${stackRefs}`);
            }
            const rawStack = formatGuestStackRaw(ctx, mem);
            if (rawStack) {
                Logger.log(LogCategory.USER32, `MessageBoxA raw stack: ${rawStack}`);
            }
            Logger.log(LogCategory.USER32, `MessageBoxA regs: ${formatGuestRegisters(ctx)}`);
            const ebpChain = formatGuestEbpChain(ctx, mem);
            if (ebpChain) {
                Logger.log(LogCategory.USER32, `MessageBoxA ebp chain: ${ebpChain}`);
            }
            if (text.includes('Z_Free: bad magic')) {
                const dataRefs = formatGuestStackDataPointers(ctx, mem);
                if (dataRefs) {
                    Logger.log(LogCategory.USER32, `MessageBoxA q2 data stack refs: ${dataRefs}`);
                }
                const zfreeWindows = formatGuestZFreeStackWindows(ctx, mem);
                if (zfreeWindows) {
                    Logger.log(LogCategory.USER32, `MessageBoxA zfree stack windows: ${zfreeWindows}`);
                }
                const zfreeXrefs = formatQuake2ZFreeLiteralXrefs(mem);
                if (zfreeXrefs) {
                    Logger.log(LogCategory.USER32, `MessageBoxA zfree literal xrefs: ${zfreeXrefs}`);
                }
            }
        } else {
            Logger.log(LogCategory.USER32, `MessageBoxA: ${caption} - ${text}`);
        }

        const result = await requestMessageBox(text, caption, uType);
        return { value: result, stackCleanup: 16 };
    };

    exports['MessageBoxW'] = async (ctx, mem, args) => {
        const lpText = args[1];
        const lpCaption = args[2];
        const uType = args[3];

        const text = lpText ? Marshaler.readWideString(mem, lpText) : '';
        const caption = lpCaption ? Marshaler.readWideString(mem, lpCaption) : 'Message';

        Logger.log(LogCategory.USER32, `MessageBoxW: ${caption} - ${text}`);
        const result = await requestMessageBox(text, caption, uType);
        return { value: result, stackCleanup: 16 };
    };

    // MessageBoxEx* is MessageBox* with a trailing wLanguageId. We render one UI in the
    // host's own locale, so the id only selects which resource strings USER would have
    // used for the buttons — everything else, including the stack layout up to arg 3, is
    // identical. Chain rather than duplicate: an unimplemented MessageBoxEx returns
    // ERROR_NOT_SUPPORTED as if the user had clicked a button that does not exist.
    exports['MessageBoxExA'] = async (ctx, mem, args) => {
        const r = await (exports['MessageBoxA'] as (c: unknown, m: Uint8Array, a: number[]) => Promise<{ value: number }>)(ctx, mem, args);
        return { value: r.value, stackCleanup: 20 };
    };

    exports['MessageBoxExW'] = async (ctx, mem, args) => {
        const r = await (exports['MessageBoxW'] as (c: unknown, m: Uint8Array, a: number[]) => Promise<{ value: number }>)(ctx, mem, args);
        return { value: r.value, stackCleanup: 20 };
    };

    exports['MessageBoxIndirectA'] = async (ctx, mem, args) => {
        const lpmbp = args[0];
        if (!lpmbp || lpmbp + 40 > mem.length) {
            return { value: 0, stackCleanup: 4 }; // IDOK fallback
        }
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const cbSize = view.getUint32(lpmbp, true);
        if (cbSize < 20) {
            return { value: 0, stackCleanup: 4 };
        }
        const lpszText = view.getUint32(lpmbp + 12, true);
        const lpszCaption = view.getUint32(lpmbp + 16, true);
        const dwStyle = view.getUint32(lpmbp + 20, true);

        const text = lpszText ? Marshaler.readString(mem, lpszText) : '';
        const caption = lpszCaption ? Marshaler.readString(mem, lpszCaption) : 'Message';

        Logger.log(LogCategory.USER32, `MessageBoxIndirectA: ${caption} - ${text}`);
        const result = await requestMessageBox(text, caption, dwStyle);
        return { value: result, stackCleanup: 4 };
    };

    exports['MessageBoxIndirectW'] = async (ctx, mem, args) => {
        const lpmbp = args[0];
        if (!lpmbp || lpmbp + 40 > mem.length) {
            return { value: 0, stackCleanup: 4 };
        }
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const cbSize = view.getUint32(lpmbp, true);
        if (cbSize < 20) {
            return { value: 0, stackCleanup: 4 };
        }
        const lpszText = view.getUint32(lpmbp + 12, true);
        const lpszCaption = view.getUint32(lpmbp + 16, true);
        const dwStyle = view.getUint32(lpmbp + 20, true);

        const text = lpszText ? Marshaler.readWideString(mem, lpszText) : '';
        const caption = lpszCaption ? Marshaler.readWideString(mem, lpszCaption) : 'Message';

        Logger.log(LogCategory.USER32, `MessageBoxIndirectW: ${caption} - ${text}`);
        const result = await requestMessageBox(text, caption, dwStyle);
        return { value: result, stackCleanup: 4 };
    };
}
