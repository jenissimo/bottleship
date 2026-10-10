import { expect, spyOn, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { registerCrossingCommands } from '../../src/worker/harness/cmds/crossings';
import { HarnessErrorCode } from '../../src/worker/harness/rpc';

test('crossingCost refuses live peers before accessing or changing guest CPU memory', () => {
    const handlers = new Map<string, (args: unknown[]) => unknown>();
    registerCrossingCommands({ register: (name: string, handler: (args: unknown[]) => unknown) => {
        handlers.set(name, handler);
    } } as never);
    let guestAccesses = 0;
    const fake = {
        isPaused: false,
        scheduler: { getThreadCount: () => 2 },
        get process() { guestAccesses++; throw new Error('guest state accessed'); },
    };
    const instance = spyOn(System, 'getInstance').mockReturnValue(fake as never);
    try {
        let error: any;
        try { handlers.get('crossingCost')!([{ calls: [{ name: 'kernel32:GetCurrentProcessId' }] }]); }
        catch (caught) { error = caught; }
        expect(error?.code).toBe(HarnessErrorCode.BAD_ARGS);
        expect(error?.message).toContain('single live guest thread');
        expect(guestAccesses).toBe(0);
    } finally {
        instance.mockRestore();
    }
});
