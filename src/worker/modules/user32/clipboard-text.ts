/**
 * Text access to the user32 clipboard for the control classes that need it
 * (EDIT's WM_COPY/WM_CUT/WM_PASTE).
 *
 * The store is the clipboard map system.ts publishes: format → guest HGLOBAL. Text
 * therefore has to live in GUEST memory, allocated exactly the way Wine's
 * EDIT_WM_Copy does it (GlobalAlloc(GMEM_MOVEABLE|GMEM_DDESHARE)), or a guest that
 * GlobalLocks what GetClipboardData handed it gets ERROR_INVALID_HANDLE.
 */

import { Mem } from '../../core/memory/mem-accessor';
import { Marshaler } from '../../core/memory/marshaler';
import { exports as kernel32Memory } from '../kernel32/memory';
import { encodeAnsi, readAnsiFromGuest } from '../codepage-utils';
import {
    clipboardDataByFormat,
    openClipboard,
    closeClipboard,
    emptyClipboard,
} from './shared-state';

const CF_TEXT = 1;
const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x0002;
const GMEM_DDESHARE = 0x2000;

// The Global* thunks ignore their CPU context; they only need mem + args.
const NO_CTX = {} as Parameters<NonNullable<(typeof kernel32Memory)['GlobalAlloc']>>[0];

function globalAlloc(mem: Uint8Array, bytes: number): number {
    return (kernel32Memory['GlobalAlloc']?.(NO_CTX, mem, [GMEM_MOVEABLE | GMEM_DDESHARE, bytes]) ?? 0) as number;
}

function globalLock(mem: Uint8Array, hMem: number): number {
    return (kernel32Memory['GlobalLock']?.(NO_CTX, mem, [hMem]) ?? 0) as number;
}

function globalUnlock(mem: Uint8Array, hMem: number): void {
    kernel32Memory['GlobalUnlock']?.(NO_CTX, mem, [hMem]);
}

/** Publish `text` as the clipboard's text content (Wine EDIT_WM_Copy sequence). */
export function setClipboardText(mem: Uint8Array, owner: number, text: string): boolean {
    const wide = new Uint8Array((text.length + 1) * 2);
    const wideView = new DataView(wide.buffer);
    for (let i = 0; i < text.length; i++) wideView.setUint16(i * 2, text.charCodeAt(i), true);
    const ansi = encodeAnsi(text);

    const hWide = globalAlloc(mem, wide.length);
    const hAnsi = globalAlloc(mem, ansi.length + 1);
    if (!hWide || !hAnsi) return false;

    const pWide = globalLock(mem, hWide);
    const pAnsi = globalLock(mem, hAnsi);
    if (!pWide || !pAnsi) return false;
    Mem.writeBytes(pWide, wide);
    Mem.writeBytes(pAnsi, ansi);
    Mem.writeUint8(pAnsi + ansi.length, 0);
    globalUnlock(mem, hWide);
    globalUnlock(mem, hAnsi);

    if (!openClipboard(owner)) return false;
    emptyClipboard();
    // Windows SYNTHESIZES the other charset on demand; our clipboard is a plain
    // format→handle map, so both charsets are published up front instead.
    clipboardDataByFormat.set(CF_UNICODETEXT, hWide);
    clipboardDataByFormat.set(CF_TEXT, hAnsi);
    closeClipboard();
    return true;
}

/** Clipboard text, or null when the clipboard holds no text format. */
export function getClipboardText(mem: Uint8Array): string | null {
    for (const format of [CF_UNICODETEXT, CF_TEXT]) {
        const handle = clipboardDataByFormat.get(format) ?? 0;
        if (!handle) continue;
        const ptr = globalLock(mem, handle);
        if (!ptr) continue;
        const text = format === CF_UNICODETEXT
            ? Marshaler.readWideString(mem, ptr)
            : readAnsiFromGuest(mem, ptr);
        globalUnlock(mem, handle);
        return text;
    }
    return null;
}
