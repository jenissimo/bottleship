// The CHILD process of process-inherited-handles.test.ts: a real worker, so it has its own
// handle table, sync objects and process manager, exactly as a CreateProcess child does.
import { adoptProcessIdentity } from '../../../src/worker/core/process-identity';
import { adoptProcessIpc } from '../../../src/worker/core/process-ipc';
import { System } from '../../../src/worker/core/system';
import { Mem } from '../../../src/worker/core/memory/mem-accessor';
import { adoptInheritedHandles } from '../../../src/worker/modules/kernel32/inherited-handles';
import { exports as processApi } from '../../../src/worker/modules/kernel32/process/process';
import { exports as syncApi } from '../../../src/worker/modules/kernel32/sync';

const memory = new Uint8Array(4096);
Mem.bind(() => memory);
let lastError = 0;
const value = (result: unknown) => (typeof result === 'number' ? result : (result as { value: number }).value) >>> 0;

self.onmessage = async (event: MessageEvent) => {
    const message = event.data;
    try {
        const system = System.getInstance();
        const setLastError = system.scheduler.setLastError.bind(system.scheduler);
        system.scheduler.setLastError = code => { lastError = code; setLastError(code); };
        system.scheduler.setLastErrorForThread = (_tid, code) => { lastError = code; };
        if (message.type === 'boot') {
            adoptProcessIdentity(message.identity);
            adoptProcessIpc(message.identity, message.port);
            const adopted = adoptInheritedHandles(message.specs);
            const valid = (message.specs as { handle: number }[])
                .map(spec => system.scheduler.syncObjects.validateHandles([spec.handle]));
            // A handle the child creates itself must not land on an inherited value.
            const own = system.scheduler.createEvent(false, false);
            self.postMessage({ type: 'adopted', adopted, valid, own });
        } else if (message.type === 'wait') {
            // WaitForSingleObject(handle, timeout): the scheduler's own wait check and consume.
            const deadline = performance.now() + message.timeout;
            let result = 0x102;
            for (;;) {
                if (!system.scheduler.syncObjects.validateHandles([message.handle])) { result = 0xffffffff; break; }
                if (system.scheduler.tryConsumeWait(message.handle, 1)) { result = 0; break; }
                if (performance.now() >= deadline) break;
                await new Promise(resolve => setTimeout(resolve, 1));
            }
            self.postMessage({ type: 'waited', result });
        } else if (message.type === 'set') {
            self.postMessage({ type: 'set', result: value(syncApi.SetEvent!({ esp: 0 } as never, memory, [message.handle])) });
        } else if (message.type === 'exitCode') {
            const ok = value(processApi.GetExitCodeProcess!(undefined as never, memory, [message.handle, 64]));
            self.postMessage({ type: 'exitCode', ok, code: new DataView(memory.buffer).getUint32(64, true), lastError });
        } else if (message.type === 'terminate') {
            lastError = 0;
            const ok = value(await processApi.TerminateProcess!(undefined as never, memory, [message.handle, message.code]));
            self.postMessage({ type: 'terminate', ok, lastError });
        }
    } catch (error) {
        self.postMessage({ type: 'failed', error: String(error && (error as Error).stack || error) });
    }
};
