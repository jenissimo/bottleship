import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import {
    createQueryExports,
    getD3D9QueryLedger,
    notifyDeviceSubmission,
    resetD3D9QueryLedger,
    tryFastGetData,
} from "../../src/worker/modules/d3d9/query";
import { devices, resetD3D9SharedState } from "../../src/worker/modules/d3d9/shared-state";
import { d3d9PerfAdd, getD3D9PerfSnapshot, resetD3D9Perf } from "../../src/worker/modules/d3d9/d3d9-perf";
import { gpuDeviceLifecycle } from "../../src/worker/core/gpu/gpu-device-lifecycle";
import { forgetLossTrackedDevice, registerLossTrackedDevice } from "../../src/worker/core/gpu/gpu-device-loss-contract";

const D3D_OK = 0;
const S_FALSE = 1;
const D3DQUERYTYPE_EVENT = 8;
const D3DQUERYTYPE_OCCLUSION = 9;
const D3DQUERYTYPE_VCACHE = 4;
const D3DQUERYTYPE_TIMESTAMP = 10;
const D3DQUERYTYPE_TIMESTAMPDISJOINT = 11;
const D3DQUERYTYPE_TIMESTAMPFREQ = 12;
const D3DQUERYTYPE_VERTEXSTATS = 6;
const D3DISSUE_BEGIN = 2;
const D3DISSUE_END = 1;
const D3DGETDATA_FLUSH = 1;
const D3DERR_DEVICELOST = 0x88760868;
const DEVICE = 0x100;
const QUERY_OUT = 0x300;
const DATA_OUT = 0x400;
const RIID = 0x500;
const QI_OUT = 0x520;

let originalProcess: unknown;
let memory: Uint8Array;
let nextSystemPtr = 0x1000;
let queryExports: Record<string, any>;
let drawCount = 0;

function call(name: string, ...args: number[]): number {
    return queryExports[name]!({ esp: 0 }, memory, args) as number;
}

beforeEach(() => {
    const system = System.getInstance();
    originalProcess = system.process;
    memory = new Uint8Array(0x200000);
    nextSystemPtr = 0x1f0000;
    drawCount = 0;
    const thunkGenerator = new ThunkGenerator();
    // Keep generated stubs/vtables inside the synthetic test memory.
    thunkGenerator.setBaseAddress(0x1000);
    system.process = {
        memory: {
            alloc(size: number) {
                const ptr = nextSystemPtr;
                nextSystemPtr += Math.max(4, size);
                return ptr;
            },
            allocAt: () => undefined,
            allocSystemBlock(size: number) {
                const ptr = nextSystemPtr;
                nextSystemPtr += Math.max(16, size);
                return ptr;
            },
            free: () => undefined,
            freeSystemBlock: () => undefined,
        },
        dispatcher: {
            registerModule: () => undefined,
            applyPendingRegistrations: () => undefined,
        },
        thunkGenerator,
        getCurrentMemory: () => memory,
    } as any;
    Mem.bind(() => memory, (address, size) => address >= 0 && address + size <= memory.length);
    resetD3D9SharedState();
    // resetD3D9SharedState intentionally clears the device registry; install the
    // minimal device identity the query implementation requires afterwards.
    devices.set(DEVICE, {
        getViewport: () => ({ width: 64, height: 32 }),
        getDrawCount: () => drawCount,
        resetSubsystemPerf: () => undefined,
    } as any);
    queryExports = createQueryExports();
    resetD3D9QueryLedger();
});

afterEach(() => {
    resetD3D9SharedState();
    System.getInstance().process = originalProcess as any;
});

describe("D3D9 query submission readiness", () => {
    test("QueryInterface and AddRef reject stale query pointers", () => {
        // IID_IDirect3DQuery9 in guest byte order.
        memory.set([0x60, 0x14, 0x77, 0xd9, 0x95, 0xa6, 0x26, 0x4f,
            0xbb, 0xd3, 0x27, 0xb8, 0x40, 0xb5, 0x41, 0xcc], RIID);
        expect(Mem.writeUint32(QI_OUT, 0xffffffff)).toBe(true);
        expect(call("IDirect3DQuery9_QueryInterface", 0xdead, RIID, QI_OUT)).toBe(0x80004002);
        expect(Mem.readUint32(QI_OUT)).toBe(0);
        expect(call("IDirect3DQuery9_AddRef", 0xdead)).toBe(0);

        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_QueryInterface", query, RIID, QI_OUT)).toBe(D3D_OK);
        expect(Mem.readUint32(QI_OUT)).toBe(query);
    });

    test("GetData implicitly ends an initial query and FLUSH advances its serial", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;

        expect(Mem.writeUint32(DATA_OUT, 0xdeadbeef)).toBe(true);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(S_FALSE);
        expect(Mem.readUint32(DATA_OUT)).toBe(0xdeadbeef);

        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, D3DGETDATA_FLUSH)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(1);
    });

    test("GetData preserves NULL/zero-sized output validation while reporting readiness", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_GetData", query, 0, 4, 0)).not.toBe(D3D_OK);
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_GetData", query, 0, 0, 0)).toBe(S_FALSE);
        notifyDeviceSubmission(DEVICE);
        expect(call("IDirect3DQuery9_GetData", query, 0, 0, 0)).toBe(D3D_OK);
    });

    test("VCACHE exposes DXVK's fixed payload and honors short buffers", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_VCACHE, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_GetDataSize", query)).toBe(16);
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);

        for (let i = 0; i < 16; i++) expect(Mem.writeUint8(DATA_OUT + i, 0xaa)).toBe(true);
        // VCACHE is an information query, not a GPU fence; DXVK returns it without a
        // submission/flush boundary.
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 6, 0)).toBe(D3D_OK);
        expect([...Array(6)].map((_, i) => Mem.readUint8(DATA_OUT + i))).toEqual([
            0x43, 0x41, 0x43, 0x48, 0x01, 0x00,
        ]);
        expect(Mem.readUint8(DATA_OUT + 6)).toBe(0xaa);
        expect(Mem.readUint8(DATA_OUT + 15)).toBe(0xaa);

        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 16, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(0x48434143);
        expect(Mem.readUint32(DATA_OUT + 4)).toBe(1);
        expect(Mem.readUint32(DATA_OUT + 8)).toBe(16);
        expect(Mem.readUint32(DATA_OUT + 12)).toBe(7);
    });

    test("EVENT stays S_FALSE until the submission serial reaches END", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT);
        expect(query).toBeTruthy();
        expect(call("IDirect3DQuery9_GetType", query!)).toBe(D3DQUERYTYPE_EVENT);
        expect(call("IDirect3DQuery9_GetDataSize", query!)).toBe(4);

        expect(Mem.writeUint32(DATA_OUT, 0xdeadbeef)).toBe(true);
        expect(call("IDirect3DQuery9_Issue", query!, D3DISSUE_END)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_GetData", query!, DATA_OUT, 4, 0)).toBe(S_FALSE);
        expect(Mem.readUint32(DATA_OUT)).toBe(0xdeadbeef);

        notifyDeviceSubmission(DEVICE);
        expect(call("IDirect3DQuery9_GetData", query!, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(1);
    });

    test("Issue treats only BEGIN as BEGIN and all other flag values as END", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const beginOnEvent = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", beginOnEvent, D3DISSUE_BEGIN)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_Issue", beginOnEvent, 0)).toBe(D3D_OK);

        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const unknownFlags = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", unknownFlags, D3DISSUE_BEGIN | D3DISSUE_END)).toBe(D3D_OK);

        notifyDeviceSubmission(DEVICE);
        expect(call("IDirect3DQuery9_GetData", beginOnEvent, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_GetData", unknownFlags, DATA_OUT, 4, 0)).toBe(D3D_OK);
    });

    test("the live-device serial domain is not satisfied by an old present counter", () => {
        let managerSerial = 100;
        const manager = {
            acquire: () => ({ mode: "fallback", reason: "event-is-cpu-complete" }),
            release: () => undefined,
            getCapability: () => ({ kind: "timestamp", supported: true }),
            getSubmittedSerial: () => managerSerial,
            notifySubmitted: (serial: number) => { managerSerial = Math.max(managerSerial, serial); },
        };
        devices.set(DEVICE, {
            getViewport: () => ({ width: 64, height: 32 }),
            getQueryManager: () => manager,
            resetSubsystemPerf: () => undefined,
        } as any);

        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        // The query must fence the next live-device submission (101), not be
        // declared ready merely because the manager has seen frame 100.
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(S_FALSE);
        managerSerial = 101;
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(D3D_OK);
    });

    test("a later END waits for the next submission rather than reusing the prior serial", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        notifyDeviceSubmission(DEVICE);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(D3D_OK);

        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(S_FALSE);
        notifyDeviceSubmission(DEVICE);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(D3D_OK);
    });

    test("OCCLUSION reports zero for an empty interval and keeps nested intervals independent", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_OCCLUSION, QUERY_OUT)).toBe(D3D_OK);
        const empty = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", empty, D3DISSUE_BEGIN)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_Issue", empty, D3DISSUE_END)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_GetData", empty, DATA_OUT, 4, 0)).toBe(S_FALSE);
        notifyDeviceSubmission(DEVICE);
        expect(call("IDirect3DQuery9_GetData", empty, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(0);

        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_OCCLUSION, QUERY_OUT)).toBe(D3D_OK);
        const outer = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_OCCLUSION, QUERY_OUT + 4)).toBe(D3D_OK);
        const inner = Mem.readUint32(QUERY_OUT + 4)!;
        expect(call("IDirect3DQuery9_Issue", outer, D3DISSUE_BEGIN)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_Issue", inner, D3DISSUE_BEGIN)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_Issue", inner, D3DISSUE_END)).toBe(D3D_OK);
        drawCount = 1;
        expect(call("IDirect3DQuery9_Issue", outer, D3DISSUE_END)).toBe(D3D_OK);
        notifyDeviceSubmission(DEVICE);
        expect(call("IDirect3DQuery9_GetData", inner, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(0);
        expect(call("IDirect3DQuery9_GetData", outer, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(64 * 32);
    });

    test("live query-manager allocation failure never falls back to viewport-sized occlusion", () => {
        const fallbackManager = {
            acquire: () => ({ mode: "fallback", reason: "query-set-allocation-failed" }),
            release: () => undefined,
            getSubmittedSerial: () => 0,
        };
        devices.set(DEVICE, {
            getViewport: () => ({ width: 64, height: 32 }),
            getDrawCount: () => drawCount,
            getQueryManager: () => fallbackManager,
            resetSubsystemPerf: () => undefined,
        } as any);
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_OCCLUSION, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_BEGIN)).toBe(D3D_OK);
        drawCount = 1;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        notifyDeviceSubmission(DEVICE);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(0x8876086a);
    });

    test("reusing an OCCLUSION query with END starts a fresh implicit interval", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_OCCLUSION, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_BEGIN)).toBe(D3D_OK);
        drawCount = 1;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        notifyDeviceSubmission(DEVICE);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(64 * 32);

        // No BEGIN here: DXVK implicitly brackets END-only reuse at the current draw count.
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(S_FALSE);
        notifyDeviceSubmission(DEVICE);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(0);
    });

    test("an occlusion END after a mid-frame submit re-arms a local pair instead of hanging", () => {
        let managerSerial = 0;
        let split = false;
        let rearmCount = 0;
        let beginCount = 0;
        let endCount = 0;
        const manager = {
            acquire: () => ({ mode: "gpu", index: 0, querySet: {} }),
            release: () => undefined,
            getSubmittedSerial: () => managerSerial,
            notifySubmitted: (serial: number) => { managerSerial = Math.max(managerSerial, serial); },
            needsRebegin: () => split,
            rearm: () => {
                rearmCount++;
                split = false;
                return { mode: "gpu", index: 0, querySet: {} };
            },
            poll: () => ({ state: "ready", submissionSerial: managerSerial, value: 0n }),
        };
        devices.set(DEVICE, {
            getViewport: () => ({ width: 64, height: 32 }),
            getDrawCount: () => drawCount,
            getQueryManager: () => manager,
            recordQueryBegin: () => { beginCount++; },
            recordQueryEnd: () => { endCount++; },
            resetSubsystemPerf: () => undefined,
        } as any);

        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_OCCLUSION, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_BEGIN)).toBe(D3D_OK);
        // A helper submit (SetRenderTarget/Clear/etc.) happened before END.
        managerSerial = 1;
        split = true;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        expect(rearmCount).toBe(1);
        expect(beginCount).toBe(2);
        expect(endCount).toBe(1);
        managerSerial = 2;
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(0);
    });

    test("a WebGPU occlusion PREDICATE is reported as a pixel count, not as 1", () => {
        // WebGPU's occlusion query answers "did any sample pass" and Dawn spells that 1.
        // D3D9 promises a visible-pixel COUNT, and engines compare it against a coverage
        // threshold — passing the 1 through culls almost everything that is actually on
        // screen (Far Cry's ocean surface, and most distant geometry with it).
        let managerSerial = 0;
        let gpuValue = 1n;
        const manager = {
            acquire: () => ({ mode: "gpu", index: 0, querySet: {} }),
            release: () => undefined,
            getSubmittedSerial: () => managerSerial,
            notifySubmitted: (serial: number) => { managerSerial = Math.max(managerSerial, serial); },
            needsRebegin: () => false,
            rearm: () => ({ mode: "gpu", index: 0, querySet: {} }),
            poll: () => ({ state: "ready", submissionSerial: managerSerial, value: gpuValue }),
        };
        devices.set(DEVICE, {
            getViewport: () => ({ width: 64, height: 32 }),
            getDrawCount: () => drawCount,
            getQueryManager: () => manager,
            recordQueryBegin: () => undefined,
            recordQueryEnd: () => undefined,
            resetSubsystemPerf: () => undefined,
        } as any);

        const runQuery = (): number => {
            expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_OCCLUSION, QUERY_OUT)).toBe(D3D_OK);
            const query = Mem.readUint32(QUERY_OUT)!;
            expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_BEGIN)).toBe(D3D_OK);
            drawCount++;
            expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
            managerSerial++;
            expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(D3D_OK);
            return Mem.readUint32(DATA_OUT)!;
        };

        // The predicate becomes the upper bound we can stand behind: the viewport's area.
        gpuValue = 1n;
        expect(runQuery()).toBe(64 * 32);
        // "Nothing passed" stays exactly zero — the one answer the predicate states outright.
        gpuValue = 0n;
        expect(runQuery()).toBe(0);
        // A backend that really counts samples is trusted and passes through untouched.
        gpuValue = 4321n;
        expect(runQuery()).toBe(4321);
    });

    test("timestamp-family payloads use the D3D9 uint64 layout and stable frequency", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_TIMESTAMP, QUERY_OUT)).toBe(D3D_OK);
        const timestamp = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", timestamp, D3DISSUE_END)).toBe(D3D_OK);
        notifyDeviceSubmission(DEVICE);
        expect(call("IDirect3DQuery9_GetData", timestamp, DATA_OUT, 8, 0)).toBe(D3D_OK);
        const timestampLow = Mem.readUint32(DATA_OUT)!;
        const timestampHigh = Mem.readUint32(DATA_OUT + 4)!;
        expect(timestampLow | timestampHigh).not.toBe(0);

        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_TIMESTAMPFREQ, QUERY_OUT)).toBe(D3D_OK);
        const frequency = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", frequency, D3DISSUE_END)).toBe(D3D_OK);
        notifyDeviceSubmission(DEVICE);
        // TIMESTAMPFREQ is likewise static metadata and is immediately readable.
        expect(call("IDirect3DQuery9_GetData", frequency, DATA_OUT, 8, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(1_000_000_000);
        expect(Mem.readUint32(DATA_OUT + 4)).toBe(0);

        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_TIMESTAMPDISJOINT, QUERY_OUT)).toBe(D3D_OK);
        const disjoint = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_GetDataSize", disjoint)).toBe(4);
        expect(call("IDirect3DQuery9_Issue", disjoint, D3DISSUE_BEGIN)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_Issue", disjoint, D3DISSUE_END)).toBe(D3D_OK);
        notifyDeviceSubmission(DEVICE);
        expect(Mem.writeUint32(DATA_OUT, 0xdeadbeef)).toBe(true);
        expect(call("IDirect3DQuery9_GetData", disjoint, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT)).toBe(0);
        expect(Mem.writeUint32(DATA_OUT + 4, 0xfeedface)).toBe(true);
        expect(call("IDirect3DQuery9_GetData", disjoint, DATA_OUT + 4, 2, 0)).toBe(D3D_OK);
        expect(Mem.readUint32(DATA_OUT + 4)).toBe(0xfeed0000);
    });

    test("TIMESTAMP support probes fail before allocating on a live device without the feature", () => {
        const manager = {
            getCapability: () => ({ kind: "timestamp", supported: false, reason: "timestamp-query-feature-missing" }),
            acquire: () => ({ mode: "fallback", reason: "timestamp-query-feature-missing" }),
            release: () => undefined,
            getSubmittedSerial: () => 0,
            notifySubmitted: () => undefined,
        };
        devices.set(DEVICE, { getQueryManager: () => manager, resetSubsystemPerf: () => undefined } as any);
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_TIMESTAMP, 0)).toBe(0x8876086a);
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_TIMESTAMP, QUERY_OUT)).toBe(0x8876086a);
        expect(Mem.readUint32(QUERY_OUT)).toBe(0);
    });

    test("GetData reports DEVICELOST only to a FLUSH caller while the device is lost", () => {
        registerLossTrackedDevice(DEVICE);
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        gpuDeviceLifecycle.notifyLost("test-query", "forced query loss");
        try {
            // A plain poll during an alt-tab gets "not ready", not a broken query.
            expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(S_FALSE);
            expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, D3DGETDATA_FLUSH))
                .toBe(D3DERR_DEVICELOST);
        } finally {
            if (!gpuDeviceLifecycle.isUsable()) gpuDeviceLifecycle.notifyRecreated({} as GPUDevice);
            forgetLossTrackedDevice(DEVICE);
        }
    });

    test("GetData reports DEVICELOST from the live query manager loss seam", () => {
        const manager = {
            isDeviceLost: () => true,
            getCapability: () => ({ kind: "timestamp", supported: true }),
            acquire: () => ({ mode: "fallback", reason: "device-lost" }),
            release: () => undefined,
            getSubmittedSerial: () => 0,
            notifySubmitted: () => undefined,
        };
        devices.set(DEVICE, { getQueryManager: () => manager, resetSubsystemPerf: () => undefined } as any);
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(S_FALSE);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, D3DGETDATA_FLUSH))
            .toBe(D3DERR_DEVICELOST);
    });

    test("a D3D9Ex device never reports DEVICELOST from GetData", () => {
        const manager = {
            isDeviceLost: () => true,
            getCapability: () => ({ kind: "timestamp", supported: true }),
            acquire: () => ({ mode: "fallback", reason: "device-lost" }),
            release: () => undefined,
            getSubmittedSerial: () => 0,
            notifySubmitted: () => undefined,
        };
        devices.set(DEVICE, {
            isExtended: true,
            getQueryManager: () => manager,
            resetSubsystemPerf: () => undefined,
        } as any);
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, D3DGETDATA_FLUSH)).toBe(S_FALSE);
    });

    test("VERTEXSTATS stays unavailable instead of exposing a fabricated payload", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_VERTEXSTATS, QUERY_OUT))
            .toBe(0x8876086a);
        expect(Mem.readUint32(QUERY_OUT)).toBe(0);
    });
});

describe("GetData fast path defers unless the answer is the free S_FALSE", () => {
    function makeIssuedEventQuery(): number {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        return query;
    }

    test("serves the pending-serial poll and agrees with the thunk", () => {
        const query = makeIssuedEventQuery();
        expect(tryFastGetData(query, DATA_OUT, 4, 0)).toBe(S_FALSE);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(S_FALSE);
    });

    test("defers for an unknown query pointer", () => {
        expect(tryFastGetData(0xdead, DATA_OUT, 4, 0)).toBe(null);
    });

    test("defers while the query has not been issued (the implicit END is a side effect)", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        expect(tryFastGetData(Mem.readUint32(QUERY_OUT)!, DATA_OUT, 4, 0)).toBe(null);
    });

    test("defers while a BEGIN interval is open", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_OCCLUSION, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_BEGIN)).toBe(D3D_OK);
        expect(tryFastGetData(query, DATA_OUT, 4, 0)).toBe(null);
    });

    test("defers on D3DGETDATA_FLUSH", () => {
        const query = makeIssuedEventQuery();
        expect(tryFastGetData(query, DATA_OUT, 4, D3DGETDATA_FLUSH)).toBe(null);
    });

    test("defers on a NULL pData with a non-zero size", () => {
        const query = makeIssuedEventQuery();
        expect(tryFastGetData(query, 0, 4, 0)).toBe(null);
    });

    test("defers once the submission serial has observed the END", () => {
        const query = makeIssuedEventQuery();
        notifyDeviceSubmission(DEVICE);
        expect(tryFastGetData(query, DATA_OUT, 4, 0)).toBe(null);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(D3D_OK);
    });

    test("defers while the owning device is lost", () => {
        registerLossTrackedDevice(DEVICE);
        const query = makeIssuedEventQuery();
        gpuDeviceLifecycle.notifyLost("test-fast-getdata", "forced query loss");
        try {
            expect(tryFastGetData(query, DATA_OUT, 4, 0)).toBe(null);
        } finally {
            if (!gpuDeviceLifecycle.isUsable()) gpuDeviceLifecycle.notifyRecreated({} as GPUDevice);
            forgetLossTrackedDevice(DEVICE);
        }
    });

    test("defers when the query manager reports device loss", () => {
        const manager = {
            isDeviceLost: () => true,
            getCapability: () => ({ kind: "timestamp", supported: true }),
            acquire: () => ({ mode: "fallback", reason: "device-lost" }),
            release: () => undefined,
            getSubmittedSerial: () => 0,
            notifySubmitted: () => undefined,
        };
        devices.set(DEVICE, { getQueryManager: () => manager, resetSubsystemPerf: () => undefined } as any);
        const query = makeIssuedEventQuery();
        expect(tryFastGetData(query, DATA_OUT, 4, 0)).toBe(null);
    });
});

/**
 * A query that stops resolving is invisible in every other counter: GetData keeps
 * answering S_FALSE (or a viewport-sized upper bound) and the app culls against it.
 */
describe("D3D9 query lifecycle ledger", () => {
    function gpuManagerStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        let managerSerial = 0;
        return {
            acquire: () => ({ mode: "gpu", index: 0, querySet: {} }),
            release: () => undefined,
            getCapability: () => ({ kind: "occlusion", supported: true }),
            getSubmittedSerial: () => managerSerial,
            notifySubmitted: (serial: number) => { managerSerial = Math.max(managerSerial, serial); },
            needsRebegin: () => false,
            rearm: () => ({ mode: "gpu", index: 0, querySet: {} }),
            poll: () => ({ state: "ready", submissionSerial: managerSerial, value: 1n }),
            ...overrides,
        };
    }

    test("an issued interval released before it resolves is counted as missing", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_OCCLUSION, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_BEGIN)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        expect(getD3D9QueryLedger()).toMatchObject({ created: 1, begin: 1, end: 1, missing: 0 });

        expect(call("IDirect3DQuery9_Release", query)).toBe(0);
        expect(getD3D9QueryLedger().missing).toBe(1);
    });

    test("a result the guest actually read is not counted as missing", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_OCCLUSION, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_BEGIN)).toBe(D3D_OK);
        drawCount = 1;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(S_FALSE);
        notifyDeviceSubmission(DEVICE);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_Release", query)).toBe(0);
        expect(getD3D9QueryLedger()).toMatchObject({ ready: 1, pending: 1, missing: 0 });
    });

    test("a synthesized occlusion upper bound is never counted as a measurement", () => {
        let gpuValue = 1n;
        const manager = gpuManagerStub({
            poll: () => ({ state: "ready", submissionSerial: 99, value: gpuValue }),
        });
        devices.set(DEVICE, {
            getViewport: () => ({ width: 64, height: 32 }),
            getDrawCount: () => drawCount,
            getQueryManager: () => manager,
            recordQueryBegin: () => undefined,
            recordQueryEnd: () => undefined,
            resetSubsystemPerf: () => undefined,
        } as any);

        const runQuery = (): number => {
            expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_OCCLUSION, QUERY_OUT)).toBe(D3D_OK);
            const query = Mem.readUint32(QUERY_OUT)!;
            expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_BEGIN)).toBe(D3D_OK);
            drawCount++;
            expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
            (manager as any).notifySubmitted((manager as any).getSubmittedSerial() + 1);
            expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(D3D_OK);
            return Mem.readUint32(DATA_OUT)!;
        };

        // The predicate is widened to the viewport area — a number nobody measured.
        expect(runQuery()).toBe(64 * 32);
        expect(getD3D9QueryLedger()).toMatchObject({ synthesized: 1, measured: 0 });
        // A backend that really counts samples passes through, and says so.
        gpuValue = 4321n;
        expect(runQuery()).toBe(4321);
        expect(getD3D9QueryLedger()).toMatchObject({ synthesized: 1, measured: 1 });
    });

    test("a re-arm that cannot reserve a generation is counted as an error", () => {
        const manager = gpuManagerStub({ rearm: () => null });
        devices.set(DEVICE, {
            getViewport: () => ({ width: 64, height: 32 }),
            getDrawCount: () => drawCount,
            getQueryManager: () => manager,
            recordQueryBegin: () => undefined,
            recordQueryEnd: () => undefined,
            resetSubsystemPerf: () => undefined,
        } as any);

        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_OCCLUSION, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_BEGIN)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        expect(getD3D9QueryLedger().error).toBe(0);
        // The second interval needs a fresh generation; the manager cannot supply one.
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_BEGIN)).toBe(0x8876086a);
        expect(getD3D9QueryLedger().error).toBe(1);
    });

    test("the GetData fast path counts its S_FALSE into the same field as the thunk", () => {
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        expect(tryFastGetData(query, DATA_OUT, 4, 0)).toBe(S_FALSE);
        expect(getD3D9QueryLedger().pending).toBe(1);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(S_FALSE);
        expect(getD3D9QueryLedger().pending).toBe(2);
    });

    test("an interval abandoned to device loss is counted once, not once per poll", () => {
        const manager = gpuManagerStub({
            isDeviceLost: () => true,
            acquire: () => ({ mode: "fallback", reason: "device-lost" }),
        });
        devices.set(DEVICE, {
            getQueryManager: () => manager,
            resetSubsystemPerf: () => undefined,
        } as any);
        expect(call("IDirect3DDevice9_CreateQuery", DEVICE, D3DQUERYTYPE_EVENT, QUERY_OUT)).toBe(D3D_OK);
        const query = Mem.readUint32(QUERY_OUT)!;
        expect(call("IDirect3DQuery9_Issue", query, D3DISSUE_END)).toBe(D3D_OK);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(S_FALSE);
        expect(call("IDirect3DQuery9_GetData", query, DATA_OUT, 4, 0)).toBe(S_FALSE);
        expect(getD3D9QueryLedger().lostOnDeviceLoss).toBe(1);
    });
});

/** d3d9-perf.ts has no test file of its own; the guard is pinned here beside the ledger
 *  work that motivated it. */
describe("D3D9 batched counter domain guard", () => {
    test("d3d9PerfAdd refuses a count that is not a non-negative integer", () => {
        resetD3D9Perf();
        d3d9PerfAdd("drawPrimitive", 3);
        d3d9PerfAdd("drawPrimitive", Number.NaN);
        d3d9PerfAdd("drawPrimitive", -5);
        d3d9PerfAdd("drawPrimitive", 1.5);
        d3d9PerfAdd("drawPrimitive", Number.POSITIVE_INFINITY);
        const snap = getD3D9PerfSnapshot();
        // A poisoned counter is worse than a missing one: the reconcile still reads healthy.
        expect(snap.api.drawPrimitive).toBe(3);
        expect(snap.counterRejections.drawPrimitive).toBe(4);
        resetD3D9Perf();
        expect(getD3D9PerfSnapshot().counterRejections).toEqual({});
    });
});
