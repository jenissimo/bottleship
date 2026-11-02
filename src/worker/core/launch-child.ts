import { System } from "./system";
import { getProcessIpc } from "./process-ipc";
import type { ChildProcessRequest } from "./child-process";
import { startProcessRuntime } from "../modules/kernel32/process/runtime-child";
import { getVirtualProcessManager } from "../modules/kernel32/process/virtual-process-manager";
export interface PreparedChildLaunch {
    readonly processId: number;
    start(): void;
    cancel(): void;
    closeHandles(): void;
}
/** Prepare a real worker-backed process without running guest instructions before setup completes. */
export async function prepareChildLaunch(request: ChildProcessRequest, system = System.getInstance()): Promise<PreparedChildLaunch> {
    const directory = request.currentDirectory || system.fileSystem.currentDir;
    const imagePath = system.resolveImagePath(request.imagePath, directory);
    if (!imagePath) throw new Error("Child executable not found");
    const file = await system.fileSystem.open(imagePath, 0x80000000, 3);
    if (!file) throw new Error("Child executable not found");
    // Read the fixed DOS header first, then the actual NT header: PE images need not
    // place e_lfanew in the first few kilobytes.
    const head = await system.fileSystem.read(file, 64);
    if (head.length < 64) throw new Error("Invalid child executable");
    const dos = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (dos.getUint16(0, true) !== 0x5a4d) throw new Error("Invalid child executable");
    const offset = dos.getUint32(0x3c, true);
    if (offset > 16 * 1024 * 1024) throw new Error("Invalid child executable");
    file.position = offset;
    const header = await system.fileSystem.read(file, 24);
    if (header.length < 24) throw new Error("Invalid child executable");
    const nt = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (nt.getUint32(0, true) !== 0x4550 || nt.getUint16(4, true) !== 0x14c || (nt.getUint16(22, true) & 0x2000)) throw new Error("Unsupported child executable");
    const manager = getVirtualProcessManager();
    const proc = manager.createProcess({ applicationName: imagePath, commandLine: request.commandLine,
        currentDirectory: directory, creationFlags: 0, runtimeBacked: true });
    let started = false, cancelled = false, handlesClosed = false;
    return {
        processId: proc.processId,
        start() {
            if (cancelled || started) throw new Error("Child launch is no longer pending");
            started = true;
            try { startProcessRuntime(system.fileSystem, proc.processId, { ...request, imagePath, currentDirectory: directory }, "worker"); }
            catch (error) { manager.terminateProcess(proc.processHandle, 1); throw error; }
        },
        cancel() { if (!cancelled) { cancelled = true; manager.terminateProcess(proc.processHandle, 1); if (!started) getProcessIpc().markProcessExited(proc.processId); } },
        closeHandles() {
            if (!handlesClosed) {
                handlesClosed = true;
                system.resourceProvider.unregisterKernelObject(proc.threadHandle);
                system.resourceProvider.unregisterKernelObject(proc.processHandle);
            }
        },
    };
}
