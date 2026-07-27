/**
 * D3D device cursor — IDirect3DDevice8/9 SetCursorProperties + ShowCursor.
 *
 * A D3D window has TWO pointers: the Win32 one (SetCursor/ShowCursor) and the
 * device cursor the runtime composites over the frame. A game that wants a themed
 * pointer uploads a bitmap here, enables it, and hides the Win32 one — so with this
 * unimplemented such an app has NO pointer at all. Real Windows draws the device
 * cursor regardless of the Win32 display count, which is why it wins in the user32
 * sync point.
 *
 * One cursor for both API versions: the host has a single pointer, and no app drives
 * a d3d8 and a d3d9 device at once. Ground truth: wined3d turns the bitmap into the
 * cursor the window system draws (set_cursor_properties → CreateIconIndirect +
 * SetCursor) — the same channel we forward it through.
 */
import type { HostCursorImage } from "./system";

let image: HostCursorImage | null = null;
let visible = false;

/** SetCursorProperties: install the shape. Does not change visibility (ShowCursor owns it). */
export function setDeviceCursorImage(next: HostCursorImage | null): void {
    image = next;
}

/** ShowCursor(bShow) — returns the PREVIOUS visibility, as the D3D method must. */
export function showDeviceCursor(show: boolean): boolean {
    const prev = visible;
    visible = show;
    return prev;
}

export function isDeviceCursorVisible(): boolean {
    return visible;
}

/** The shape the host must draw, or null while the app is not driving the device cursor. */
export function getActiveDeviceCursor(): HostCursorImage | null {
    return visible ? image : null;
}

/** Device teardown: the cursor texture does not outlive the device that owns it. */
export function resetDeviceCursor(): void {
    image = null;
    visible = false;
}
