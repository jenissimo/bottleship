/**
 * D3D device cursor — IDirect3DDevice8/9 SetCursorProperties / SetCursorPosition / ShowCursor.
 *
 * A D3D app has TWO pointers: the Win32 one (SetCursor/ShowCursor) and the device cursor,
 * which the runtime realises in one of two ways. Which kind it picks decides whether
 * SetCursorPosition touches the OS pointer at all:
 *   HARDWARE — a real OS cursor (CreateIconIndirect + SetCursor). Picked when the bitmap is
 *     exactly the system cursor metric, or whenever the device is windowed — the runtime
 *     cannot composite outside its own window. SetCursorPosition IS SetCursorPos, so
 *     GetCursorPos follows it.
 *   SOFTWARE — the runtime composites the sprite into the frame; only a fullscreen device
 *     with an off-metric bitmap gets one. SetCursorPosition moves the SPRITE only: the OS
 *     pointer does not move and GetCursorPos does not follow.
 * Ground truth: dxvk d3d9_device.cpp SetCursorProperties + d3d9_cursor.cpp UpdateCursor;
 * wined3d device.c wined3d_device_set_cursor_position / _show_cursor.
 *
 * State is per device — several devices in one process are legal, and a cursor does not
 * outlive the device state that owns it (wined3d drops cursor_texture in both reset and
 * uninit_3d). The host draws ONE pointer, so the device that most recently installed or
 * showed a cursor is the one it is asked to draw.
 */
import { System } from "./system";
import type { HostCursorImage } from "./system";
import { syncHostCursorToGuestState, warpGuestCursorTo } from "../modules/user32/shared-state";

/** SM_CXCURSOR / SM_CYCURSOR as user32 reports them (modules/user32/system.ts). */
const OS_CURSOR_WIDTH = 32;
const OS_CURSOR_HEIGHT = 32;

interface DeviceCursor {
    image: HostCursorImage | null;
    visible: boolean;
    hardware: boolean;
    /** Screen-space sprite position; the only truth about a software cursor's location. */
    x: number;
    y: number;
}

const cursors: Map<number, DeviceCursor> = new Map();
let activeDevice = 0;

function cursorFor(devicePtr: number): DeviceCursor {
    let cursor = cursors.get(devicePtr);
    if (!cursor) {
        cursor = { image: null, visible: false, hardware: true, x: 0, y: 0 };
        cursors.set(devicePtr, cursor);
    }
    return cursor;
}

/** True when the given extents make the runtime install a real OS cursor. */
export function isHardwareDeviceCursor(width: number, height: number, windowed: boolean): boolean {
    return windowed || (width === OS_CURSOR_WIDTH && height === OS_CURSOR_HEIGHT);
}

/** SetCursorProperties: install the shape and fix the kind. Visibility belongs to ShowCursor. */
export function setDeviceCursorImage(devicePtr: number, image: HostCursorImage | null, windowed: boolean): void {
    const cursor = cursorFor(devicePtr);
    cursor.image = image;
    if (image) {
        cursor.hardware = isHardwareDeviceCursor(image.width, image.height, windowed);
        activeDevice = devicePtr;
    }
    publishSpritePosition();
    syncHostCursorToGuestState();
}

/**
 * ShowCursor(bShow) — returns the PREVIOUS visibility. A device with no cursor installed
 * cannot be shown and its visibility does not change (d3d9 conformance test: "not enabled
 * without a surface").
 */
export function showDeviceCursor(devicePtr: number, show: boolean): boolean {
    const cursor = cursorFor(devicePtr);
    const prev = cursor.visible;
    if (!cursor.image) return prev;
    // First show adopts the OS pointer position, so the sprite starts where the user left it.
    if (show && !prev) {
        const pos = System.getInstance().inputManager.getMouseState();
        cursor.x = pos.x;
        cursor.y = pos.y;
    }
    cursor.visible = show;
    if (show) activeDevice = devicePtr;
    publishSpritePosition();
    syncHostCursorToGuestState();
    return prev;
}

/** SetCursorPosition: always records the sprite position; only a hardware cursor also moves
 *  the OS pointer (warpGuestCursorTo owns the no-displacement case). */
export function setDeviceCursorPosition(devicePtr: number, x: number, y: number): void {
    const cursor = cursorFor(devicePtr);
    cursor.x = x;
    cursor.y = y;
    if (cursor.hardware) warpGuestCursorTo(x, y);
    else publishSpritePosition();
}

/** Only a visible software cursor has a position of its own; otherwise the host draws at
 *  the pointer. Called from every mutator that can change which of the two applies. */
function publishSpritePosition(): void {
    System.getInstance().requestHostCursorPosition(getActiveDeviceCursorPosition());
}

export function isDeviceCursorVisible(): boolean {
    return !!cursors.get(activeDevice)?.visible;
}

/** The shape the host must draw, or null while no device is driving its cursor. */
export function getActiveDeviceCursor(): HostCursorImage | null {
    const cursor = cursors.get(activeDevice);
    return cursor?.visible ? cursor.image : null;
}

/** Where a SOFTWARE device cursor must be drawn: the OS pointer never followed it, so the
 *  host cannot infer the sprite's position from the pointer. null for a hardware cursor,
 *  whose position IS the pointer's. */
export function getActiveDeviceCursorPosition(): { x: number; y: number } | null {
    const cursor = cursors.get(activeDevice);
    if (!cursor?.visible || !cursor.image || cursor.hardware) return null;
    return { x: cursor.x, y: cursor.y };
}

/** Device teardown or Reset — the cursor dies with the device state that owns it. */
export function releaseDeviceCursor(devicePtr: number): void {
    if (!cursors.delete(devicePtr)) return;
    if (activeDevice === devicePtr) activeDevice = 0;
    publishSpritePosition();
    syncHostCursorToGuestState();
}

/** Process teardown. */
export function resetDeviceCursor(): void {
    cursors.clear();
    activeDevice = 0;
    publishSpritePosition();
    syncHostCursorToGuestState();
}
