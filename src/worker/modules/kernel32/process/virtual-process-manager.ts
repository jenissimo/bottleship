import { Logger, LogCategory } from '../../../core/logger';
import { System } from '../../../core/system';
import { SystemResourceProvider } from '../../../core/resources/system-resource-provider';

const STILL_ACTIVE = 259;
const CREATE_SUSPENDED = 0x00000004;
const AUTO_EXIT_DELAY_MS = 1;

export const VIRTUAL_CURRENT_PROCESS_ID = 1234;

export interface VirtualProcessInfo {
    processHandle: number;
    threadHandle: number;
    processId: number;
    threadId: number;
}

export interface VirtualProcessSnapshotEntry {
    pid: number;
    parentPid: number;
    exeName: string;
}

export interface VirtualThreadSnapshotEntry {
    tid: number;
    ownerPid: number;
    basePri: number;
}

interface VirtualThreadContext {
    edi: number;
    esi: number;
    ebx: number;
    edx: number;
    ecx: number;
    eax: number;
    ebp: number;
    eip: number;
    eflags: number;
    esp: number;
}

interface VirtualThreadRecord {
    handle: number;
    threadId: number;
    processPid: number;
    suspendCount: number;
    started: boolean;
    terminated: boolean;
    exitCode: number;
    autoExitTimerId: ReturnType<typeof setTimeout> | null;
    context: VirtualThreadContext;
}

interface VirtualProcessRecord {
    handle: number;
    pid: number;
    parentPid: number;
    imageName: string;
    commandLine: string;
    currentDirectory: string;
    terminated: boolean;
    exitCode: number;
    primaryThreadHandle: number;
    primaryThreadId: number;
    isCurrentProcess: boolean;
}

interface CreateVirtualProcessParams {
    applicationName: string;
    commandLine: string;
    currentDirectory: string;
    creationFlags: number;
}

class VirtualProcessManager {
    private readonly resourceProvider = SystemResourceProvider.getInstance();
    private processesByHandle = new Map<number, VirtualProcessRecord>();
    private processesByPid = new Map<number, VirtualProcessRecord>();
    private threadsByHandle = new Map<number, VirtualThreadRecord>();
    private threadsByTid = new Map<number, VirtualThreadRecord>();
    private nextPid = 5000;
    private nextTid = 0x100000;
    private currentProcessHandle = 0;

    private isLiveEventHandle(handle: number): boolean {
        const kobj = this.resourceProvider.getKernelObject(handle) as { kind?: string } | null;
        return kobj?.kind === 'event';
    }

    private pruneStaleHandles(): void {
        for (const [handle, proc] of this.processesByHandle) {
            if (this.isLiveEventHandle(handle)) continue;
            this.processesByHandle.delete(handle);
            if (this.currentProcessHandle === handle) {
                this.currentProcessHandle = 0;
            }
        }

        for (const [handle, thread] of this.threadsByHandle) {
            if (this.isLiveEventHandle(handle)) continue;
            this.threadsByHandle.delete(handle);
        }
    }

    private ensureCurrentProcessRecord(): VirtualProcessRecord {
        this.pruneStaleHandles();

        const current = this.processesByPid.get(VIRTUAL_CURRENT_PROCESS_ID);
        if (current) {
            if (this.currentProcessHandle === 0 || !this.isLiveEventHandle(this.currentProcessHandle)) {
                const handle = System.getInstance().scheduler.createEvent(true, current.terminated);
                this.currentProcessHandle = handle;
                this.processesByHandle.set(handle, current);
            }
            return current;
        }

        if (this.currentProcessHandle !== 0) {
            const existing = this.processesByHandle.get(this.currentProcessHandle);
            if (existing) {
                return existing;
            }
            this.currentProcessHandle = 0;
        }

        const system = System.getInstance();
        const handle = system.scheduler.createEvent(true, false);
        const imageName = system.executableName || 'app.exe';
        const commandLine = system.executableArgs || '';
        const process: VirtualProcessRecord = {
            handle,
            pid: VIRTUAL_CURRENT_PROCESS_ID,
            parentPid: 0,
            imageName,
            commandLine,
            currentDirectory: 'C:\\',
            terminated: false,
            exitCode: STILL_ACTIVE,
            primaryThreadHandle: 0,
            primaryThreadId: 0,
            isCurrentProcess: true,
        };

        this.currentProcessHandle = handle;
        this.processesByHandle.set(handle, process);
        this.processesByPid.set(process.pid, process);
        return process;
    }

    private createProcessAliasHandle(process: VirtualProcessRecord): number {
        const handle = System.getInstance().scheduler.createEvent(true, process.terminated);
        this.processesByHandle.set(handle, process);
        return handle;
    }

    private createThreadAliasHandle(thread: VirtualThreadRecord): number {
        const handle = System.getInstance().scheduler.createEvent(true, thread.terminated);
        this.threadsByHandle.set(handle, thread);
        return handle;
    }

    private deriveImageName(applicationName: string, commandLine: string): string {
        const tokenSource = applicationName.trim() || commandLine.trim();
        if (!tokenSource) return 'child.exe';

        let token = tokenSource;
        if (token.startsWith('"')) {
            const endQuote = token.indexOf('"', 1);
            token = endQuote > 1 ? token.slice(1, endQuote) : token.slice(1);
        } else {
            const firstSpace = token.indexOf(' ');
            token = firstSpace > 0 ? token.slice(0, firstSpace) : token;
        }

        if (!token) return 'child.exe';
        const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
        return slash >= 0 ? token.slice(slash + 1) : token;
    }

    private createDefaultThreadContext(): VirtualThreadContext {
        return {
            edi: 0,
            esi: 0,
            ebx: 0,
            edx: 0,
            ecx: 0,
            eax: 0,
            ebp: 0,
            eip: 0x00400000,
            eflags: 0x00000202,
            esp: 0x0012ff00,
        };
    }

    private startThreadExecution(thread: VirtualThreadRecord): void {
        if (thread.terminated || thread.suspendCount > 0) return;
        if (thread.autoExitTimerId !== null) return;

        thread.started = true;
        thread.autoExitTimerId = setTimeout(() => {
            thread.autoExitTimerId = null;
            this.terminateThread(thread.handle, 0);
        }, AUTO_EXIT_DELAY_MS);
    }

    private setThreadTerminated(thread: VirtualThreadRecord, exitCode: number): void {
        if (thread.terminated) return;
        thread.terminated = true;
        thread.exitCode = exitCode >>> 0;
        thread.suspendCount = 0;
        if (thread.autoExitTimerId !== null) {
            clearTimeout(thread.autoExitTimerId);
            thread.autoExitTimerId = null;
        }

        const system = System.getInstance();
        for (const [handle, rec] of this.threadsByHandle) {
            if (rec === thread) {
                system.scheduler.setEvent(handle);
            }
        }
    }

    private setProcessTerminated(process: VirtualProcessRecord, exitCode: number): void {
        if (process.terminated) return;
        process.terminated = true;
        process.exitCode = exitCode >>> 0;

        const system = System.getInstance();
        for (const [handle, rec] of this.processesByHandle) {
            if (rec === process) {
                system.scheduler.setEvent(handle);
            }
        }
    }

    createProcess(params: CreateVirtualProcessParams): VirtualProcessInfo {
        this.pruneStaleHandles();
        this.ensureCurrentProcessRecord();

        const system = System.getInstance();
        const scheduler = system.scheduler;
        const processHandle = scheduler.createEvent(true, false);
        const threadHandle = scheduler.createEvent(true, false);
        const pid = this.nextPid++;
        const tid = this.nextTid++;
        const isSuspended = (params.creationFlags & CREATE_SUSPENDED) !== 0;
        const imageName = this.deriveImageName(params.applicationName, params.commandLine);

        const process: VirtualProcessRecord = {
            handle: processHandle,
            pid,
            parentPid: VIRTUAL_CURRENT_PROCESS_ID,
            imageName,
            commandLine: params.commandLine,
            currentDirectory: params.currentDirectory,
            terminated: false,
            exitCode: STILL_ACTIVE,
            primaryThreadHandle: threadHandle,
            primaryThreadId: tid,
            isCurrentProcess: false,
        };

        const thread: VirtualThreadRecord = {
            handle: threadHandle,
            threadId: tid,
            processPid: pid,
            suspendCount: isSuspended ? 1 : 0,
            started: !isSuspended,
            terminated: false,
            exitCode: STILL_ACTIVE,
            autoExitTimerId: null,
            context: this.createDefaultThreadContext(),
        };

        this.processesByHandle.set(process.handle, process);
        this.processesByPid.set(process.pid, process);
        this.threadsByHandle.set(thread.handle, thread);
        this.threadsByTid.set(thread.threadId, thread);

        if (!isSuspended) {
            this.startThreadExecution(thread);
        }

        Logger.log(
            LogCategory.KERNEL32,
            `[VirtualProcess] Create pid=${pid} tid=${tid} image="${imageName}" ` +
            `suspended=${isSuspended ? 1 : 0} handle=0x${processHandle.toString(16)} thread=0x${threadHandle.toString(16)}`
        );

        return {
            processHandle,
            threadHandle,
            processId: pid,
            threadId: tid,
        };
    }

    openProcessById(pid: number): number {
        this.pruneStaleHandles();

        if ((pid >>> 0) === VIRTUAL_CURRENT_PROCESS_ID) {
            const process = this.ensureCurrentProcessRecord();
            return this.createProcessAliasHandle(process);
        }

        const process = this.processesByPid.get(pid >>> 0);
        if (!process) return 0;
        return this.createProcessAliasHandle(process);
    }

    openThreadById(threadId: number): number {
        this.pruneStaleHandles();
        const thread = this.threadsByTid.get(threadId >>> 0);
        if (!thread) return 0;
        return this.createThreadAliasHandle(thread);
    }

    getProcessIdByHandle(handle: number): number | null {
        this.pruneStaleHandles();
        return this.processesByHandle.get(handle >>> 0)?.pid ?? null;
    }

    hasProcessHandle(handle: number): boolean {
        this.pruneStaleHandles();
        return this.processesByHandle.has(handle >>> 0);
    }

    getThreadIdByHandle(handle: number): number | null {
        this.pruneStaleHandles();
        return this.threadsByHandle.get(handle >>> 0)?.threadId ?? null;
    }

    hasThreadHandle(handle: number): boolean {
        this.pruneStaleHandles();
        return this.threadsByHandle.has(handle >>> 0);
    }

    duplicateHandle(sourceHandle: number): number | null {
        this.pruneStaleHandles();
        const process = this.processesByHandle.get(sourceHandle >>> 0);
        if (process) {
            return this.createProcessAliasHandle(process);
        }

        const thread = this.threadsByHandle.get(sourceHandle >>> 0);
        if (thread) {
            return this.createThreadAliasHandle(thread);
        }

        return null;
    }

    getThreadContext(handle: number): VirtualThreadContext | null {
        this.pruneStaleHandles();
        const thread = this.threadsByHandle.get(handle >>> 0);
        if (!thread) return null;
        return { ...thread.context };
    }

    setThreadContext(handle: number, partial: Partial<VirtualThreadContext>): boolean {
        this.pruneStaleHandles();
        const thread = this.threadsByHandle.get(handle >>> 0);
        if (!thread || thread.terminated) return false;

        if (partial.edi !== undefined) thread.context.edi = partial.edi >>> 0;
        if (partial.esi !== undefined) thread.context.esi = partial.esi >>> 0;
        if (partial.ebx !== undefined) thread.context.ebx = partial.ebx >>> 0;
        if (partial.edx !== undefined) thread.context.edx = partial.edx >>> 0;
        if (partial.ecx !== undefined) thread.context.ecx = partial.ecx >>> 0;
        if (partial.eax !== undefined) thread.context.eax = partial.eax >>> 0;
        if (partial.ebp !== undefined) thread.context.ebp = partial.ebp >>> 0;
        if (partial.eip !== undefined) thread.context.eip = partial.eip >>> 0;
        if (partial.eflags !== undefined) thread.context.eflags = partial.eflags >>> 0;
        if (partial.esp !== undefined) thread.context.esp = partial.esp >>> 0;

        return true;
    }

    resumeThread(handle: number): number | null {
        this.pruneStaleHandles();
        const thread = this.threadsByHandle.get(handle >>> 0);
        if (!thread) return null;
        if (thread.terminated) return 0xFFFFFFFF;

        const prev = thread.suspendCount >>> 0;
        if (thread.suspendCount > 0) {
            thread.suspendCount--;
        }

        if (thread.suspendCount === 0) {
            this.startThreadExecution(thread);
        }

        return prev;
    }

    suspendThread(handle: number): number | null {
        this.pruneStaleHandles();
        const thread = this.threadsByHandle.get(handle >>> 0);
        if (!thread) return null;
        if (thread.terminated) return 0xFFFFFFFF;

        const prev = thread.suspendCount >>> 0;
        thread.suspendCount++;
        if (thread.autoExitTimerId !== null) {
            clearTimeout(thread.autoExitTimerId);
            thread.autoExitTimerId = null;
        }
        return prev;
    }

    terminateProcess(handle: number, exitCode: number): boolean {
        this.pruneStaleHandles();
        const process = this.processesByHandle.get(handle >>> 0);
        if (!process) return false;

        const thread = this.threadsByHandle.get(process.primaryThreadHandle);
        if (thread) {
            this.setThreadTerminated(thread, exitCode);
        }
        this.setProcessTerminated(process, exitCode);
        return true;
    }

    terminateThread(handle: number, exitCode: number): boolean {
        this.pruneStaleHandles();
        const thread = this.threadsByHandle.get(handle >>> 0);
        if (!thread) return false;

        const process = this.processesByPid.get(thread.processPid);
        this.setThreadTerminated(thread, exitCode);
        if (process) {
            this.setProcessTerminated(process, exitCode);
        }
        return true;
    }

    getExitCodeProcess(handle: number): number | null {
        this.pruneStaleHandles();
        const process = this.processesByHandle.get(handle >>> 0);
        if (!process) return null;
        return process.terminated ? process.exitCode >>> 0 : STILL_ACTIVE;
    }

    getExitCodeThread(handle: number): number | null {
        this.pruneStaleHandles();
        const thread = this.threadsByHandle.get(handle >>> 0);
        if (!thread) return null;
        return thread.terminated ? thread.exitCode >>> 0 : STILL_ACTIVE;
    }

    listProcessSnapshotEntries(): VirtualProcessSnapshotEntry[] {
        this.pruneStaleHandles();
        const list: VirtualProcessSnapshotEntry[] = [];
        for (const process of this.processesByPid.values()) {
            if (process.terminated) continue;
            list.push({
                pid: process.pid >>> 0,
                parentPid: process.parentPid >>> 0,
                exeName: process.imageName || 'child.exe',
            });
        }
        return list;
    }

    listThreadSnapshotEntries(): VirtualThreadSnapshotEntry[] {
        this.pruneStaleHandles();
        const list: VirtualThreadSnapshotEntry[] = [];
        for (const thread of this.threadsByTid.values()) {
            if (thread.terminated) continue;
            list.push({
                tid: thread.threadId >>> 0,
                ownerPid: thread.processPid >>> 0,
                basePri: 8,
            });
        }
        return list;
    }

    /** Drop every virtual child process/thread on game switch. */
    reset(): void {
        for (const thread of this.threadsByHandle.values()) {
            if (thread.autoExitTimerId !== null) {
                clearTimeout(thread.autoExitTimerId);
                thread.autoExitTimerId = null;
            }
        }
        this.processesByHandle.clear();
        this.processesByPid.clear();
        this.threadsByHandle.clear();
        this.threadsByTid.clear();
        this.nextPid = 5000;
        this.nextTid = 0x100000;
        this.currentProcessHandle = 0;
    }
}

const virtualProcessManager = new VirtualProcessManager();

export const getVirtualProcessManager = (): VirtualProcessManager => virtualProcessManager;
