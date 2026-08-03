/**
 * SysAnimate32 common control — AVI playback via VideoEngine (FFmpeg WASM).
 * Playback starts on ACM_PLAY, or immediately after ACM_OPEN when ACS_AUTOPLAY is set.
 */

import { Logger, LogCategory } from '../../core/logger';
import { Marshaler } from '../../core/memory/marshaler';
import { System } from '../../core/system';
import { TimeService } from '../../runtime/time';
import { videoEngine } from '../../../video/video-engine';
import { registerBuiltinClass } from './class';
import { windows, getAbsoluteWindowPosition, type WindowInfo } from './shared-state';

// ACM_* messages (commctrl.h)
const ACM_OPENA = 0x0400 + 100;   // 0x464
const ACM_OPENW = 0x0400 + 101;
const ACM_PLAY = 0x0400 + 102;
const ACM_STOP = 0x0400 + 103;
const ACM_CLOSE = 0x0400 + 104;
const ACM_ISPLAYING = 0x0400 + 105;

/** Animation control styles (commctrl.h). */
const ACS_AUTOPLAY = 0x0004;

const ACN_START = 1;
const ACN_STOP = 2;

/** ACM_PLAY wParam: repeat forever (Animate_Play -1). */
const REPEAT_FOREVER = 0xFFFFFFFF;

const WM_COMMAND = 0x0111;

interface AnimateState {
    filePath: string;
    /** Resolved VFS path (C:\\media\\logo.AVI) after ROM lookup. */
    vfsPath: string;
    playing: boolean;
    playPending: boolean;
    startInFlight: boolean;
    notifiedStart: boolean;
    repeats: number;
    loopsDone: number;
    engineHandle: number;
    frameIndex: number;
    frameDurationMs: number;
    width: number;
    height: number;
    playbackTimer?: ReturnType<typeof setTimeout>;
    stubTimer?: ReturnType<typeof setTimeout>;
}

const animateStates = new Map<number, AnimateState>();

let classesRegistered = false;

function emptyState(filePath = '', vfsPath = ''): AnimateState {
    return {
        filePath,
        vfsPath,
        playing: false,
        playPending: false,
        startInFlight: false,
        notifiedStart: false,
        repeats: 0,
        loopsDone: 0,
        engineHandle: 0,
        frameIndex: 0,
        frameDurationMs: 66,
        width: 0,
        height: 0,
    };
}

export function ensureAnimateControlClasses(): void {
    if (classesRegistered) return;
    classesRegistered = true;
    // Common-control HWNDs participate in USER's system-control paint ordering.
    // In particular, ACS_TRANSPARENT must leave the parent's pixels underneath;
    // treating the control as a guest-owned child punches an unpainted hole there.
    registerBuiltinClass('SysAnimate32', {
        cbWndExtra: 4,
        controlClass: 'SysAnimate32',
        externalPaintManaged: true,
    });
    registerBuiltinClass('SysAnimate32_class', {
        cbWndExtra: 4,
        controlClass: 'SysAnimate32_class',
        externalPaintManaged: true,
    });
}

export function isAnimateControlWindow(win: WindowInfo | undefined): boolean {
    if (!win) return false;
    const n = (win.nativeClassName ?? win.systemControlClass ?? '').toLowerCase();
    return n === 'sysanimate32' || n === 'sysanimate32_class';
}

function cancelTimers(st: AnimateState | undefined): void {
    if (!st) return;
    if (st.playbackTimer) {
        clearTimeout(st.playbackTimer);
        st.playbackTimer = undefined;
    }
    if (st.stubTimer) {
        clearTimeout(st.stubTimer);
        st.stubTimer = undefined;
    }
}

function stopPlayback(hwnd: number, notifyStop: boolean): void {
    const st = animateStates.get(hwnd);
    if (!st) return;

    cancelTimers(st);
    st.playing = false;
    st.playPending = false;
    st.startInFlight = false;
    st.notifiedStart = false;

    if (st.engineHandle > 0) {
        videoEngine.close(st.engineHandle);
        st.engineHandle = 0;
    }

    if (notifyStop) {
        const win = windows.get(hwnd);
        if (win) notifyParentStopped(hwnd, win);
    }
}

function notifyParentStopped(hwnd: number, win: WindowInfo): void {
    const parentHwnd = win.parent;
    if (!parentHwnd) return;
    const controlId = win.controlId ?? 0;
    const wParam = ((ACN_STOP << 16) | (controlId & 0xFFFF)) >>> 0;
    Logger.log(LogCategory.USER32,
        `SysAnimate32: ACN_STOP notify parent=0x${parentHwnd.toString(16)} id=${controlId}`);
    System.getInstance().windowManager.postMessage(parentHwnd, WM_COMMAND, wParam, hwnd);
    System.getInstance().scheduler.wakeMessageWaiters();
}

function notifyParentStart(hwnd: number, win: WindowInfo): void {
    const parentHwnd = win.parent;
    if (!parentHwnd) return;
    const controlId = win.controlId ?? 0;
    const wParam = ((ACN_START << 16) | (controlId & 0xFFFF)) >>> 0;
    Logger.log(LogCategory.USER32,
        `SysAnimate32: ACN_START notify parent=0x${parentHwnd.toString(16)} id=${controlId}`);
    System.getInstance().windowManager.postMessage(parentHwnd, WM_COMMAND, wParam, hwnd);
    System.getInstance().scheduler.wakeMessageWaiters();
}

function resolveMediaVfsPath(guestPath: string): string | null {
    const vfs = System.getInstance().fileSystem;
    const resolved = vfs.resolveRomMediaPath(guestPath);
    if (resolved) return resolved;

    // Fallback: direct resolvePath (overlay / exact ROM key)
    let vfsPath = guestPath.replace(/\\/g, '/');
    if (vfsPath.match(/^[A-Z]:/i)) {
        vfsPath = `C:${vfsPath.substring(2).replace(/\//g, '\\')}`;
    } else {
        vfsPath = vfs.resolvePath(vfsPath);
    }
    return vfs.getFileSize(vfsPath) > 0 ? vfsPath : null;
}

async function readVfsFile(vfsPath: string): Promise<Uint8Array | null> {
    try {
        const vfs = System.getInstance().fileSystem;
        const size = vfs.getFileSize(vfsPath);
        if (size <= 0) {
            Logger.warn(LogCategory.USER32, `SysAnimate32: readVfsFile("${vfsPath}") size=${size}`);
            return null;
        }
        const LIMIT_BYTES = 256 * 1024 * 1024;
        if (size > LIMIT_BYTES) {
            Logger.warn(LogCategory.USER32, `SysAnimate32: readVfsFile("${vfsPath}") too large (${size})`);
            return null;
        }
        const GENERIC_READ = 0x80000000;
        const OPEN_EXISTING = 3;
        const handle = await vfs.open(vfsPath, GENERIC_READ, OPEN_EXISTING);
        if (!handle) return null;
        return await vfs.read(handle, size);
    } catch (e) {
        Logger.error(LogCategory.USER32, `SysAnimate32: readVfsFile("${vfsPath}") error: ${e}`);
        return null;
    }
}

function shouldLoopAgain(st: AnimateState): boolean {
    const r = st.repeats >>> 0;
    if (r === REPEAT_FOREVER || r === 0xFFFF) return true;
    if (r <= 1) return false;
    return st.loopsDone + 1 < r;
}

function resumeDeferredPlayback(hwnd: number, win: WindowInfo): void {
    const st = animateStates.get(hwnd);
    if (!st || st.engineHandle <= 0 || st.startInFlight) return;

    st.playing = true;
    st.playPending = false;

    if (!st.notifiedStart) {
        st.notifiedStart = true;
        notifyParentStart(hwnd, win);
    }

    Logger.log(LogCategory.USER32,
        `SysAnimate32: resume decode hwnd=0x${hwnd.toString(16)} "${st.filePath}"`);
    decodeOneFrame(hwnd);
}

export function formatAnimateDiagnosticSnapshot(): string {
    if (animateStates.size === 0) return 'animate=none';
    const parts: string[] = [];
    for (const [hwnd, st] of animateStates) {
        const win = windows.get(hwnd);
        parts.push(
            `0x${hwnd.toString(16)} vis=${win?.visible ? 1 : 0} ` +
            `file="${st.filePath}" pending=${st.playPending ? 1 : 0} ` +
            `playing=${st.playing ? 1 : 0} inFlight=${st.startInFlight ? 1 : 0} ` +
            `engine=${st.engineHandle} notified=${st.notifiedStart ? 1 : 0}`,
        );
    }
    return `animate=[${parts.join('; ')}]`;
}

function scheduleStubPlayback(hwnd: number, win: WindowInfo, repeats: number): void {
    const st = animateStates.get(hwnd);
    if (!st) return;
    if (!st.notifiedStart) {
        st.notifiedStart = true;
        notifyParentStart(hwnd, win);
    }
    const durationMs = repeats === 0xFFFFFFFF || repeats === 0xFFFF
        ? 8000
        : Math.min(15000, 3000 + (repeats * 2000));
    st.stubTimer = setTimeout(() => {
        const cur = animateStates.get(hwnd);
        if (!cur?.playing) return;
        stopPlayback(hwnd, true);
    }, durationMs);
}

function paintFrameToControl(hwnd: number, bgra: Uint8Array, width: number, height: number): void {
    const win = windows.get(hwnd);
    if (!win?.visible) return;

    const { x, y } = getAbsoluteWindowPosition(win);
    const destW = win.width > 0 ? win.width : width;
    const destH = win.height > 0 ? win.height : height;
    System.getInstance().gdiContext.drawBgraToOverlayRect(x, y, destW, destH, bgra, width, height);
}

function scheduleNextFrame(hwnd: number, delayMs: number): void {
    const st = animateStates.get(hwnd);
    if (!st?.playing) return;
    st.playbackTimer = setTimeout(() => decodeOneFrame(hwnd), Math.max(1, delayMs));
}

function decodeOneFrame(hwnd: number): void {
    const st = animateStates.get(hwnd);
    const win = windows.get(hwnd);
    if (!st?.playing || !win?.visible || st.engineHandle <= 0) return;

    const startMs = performance.now();
    const ok = videoEngine.doFrame(st.engineHandle);
    const decodeElapsed = performance.now() - startMs;
    if (decodeElapsed > 1) {
        TimeService.getInstance().advanceVirtualTime(decodeElapsed);
    }

    if (!ok) {
        if (shouldLoopAgain(st)) {
            st.loopsDone += 1;
            st.frameIndex = 0;
            videoEngine.gotoFrame(st.engineHandle, 0);
            Logger.verbose(LogCategory.USER32,
                `SysAnimate32: loop ${st.loopsDone} hwnd=0x${hwnd.toString(16)} repeats=${st.repeats >>> 0}`);
            scheduleNextFrame(hwnd, st.frameDurationMs);
            return;
        }
        Logger.log(LogCategory.USER32, `SysAnimate32: playback EOF hwnd=0x${hwnd.toString(16)}`);
        stopPlayback(hwnd, true);
        return;
    }

    const bgra = videoEngine.getFrameBgra(st.engineHandle);
    if (bgra) {
        const copy = new Uint8Array(bgra.length);
        copy.set(bgra);

        paintFrameToControl(hwnd, copy, st.width, st.height);
    }

    videoEngine.nextFrame(st.engineHandle);
    st.frameIndex += 1;
    scheduleNextFrame(hwnd, st.frameDurationMs);
}

async function startPlayback(hwnd: number, win: WindowInfo): Promise<void> {
    const st = animateStates.get(hwnd);
    if (!st || st.startInFlight || st.engineHandle > 0) return;
    if (!st.playPending && !st.playing) return;

    st.startInFlight = true;
    st.playing = true;

    try {
        const vfsPath = st.vfsPath || resolveMediaVfsPath(st.filePath);
        if (!vfsPath) {
            Logger.warn(LogCategory.USER32,
                `SysAnimate32: "${st.filePath}" not in ROM/VFS (need media/logo.avi in bundle) → stub`);
            scheduleStubPlayback(hwnd, win, st.repeats);
            return;
        }
        st.vfsPath = vfsPath;

        const fileBytes = await readVfsFile(vfsPath);
        if (!fileBytes) {
            Logger.warn(LogCategory.USER32,
                `SysAnimate32: failed to read "${vfsPath}" → stub playback`);
            scheduleStubPlayback(hwnd, win, st.repeats);
            return;
        }

        const engineHandle = await videoEngine.open(fileBytes);
        const info = videoEngine.getInfo(engineHandle);
        if (!info) {
            videoEngine.close(engineHandle);
            scheduleStubPlayback(hwnd, win, st.repeats);
            return;
        }

        st.engineHandle = engineHandle;
        st.width = info.width;
        st.height = info.height;
        st.frameIndex = 0;
        st.loopsDone = 0;
        st.frameDurationMs = info.fps > 0 ? (1000 / info.fps) : 66;

        const curWin = windows.get(hwnd);
        const curSt = animateStates.get(hwnd);
        if (!curSt?.playing && !curSt?.playPending) {
            videoEngine.close(engineHandle);
            st.engineHandle = 0;
            st.playing = false;
            st.playPending = false;
            return;
        }

        if (!curWin?.visible) {
            st.playPending = true;
            st.playing = false;
            if (!st.notifiedStart) {
                st.notifiedStart = true;
                notifyParentStart(hwnd, win);
            }
            Logger.log(LogCategory.USER32,
                `SysAnimate32: engine ready while hidden hwnd=0x${hwnd.toString(16)} — ACN_START sent, decode deferred`);
            return;
        }

        if (!st.notifiedStart) {
            st.notifiedStart = true;
            notifyParentStart(hwnd, win);
        }

        Logger.log(LogCategory.USER32,
            `SysAnimate32: decode started hwnd=0x${hwnd.toString(16)} ` +
            `guest="${st.filePath}" vfs="${vfsPath}" ${info.width}×${info.height} ` +
            `fps=${info.fps.toFixed(1)} codec="${info.codecName}"`);

        decodeOneFrame(hwnd);
    } catch (e) {
        Logger.error(LogCategory.USER32,
            `SysAnimate32: VideoEngine.open failed for "${st.filePath}": ${e}`);
        scheduleStubPlayback(hwnd, win, st.repeats);
    } finally {
        const cur = animateStates.get(hwnd);
        if (cur) cur.startInFlight = false;
    }
}

/** Start decode when play is pending and the window is visible. */
function tryStartPlayback(hwnd: number): void {
    const st = animateStates.get(hwnd);
    const win = windows.get(hwnd);
    if (!st || !win || !st.playPending) return;
    if (!st.filePath || st.startInFlight) return;

    if (st.engineHandle > 0) {
        if (win.visible) resumeDeferredPlayback(hwnd, win);
        return;
    }

    if (!win.visible) return;
    void startPlayback(hwnd, win);
}

function hasAutoPlayStyle(win: WindowInfo | undefined): boolean {
    return !!win && ((win.style >>> 0) & ACS_AUTOPLAY) !== 0;
}

function openAnimateFile(hwnd: number, path: string): number {
    if (!path) return 0;

    stopPlayback(hwnd, false);
    const vfsPath = resolveMediaVfsPath(path);
    const st = emptyState(path, vfsPath ?? '');
    const win = windows.get(hwnd);
    // MSDN: ACS_AUTOPLAY begins playing immediately after ACM_OPEN; otherwise ACM_PLAY.
    if (hasAutoPlayStyle(win)) {
        st.playPending = true;
        st.repeats = REPEAT_FOREVER;
    }
    animateStates.set(hwnd, st);

    Logger.log(LogCategory.USER32,
        `SysAnimate32 ACM_OPEN hwnd=0x${hwnd.toString(16)} guest="${path}"` +
        (vfsPath ? ` vfs="${vfsPath}" size=${System.getInstance().fileSystem.getFileSize(vfsPath)}` : ' (NOT IN BUNDLE)') +
        (hasAutoPlayStyle(win) ? ' ACS_AUTOPLAY' : ''));

    if (win && st.playPending) tryStartPlayback(hwnd);

    // Win32: FALSE if file missing.
    return vfsPath ? 1 : 0;
}

/** Called from ShowWindow when SysAnimate32 becomes visible/hidden. */
export function onAnimateShowWindow(hwnd: number, nCmdShow: number): void {
    const st = animateStates.get(hwnd);
    if (!st?.filePath) return;

    if (nCmdShow === 0) {
        if (st.startInFlight) {
            Logger.log(LogCategory.USER32,
                `SysAnimate32: ShowWindow(0x${hwnd.toString(16)}, SW_HIDE) during startInFlight — defer cancel`);
            return;
        }
        Logger.log(LogCategory.USER32,
            `SysAnimate32: ShowWindow(0x${hwnd.toString(16)}, SW_HIDE) — stop`);
        stopPlayback(hwnd, false);
        return;
    }

    // Show alone does not start playback — only resume a pending/open autoplay or ACM_PLAY.
    if (!st.playPending && !st.playing) return;
    Logger.log(LogCategory.USER32,
        `SysAnimate32: ShowWindow(0x${hwnd.toString(16)}, ${nCmdShow}) → resume "${st.filePath}" repeats=${st.repeats >>> 0}`);
    tryStartPlayback(hwnd);
}

/** Handle ACM_* SendMessage for SysAnimate32 windows. Returns null if not handled. */
export function handleAnimateMessage(
    hwnd: number,
    msg: number,
    wParam: number,
    lParam: number,
    mem: Uint8Array,
): number | null {
    const win = windows.get(hwnd);
    if (!isAnimateControlWindow(win)) return null;

    switch (msg) {
        case ACM_OPENA: {
            const path = lParam ? Marshaler.readString(mem, lParam) : '';
            return openAnimateFile(hwnd, path);
        }
        case ACM_OPENW: {
            const path = lParam ? Marshaler.readWideString(mem, lParam) : '';
            if (path) {
                return openAnimateFile(hwnd, path);
            }
            Logger.verbose(LogCategory.USER32,
                `SysAnimate32 ACM_OPENW hwnd=0x${hwnd.toString(16)} (empty probe, keeping prior path)`);
            return 1;
        }
        case ACM_PLAY: {
            const prev = animateStates.get(hwnd) ?? emptyState();
            cancelTimers(prev);
            prev.playing = true;
            prev.playPending = true;
            prev.repeats = wParam >>> 0;
            prev.loopsDone = 0;
            animateStates.set(hwnd, prev);
            Logger.log(LogCategory.USER32,
                `SysAnimate32 ACM_PLAY hwnd=0x${hwnd.toString(16)} repeats=${prev.repeats} path="${prev.filePath}"`);
            tryStartPlayback(hwnd);
            return 1;
        }
        case ACM_STOP: {
            Logger.log(LogCategory.USER32, `SysAnimate32 ACM_STOP hwnd=0x${hwnd.toString(16)}`);
            stopPlayback(hwnd, false);
            return 1;
        }
        case ACM_CLOSE: {
            Logger.log(LogCategory.USER32, `SysAnimate32 ACM_CLOSE hwnd=0x${hwnd.toString(16)}`);
            stopPlayback(hwnd, false);
            animateStates.delete(hwnd);
            return 1;
        }
        default:
            if (msg === ACM_ISPLAYING) {
                return animateStates.get(hwnd)?.playing ? 1 : 0;
            }
            return null;
    }
}

export function clearAnimateState(hwnd: number): void {
    stopPlayback(hwnd, false);
    animateStates.delete(hwnd);
}
