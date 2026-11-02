import { beforeEach, afterEach, expect, test } from 'bun:test';
import { socketCompletionWait } from '../../src/worker/modules/kernel32/socket-completion-wait';
import { getWsaProcessState } from '../../src/worker/modules/wsa-stub-shared';
import { getWsaOverlapped } from '../../src/worker/modules/wsa-overlapped';
import { WsaFailure, WSA } from '../../src/worker/modules/wsa-network';
import { Process } from '../../src/worker/core/process';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
const system = System.getInstance(), saved = system.process;
let ram: Uint8Array, owner: Process, resets: Set<() => void>, socket: number;
const state = () => getWsaProcessState(owner), provider = () => getWsaOverlapped(state().table, owner);
const drain = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
    ram = new Uint8Array(0x10000); Mem.bind(() => ram); resets = new Set();
    owner = { resetGeneration: 0, getCurrentMemory: () => ram, enqueueCompletion: Process.prototype.enqueueCompletion,
        addressSpace: { validateRange: (p: number, n: number) => p > 0 && p + n <= ram.length,
            write: (p: number, bytes: Uint8Array) => { ram.set(bytes, p); return bytes.length; } },
        onReset: (fn: () => void) => { resets.add(fn); return () => resets.delete(fn); },
    } as unknown as Process; system.process = owner;
    socket = state().table.socket(2, 2, 17);
    provider().issue(socket, 0x1000, 0, 'read', () => { throw new WsaFailure(WSA.EWOULDBLOCK); }, () => []);
});
afterEach(async () => {
    owner.resetGeneration++; for (const reset of [...resets]) reset();
    state().reset(); await drain(); system.process = saved;
});
test('a private wait event signals after completion memory is published and is released independently', async () => {
    const baseline = system.resourceProvider.getStatistics().kernel_object.count;
    const wait = socketCompletionWait(socket, 0x1000)!;
    expect(wait).not.toBeNull(); expect(system.resourceProvider.getKernelObject(wait.handle)).toMatchObject({ signaled: false });
    provider().cancel(socket, 0x1000); await drain();
    expect(new DataView(ram.buffer).getUint32(0x1000, true)).toBe(0xc0000120);
    expect(system.resourceProvider.getKernelObject(wait.handle)).toMatchObject({ signaled: true });
    wait.release(); wait.release();
    expect(system.resourceProvider.getStatistics().kernel_object.count).toBe(baseline); expect(resets.size).toBe(0);
});
test('repeated timed-out observers and unknown requests leave no private handles or reset listeners', () => {
    const baseline = system.resourceProvider.getStatistics().kernel_object.count;
    expect(socketCompletionWait(socket, 0x2000)).toBeNull();
    for (let i = 0; i < 1000; i++) socketCompletionWait(socket, 0x1000)!.release();
    expect(system.resourceProvider.getStatistics().kernel_object.count).toBe(baseline);
    expect(resets.size).toBe(0);
});
test('process reset revokes pending observers before a stale provider can signal another process event', async () => {
    const wait = socketCompletionWait(socket, 0x1000)!;
    provider().cancel(socket, 0x1000);
    owner.resetGeneration++; for (const reset of [...resets]) reset();
    expect(system.resourceProvider.getKernelObject(wait.handle)).toBeNull(); expect(resets.size).toBe(0);
    await drain();
    expect(new DataView(ram.buffer).getUint32(0x1000, true)).toBe(0x103);
});
