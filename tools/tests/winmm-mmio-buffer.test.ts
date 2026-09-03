import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import {
    mmioFillGuestWindow,
    mmioWriteInfoStruct,
    mmioCommitInfoCursor,
    mmioSelectsMemoryIoProc,
    mmioResolveBytes,
    type MmioBufState,
} from "../../src/worker/modules/winmm";

// MMIOINFO field offsets (mirror winmm.ts; the struct is part of the Win32 ABI).
const PCHBUFFER = 24;
const PCHNEXT = 28;
const PCHENDREAD = 32;
const PCHENDWRITE = 36;
const CCHBUFFER = 20;
const LBUFOFFSET = 40;
const LDISKOFFSET = 44;
const HMMIO = 68;

let mem: Uint8Array;

const GUEST_BUF = 0x2000;
const BUFCAP = 64; // small window so we can exercise mmioAdvance refills
const INFO = 0x100;
const HANDLE = 7;

function readU32(ptr: number): number {
    return (mem[ptr] | (mem[ptr + 1] << 8) | (mem[ptr + 2] << 16) | (mem[ptr + 3] << 24)) >>> 0;
}
function writeU32(ptr: number, v: number): void {
    mem[ptr] = v & 0xff;
    mem[ptr + 1] = (v >>> 8) & 0xff;
    mem[ptr + 2] = (v >>> 16) & 0xff;
    mem[ptr + 3] = (v >>> 24) & 0xff;
}

/** Build a state with the guest buffer pre-allocated at GUEST_BUF. */
function makeState(data: Uint8Array, position = 0): MmioBufState {
    return { data, position, guestBuffer: GUEST_BUF, guestBufferSize: BUFCAP };
}

describe("winmm MMIO direct-I/O buffering", () => {
    beforeEach(() => {
        mem = new Uint8Array(0x4000);
        Mem.bind(() => mem);
    });

    test("mmioGetInfo path exposes valid, non-null buffer pointers (the crash fix)", () => {
        const data = new Uint8Array(200).map((_, i) => i & 0xff);
        const state = makeState(data, 10);

        mmioFillGuestWindow(state);
        mmioWriteInfoStruct(INFO, HANDLE, state);

        const base = readU32(INFO + PCHBUFFER);
        const next = readU32(INFO + PCHNEXT);
        const endRead = readU32(INFO + PCHENDREAD);

        // The stub previously left these zero -> guest deref of address 0 -> null fault.
        expect(base).toBe(GUEST_BUF);
        expect(next).toBe(GUEST_BUF);
        expect(endRead).toBe(GUEST_BUF + BUFCAP); // window clamps to capacity
        expect(endRead).toBeGreaterThan(next);
        expect(readU32(INFO + PCHENDWRITE)).toBe(endRead);
        expect(readU32(INFO + CCHBUFFER)).toBe(BUFCAP);
        expect(readU32(INFO + LBUFOFFSET)).toBe(10);
        expect(readU32(INFO + LDISKOFFSET)).toBe(10 + BUFCAP);
        expect(readU32(INFO + HMMIO)).toBe(HANDLE);

        // Bytes in the window match the file starting at position 10.
        for (let i = 0; i < BUFCAP; i++) expect(mem[GUEST_BUF + i]).toBe((10 + i) & 0xff);
    });

    test("guest reads through the window, commits via pchNext, advances to refill", () => {
        const data = new Uint8Array(150).map((_, i) => i & 0xff);
        const state = makeState(data, 0);

        // First window: bytes 0..63.
        mmioFillGuestWindow(state);
        mmioWriteInfoStruct(INFO, HANDLE, state);
        expect(readU32(INFO + PCHENDREAD) - readU32(INFO + PCHBUFFER)).toBe(64);

        // Guest consumes the whole window: pchNext == pchEndRead. Commit + refill (mmioAdvance).
        writeU32(INFO + PCHNEXT, readU32(INFO + PCHENDREAD));
        mmioCommitInfoCursor(INFO, state);
        expect(state.position).toBe(64);

        mmioFillGuestWindow(state);
        mmioWriteInfoStruct(INFO, HANDLE, state);
        // Second window: bytes 64..127, first byte is 64.
        expect(mem[GUEST_BUF]).toBe(64);
        expect(readU32(INFO + LBUFOFFSET)).toBe(64);

        // Third (partial) window: only 150-128 = 22 bytes remain.
        writeU32(INFO + PCHNEXT, readU32(INFO + PCHENDREAD));
        mmioCommitInfoCursor(INFO, state);
        expect(state.position).toBe(128);
        const n = mmioFillGuestWindow(state);
        expect(n).toBe(22);
        mmioWriteInfoStruct(INFO, HANDLE, state);
        expect(readU32(INFO + PCHENDREAD) - readU32(INFO + PCHBUFFER)).toBe(22);
    });

    test("partial consume commits the exact file position", () => {
        const data = new Uint8Array(150).map((_, i) => i & 0xff);
        const state = makeState(data, 0);
        mmioFillGuestWindow(state);
        mmioWriteInfoStruct(INFO, HANDLE, state);

        // Guest read only 20 of the 64 buffered bytes.
        writeU32(INFO + PCHNEXT, GUEST_BUF + 20);
        mmioCommitInfoCursor(INFO, state);
        expect(state.position).toBe(20);
    });

    test("EOF yields an empty window (pchNext == pchEndRead), never a null pointer", () => {
        const data = new Uint8Array(30).map((_, i) => i & 0xff);
        const state = makeState(data, 30); // already at EOF
        const n = mmioFillGuestWindow(state);
        expect(n).toBe(0);
        mmioWriteInfoStruct(INFO, HANDLE, state);
        expect(readU32(INFO + PCHBUFFER)).toBe(GUEST_BUF);
        expect(readU32(INFO + PCHNEXT)).toBe(GUEST_BUF);
        expect(readU32(INFO + PCHENDREAD)).toBe(GUEST_BUF); // empty: next == endRead
    });
});

describe("winmm mmioOpen I/O-proc selection", () => {
    const FCC_MEM = 0x204d454d; // 'MEM '
    const FCC_DOS = 0x20534f44; // 'DOS '

    test("'MEM ' selects the memory proc even when szFilename names the asset", () => {
        // THPS2's shape: it reads the WAV out of its .pkr, then hands mmio the buffer AND
        // the asset name. Selecting on the name sends it to a disk file that does not exist,
        // and every sound in the game fails to load.
        expect(mmioSelectsMemoryIoProc(true, FCC_MEM, 0, "audio/selectD.wav")).toBe(true);
    });

    test("a NULL name with no proc at all is still a memory file", () => {
        expect(mmioSelectsMemoryIoProc(true, 0, 0, "")).toBe(true);
    });

    test("a named file with no MMIOINFO, or an explicit non-MEM proc, goes to disk", () => {
        expect(mmioSelectsMemoryIoProc(false, 0, 0, "C:\sound.wav")).toBe(false);
        expect(mmioSelectsMemoryIoProc(true, 0, 0, "C:\sound.wav")).toBe(false);
        expect(mmioSelectsMemoryIoProc(true, FCC_DOS, 0, "C:\sound.wav")).toBe(false);
        // A custom pIOProc owns the open; the name must not steal it back.
        expect(mmioSelectsMemoryIoProc(true, 0, 0x401000, "")).toBe(false);
    });
});

describe("mmioResolveBytes — a memory file's bytes are the guest's, re-derived", () => {
    const BASE = 0x400;
    const SIZE = 8;
    const memWith = (fill: number, length = 0x1000) => {
        const m = new Uint8Array(length);
        m.fill(fill, BASE, BASE + SIZE);
        return m;
    };
    const memState = (): MmioBufState =>
        ({ data: null, position: 0, memoryBase: BASE, guestBufferSize: SIZE });

    test("reads through to whatever the guest wrote, without a stored view", () => {
        const bytes = mmioResolveBytes(memState(), memWith(0xab));
        expect(bytes).not.toBeNull();
        expect(Array.from(bytes!)).toEqual(new Array(SIZE).fill(0xab));
    });

    // The point of re-deriving: WASM growth REPLACES the buffer, and a view captured at
    // mmioOpen would be detached — length 0, so the file reports EOF and the audio just
    // stops, with nothing logged. Resolving per use follows the memory that exists now.
    test("follows guest memory across a growth that would have detached a stored view", () => {
        const state = memState();
        const before = mmioResolveBytes(state, memWith(0x11));
        const after = mmioResolveBytes(state, memWith(0x22, 0x4000));
        expect(Array.from(before!)).toEqual(new Array(SIZE).fill(0x11));
        expect(Array.from(after!)).toEqual(new Array(SIZE).fill(0x22));
        expect(after!.length).toBe(SIZE); // never the 0 a detached view answers
    });

    test("a disk file's own copy is returned unchanged, and needs no memory", () => {
        const data = new Uint8Array([1, 2, 3]);
        const state: MmioBufState = { data, position: 0 };
        expect(mmioResolveBytes(state, null)).toBe(data);
    });

    test("refuses a block that does not fit the current memory instead of truncating", () => {
        // A short read served silently is a wrong answer the caller cannot detect.
        const state = memState();
        expect(mmioResolveBytes(state, new Uint8Array(BASE + SIZE - 1))).toBeNull();
        expect(mmioResolveBytes(state, null)).toBeNull();
    });
});
