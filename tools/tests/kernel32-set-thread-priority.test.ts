/**
 * SetThreadPriority / GetThreadPriority against the documented contract: the XP ranges, and
 * the background processing mode Vista added, gated on the reported OS version.
 *
 * nPriority is a signed int, but thunk arguments arrive as unsigned DWORDs: read unsigned,
 * THREAD_PRIORITY_LOWEST (-2) is 0xfffffffe and fails the range check. A title whose thread
 * setup frees its thread object on that failure, without unlinking it from its own thread
 * list, then corrupts its heap.
 *
 * Runs against the real scheduler with one injected thread, so what is asserted is what
 * GetThreadPriority reads back, not what a mock was handed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";
import { exports as processApi, resetProcessApiState } from "../../src/worker/modules/kernel32/process/process";

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_THREAD_MODE_ALREADY_BACKGROUND = 400;
const ERROR_THREAD_MODE_NOT_BACKGROUND = 401;
const THREAD_MODE_BACKGROUND_BEGIN = 0x10000;
const THREAD_MODE_BACKGROUND_END = 0x20000;
const THREAD_PRIORITY_ERROR_RETURN = 0x7fffffff;
const CURRENT_PROCESS = 0xffffffff;
const CURRENT_THREAD = 0xfffffffe;
const NORMAL_PRIORITY_CLASS = 0x20;
const REALTIME_PRIORITY_CLASS = 0x100;
const THREAD_ID = 0x7ff1;
const HTHREAD = 0x30044;
const OTHER_ID = 0x7ff2;
const HOTHER = 0x30048;
const XP = { major: 5, minor: 1, build: 2600, platformId: 2 };
const VISTA = { major: 6, minor: 0, build: 6000, platformId: 2 };

type Api = (ctx: never, mem: Uint8Array, args: number[]) => { value: number; stackCleanup: number };
const api = (name: string) => processApi[name] as unknown as Api;

describe("SetThreadPriority", () => {
    const scheduler = System.getInstance().scheduler as unknown as {
        threads: Map<number, unknown>;
        currentThreadId: number | null;
        setLastError: (code: number) => void;
        setThreadPriority: (handle: number, priority: number) => boolean;
    };
    let savedSetLastError: (code: number) => void;
    let savedCurrent: number | null;
    let savedOs: typeof EmulatorConfig.prototype.osVersion;
    const config = EmulatorConfig.getInstance();
    let lastError = 0;

    beforeEach(() => {
        savedSetLastError = scheduler.setLastError;
        savedCurrent = scheduler.currentThreadId;
        savedOs = config.osVersion;
        config.osVersion = { ...XP };
        lastError = 0;
        scheduler.setLastError = (code: number) => { lastError = code; };
        scheduler.threads.set(THREAD_ID, { id: THREAD_ID, handle: HTHREAD, priority: 0 });
        resetProcessApiState();
    });
    afterEach(() => {
        scheduler.setLastError = savedSetLastError;
        scheduler.currentThreadId = savedCurrent;
        scheduler.threads.delete(THREAD_ID);
        scheduler.threads.delete(OTHER_ID);
        config.osVersion = savedOs;
        resetProcessApiState();
    });

    /** stdcall: every outcome, success or failure, pops exactly the arguments it was given. */
    const set = (priority: number, h = HTHREAD) => {
        const r = api("SetThreadPriority")(null as never, new Uint8Array(0), [h, priority >>> 0]);
        expect(r.stackCleanup).toBe(8);
        return r.value;
    };
    const get = (h = HTHREAD) => {
        const r = api("GetThreadPriority")(null as never, new Uint8Array(0), [h]);
        expect(r.stackCleanup).toBe(4);
        return r.value | 0;
    };
    const setClass = (cls: number) =>
        api("SetPriorityClass")(null as never, new Uint8Array(0), [CURRENT_PROCESS, cls]).value;

    /** Each value is accepted and is what GetThreadPriority then reports. */
    const expectAccepted = (values: number[]) => {
        for (const p of values) {
            expect(set(p)).toBe(1);
            expect(get()).toBe(p);
        }
    };
    /** Each value fails with ERROR_INVALID_PARAMETER and leaves the priority as it was. */
    const expectRejected = (values: number[]) => {
        for (const p of values) {
            expect(set(-1)).toBe(1);
            lastError = 0;
            expect(set(p)).toBe(0);
            expect(lastError).toBe(ERROR_INVALID_PARAMETER);
            expect(get()).toBe(-1);
        }
    };

    test("negative priorities arrive as unsigned DWORDs and are accepted", () => {
        expectAccepted([-15, -2, -1]);
    });

    test("outside realtime: IDLE, LOWEST..HIGHEST and TIME_CRITICAL, nothing else", () => {
        expectAccepted([-15, -2, -1, 0, 1, 2, 15]);
        expectRejected([3, 6, -3, -7, 14, -14, 16, -16]);
    });

    test("before Vista the background-mode values are invalid priorities", () => {
        scheduler.currentThreadId = THREAD_ID;
        for (const os of [XP, { major: 5, minor: 2, build: 3790, platformId: 2 }, { major: 4, minor: 10, build: 2222, platformId: 1 }]) {
            config.osVersion = { ...os };
            expectRejected([THREAD_MODE_BACKGROUND_BEGIN, THREAD_MODE_BACKGROUND_END]);
            expect(set(THREAD_MODE_BACKGROUND_BEGIN, CURRENT_THREAD)).toBe(0);
            expect(lastError).toBe(ERROR_INVALID_PARAMETER);
        }
    });

    test("a REALTIME_PRIORITY_CLASS process also accepts -7..-3 and 3..6", () => {
        expect(setClass(REALTIME_PRIORITY_CLASS)).toBe(1);
        expectAccepted([-15, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 15]);
        expectRejected([7, -8, 14, -14, 16, -16]);
    });

    test("leaving REALTIME narrows the range again", () => {
        expect(setClass(REALTIME_PRIORITY_CLASS)).toBe(1);
        expect(setClass(NORMAL_PRIORITY_CLASS)).toBe(1);
        expectRejected([3, -3]);
    });

    test("the GetCurrentThread pseudo-handle reaches the running thread", () => {
        scheduler.currentThreadId = THREAD_ID;
        expect(set(-2, CURRENT_THREAD)).toBe(1);
        expect(get(CURRENT_THREAD)).toBe(-2);
        expect(get()).toBe(-2);
    });

    test("an unknown thread handle is ERROR_INVALID_HANDLE for both calls", () => {
        expect(set(-2, 0x1234)).toBe(0);
        expect(lastError).toBe(ERROR_INVALID_HANDLE);
        lastError = 0;
        expect(api("GetThreadPriority")(null as never, new Uint8Array(0), [0x1234]).value >>> 0)
            .toBe(THREAD_PRIORITY_ERROR_RETURN);
        expect(lastError).toBe(ERROR_INVALID_HANDLE);
    });

    test("the scheduler leaves validation to the API and rejects only an unknown thread", () => {
        expect(scheduler.setThreadPriority(HTHREAD, 6)).toBe(true);
        expect(get()).toBe(6);
        expect(scheduler.setThreadPriority(0x1234, 0)).toBe(false);
    });

    describe("background processing mode (Vista+)", () => {
        beforeEach(() => {
            config.osVersion = { ...VISTA };
            scheduler.currentThreadId = THREAD_ID;
            scheduler.threads.set(OTHER_ID, { id: OTHER_ID, handle: HOTHER, priority: 0 });
        });

        test("BEGIN then END on the current thread succeed, by pseudo or real handle", () => {
            expect(set(THREAD_MODE_BACKGROUND_BEGIN, CURRENT_THREAD)).toBe(1);
            expect(set(THREAD_MODE_BACKGROUND_END, CURRENT_THREAD)).toBe(1);
            expect(set(THREAD_MODE_BACKGROUND_BEGIN)).toBe(1);
            expect(set(THREAD_MODE_BACKGROUND_END)).toBe(1);
        });

        test("BEGIN twice is ERROR_THREAD_MODE_ALREADY_BACKGROUND", () => {
            expect(set(THREAD_MODE_BACKGROUND_BEGIN, CURRENT_THREAD)).toBe(1);
            expect(set(THREAD_MODE_BACKGROUND_BEGIN, CURRENT_THREAD)).toBe(0);
            expect(lastError).toBe(ERROR_THREAD_MODE_ALREADY_BACKGROUND);
        });

        test("END outside background mode is ERROR_THREAD_MODE_NOT_BACKGROUND", () => {
            expect(set(THREAD_MODE_BACKGROUND_END, CURRENT_THREAD)).toBe(0);
            expect(lastError).toBe(ERROR_THREAD_MODE_NOT_BACKGROUND);
        });

        test("another thread's handle is refused and its mode is untouched", () => {
            expect(set(THREAD_MODE_BACKGROUND_BEGIN, HOTHER)).toBe(0);
            expect(lastError).toBe(ERROR_INVALID_PARAMETER);
            scheduler.currentThreadId = OTHER_ID;
            expect(set(THREAD_MODE_BACKGROUND_END, CURRENT_THREAD)).toBe(0);
            expect(lastError).toBe(ERROR_THREAD_MODE_NOT_BACKGROUND);
        });

        test("an unknown handle is ERROR_INVALID_HANDLE", () => {
            expect(set(THREAD_MODE_BACKGROUND_BEGIN, 0x1234)).toBe(0);
            expect(lastError).toBe(ERROR_INVALID_HANDLE);
        });

        test("the mode is per thread and leaves the priority alone", () => {
            expect(set(2)).toBe(1);
            expect(set(THREAD_MODE_BACKGROUND_BEGIN, CURRENT_THREAD)).toBe(1);
            expect(get()).toBe(2);
            scheduler.currentThreadId = OTHER_ID;
            expect(set(THREAD_MODE_BACKGROUND_BEGIN, CURRENT_THREAD)).toBe(1);
            scheduler.currentThreadId = THREAD_ID;
            expect(set(THREAD_MODE_BACKGROUND_END, CURRENT_THREAD)).toBe(1);
            expect(set(THREAD_MODE_BACKGROUND_END, CURRENT_THREAD)).toBe(0);
        });

        test("every version from 6.0 on has it", () => {
            for (const os of [{ major: 6, minor: 1, build: 7601 }, { major: 6, minor: 3, build: 9600 }, { major: 10, minor: 0, build: 19045 }]) {
                config.osVersion = { ...os, platformId: 2 };
                expect(set(THREAD_MODE_BACKGROUND_BEGIN, CURRENT_THREAD)).toBe(1);
                expect(set(THREAD_MODE_BACKGROUND_END, CURRENT_THREAD)).toBe(1);
            }
        });

        test("the pseudo-handle with no running thread is ERROR_INVALID_HANDLE", () => {
            scheduler.currentThreadId = null;
            expect(set(THREAD_MODE_BACKGROUND_BEGIN, CURRENT_THREAD)).toBe(0);
            expect(lastError).toBe(ERROR_INVALID_HANDLE);
        });

        test("other out-of-range values stay invalid on Vista", () => {
            expectRejected([3, -3, 16, 0x30000, 0x10001]);
        });
    });
});
