/**
 * AVI File Library (avifil32.dll)
 *
 * Decodes .AVI video files via the FFmpeg WASM video engine.
 * Implements the AVIFile/AVIStream Win32 API for games that use AVI cutscenes.
 *
 * The avifil32 API is frame-random-access: games open a stream, then call
 * AVIStreamGetFrame(pos) to retrieve individual DIBs (BITMAPINFOHEADER + pixels).
 *
 * Guest memory layout for the returned DIB (at allocDibPtr):
 *   BITMAPINFOHEADER (40 bytes):
 *     +0   biSize          DWORD  = 40
 *     +4   biWidth         LONG   = video width
 *     +8   biHeight        LONG   = video height (positive = bottom-up)
 *     +12  biPlanes        WORD   = 1
 *     +14  biBitCount      WORD   = 32
 *     +16  biCompression   DWORD  = 0 (BI_RGB)
 *     +20  biSizeImage     DWORD  = width * height * 4
 *     +24..39  zeros
 *   Pixel data (BGRA, bottom-up) immediately follows at +40.
 *
 * Invariants (do not break — ref leaks / double-close follow from violations):
 * 1. Each VideoEngine handle has exactly one owner: either an AviFileSession, or a
 *    standalone AviSession (AVIStreamOpenFromFileA). File-linked streams borrow only.
 * 2. videoEngine.close() is called at most once per engine handle — on the owning object
 *    teardown (owned stream release, or file release when refCount hits 0).
 * 3. File refCount: starts at 1 on AVIFileOpenA; +1 per AVIFileGetStream; −1 per
 *    AVIStreamRelease on a file-linked stream; −1 per AVIFileRelease. At 0 the file
 *    and all dangling stream entries are torn down and the decoder is closed.
 * 4. Stream refCount: starts at 1; AVIStreamRelease returns the remaining count (0 when
 *    destroyed). Destroying a file-linked stream also decrements the parent file ref.
 * 5. dwScale/dwRate are the single source of truth for SampleToTime/TimeToSample and
 *    must match the values written into AVISTREAMINFOA (+20/+24).
 */

import { toPlainGuestMemory } from "../core/memory/guest-memory";
import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";
import { EmulatorConfig } from "../core/emulator-config-manager";
import { videoEngine } from "../../video/video-engine";
import { TimeService } from "../runtime/time";
import { readAnsiFromGuest, encodeAnsi } from "./codepage-utils";

/** AVISTREAMINFOA is 140 bytes on 32-bit Windows */
const AVISTREAMINFO_SIZE = 140;

/** BITMAPINFOHEADER size */
const BMIH_SIZE = 40;

/** FOURCC codes */
const STREAMTYPE_VIDEO = 0x73646976; // 'vids'
const STREAMTYPE_AUDIO = 0x73647561; // 'auds'

/** Opened AVI file — owns the VideoEngine decoder instance */
interface AviFileSession {
    engineHandle: number;
    width:        number;
    height:       number;
    frameCount:   number;
    fps:          number;
    refCount:     number;
    streamHandles: Set<number>;
}

/** Per-open AVI stream session */
interface AviSession {
    engineHandle: number;   // VideoEngine JS handle (owned unless fileHandle is set)
    width:        number;
    height:       number;
    frameCount:   number;
    /** AVISTREAMINFO dwScale — fixed at 1 for our output streams */
    dwScale:      number;
    /** AVISTREAMINFO dwRate — samples per second (integer fps) */
    dwRate:       number;
    refCount:     number;
    /** Guest pointer to allocated DIB buffer (BMIH + pixels) */
    dibPtr:       number;
    dibSize:      number;
    /** Current decoded frame index (-1 = none) */
    decodedFrame: number;
    /** Whether GetFrameOpen has been called */
    frameOpen:    boolean;
    /** Limited diagnostics counter for frame content sampling */
    diagSamples:  number;
    /** When set, engineHandle is borrowed from the parent file session */
    fileHandle?:  number;
}

/** Unique handle counters — odd numbers to be distinguishable from other module handles */
let nextAviHandle = 0xAF000001;
let nextAviFileHandle = 0xAF100001;

export class Avifil32 implements IModule {
    name = "avifil32";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;

    /** Map from guest stream handle value → session state */
    private sessions: Map<number, AviSession> = new Map();
    /** Map from guest file handle value → opened AVI file */
    private fileSessions: Map<number, AviFileSession> = new Map();

    private readCString(mem: Uint8Array, ptr: number, maxLen = 520): string {
        return readAnsiFromGuest(mem, ptr, maxLen);
    }

    private writeU32(mem: Uint8Array, addr: number, value: number): void {
        mem[addr]     =  value        & 0xFF;
        mem[addr + 1] = (value >> 8)  & 0xFF;
        mem[addr + 2] = (value >> 16) & 0xFF;
        mem[addr + 3] = (value >> 24) & 0xFF;
    }

    private writeU16(mem: Uint8Array, addr: number, value: number): void {
        mem[addr]     =  value       & 0xFF;
        mem[addr + 1] = (value >> 8) & 0xFF;
    }

    private getMemory(): Uint8Array {
        const v86 = this.process.v86;
        return toPlainGuestMemory(v86["mem8"] || (v86["v86"] && v86["v86"]["cpu"]["mem8"]));
    }

    private normalizeVfsPath(filePath: string): string {
        let vfsPath = filePath.replace(/\\/g, "/");
        if (vfsPath.match(/^[A-Z]:/i)) {
            vfsPath = vfsPath.substring(2);
        }
        return vfsPath;
    }

    /** Integer timing fields shared by AVISTREAMINFO and time/sample helpers. */
    private streamTimingFromFps(fps: number): { dwScale: number; dwRate: number } {
        return { dwScale: 1, dwRate: Math.max(1, Math.round(fps)) };
    }

    private sampleToMs(lSample: number, dwScale: number, dwRate: number): number {
        if (dwRate <= 0) return 0;
        return Math.round((lSample * 1000 * dwScale) / dwRate);
    }

    private timeToSample(lTime: number, dwScale: number, dwRate: number, frameCount: number): number {
        if (dwRate <= 0 || dwScale <= 0) return 0;
        const sample = Math.floor((lTime * dwRate) / (1000 * dwScale));
        if (frameCount <= 0) return Math.max(0, sample);
        return Math.max(0, Math.min(sample, frameCount - 1));
    }

    /** Read a complete file from VFS into a Uint8Array. */
    private async readVfsFile(path: string): Promise<Uint8Array | null> {
        try {
            const vfs  = System.getInstance().fileSystem;
            const size = vfs.getFileSize(path);
            if (size <= 0) {
                Logger.warn(LogCategory.SYSTEM, `[AVIFIL32] readVfsFile("${path}"): size=${size}`);
                return null;
            }
            const LIMIT_BYTES = 256 * 1024 * 1024;
            if (size > LIMIT_BYTES) {
                Logger.warn(LogCategory.SYSTEM,
                    `[AVIFIL32] readVfsFile("${path}"): size ${size} exceeds limit, skipping`);
                return null;
            }
            const GENERIC_READ = 0x80000000;
            const OPEN_EXISTING = 3;
            const handle = await vfs.open(path, GENERIC_READ, OPEN_EXISTING);
            if (!handle) {
                Logger.warn(LogCategory.SYSTEM, `[AVIFIL32] readVfsFile("${path}"): open failed`);
                return null;
            }
            const data = await vfs.read(handle, size);
            return data;
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `[AVIFIL32] readVfsFile("${path}") error: ${e}`);
            return null;
        }
    }

    /** Allocate guest DIB buffer and write BITMAPINFOHEADER. */
    private allocDibBuffer(width: number, height: number): { dibPtr: number; dibSize: number } {
        const dibSize = BMIH_SIZE + width * height * 4;
        const dibPtr = this.process.memory.alloc(dibSize, "HEAP", "rw");
        const m = this.getMemory();
        this.writeU32(m, dibPtr + 0,  40);
        this.writeU32(m, dibPtr + 4,  width);
        this.writeU32(m, dibPtr + 8,  height);
        this.writeU16(m, dibPtr + 12, 1);
        this.writeU16(m, dibPtr + 14, 32);
        this.writeU32(m, dibPtr + 16, 0);
        this.writeU32(m, dibPtr + 20, width * height * 4);
        this.writeU32(m, dibPtr + 24, 0);
        this.writeU32(m, dibPtr + 28, 0);
        this.writeU32(m, dibPtr + 32, 0);
        this.writeU32(m, dibPtr + 36, 0);
        return { dibPtr, dibSize };
    }

    /** Create a stream session that owns its VideoEngine handle. */
    private createOwnedStreamSession(
        engineHandle: number,
        width: number,
        height: number,
        frameCount: number,
        fps: number,
    ): AviSession {
        const { dibPtr, dibSize } = this.allocDibBuffer(width, height);
        const { dwScale, dwRate } = this.streamTimingFromFps(fps);
        return {
            engineHandle,
            width,
            height,
            frameCount,
            dwScale,
            dwRate,
            refCount: 1,
            dibPtr,
            dibSize,
            decodedFrame: -1,
            frameOpen: false,
            diagSamples: 0,
        };
    }

    /** Create a stream session that borrows the decoder from an open AVI file. */
    private createFileStreamSession(file: AviFileSession, fileHandle: number): AviSession {
        const { dibPtr, dibSize } = this.allocDibBuffer(file.width, file.height);
        const { dwScale, dwRate } = this.streamTimingFromFps(file.fps);
        return {
            engineHandle: file.engineHandle,
            width: file.width,
            height: file.height,
            frameCount: file.frameCount,
            dwScale,
            dwRate,
            refCount: 1,
            dibPtr,
            dibSize,
            decodedFrame: -1,
            frameOpen: false,
            diagSamples: 0,
            fileHandle,
        };
    }

    private releaseStreamHandle(handle: number): number {
        const s = this.sessions.get(handle);
        if (!s) return 0;

        s.refCount--;
        const remaining = s.refCount;
        if (s.refCount > 0) {
            Logger.log(LogCategory.SYSTEM,
                `[AVIFIL32] AVIStreamRelease(0x${handle.toString(16)}) → ref=${remaining}`);
            return remaining;
        }

        if (s.fileHandle !== undefined) {
            const file = this.fileSessions.get(s.fileHandle);
            if (file) {
                file.streamHandles.delete(handle);
                file.refCount--;
            }
        } else {
            videoEngine.close(s.engineHandle);
        }

        this.sessions.delete(handle);
        Logger.log(LogCategory.SYSTEM,
            `[AVIFIL32] AVIStreamRelease(0x${handle.toString(16)}) → closed`);
        return 0;
    }

    private releaseFileHandle(handle: number): number {
        const file = this.fileSessions.get(handle);
        if (!file) return 0;

        file.refCount--;
        const remaining = file.refCount;
        if (file.refCount > 0) {
            Logger.log(LogCategory.SYSTEM,
                `[AVIFIL32] AVIFileRelease(0x${handle.toString(16)}) → ref=${remaining}`);
            return remaining;
        }

        // File teardown: drop stream entries without closing the decoder again.
        for (const streamHandle of file.streamHandles) {
            this.sessions.delete(streamHandle);
        }
        videoEngine.close(file.engineHandle);
        this.fileSessions.delete(handle);
        Logger.log(LogCategory.SYSTEM,
            `[AVIFIL32] AVIFileRelease(0x${handle.toString(16)}) → closed`);
        return 0;
    }

    /** Open a video file from VFS and create an AviFileSession. */
    private async openAviFileFromPath(
        mem: Uint8Array,
        ppfile: number,
        szFilePtr: number,
        logLabel: string,
    ): Promise<number> {
        const filePath = this.readCString(mem, szFilePtr);
        Logger.log(LogCategory.SYSTEM,
            `[AVIFIL32] ${logLabel}(ppfile=0x${ppfile.toString(16)}, file="${filePath}")`);

        if (EmulatorConfig.getInstance().skipVideo) {
            Logger.log(LogCategory.SYSTEM, "[AVIFIL32] SKIPPED (skipVideo=true)");
            this.writeU32(mem, ppfile, 0);
            return 0x80040154; // AVIERR_NODATA
        }

        const vfsPath = this.normalizeVfsPath(filePath);
        const fileBytes = await this.readVfsFile(vfsPath);
        if (!fileBytes) {
            Logger.warn(LogCategory.SYSTEM, `[AVIFIL32] Failed to read "${vfsPath}" from VFS`);
            this.writeU32(mem, ppfile, 0);
            return 0x80044065; // AVIERR_FILEOPEN
        }

        try {
            const engineHandle = await videoEngine.open(fileBytes);
            const info = videoEngine.getInfo(engineHandle);
            if (!info) {
                videoEngine.close(engineHandle);
                this.writeU32(mem, ppfile, 0);
                return 0x80044065;
            }

            const handle = nextAviFileHandle++;
            const fileSession: AviFileSession = {
                engineHandle,
                width: info.width,
                height: info.height,
                frameCount: info.frameCount,
                fps: info.fps,
                refCount: 1,
                streamHandles: new Set(),
            };
            this.fileSessions.set(handle, fileSession);
            this.writeU32(mem, ppfile, handle);

            Logger.log(LogCategory.SYSTEM,
                `[AVIFIL32] Opened "${filePath}" → file=0x${handle.toString(16)} ` +
                `${info.width}×${info.height} fps=${info.fps.toFixed(1)} frames=${info.frameCount} ` +
                `codec="${info.codecName}" fourCC="${info.fourCC}" codecId=${info.codecId} pixFmt=${info.pixFmt}`);
            return 0;
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `[AVIFIL32] VideoEngine.open failed: ${e}`);
            this.writeU32(mem, ppfile, 0);
            return 0x80044065;
        }
    }

    initialize(process: Process): void {
        this.process = process;

        // ── AVIFileInit() — one-time library initialization ──────────────────
        this.exports["AVIFileInit"] = (_ctx, _mem, _args) => {
            Logger.log(LogCategory.SYSTEM, "[AVIFIL32] AVIFileInit()");
            return 0;
        };

        // ── AVIFileExit() — library cleanup ──────────────────────────────────
        this.exports["AVIFileExit"] = (_ctx, _mem, _args) => {
            Logger.log(LogCategory.SYSTEM, "[AVIFIL32] AVIFileExit()");
            return 0;
        };

        // ── AVIFileOpenA(ppfile, szFile, uMode, lpHandler) ───────────────────
        this.exports["AVIFileOpenA"] = async (_ctx, mem, args) => {
            return this.openAviFileFromPath(mem, args[0], args[1], "AVIFileOpenA");
        };

        // ── AVIFileRelease(pfile) → ref count (0 = closed) ───────────────────
        this.exports["AVIFileRelease"] = (_ctx, _mem, args) => {
            return this.releaseFileHandle(args[0]);
        };

        // ── AVIFileGetStream(pfile, ppavi, fccType, lParam) ──────────────────
        this.exports["AVIFileGetStream"] = (_ctx, mem, args) => {
            const pfile   = args[0];
            const ppavi   = args[1];
            const fccType = args[2];
            const lParam  = args[3];

            Logger.log(LogCategory.SYSTEM,
                `[AVIFIL32] AVIFileGetStream(pfile=0x${pfile.toString(16)}, ` +
                `ppavi=0x${ppavi.toString(16)}, fccType=0x${fccType.toString(16)}, lParam=${lParam})`);

            const file = this.fileSessions.get(pfile);
            if (!file) {
                this.writeU32(mem, ppavi, 0);
                return 0x8004406E; // AVIERR_NODATA / invalid file
            }

            // fccType: 0 = any, 'vids' = video, 'auds' = audio
            if (fccType !== 0 && fccType !== STREAMTYPE_VIDEO) {
                if (fccType === STREAMTYPE_AUDIO) {
                    Logger.warn(LogCategory.SYSTEM, "[AVIFIL32] Audio stream requested but not supported");
                } else {
                    Logger.warn(LogCategory.SYSTEM, `[AVIFIL32] Unsupported stream type 0x${fccType.toString(16)}`);
                }
                this.writeU32(mem, ppavi, 0);
                return 0x8004406E;
            }

            const handle = nextAviHandle++;
            const session = this.createFileStreamSession(file, pfile);
            this.sessions.set(handle, session);
            file.streamHandles.add(handle);
            file.refCount++;
            this.writeU32(mem, ppavi, handle);

            Logger.log(LogCategory.SYSTEM,
                `[AVIFIL32] AVIFileGetStream → stream=0x${handle.toString(16)} ` +
                `${file.width}×${file.height} frames=${file.frameCount}`);
            return 0;
        };

        // ── AVIStreamOpenFromFileA(ppavi, szFile, fccType, lParam, mode, pclsidHandler)
        this.exports["AVIStreamOpenFromFileA"] = async (_ctx, mem, args) => {
            const ppavi     = args[0];
            const szFilePtr = args[1];
            const fccType   = args[2];
            const _lParam   = args[3];
            const _mode     = args[4];

            const filePath = this.readCString(mem, szFilePtr);
            Logger.log(LogCategory.SYSTEM,
                `[AVIFIL32] AVIStreamOpenFromFileA(ppavi=0x${ppavi.toString(16)}, ` +
                `file="${filePath}", fccType=0x${fccType.toString(16)})`);

            if (EmulatorConfig.getInstance().skipVideo) {
                Logger.log(LogCategory.SYSTEM, "[AVIFIL32] SKIPPED (skipVideo=true)");
                this.writeU32(mem, ppavi, 0);
                return 0x80040154;
            }

            const vfsPath = this.normalizeVfsPath(filePath);
            const fileBytes = await this.readVfsFile(vfsPath);
            if (!fileBytes) {
                Logger.warn(LogCategory.SYSTEM, `[AVIFIL32] Failed to read "${vfsPath}" from VFS`);
                this.writeU32(mem, ppavi, 0);
                return 0x80044065;
            }

            try {
                const engineHandle = await videoEngine.open(fileBytes);
                const info = videoEngine.getInfo(engineHandle);
                if (!info) {
                    videoEngine.close(engineHandle);
                    this.writeU32(mem, ppavi, 0);
                    return 0x80044065;
                }

                const handle = nextAviHandle++;
                const session = this.createOwnedStreamSession(
                    engineHandle,
                    info.width,
                    info.height,
                    info.frameCount,
                    info.fps,
                );
                this.sessions.set(handle, session);
                this.writeU32(mem, ppavi, handle);

                Logger.log(LogCategory.SYSTEM,
                    `[AVIFIL32] Opened "${filePath}" → handle=0x${handle.toString(16)} ` +
                    `${info.width}×${info.height} fps=${info.fps.toFixed(1)} frames=${info.frameCount} ` +
                    `codec="${info.codecName}" fourCC="${info.fourCC}" codecId=${info.codecId} pixFmt=${info.pixFmt}`);
                return 0;
            } catch (e) {
                Logger.error(LogCategory.SYSTEM, `[AVIFIL32] VideoEngine.open failed: ${e}`);
                this.writeU32(mem, ppavi, 0);
                return 0x80044065;
            }
        };

        // ── AVIStreamRelease(pavi) — close and release stream ────────────────
        this.exports["AVIStreamRelease"] = (_ctx, _mem, args) => {
            return this.releaseStreamHandle(args[0]);
        };

        // ── AVIStreamInfoA(pavi, psi, lSize) — fill AVISTREAMINFOA struct ────
        this.exports["AVIStreamInfoA"] = (_ctx, mem, args) => {
            const handle = args[0];
            const psi    = args[1];
            const lSize  = args[2];
            const s = this.sessions.get(handle);

            Logger.log(LogCategory.SYSTEM,
                `[AVIFIL32] AVIStreamInfoA(0x${handle.toString(16)}, psi=0x${psi.toString(16)}, size=${lSize})`);

            if (!s || !psi) return 0x80004005; // E_FAIL

            const size = Math.min(lSize, AVISTREAMINFO_SIZE);
            mem.fill(0, psi, psi + size);

            this.writeU32(mem, psi + 0,  0x73646976); // 'vids'
            this.writeU32(mem, psi + 4,  0x20424944); // 'DIB '
            this.writeU32(mem, psi + 20, s.dwScale);
            this.writeU32(mem, psi + 24, s.dwRate);
            this.writeU32(mem, psi + 28, 0);
            this.writeU32(mem, psi + 32, s.frameCount);
            this.writeU32(mem, psi + 40, s.width * s.height * 4);
            this.writeU32(mem, psi + 44, 0xFFFFFFFF);
            this.writeU32(mem, psi + 48, 0);
            this.writeU32(mem, psi + 52, 0);
            this.writeU32(mem, psi + 56, 0);
            this.writeU32(mem, psi + 60, s.width);
            this.writeU32(mem, psi + 64, s.height);
            const name = "BottleShip AVI";
            const nameBytes = encodeAnsi(name);
            const nameLen = Math.min(nameBytes.length, 63);
            mem.set(nameBytes.subarray(0, nameLen), psi + 76);
            mem[psi + 76 + nameLen] = 0;

            return 0;
        };

        // ── AVIStreamLength(pavi) → frame count ─────────────────────────────
        this.exports["AVIStreamLength"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const s = this.sessions.get(handle);
            const count = s ? s.frameCount : 0;
            Logger.log(LogCategory.SYSTEM,
                `[AVIFIL32] AVIStreamLength(0x${handle.toString(16)}) → ${count}`);
            return count;
        };

        // ── AVIStreamStart(pavi) → start sample ─────────────────────────────
        this.exports["AVIStreamStart"] = (_ctx, _mem, args) => {
            const handle = args[0];
            Logger.log(LogCategory.SYSTEM,
                `[AVIFIL32] AVIStreamStart(0x${handle.toString(16)}) → 0`);
            return 0;
        };

        // ── AVIStreamStartTime(pavi) → start time (ms) ──────────────────────
        this.exports["AVIStreamStartTime"] = (_ctx, _mem, args) => {
            const handle = args[0];
            Logger.log(LogCategory.SYSTEM,
                `[AVIFIL32] AVIStreamStartTime(0x${handle.toString(16)}) → 0`);
            return 0;
        };

        // ── AVIStreamSampleToTime(pavi, lSample) → milliseconds ─────────────
        this.exports["AVIStreamSampleToTime"] = (_ctx, _mem, args) => {
            const handle  = args[0];
            const lSample = args[1];
            const s = this.sessions.get(handle);
            if (!s) return 0;
            const ms = this.sampleToMs(lSample, s.dwScale, s.dwRate);
            Logger.verbose(LogCategory.SYSTEM, `[AVIFIL32] AVIStreamSampleToTime(0x${handle.toString(16)}, sample=${lSample}) → ${ms}ms`);
            return ms;
        };

        // ── AVIStreamTimeToSample(pavi, lTime) → frame index ────────────────
        this.exports["AVIStreamTimeToSample"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const lTime  = args[1];
            const s = this.sessions.get(handle);
            if (!s) return 0;
            const sample = this.timeToSample(lTime, s.dwScale, s.dwRate, s.frameCount);
            Logger.verbose(LogCategory.SYSTEM, `[AVIFIL32] AVIStreamTimeToSample(0x${handle.toString(16)}, time=${lTime}ms) → sample=${sample}`);
            return sample;
        };

        // ── AVIStreamRead(pavi, lStart, lSamples, lpBuffer, cbBuffer, plBytes, plSamples)
        this.exports["AVIStreamRead"] = (_ctx, mem, args) => {
            const handle    = args[0];
            const lStart    = args[1] | 0;
            const lSamples  = args[2] | 0;
            const lpBuffer  = args[3];
            const cbBuffer  = args[4];
            const plBytes   = args[5];
            const plSamples = args[6];

            const s = this.sessions.get(handle);
            if (!s) return 0x80004005; // E_FAIL

            Logger.log(LogCategory.SYSTEM,
                `[AVIFIL32] AVIStreamRead(0x${handle.toString(16)}, start=${lStart}, count=${lSamples}, ` +
                `buf=0x${lpBuffer.toString(16)}, size=${cbBuffer})`);

            const frameSize = s.width * s.height * 4;
            const totalBytes = lSamples * frameSize;

            if (lpBuffer === 0) {
                if (plBytes) this.writeU32(mem, plBytes, totalBytes);
                if (plSamples) this.writeU32(mem, plSamples, lSamples);
                return 0; // S_OK
            }

            if (cbBuffer < totalBytes) return 0x8004406D; // AVIERR_BUFFERTOOSMALL

            // Decode and copy requested frames
            let samplesRead = 0;
            for (let i = 0; i < lSamples; i++) {
                const lPos = lStart + i;
                if (lPos < 0 || lPos >= s.frameCount) break;

                // Decode frame lPos
                if (lPos < s.decodedFrame) {
                    videoEngine.gotoFrame(s.engineHandle, 0);
                    s.decodedFrame = -1;
                }
                while (s.decodedFrame < lPos) {
                    if (!videoEngine.doFrame(s.engineHandle)) break;
                    s.decodedFrame++;
                    TimeService.getInstance().reanchorToWallClock();
                }

                const bgra = videoEngine.getFrameBgra(s.engineHandle);
                if (bgra) {
                    const dstOff = lpBuffer + i * frameSize;
                    // Flip rows for bottom-up DIB (most games expect this via AVIStreamRead)
                    const rowBytes = s.width * 4;
                    for (let y = 0; y < s.height; y++) {
                        const srcOff = y * rowBytes;
                        const dstRow = s.height - 1 - y;
                        const dstRowOff = dstOff + dstRow * rowBytes;
                        mem.set(bgra.subarray(srcOff, srcOff + rowBytes), dstRowOff);
                    }
                    // Force alpha to 0xFF
                    if ((dstOff & 3) === 0) {
                        const m32 = new Uint32Array(mem.buffer, mem.byteOffset + dstOff, s.width * s.height);
                        for (let j = 0; j < m32.length; j++) m32[j] |= 0xFF000000;
                    }
                    samplesRead++;
                }
            }

            if (plBytes) this.writeU32(mem, plBytes, samplesRead * frameSize);
            if (plSamples) this.writeU32(mem, plSamples, samplesRead);
            return 0;
        };

        // ── AVIStreamReadFormat(pavi, lPos, lpFormat, lpcbFormat) ────────────
        this.exports["AVIStreamReadFormat"] = (_ctx, mem, args) => {
            const handle     = args[0];
            const _lPos      = args[1];
            const lpFormat   = args[2];
            const lpcbFormat = args[3];

            const s = this.sessions.get(handle);
            if (!s) return 0x80004005;

            const formatSize = 40; // BITMAPINFOHEADER
            if (lpFormat === 0) {
                if (lpcbFormat) this.writeU32(mem, lpcbFormat, formatSize);
                return 0;
            }

            const cbFormat = lpcbFormat ? new DataView(mem.buffer, mem.byteOffset + lpcbFormat, 4).getUint32(0, true) : formatSize;
            const toCopy = Math.min(cbFormat, formatSize);

            // Write BITMAPINFOHEADER
            this.writeU32(mem, lpFormat + 0,  40);
            this.writeU32(mem, lpFormat + 4,  s.width);
            this.writeU32(mem, lpFormat + 8,  s.height); // positive = bottom-up
            this.writeU16(mem, lpFormat + 12, 1);
            this.writeU16(mem, lpFormat + 14, 32);
            this.writeU32(mem, lpFormat + 16, 0); // BI_RGB
            this.writeU32(mem, lpFormat + 20, s.width * s.height * 4);
            this.writeU32(mem, lpFormat + 24, 0);
            this.writeU32(mem, lpFormat + 28, 0);
            this.writeU32(mem, lpFormat + 32, 0);
            this.writeU32(mem, lpFormat + 36, 0);

            if (lpcbFormat) this.writeU32(mem, lpcbFormat, toCopy);
            return 0;
        };

        // ── AVIStreamReadData(pavi, fcc, lp, lpcb) ───────────────────────────
        this.exports["AVIStreamReadData"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const fcc    = args[1];
            Logger.verbose(LogCategory.SYSTEM, `[AVIFIL32] AVIStreamReadData(0x${handle.toString(16)}, fcc=0x${fcc.toString(16)}) → AVIERR_NODATA`);
            return 0x8004406E; // AVIERR_NODATA
        };

        // ── AVIStreamWriteData(pavi, fcc, lp, cb) ────────────────────────────
        this.exports["AVIStreamWriteData"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const fcc    = args[1];
            Logger.verbose(LogCategory.SYSTEM, `[AVIFIL32] AVIStreamWriteData(0x${handle.toString(16)}, fcc=0x${fcc.toString(16)}) → AVIERR_READONLY`);
            return 0x8004406F; // AVIERR_READONLY
        };

        // ── AVIStreamFindSample(pavi, lPos, lFlags) ──────────────────────────
        this.exports["AVIStreamFindSample"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const lPos   = args[1] | 0;
            const lFlags = args[2];
            // Stub: just return the requested position.
            // FIND_KEY = 0x00000001, FIND_ANY = 0x00000000
            Logger.verbose(LogCategory.SYSTEM, `[AVIFIL32] AVIStreamFindSample(0x${handle.toString(16)}, pos=${lPos}, flags=0x${lFlags.toString(16)}) → ${lPos}`);
            return lPos;
        };

        // ── AVIStreamGetFrameOpen(pavi, lpbiWanted) → PGETFRAME handle ──────
        this.exports["AVIStreamGetFrameOpen"] = (_ctx, _mem, args) => {
            const handle    = args[0];
            const _lpbiWanted = args[1];
            const s = this.sessions.get(handle);
            if (!s) return 0;

            s.frameOpen = true;
            Logger.log(LogCategory.SYSTEM,
                `[AVIFIL32] AVIStreamGetFrameOpen(0x${handle.toString(16)}) → 0x${handle.toString(16)}`);
            return handle;
        };

        // ── AVIStreamGetFrame(pgf, lPos) → pointer to DIB (BMIH + pixels) ──
        this.exports["AVIStreamGetFrame"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const lPos   = args[1];
            const s = this.sessions.get(handle);
            if (!s || !s.frameOpen) return 0;
            if (lPos < 0 || lPos >= s.frameCount) return 0;

            if (lPos < s.decodedFrame) {
                videoEngine.gotoFrame(s.engineHandle, 0);
                s.decodedFrame = -1;
            }
            while (s.decodedFrame < lPos) {
                const decodeStart = performance.now();
                if (!videoEngine.doFrame(s.engineHandle)) {
                    Logger.warn(LogCategory.SYSTEM,
                        `[AVIFIL32] GetFrame: doFrame EOF at decoded=${s.decodedFrame} requested=${lPos} total=${s.frameCount}`);
                    if (s.decodedFrame >= 0) break;
                    return 0;
                }
                s.decodedFrame++;
                void decodeStart;
                TimeService.getInstance().reanchorToWallClock();
            }

            const bgra = videoEngine.getFrameBgra(s.engineHandle);
            if (!bgra) return 0;

            const shouldSample = s.diagSamples < 5 || (s.diagSamples < 20 && lPos % 30 === 0);
            if (shouldSample) {
                const cX = Math.max(0, (s.width >> 1) - 1);
                const cY = Math.max(0, (s.height >> 1) - 1);
                const p0 = 0;
                const pc = (cY * s.width + cX) * 4;
                let maxVal = 0;
                const step = Math.max(1, ((s.width * s.height) >> 8));
                for (let i = 0; i < s.width * s.height * 4 && maxVal < 128; i += step * 4) {
                    const v = Math.max(bgra[i], bgra[i + 1], bgra[i + 2]);
                    if (v > maxVal) maxVal = v;
                }
                Logger.log(
                    LogCategory.SYSTEM,
                    `[AVIFIL32] GetFrame lPos=${lPos} decoded=${s.decodedFrame} ` +
                    `bgra[0]=[${bgra[p0]},${bgra[p0 + 1]},${bgra[p0 + 2]},${bgra[p0 + 3]}] ` +
                    `center=[${bgra[pc]},${bgra[pc + 1]},${bgra[pc + 2]},${bgra[pc + 3]}] maxRGB=${maxVal}`
                );
                s.diagSamples++;
            }

            const m = this.getMemory();
            const pixelStart = s.dibPtr + BMIH_SIZE;
            const rowBytes = s.width * 4;
            for (let y = 0; y < s.height; y++) {
                const srcOff = y * rowBytes;
                const dstRow = s.height - 1 - y;
                const dstOff = pixelStart + dstRow * rowBytes;
                m.set(bgra.subarray(srcOff, srcOff + rowBytes), dstOff);
            }
            if ((pixelStart & 3) === 0) {
                const totalPixels = s.width * s.height;
                const m32 = new Uint32Array(m.buffer, m.byteOffset + pixelStart, totalPixels);
                for (let i = 0; i < totalPixels; i++) m32[i] |= 0xFF000000;
            }

            return s.dibPtr;
        };

        // ── AVIStreamGetFrameClose(pgf) ─────────────────────────────────────
        this.exports["AVIStreamGetFrameClose"] = (_ctx, _mem, args) => {
            const handle = args[0];
            const s = this.sessions.get(handle);
            if (s) {
                s.frameOpen = false;
                Logger.log(LogCategory.SYSTEM,
                    `[AVIFIL32] AVIStreamGetFrameClose(0x${handle.toString(16)})`);
            }
            return 0;
        };
    }

    reset(): void {
        const closedEngines = new Set<number>();

        for (const s of this.sessions.values()) {
            if (s.fileHandle === undefined && !closedEngines.has(s.engineHandle)) {
                videoEngine.close(s.engineHandle);
                closedEngines.add(s.engineHandle);
            }
        }
        this.sessions.clear();

        for (const file of this.fileSessions.values()) {
            if (!closedEngines.has(file.engineHandle)) {
                videoEngine.close(file.engineHandle);
                closedEngines.add(file.engineHandle);
            }
        }
        this.fileSessions.clear();
    }
}
