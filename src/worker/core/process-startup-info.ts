/**
 * STARTUPINFO as the parent passed it, as a child sees it.
 *
 * CreateProcess copies the caller's lpStartupInfo into the child's request; the child
 * hands that copy back through GetStartupInfoA/W. Everything here is already copied
 * out of the parent's memory, so nothing points into another process.
 *
 * The std handles and STARTF_USESTDHANDLES are deliberately not modelled yet: the
 * child's handles are the ones the runtime gives it, not the ones the caller listed,
 * and pretending otherwise would report handles the guest cannot use.
 */

/** The subset of STARTUPINFO this build carries across a process start. */
export interface ProcessStartupInfo {
    dwFlags: number;
    wShowWindow: number;
    dwX: number;
    dwY: number;
    dwXSize: number;
    dwYSize: number;
    /** lpDesktop, copied out of the parent's memory ('' when it had none). */
    desktop: string;
    /** lpTitle, copied out of the parent's memory ('' when it had none). */
    title: string;
}

export const STARTF_USESHOWWINDOW = 0x00000001;

/** cb of a STARTUPINFOA/W: 11 DWORDs, 2 WORDs, 3 pointers. */
export const STARTUPINFO_SIZE = 68;

export const STARTUPINFO_OFFSETS = {
    cb: 0,
    lpReserved: 4,
    lpDesktop: 8,
    lpTitle: 12,
    dwX: 16,
    dwY: 20,
    dwXSize: 24,
    dwYSize: 28,
    dwXCountChars: 32,
    dwYCountChars: 36,
    dwFillAttribute: 40,
    dwFlags: 44,
    wShowWindow: 48,
    cbReserved2: 50,
    lpReserved2: 52,
    hStdInput: 56,
    hStdOutput: 60,
    hStdError: 64,
} as const;

interface StartupState {
    /** The parent's copy, or null for a process that was booted directly. */
    adopted: ProcessStartupInfo | null;
    /** Whether the first top-level ShowWindow can still resolve to wShowWindow. */
    showWindowPending: boolean;
    /** The child's own lpDesktop/lpTitle, placed in the current guest image. */
    strings: { key: string; desktop: number; title: number } | null;
}

/**
 * One literal rather than a set of module bindings, because all three fields belong to
 * one lifetime: the guest session. System.registerSessionState() adds resetProcessStartupInfo
 * to the reset walk, so a game switch clears them and no call site has to remember to.
 */
const state: StartupState = { adopted: null, showWindowPending: false, strings: null };

/** Take the parent's copy as this process's own. Called once, from the boot message. */
export function adoptProcessStartupInfo(info: ProcessStartupInfo | undefined): void {
    state.adopted = info ? { ...info } : null;
    state.showWindowPending = !!info && (info.dwFlags & STARTF_USESHOWWINDOW) !== 0;
    state.strings = null;
}

/** The parent's copy, or null for a process that was booted directly. */
export function getProcessStartupInfo(): ProcessStartupInfo | null {
    return state.adopted;
}

/**
 * The wShowWindow the first top-level ShowWindow resolves to, once.
 *
 * Wine's show_window spends STARTF_USESHOWWINDOW on the first ShowWindow of a window
 * that is neither a child nor owned (a popup only when it also carries a caption),
 * whatever command that call uses. The value replaces SW_SHOW, SW_SHOWNORMAL and
 * SW_SHOWDEFAULT only; an explicit SW_HIDE or SW_SHOWMAXIMIZED still wins. Later calls
 * are ordinary: an application that hides its own window after starting still hides it.
 */
export function takeStartupShowWindow(): number | null {
    if (!state.adopted || !state.showWindowPending) return null;
    state.showWindowPending = false;
    return state.adopted.wShowWindow;
}

/** Whether a ShowWindow still has a wShowWindow waiting for it. */
export function hasPendingStartupShowWindow(): boolean {
    return !!state.adopted && state.showWindowPending;
}

/**
 * The child's own copies of lpDesktop/lpTitle, allocated by `place` on first use.
 *
 * Windows keeps these strings for the life of the process, so a second GetStartupInfo
 * has to hand back the same addresses rather than allocating another pair. The key
 * names the pair of strings, so a different STARTUPINFO replaces them.
 */
export function cachedStartupStrings(
    key: string, place: () => { desktop: number; title: number },
): { desktop: number; title: number } {
    if (state.strings?.key === key) return state.strings;
    state.strings = { key, ...place() };
    return state.strings;
}

export function resetProcessStartupInfo(): void {
    state.adopted = null;
    state.showWindowPending = false;
    state.strings = null;
}

export interface StartupSessionState {
    showWindowPending: boolean;
    strings: { key: string; desktop: number; title: number } | null;
}

export function captureStartupSessionState(): StartupSessionState {
    return { showWindowPending: state.showWindowPending, strings: state.strings ? { ...state.strings } : null };
}

export function restoreStartupSessionState(saved: StartupSessionState): void {
    state.showWindowPending = saved.showWindowPending;
    state.strings = saved.strings ? { ...saved.strings } : null;
}
