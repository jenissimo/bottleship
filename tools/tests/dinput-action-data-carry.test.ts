/**
 * Action-mapped GetDeviceData must not LOSE edges it has already polled.
 *
 * pollActionMapEntries is destructive — it advances every entry's lastValue — so an edge
 * that does not fit the caller's array, or a count-only/PEEK call, cannot be recomputed on
 * the next call. Dropping it and answering DI_BUFFEROVERFLOW is doubly wrong: the input is
 * gone AND the engine is told to flush its own input table (Painkiller's DIInputSystem
 * answers that error with Reset(), which clears the held-key mask).
 */
import { describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { INPUT_BUFFER_SIZE } from "../../src/input/sab-layout";
import { DInput } from "../../src/worker/modules/dinput/dinput";
import type { ActionMapEntry } from "../../src/worker/modules/dinput/dinput-action-helpers";

const DI_OK = 0;
const DI_BUFFEROVERFLOW = 1;
const DIDEVICEOBJECTDATA8_SIZE = 20;

const MEM_SIZE = 0x20000;
const RGDOD = 0x2000;
const PDWINOUT = 0x3000;
const ESP = 0x4000;
const CALLER_RET = 0x5c189e;

const mem = new Uint8Array(MEM_SIZE);
const view = new DataView(mem.buffer);

const dinput = new DInput();
(dinput as any).process = { getCurrentMemory: () => mem };

/** Two independent keyboard buttons — one poll can produce two edges. */
function actionMap(): ActionMapEntry[] {
    return [
        { uAppData: 1, semantic: 0, kind: "button", dwOfs: 0x1e, dik: 0x1e, lastValue: 0 }, // A
        { uAppData: 2, semantic: 0, kind: "button", dwOfs: 0x20, dik: 0x20, lastValue: 0 }, // D
    ];
}

function device() {
    return {
        acquired: true, isActionMapped: true, deviceType: "keyboard",
        actionMap: actionMap(), actionDataPending: [], actionDataOverflowed: false,
        seq: 0, mousePollPrevButtons: 0, mouseInitialized: false,
        lastDInputAccumX: 0, lastDInputAccumY: 0,
    } as any;
}

/** The ledger row the slow path maintains; the action-mapped path must keep the same one. */
function trafficRow() {
    return {
        getDeviceDataCalls: 0, notAcquired: 0, inputLost: 0, queryCountCalls: 0,
        peekCalls: 0, drains: 0, eventsDelivered: 0, emptyDrains: 0, overflows: 0,
        acquireCalls: 0, acquireNoEffect: 0, lastDeliveringCaller: 0,
    };
}

/** One GetDeviceData call asking for `maxItems`; returns hr plus what it reported. */
function getData(dev: any, maxItems: number, opts: { rgdod?: number; flags?: number; traffic?: any } = {}) {
    const rgdod = opts.rgdod ?? RGDOD;
    view.setUint32(PDWINOUT, maxItems, true);
    view.setUint32(ESP, CALLER_RET, true); // [ESP] = the guest return address the ledger names
    const hr = (dinput as any).getActionMappedDeviceData(
        dev, DIDEVICEOBJECTDATA8_SIZE, rgdod, PDWINOUT, opts.flags ?? 0, view,
        opts.traffic ?? trafficRow(), { esp: ESP },
    );
    const items = view.getUint32(PDWINOUT, true);
    const appData: number[] = [];
    for (let i = 0; i < items; i++) appData.push(view.getUint32(rgdod + i * DIDEVICEOBJECTDATA8_SIZE + 16, true));
    return { hr, items, appData };
}

function press(...vks: number[]) {
    const im = System.getInstance().inputManager;
    im.setInputBuffer(new SharedArrayBuffer(INPUT_BUFFER_SIZE));
    im.reset();
    for (const vk of vks) im.injectKey(vk, true);
}

describe("action-mapped GetDeviceData", () => {
    test("an edge that did not fit is carried to the next call, not lost", () => {
        press(0x41, 0x44); // A and D down => two edges from one poll
        const dev = device();

        const first = getData(dev, 1);
        expect(first.hr).toBe(DI_OK);          // a backlog is not an overflow
        expect(first.items).toBe(1);

        const second = getData(dev, 1);
        expect(second.hr).toBe(DI_OK);
        expect(second.items).toBe(1);
        expect(second.appData[0]).not.toBe(first.appData[0]);

        // Both actions were delivered exactly once, and nothing is left over.
        expect([...first.appData, ...second.appData].sort()).toEqual([1, 2]);
        expect(dev.actionDataPending.length).toBe(0);
    });

    test("a count-only call keeps the edges it counted", () => {
        press(0x41, 0x44);
        const dev = device();

        const count = getData(dev, 0, { rgdod: 0 });
        expect(count.hr).toBe(DI_OK);
        expect(count.items).toBe(2);

        const read = getData(dev, 8);
        expect(read.items).toBe(2);
        expect(read.appData.sort()).toEqual([1, 2]);
    });

    // §3.4 ledger rule: this path answers the same call as the buffered one, so a reader
    // asking "did the guest ever RECEIVE anything" must not have to know which path ran.
    // Counting only the calls made it report 0 events for a device that was delivering.
    test("the fast path updates the same traffic ledger as the buffered path", () => {
        press(0x41, 0x44);
        const dev = device();
        const traffic = trafficRow();

        const read = getData(dev, 8, { traffic });
        expect(read.items).toBe(2);
        expect(traffic.drains).toBe(1);
        expect(traffic.eventsDelivered).toBe(2);
        expect(traffic.emptyDrains).toBe(0);
        expect(traffic.lastDeliveringCaller).toBe(CALLER_RET);

        // A quiet poll is an empty drain, not a silent one.
        const quiet = getData(dev, 8, { traffic });
        expect(quiet.items).toBe(0);
        expect(traffic.drains).toBe(2);
        expect(traffic.eventsDelivered).toBe(2);
        expect(traffic.emptyDrains).toBe(1);
    });

    test("count-only and PEEK are accounted as their own calls, not as drains", () => {
        press(0x41, 0x44);
        const dev = device();
        const traffic = trafficRow();

        getData(dev, 0, { rgdod: 0, traffic });       // count-only
        getData(dev, 8, { flags: 0x1, traffic });      // DIGDD_PEEK
        expect(traffic.queryCountCalls).toBe(1);
        expect(traffic.peekCalls).toBe(1);
        expect(traffic.drains).toBe(0);
        expect(traffic.eventsDelivered).toBe(0);
    });

    test("only a real refusal reports DI_BUFFEROVERFLOW", () => {
        press(0x41, 0x44);
        const dev = device();
        // Pre-fill past the carry bound so the poll's own edges have nowhere to go.
        for (let i = 0; i < 64; i++) dev.actionDataPending.push({ entry: dev.actionMap[0], dwData: 0 });

        const hit = getData(dev, 1);
        expect(hit.hr).toBe(DI_BUFFEROVERFLOW);
        // Reported once.
        expect(getData(dev, 1).hr).toBe(DI_OK);
    });
});
