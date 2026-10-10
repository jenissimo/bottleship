import { Mem } from '../../core/memory/mem-accessor';
import { System } from '../../core/system';
import type { X86Context, ThunkResult } from '../../core/thunking/thunk-dispatcher';
import { decodeAnsiString, encodeAnsi, getAnsiCodePage } from '../codepage-utils';
import { ANSI_CHARSET, DEFAULT_CHARSET, fontSignature, systemDefaultCharset } from './font-charset';
import { bundledFontFamilies, resolveWindowsFontName } from './font-map';
import { registeredFontFamilies } from './font-resource';

const STYLES = [
    { name: 'Regular', weight: 400, italic: false },
    { name: 'Bold', weight: 700, italic: false },
    { name: 'Italic', weight: 400, italic: true },
    { name: 'Bold Italic', weight: 700, italic: true },
];

function readFace(ptr: number, wide: boolean, chars = 32): string {
    const bytes = Mem.readBytes(ptr, chars * (wide ? 2 : 1));
    if (!bytes) return '';
    if (!wide) return decodeAnsiString(bytes, 0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0), getAnsiCodePage());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let text = '';
    for (let i = 0; i < chars; i++) {
        const unit = view.getUint16(i * 2, true);
        if (!unit) break;
        text += String.fromCharCode(unit);
    }
    return text;
}

function writeName(bytes: Uint8Array, offset: number, chars: number, text: string, wide: boolean): void {
    if (!wide) {
        bytes.set(encodeAnsi(text).subarray(0, chars - 1), offset);
        return;
    }
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < Math.min(chars - 1, text.length); i++) view.setUint16(offset + i * 2, text.charCodeAt(i), true);
}

/** Enumeration owns a suspended stdcall frame until the last guest FONTENUMPROC returns. */
export function enumerateFontFamilies(ctx: X86Context, args: number[], wide: boolean, extended: boolean): number | ThunkResult {
    const system = System.getInstance();
    const process = system.process;
    const callbackManager = process?.dispatcher.callbackManager;
    const dc = system.gdiContext.getDC(args[0]);
    if (!process || !callbackManager || !dc || !args[2] || (extended && (!args[1] || args[4]))) return 0;
    const logfontBytes = wide ? 92 : 60;
    if (extended && !Mem.readBytes(args[1], logfontBytes)) return 0;
    const requested = args[1] ? readFace(args[1] + (extended ? 28 : 0), wide) : '';
    const charset = extended ? Mem.readUint8(args[1] + 23) ?? DEFAULT_CHARSET : DEFAULT_CHARSET;
    const supportedCharsets = [...new Set([ANSI_CHARSET, systemDefaultCharset()])];
    if (charset !== DEFAULT_CHARSET && !supportedCharsets.includes(charset)) return 0;
    const families = [...new Map([...bundledFontFamilies(), ...registeredFontFamilies()]
        .map(name => [name.toLowerCase(), name])).values()]
        .filter(name => !requested || name.toLowerCase() === requested.toLowerCase());
    if (!families.length) return 0;
    const charsets = charset === DEFAULT_CHARSET ? supportedCharsets : [charset];
    const entries = families.flatMap(family => (extended || requested ? STYLES : STYLES.slice(0, 1))
        .flatMap(style => (extended ? charsets : charsets.slice(0, 1)).map(charset => ({ family, style, charset }))));
    const enumSize = wide ? 348 : 188;
    const ntmSize = wide ? 76 : 72;
    const records = entries.map(entry => {
        const bytes = new Uint8Array(enumSize + ntmSize + 24);
        const view = new DataView(bytes.buffer);
        const fixed = /mono/i.test(resolveWindowsFontName(entry.family));
        const previousFont = dc.font;
        dc.font = `${entry.style.italic ? 'italic ' : ''}${entry.style.weight} 16px "${resolveWindowsFontName(entry.family)}"`;
        const m = dc.measureText('ABCgjpqy');
        const ascent = Math.ceil(m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent);
        const descent = Math.ceil(m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent);
        const average = Math.round(dc.measureText('x').width);
        const maxWidth = Math.round(dc.measureText('W').width);
        dc.font = previousFont;
        const height = ascent + descent;
        view.setInt32(0, height, true);
        view.setInt32(16, entry.style.weight, true);
        bytes[20] = +entry.style.italic;
        bytes[23] = entry.charset;
        bytes[24] = 4; // OUT_TT_PRECIS
        bytes[27] = (fixed ? 0x30 | 1 : 0x20 | 2);
        writeName(bytes, 28, 32, entry.family, wide);
        const unit = wide ? 2 : 1;
        writeName(bytes, logfontBytes, 64, entry.family + (entry.style.name === 'Regular' ? '' : ` ${entry.style.name}`), wide);
        writeName(bytes, logfontBytes + 64 * unit, 32, entry.style.name, wide);
        writeName(bytes, logfontBytes + 96 * unit, 32, entry.charset === 204 ? 'Cyrillic' : 'Western', wide);
        const fields = [height, ascent, descent, 0, 0, average, maxWidth, entry.style.weight, 0, 96, 96];
        fields.forEach((value, i) => view.setInt32(enumSize + i * 4, value, true));
        for (const [i, value] of [32, 255, 63, 32].entries()) {
            if (wide) view.setUint16(enumSize + 44 + i * 2, value, true);
            else bytes[enumSize + 44 + i] = value;
        }
        const attr = enumSize + (wide ? 52 : 48);
        bytes[attr] = +entry.style.italic;
        bytes[attr + 3] = fixed ? 0x36 : 0x27;
        bytes[attr + 4] = entry.charset;
        const tail = enumSize + (wide ? 60 : 56);
        view.setUint32(tail, (entry.style.italic ? 1 : 0) | (entry.style.weight >= 700 ? 32 : 0) | (entry.style.name === 'Regular' ? 256 : 0), true);
        view.setUint32(tail + 4, 16, true);
        view.setUint32(tail + 8, height, true);
        view.setUint32(tail + 12, average, true);
        fontSignature(entry.charset).forEach((value, i) => view.setUint32(enumSize + ntmSize + i * 4, value, true));
        return bytes;
    });
    const allocation = process.memory.alloc(enumSize + ntmSize + 24);
    if (!allocation) return 0;
    const metricsPtr = allocation + enumSize;
    const cleanup = extended ? 20 : 16;
    const source = extended ? `EnumFontFamiliesEx${wide ? 'W' : 'A'}` : 'EnumFontFamiliesA';
    const frameId = callbackManager.saveSuspendedThunkContext(ctx, cleanup, source);
    if (!frameId) { process.memory.free(allocation); return 0; }
    let index = 0;
    let firstCallbackId = 0;
    const invokeNext = (): void => {
        Mem.writeBytes(allocation, records[index++]);
        const result = callbackManager.invokeCallback(args[2], [allocation, metricsPtr, 4, args[3]], 0, ret => {
            if (!ret || index === entries.length) { process.memory.free(allocation); return ret; }
            return null;
        }, false, source, frameId);
        if (!firstCallbackId) firstCallbackId = result.callbackId;
        const callback = callbackManager.getPendingCallback(result.callbackId);
        if (callback) callback.enumerationState = { continueEnumeration: invokeNext, finishEnumeration: () => {} };
    };
    invokeNext();
    if (!firstCallbackId) {
        process.memory.free(allocation);
        callbackManager.abandonSuspendedFrame(frameId);
        return 0;
    }
    return { value: 0, callbackId: firstCallbackId, suspendedForCallback: true, stackCleanup: cleanup, skipStackCheck: true };
}
