import { afterEach, beforeEach, expect, test } from "bun:test";
import { BCrypt } from "../../src/worker/modules/bcrypt";
import type { Process } from "../../src/worker/core/process";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { bcryptModule } from "../../src/worker/api/bcrypt.api";
import { unimplementedReturnValue } from "../../src/worker/core/thunking/unimplemented-return";

const system = System.getInstance();
const originalProcess = system.process;
const memory = new Uint8Array(0x24000);
const bcrypt = new BCrypt();
let rejectWrites = false;
beforeEach(() => {
    memory.fill(0x5a);
    rejectWrites = false;
    const validateRange = (address: number, size: number) => !rejectWrites
        && address >= 0x1000 && address + size <= memory.length;
    const process = { addressSpace: { validateRange } } as unknown as Process;
    system.process = process;
    Mem.bind(() => memory, validateRange);
    bcrypt.initialize(process);
});
afterEach(() => { system.process = originalProcess; });

function call(algorithm: number, buffer: number, count: number, flags: number) {
    return bcrypt.exports.BCryptGenRandom({}, memory, [algorithm, buffer, count, flags]);
}

test("system RNG fills the whole buffer beyond Web Crypto's per-call limit and preserves its guards", () => {
    expect(call(0, 0x1000, 0x20010, 2)).toEqual({ value: 0, stackCleanup: 16 });
    for (const [start, end] of [[0x1000, 0x11000], [0x11000, 0x21000], [0x21000, 0x21010]]) {
        expect(memory.subarray(start, end).some(value => value !== 0x5a)).toBe(true);
    }
    expect(memory[0xfff]).toBe(0x5a);
    expect(memory[0x21010]).toBe(0x5a);
});

test("invalid handles, flags, pointers and protected ranges fail without writing", () => {
    expect(call(1, 0x1000, 16, 2)).toEqual({ value: 0xc0000008, stackCleanup: 16 });
    expect(call(0, 0x1000, 16, 0)).toEqual({ value: 0xc0000008, stackCleanup: 16 });
    for (const args of [[0, 0, 16, 2], [0, 0x1000, 16, 6], [0, 0x23000, 0x2000, 2]]) {
        expect(call(...args as [number, number, number, number])).toEqual({ value: 0xc000000d, stackCleanup: 16 });
    }
    rejectWrites = true;
    expect(call(0, 0x1000, 16, 2)).toEqual({ value: 0xc000000d, stackCleanup: 16 });
    expect(memory.every(value => value === 0x5a)).toBe(true);
});

test("a zero-length request with a valid buffer succeeds and the fallback is a failing NTSTATUS", () => {
    expect(call(0, 0x1000, 0, 2)).toEqual({ value: 0, stackCleanup: 16 });
    const fallback = unimplementedReturnValue(bcryptModule.functions![0].onUnimplemented!);
    expect(fallback).toBe(0xc0000002);
    expect(fallback | 0).toBeLessThan(0);
});
