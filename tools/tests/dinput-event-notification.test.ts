/**
 * IDirectInputDevice::SetEventNotification — the contract an app's input thread waits on.
 *
 * The interesting half is not the return code but the SIGNAL: an app that blocks on the
 * event never polls, so a DI_OK that is never followed by a signal parks that thread
 * forever. These tests pin both halves against the shipped registry.
 */
import { describe, expect, test } from "bun:test";
import { dinputModule } from "../../src/worker/api/dinput.api";
import {
    DInputNotifyRegistry,
    DI_OK,
    DIERR_ACQUIRED,
    DIERR_INVALIDPARAM,
    type NotifiableDevice,
} from "../../src/worker/modules/dinput/dinput-notify";

function device(): NotifiableDevice {
    return { acquired: false, notifyEvent: 0 };
}

/** The registry plus the handles it signalled, so a test can assert on the signal. */
function makeRegistry() {
    const signalled: number[] = [];
    const registry = new DInputNotifyRegistry({ setEvent: h => signalled.push(h) });
    return { registry, signalled };
}

describe("dinput descriptor", () => {
    test("SetEventNotification takes (this, hEvent)", () => {
        // Methods live on the interface tables, not the flat export list.
        const methods = dinputModule.interfaces.flatMap(iface => iface.methods);
        const named = methods.filter(m => m.name === "SetEventNotification");
        expect(named.length).toBeGreaterThan(0);
        for (const m of named) expect(m.params.length).toBe(2);
    });
});

describe("SetEventNotification", () => {
    test("DIERR_ACQUIRED is ERROR_BUSY, not ERROR_ACCESS_DENIED", () => {
        // 0x80070005 is DIERR_OTHERAPPHASPRIO/DIERR_READONLY — a different, meaningful error.
        expect(DIERR_ACQUIRED).toBe(0x800700aa);
    });

    test("arms the handle and refuses the change while acquired", () => {
        const { registry } = makeRegistry();
        const dev = device();

        expect(registry.setEventNotification(dev, 0x1234)).toBe(DI_OK);
        expect(dev.notifyEvent).toBe(0x1234);

        dev.acquired = true;
        expect(registry.setEventNotification(dev, 0x5678)).toBe(DIERR_ACQUIRED);
        expect(dev.notifyEvent).toBe(0x1234);
    });

    test("a missing device is a parameter error", () => {
        const { registry } = makeRegistry();
        expect(registry.setEventNotification(null, 0x1234)).toBe(DIERR_INVALIDPARAM);
    });

    test("NULL clears the notification", () => {
        const { registry } = makeRegistry();
        const dev = device();

        registry.setEventNotification(dev, 0x1234);
        expect(registry.armedCount).toBe(1);
        expect(registry.setEventNotification(dev, 0)).toBe(DI_OK);
        expect(dev.notifyEvent).toBe(0);
        expect(registry.armedCount).toBe(0);
    });

    test("signals only devices that are armed AND acquired", () => {
        const { registry, signalled } = makeRegistry();

        const waiting = device();
        registry.setEventNotification(waiting, 0x11);
        waiting.acquired = true;

        const unacquired = device();
        registry.setEventNotification(unacquired, 0x22);

        registry.signal();
        expect(signalled).toEqual([0x11]);
    });

    test("a device that never armed a handle is never signalled", () => {
        const { registry, signalled } = makeRegistry();
        const silent = device();
        silent.acquired = true;

        registry.signal();
        expect(signalled).toEqual([]);
        expect(silent.notifyEvent).toBe(0);
    });

    test("only teardown forgets a device — a non-final Release must not", () => {
        const { registry, signalled } = makeRegistry();
        const dev = device();
        registry.setEventNotification(dev, 0x33);
        dev.acquired = true;

        registry.signal();
        expect(signalled).toEqual([0x33]);

        registry.forget(dev);
        registry.signal();
        expect(signalled).toEqual([0x33]);
        expect(registry.isArmed(dev)).toBe(false);
    });

    test("reset drops every registration so recycled handles are not signalled", () => {
        const { registry, signalled } = makeRegistry();
        const dev = device();
        registry.setEventNotification(dev, 0x44);
        dev.acquired = true;

        registry.reset();
        registry.signal();
        expect(signalled).toEqual([]);
        expect(registry.armedCount).toBe(0);
    });
});
