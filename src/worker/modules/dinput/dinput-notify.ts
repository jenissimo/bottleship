/**
 * IDirectInputDevice::SetEventNotification state.
 *
 * The contract has two halves: the return code (NULL clears; DirectInput refuses the
 * change while the device is acquired) and the SIGNAL. An app whose input thread blocks
 * on the event never polls, so a DI_OK that is never followed by a signal parks that
 * thread forever. The event is signalled only for devices that are both armed and
 * acquired, matching what DirectInput drives from a device's buffer gaining data.
 */

export const DI_OK = 0x00000000;
/** S_FALSE. Acquire() on an ALREADY-acquired device answers this and does nothing else
 *  (Wine dinput_device_Acquire; dinput.h DI_NOEFFECT). It is a SUCCESS code, so a caller
 *  that only checks FAILED() is unaffected — but one that re-Acquires every frame (CryEngine's
 *  CryInput does, right before each GetDeviceState) uses it to tell "still mine" from
 *  "just re-taken", and answering DI_OK makes every frame look like a fresh acquisition. */
export const DI_NOEFFECT = 0x00000001;
export const DIERR_INVALIDPARAM = 0x80070057;
/** MAKE_HRESULT(SEVERITY_ERROR, FACILITY_WIN32, ERROR_BUSY) — dinput.h DIERR_ACQUIRED. */
export const DIERR_ACQUIRED = 0x800700aa;

/** The device state this contract touches; the COM device object supplies the rest. */
export interface NotifiableDevice {
    acquired: boolean;
    notifyEvent: number;
}

export interface DInputNotifyOptions {
    /** Signal a guest event handle (scheduler.setEvent in the live system). */
    setEvent(handle: number): void;
}

export class DInputNotifyRegistry {
    private readonly armed = new Set<NotifiableDevice>();

    constructor(private readonly options: DInputNotifyOptions) {}

    /** HRESULT SetEventNotification(HANDLE hEvent). */
    setEventNotification(device: NotifiableDevice | null, hEvent: number): number {
        if (!device) return DIERR_INVALIDPARAM;
        if (device.acquired) return DIERR_ACQUIRED;

        device.notifyEvent = hEvent >>> 0;
        if (device.notifyEvent) this.armed.add(device);
        else this.armed.delete(device);
        return DI_OK;
    }

    /** Device teardown (final Release): stop walking it. */
    forget(device: NotifiableDevice): void {
        this.armed.delete(device);
    }

    isArmed(device: NotifiableDevice): boolean {
        return this.armed.has(device);
    }

    get armedCount(): number {
        return this.armed.size;
    }

    /** One poll produced buffered device data. */
    signal(): void {
        for (const device of this.armed) {
            if (device.notifyEvent && device.acquired) this.options.setEvent(device.notifyEvent);
        }
    }

    /**
     * Process reset: the devices are gone and their handles will be recycled, so anything
     * still armed would signal an unrelated event object in the next process.
     */
    reset(): void {
        this.armed.clear();
    }
}
