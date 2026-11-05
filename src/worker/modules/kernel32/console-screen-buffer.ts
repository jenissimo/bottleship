/**
 * In-memory Win32 console screen buffer (CHAR_INFO grid).
 * Headless emulator: no host console window, but API semantics are faithful.
 */

import { Logger, LogCategory } from '../../core/logger';

export const STD_INPUT_HANDLE = -10;
export const STD_OUTPUT_HANDLE = -11;
export const STD_ERROR_HANDLE = -12;

const CHAR_INFO_SIZE = 4; // WCHAR/AnsiChar (2) + Attributes (2)
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 25;
const DEFAULT_ATTR = 0x0007; // gray on black

export interface SmallRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface Coord {
    x: number;
    y: number;
}

function clampCoord(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v | 0));
}

function readCoord(mem: Uint8Array, addr: number): Coord {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    return {
        x: view.getInt16(addr, true),
        y: view.getInt16(addr + 2, true),
    };
}

function readSmallRect(mem: Uint8Array, addr: number): SmallRect {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    return {
        left: view.getInt16(addr, true),
        top: view.getInt16(addr + 2, true),
        right: view.getInt16(addr + 4, true),
        bottom: view.getInt16(addr + 6, true),
    };
}

function writeCharInfo(mem: Uint8Array, addr: number, ch: number, attr: number): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint16(addr, ch & 0xffff, true);
    view.setUint16(addr + 2, attr & 0xffff, true);
}

function readCharInfo(mem: Uint8Array, addr: number): { ch: number; attr: number } {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    return {
        ch: view.getUint16(addr, true),
        attr: view.getUint16(addr + 2, true),
    };
}

export interface ConsoleBufferState {
    cols: number; rows: number; cursor: Coord; attributes: number; window: SmallRect;
    chars: Uint16Array; attrs: Uint16Array;
}

export class ConsoleScreenBuffer {
    cols: number;
    rows: number;
    cursor: Coord = { x: 0, y: 0 };
    attributes = DEFAULT_ATTR;
    window: SmallRect;
    private chars: Uint16Array;
    private attrs: Uint16Array;

    constructor(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
        this.cols = cols;
        this.rows = rows;
        this.chars = new Uint16Array(cols * rows);
        this.attrs = new Uint16Array(cols * rows);
        this.chars.fill(0x20); // space
        this.attrs.fill(DEFAULT_ATTR);
        this.window = { left: 0, top: 0, right: cols - 1, bottom: rows - 1 };
    }

    captureState(): ConsoleBufferState {
        return {
            cols: this.cols, rows: this.rows, cursor: { ...this.cursor }, attributes: this.attributes,
            window: { ...this.window }, chars: this.chars.slice(), attrs: this.attrs.slice(),
        };
    }

    static fromState(state: ConsoleBufferState): ConsoleScreenBuffer {
        const buffer = new ConsoleScreenBuffer(state.cols, state.rows);
        buffer.cursor = { ...state.cursor };
        buffer.attributes = state.attributes;
        buffer.window = { ...state.window };
        buffer.chars = state.chars.slice();
        buffer.attrs = state.attrs.slice();
        return buffer;
    }

    private idx(x: number, y: number): number {
        return y * this.cols + x;
    }

    private inBounds(x: number, y: number): boolean {
        return x >= 0 && x < this.cols && y >= 0 && y < this.rows;
    }

    fillScreenBufferInfo(mem: Uint8Array, lpInfo: number): void {
        if (lpInfo + 22 > mem.length) return;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setInt16(lpInfo + 0, this.cols, true);
        view.setInt16(lpInfo + 2, this.rows, true);
        view.setInt16(lpInfo + 4, this.cursor.x, true);
        view.setInt16(lpInfo + 6, this.cursor.y, true);
        view.setUint16(lpInfo + 8, this.attributes, true);
        view.setInt16(lpInfo + 10, this.window.left, true);
        view.setInt16(lpInfo + 12, this.window.top, true);
        view.setInt16(lpInfo + 14, this.window.right, true);
        view.setInt16(lpInfo + 16, this.window.bottom, true);
        view.setInt16(lpInfo + 18, this.cols, true);
        view.setInt16(lpInfo + 20, this.rows, true);
    }

    writeCharactersA(mem: Uint8Array, lpChars: number, length: number, coord: Coord): number {
        let written = 0;
        let x = coord.x;
        let y = coord.y;
        for (let i = 0; i < length; i++) {
            const ch = mem[lpChars + i] ?? 0;
            if (ch === 0) break;
            if (this.inBounds(x, y)) {
                const idx = this.idx(x, y);
                this.chars[idx] = ch;
                this.attrs[idx] = this.attributes;
            }
            written++;
            x++;
            if (x >= this.cols) {
                x = 0;
                y++;
            }
        }
        return written;
    }

    writeCharactersW(mem: Uint8Array, lpChars: number, length: number, coord: Coord): number {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let written = 0;
        let x = coord.x;
        let y = coord.y;
        for (let i = 0; i < length; i++) {
            const off = lpChars + i * 2;
            if (off + 1 >= mem.length) break;
            const ch = view.getUint16(off, true);
            if (ch === 0) break;
            if (this.inBounds(x, y)) {
                const idx = this.idx(x, y);
                this.chars[idx] = ch;
                this.attrs[idx] = this.attributes;
            }
            written++;
            x++;
            if (x >= this.cols) {
                x = 0;
                y++;
            }
        }
        return written;
    }

    writeAttributes(coord: Coord, length: number, attr: number): number {
        let written = 0;
        let x = coord.x;
        let y = coord.y;
        for (let i = 0; i < length; i++) {
            if (this.inBounds(x, y)) {
                this.attrs[this.idx(x, y)] = attr & 0xffff;
            }
            written++;
            x++;
            if (x >= this.cols) {
                x = 0;
                y++;
            }
        }
        return written;
    }

    fillCharacter(ch: number, length: number, coord: Coord): number {
        let written = 0;
        let x = coord.x;
        let y = coord.y;
        for (let i = 0; i < length; i++) {
            if (this.inBounds(x, y)) {
                const idx = this.idx(x, y);
                this.chars[idx] = ch & 0xffff;
                this.attrs[idx] = this.attributes;
            }
            written++;
            x++;
            if (x >= this.cols) {
                x = 0;
                y++;
            }
        }
        return written;
    }

    fillAttribute(attr: number, length: number, coord: Coord): number {
        let written = 0;
        let x = coord.x;
        let y = coord.y;
        for (let i = 0; i < length; i++) {
            if (this.inBounds(x, y)) {
                this.attrs[this.idx(x, y)] = attr & 0xffff;
            }
            written++;
            x++;
            if (x >= this.cols) {
                x = 0;
                y++;
            }
        }
        return written;
    }

    readOutputA(
        mem: Uint8Array,
        lpBuffer: number,
        bufferSize: Coord,
        bufferCoord: Coord,
        readRegion: SmallRect,
    ): boolean {
        const width = bufferSize.x;
        const height = bufferSize.y;
        if (width <= 0 || height <= 0) return true;

        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const srcX = readRegion.left + col;
                const srcY = readRegion.top + row;
                const dstOff = lpBuffer + ((bufferCoord.y + row) * width + (bufferCoord.x + col)) * CHAR_INFO_SIZE;
                if (dstOff + CHAR_INFO_SIZE > mem.length) return false;

                let ch = 0x20;
                let attr = DEFAULT_ATTR;
                if (this.inBounds(srcX, srcY)) {
                    const idx = this.idx(srcX, srcY);
                    ch = this.chars[idx] & 0xff;
                    attr = this.attrs[idx];
                }
                writeCharInfo(mem, dstOff, ch, attr);
            }
        }
        return true;
    }

    readOutputW(
        mem: Uint8Array,
        lpBuffer: number,
        bufferSize: Coord,
        bufferCoord: Coord,
        readRegion: SmallRect,
    ): boolean {
        const width = bufferSize.x;
        const height = bufferSize.y;
        if (width <= 0 || height <= 0) return true;

        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const srcX = readRegion.left + col;
                const srcY = readRegion.top + row;
                const dstOff = lpBuffer + ((bufferCoord.y + row) * width + (bufferCoord.x + col)) * CHAR_INFO_SIZE;
                if (dstOff + CHAR_INFO_SIZE > mem.length) return false;

                let ch = 0x20;
                let attr = DEFAULT_ATTR;
                if (this.inBounds(srcX, srcY)) {
                    const idx = this.idx(srcX, srcY);
                    ch = this.chars[idx];
                    attr = this.attrs[idx];
                }
                writeCharInfo(mem, dstOff, ch, attr);
            }
        }
        return true;
    }

    writeOutputA(
        mem: Uint8Array,
        lpBuffer: number,
        bufferSize: Coord,
        bufferCoord: Coord,
        writeRegion: SmallRect,
    ): boolean {
        const width = bufferSize.x;
        const height = bufferSize.y;
        if (width <= 0 || height <= 0) return true;

        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const dstX = writeRegion.left + col;
                const dstY = writeRegion.top + row;
                const srcOff = lpBuffer + ((bufferCoord.y + row) * width + (bufferCoord.x + col)) * CHAR_INFO_SIZE;
                if (srcOff + CHAR_INFO_SIZE > mem.length) return false;
                if (!this.inBounds(dstX, dstY)) continue;
                const { ch, attr } = readCharInfo(mem, srcOff);
                const idx = this.idx(dstX, dstY);
                this.chars[idx] = ch & 0xff;
                this.attrs[idx] = attr;
            }
        }
        return true;
    }

    writeOutputW(
        mem: Uint8Array,
        lpBuffer: number,
        bufferSize: Coord,
        bufferCoord: Coord,
        writeRegion: SmallRect,
    ): boolean {
        const width = bufferSize.x;
        const height = bufferSize.y;
        if (width <= 0 || height <= 0) return true;

        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const dstX = writeRegion.left + col;
                const dstY = writeRegion.top + row;
                const srcOff = lpBuffer + ((bufferCoord.y + row) * width + (bufferCoord.x + col)) * CHAR_INFO_SIZE;
                if (srcOff + CHAR_INFO_SIZE > mem.length) return false;
                if (!this.inBounds(dstX, dstY)) continue;
                const { ch, attr } = readCharInfo(mem, srcOff);
                const idx = this.idx(dstX, dstY);
                this.chars[idx] = ch;
                this.attrs[idx] = attr;
            }
        }
        return true;
    }

    scroll(
        scrollRect: SmallRect | null,
        clipRect: SmallRect | null,
        destOrigin: Coord,
        fillCh: number,
        fillAttr: number,
    ): void {
        const src = scrollRect ?? { left: 0, top: 0, right: this.cols - 1, bottom: this.rows - 1 };
        const clip = clipRect ?? { left: 0, top: 0, right: this.cols - 1, bottom: this.rows - 1 };
        const width = src.right - src.left + 1;
        const height = src.bottom - src.top + 1;
        if (width <= 0 || height <= 0) return;

        const copyChars = new Uint16Array(width * height);
        const copyAttrs = new Uint16Array(width * height);
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const sx = src.left + col;
                const sy = src.top + row;
                const i = row * width + col;
                if (this.inBounds(sx, sy)) {
                    const idx = this.idx(sx, sy);
                    copyChars[i] = this.chars[idx];
                    copyAttrs[i] = this.attrs[idx];
                } else {
                    copyChars[i] = 0x20;
                    copyAttrs[i] = fillAttr;
                }
            }
        }

        const dx = destOrigin.x - src.left;
        const dy = destOrigin.y - src.top;

        // Clear source region inside clip
        for (let y = src.top; y <= src.bottom; y++) {
            for (let x = src.left; x <= src.right; x++) {
                if (x < clip.left || x > clip.right || y < clip.top || y > clip.bottom) continue;
                if (!this.inBounds(x, y)) continue;
                const idx = this.idx(x, y);
                this.chars[idx] = fillCh & 0xffff;
                this.attrs[idx] = fillAttr & 0xffff;
            }
        }

        // Blit scrolled content
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const dxPos = src.left + col + dx;
                const dyPos = src.top + row + dy;
                if (dxPos < clip.left || dxPos > clip.right || dyPos < clip.top || dyPos > clip.bottom) continue;
                if (!this.inBounds(dxPos, dyPos)) continue;
                const i = row * width + col;
                const idx = this.idx(dxPos, dyPos);
                this.chars[idx] = copyChars[i];
                this.attrs[idx] = copyAttrs[i];
            }
        }
    }

    readCharactersA(mem: Uint8Array, lpBuffer: number, length: number, coord: Coord): number {
        let read = 0;
        let x = coord.x;
        let y = coord.y;
        for (let i = 0; i < length; i++) {
            let ch = 0x20;
            if (this.inBounds(x, y)) {
                ch = this.chars[this.idx(x, y)] & 0xff;
            }
            if (lpBuffer + i >= mem.length) break;
            mem[lpBuffer + i] = ch & 0xff;
            read++;
            x++;
            if (x >= this.cols) {
                x = 0;
                y++;
            }
        }
        return read;
    }

    readCharactersW(mem: Uint8Array, lpBuffer: number, length: number, coord: Coord): number {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let read = 0;
        let x = coord.x;
        let y = coord.y;
        for (let i = 0; i < length; i++) {
            const off = lpBuffer + i * 2;
            if (off + 1 >= mem.length) break;
            let ch = 0x20;
            if (this.inBounds(x, y)) {
                ch = this.chars[this.idx(x, y)];
            }
            view.setUint16(off, ch, true);
            read++;
            x++;
            if (x >= this.cols) {
                x = 0;
                y++;
            }
        }
        return read;
    }

    readAttributes(mem: Uint8Array, lpBuffer: number, length: number, coord: Coord): number {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let read = 0;
        let x = coord.x;
        let y = coord.y;
        for (let i = 0; i < length; i++) {
            const off = lpBuffer + i * 2;
            if (off + 1 >= mem.length) break;
            let attr = DEFAULT_ATTR;
            if (this.inBounds(x, y)) {
                attr = this.attrs[this.idx(x, y)];
            }
            view.setUint16(off, attr, true);
            read++;
            x++;
            if (x >= this.cols) {
                x = 0;
                y++;
            }
        }
        return read;
    }

    setCursorPosition(coord: Coord): void {
        this.cursor = {
            x: clampCoord(coord.x, 0, this.cols - 1),
            y: clampCoord(coord.y, 0, this.rows - 1),
        };
    }

    setScreenBufferSize(cols: number, rows: number): void {
        const newCols = Math.max(1, cols | 0);
        const newRows = Math.max(1, rows | 0);
        const newChars = new Uint16Array(newCols * newRows);
        const newAttrs = new Uint16Array(newCols * newRows);
        newChars.fill(0x20);
        newAttrs.fill(DEFAULT_ATTR);
        const copyCols = Math.min(this.cols, newCols);
        const copyRows = Math.min(this.rows, newRows);
        for (let y = 0; y < copyRows; y++) {
            for (let x = 0; x < copyCols; x++) {
                const oldIdx = this.idx(x, y);
                const newIdx = y * newCols + x;
                newChars[newIdx] = this.chars[oldIdx];
                newAttrs[newIdx] = this.attrs[oldIdx];
            }
        }
        this.cols = newCols;
        this.rows = newRows;
        this.chars = newChars;
        this.attrs = newAttrs;
        this.window = { left: 0, top: 0, right: newCols - 1, bottom: newRows - 1 };
        this.cursor.x = clampCoord(this.cursor.x, 0, newCols - 1);
        this.cursor.y = clampCoord(this.cursor.y, 0, newRows - 1);
    }
}

class ConsoleScreenBufferManager {
    private defaultBuffer = new ConsoleScreenBuffer();
    private extraBuffers = new Map<number, ConsoleScreenBuffer>();
    private nextHandle = 0x10000;

    reset(): void {
        this.defaultBuffer = new ConsoleScreenBuffer();
        this.extraBuffers.clear();
        this.nextHandle = 0x10000;
    }

    captureState(): { default: ConsoleBufferState; extra: Array<[number, ConsoleBufferState]>; nextHandle: number } {
        return {
            default: this.defaultBuffer.captureState(),
            extra: [...this.extraBuffers].map(([h, b]) => [h, b.captureState()]),
            nextHandle: this.nextHandle,
        };
    }

    restoreState(state: { default: ConsoleBufferState; extra: Array<[number, ConsoleBufferState]>; nextHandle: number }): void {
        this.defaultBuffer = ConsoleScreenBuffer.fromState(state.default);
        this.extraBuffers = new Map(state.extra.map(([h, b]) => [h, ConsoleScreenBuffer.fromState(b)]));
        this.nextHandle = state.nextHandle;
    }

    getDefault(): ConsoleScreenBuffer {
        return this.defaultBuffer;
    }

    resolveOutputHandle(hConsoleOutput: number): ConsoleScreenBuffer | null {
        const h = hConsoleOutput | 0;
        if (h === STD_OUTPUT_HANDLE || h === STD_ERROR_HANDLE || h === 1 || h === 2) {
            return this.defaultBuffer;
        }
        return this.extraBuffers.get(h >>> 0) ?? null;
    }

    registerBuffer(buffer: ConsoleScreenBuffer): number {
        const handle = this.nextHandle++;
        this.extraBuffers.set(handle, buffer);
        return handle;
    }

    createScreenBuffer(cols: number, rows: number): { handle: number; buffer: ConsoleScreenBuffer } {
        const buffer = new ConsoleScreenBuffer(cols, rows);
        const handle = this.registerBuffer(buffer);
        return { handle, buffer };
    }
}

// @participant(kernel32)
export const consoleScreenBuffers = new ConsoleScreenBufferManager();

export function readCoordFromMem(mem: Uint8Array, addr: number): Coord {
    return readCoord(mem, addr);
}

export function readSmallRectFromMem(mem: Uint8Array, addr: number): SmallRect {
    return readSmallRect(mem, addr);
}

/** Log a line to the default buffer + Logger (WriteConsole path). */
export function logConsoleText(text: string): void {
    if (!text) return;
    const buf = consoleScreenBuffers.getDefault();
    const written = buf.writeCharactersA(
        new Uint8Array([...new TextEncoder().encode(text)]),
        0,
        text.length,
        buf.cursor,
    );
    void written;
    Logger.info(LogCategory.KERNEL32, `[CONOUT] ${text.replace(/\r?\n$/, '')}`);
}
