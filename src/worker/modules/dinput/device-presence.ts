/**
 * Registry of DirectInput devices whose backing hardware can disappear
 * (joystick/gamepad). When the pad is unplugged, an acquired device must start
 * reporting DIERR_INPUTLOST until the app re-Acquires — that return code is the
 * whole hot-plug contract a DI app watches for.
 *
 * Leaf module (no imports) so the input layer can raise the event without pulling
 * in the dinput module graph.
 */

/** The slice of a DirectInput device object this tracker touches. */
export interface LosableDevice {
    acquired: boolean;
    inputLost: boolean;
}

const devices = new Set<LosableDevice>();

export function trackLosableDevice(device: LosableDevice): void {
    devices.add(device);
}

export function untrackLosableDevice(device: LosableDevice): void {
    devices.delete(device);
}

/** Mark every acquired joystick/gamepad as lost. Unacquired devices are untouched:
 *  a later Acquire is the app's own decision point, and it clears the flag. */
export function markJoystickInputLost(): void {
    for (const device of devices) {
        if (device.acquired) device.inputLost = true;
    }
}

export function resetLosableDevices(): void {
    devices.clear();
}
