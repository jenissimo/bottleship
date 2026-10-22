import {
    startChildProcess, promoteChildSession, ChildProcessCancelled, ChildNeedsSession,
    type ChildProcessRequest, type ChildProcessRecord, type ChildProcessTask,
} from '../../../core/child-process';
import { startGuestHostTool } from '../../../core/guest-host-tool';
import { getProcessIpc } from '../../../core/process-ipc';
import { Logger, LogCategory } from '../../../core/logger';
import type { VirtualFileSystem } from '../../../runtime/filesystem/vfs';
import { getVirtualProcessManager } from './virtual-process-manager';

/** Bind kernel handles to the child's actual guest lifetime for both launch APIs. */
export function startProcessRuntime(
    vfs: VirtualFileSystem,
    processId: number,
    request: ChildProcessRequest,
    backend: 'worker' | 'host' = 'worker',
    onSessionRequest: (record: ChildProcessRecord) => boolean = promoteChildSession,
): ChildProcessTask {
    const manager = getVirtualProcessManager();
    const task = backend === 'host' ? startGuestHostTool(vfs, request)
        : startChildProcess(vfs, { ...request, processId }, undefined, onSessionRequest);
    const completeRuntime = manager.bindRuntime(processId, task);
    const complete = (exitCode: number): void => {
        if (!manager.isRuntimeCurrent(processId, task)) return;
        completeRuntime(exitCode);
        getProcessIpc().markProcessExited(processId);
    };
    task.onGuestExit = complete;
    task.completion.then(complete, error => {
        if (error instanceof ChildProcessCancelled || !manager.isRuntimeCurrent(processId, task)) return;
        if (error instanceof ChildNeedsSession && onSessionRequest(error.record)) return;
        Logger.error(LogCategory.SYSTEM, `Child process "${request.imagePath}" failed: ${error}`);
        complete(1);
    });
    return task;
}
