import { System } from '../../core/system';
import { getWsaProcessState, hasWsaSocket } from '../wsa-stub-shared';
import { getWsaOverlapped } from '../wsa-overlapped';

export interface SocketCompletionWait { handle: number; release(): void; }
/** Adapt a socket request to the scheduler's event wait, including timeout and APC cleanup. */
export function socketCompletionWait(socket: number, overlapped: number): SocketCompletionWait | null {
    const system = System.getInstance(), owner = system.process;
    if (!owner || !hasWsaSocket(owner, socket)) return null;
    const scheduler = system.scheduler, epoch = owner.resetGeneration;
    const handle = scheduler.createEvent(true, false), event = system.resourceProvider.getKernelObject(handle);
    let active = true, unsubscribe = () => {}, unwatch = () => {};
    const release = () => {
        if (!active) return; active = false; unsubscribe(); unwatch();
        if (system.resourceProvider.getKernelObject(handle) === event) scheduler.syncObjects.closeEvent(handle);
    };
    const observer = getWsaOverlapped(getWsaProcessState(owner).table, owner).observeCompletion(socket, overlapped, () => {
        if (active && epoch === owner.resetGeneration) scheduler.setEvent(handle);
    });
    if (!observer) { release(); return null; }
    unsubscribe = observer;
    unwatch = owner.onReset(release);
    return { handle, release };
}
