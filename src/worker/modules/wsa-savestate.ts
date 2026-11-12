import type { Process } from "../core/process";
import { savestateParticipants, stateKeys, type FieldPolicy } from "../savestate/participant";
import { CaptureRefusal } from "../savestate/object-codecs";
import type { SaveValue } from "../savestate/value-codec";
import { wsaAsyncLookupsPending, wsaAsyncTaskCounter, type WsaProcessState } from "./wsa-stub-shared";
import { wsaOverlappedOpenForSavestate } from "./wsa-overlapped";
import { wsaBlockingOpenForSavestate } from "./wsa-blocking";
import { wsaNamespaceOpenForSavestate } from "./wsa-namespace";
import { wsaControlApcsOpenForSavestate } from "./wsa-control-apc";

export const WSOCK32_FIELDS = {
    name: 'transient', exports: 'host', socketTable: 'host', wsaState: 'host',
} as const satisfies Record<string, FieldPolicy>;

export const WS2_32_FIELDS = {
    name: 'transient', exports: 'host', socketTable: 'host', wsaState: 'host', resetAddrInfo: 'host',
} as const satisfies Record<string, FieldPolicy>;

export const WINSOCK_PROCESS_FIELDS = {
    table: 'host', counter: 'save', buffers: 'save', setError: 'host', getError: 'host', reset: 'host',
} as const satisfies Record<keyof WsaProcessState, FieldPolicy>;

export interface WinsockState {
    startups: number;
    version: number;
    nextSocket: number;
    nextAsyncTask: number;
    hostent: Array<[number, number]>;
    protoent: number;
    servent: number;
    addrinfo: Array<[number, number[]]>;
}

export const WINSOCK_SCHEMA = {
    modules: { wsock32: WSOCK32_FIELDS, ws2_32: WS2_32_FIELDS },
    process: WINSOCK_PROCESS_FIELDS,
    hostentRow: ['thread', 'ptr'],
    addrinfoRow: ['head', 'blocks'],
    state: stateKeys<WinsockState>({
        startups: true, version: true, nextSocket: true, nextAsyncTask: true,
        hostent: true, protoent: true, servent: true, addrinfo: true,
    }),
};

interface ProviderStub { dllName: string; functionName: string; address: number; }
interface OpenThings { count: number; names: string[]; nextSocket: number; }

export function winsockOpenForSavestate(process: Process, state: WsaProcessState): OpenThings {
    const hex = (value: number) => "0x" + (value >>> 0).toString(16);
    let count = 0, nextSocket = 0;
    const names: string[] = [];
    try {
        const sockets = state.table.openForSavestate();
        if (!sockets || !Array.isArray(sockets.open) || !Number.isInteger(sockets.count) || !Number.isInteger(sockets.nextHandle)) throw new Error("malformed answer");
        count = sockets.count; nextSocket = sockets.nextHandle; names.push(...sockets.open);
    } catch (e) {
        count = 1; names.push(`the socket provider did not answer (${e instanceof Error ? e.message || e.name : String(e)})`);
    }
    const others = [
        ...wsaAsyncLookupsPending(process).map(task => `asynchronous lookup ${hex(task)}`),
        ...wsaNamespaceOpenForSavestate(state.table),
        ...wsaOverlappedOpenForSavestate(state.table),
        ...wsaControlApcsOpenForSavestate(process),
        ...wsaBlockingOpenForSavestate(state),
        ...((process.thunkGenerator?.captureState().stubs ?? []) as ProviderStub[]).filter(stub => stub.dllName.toLowerCase() === "__winsock")
            .map(stub => `provider entry point ${stub.functionName} at ${hex(stub.address)}`),
    ];
    return { count: count + others.length, names: [...names, ...others], nextSocket };
}

export function captureWinsockSavestate(process: Process, state: WsaProcessState): WinsockState {
    const open = winsockOpenForSavestate(process, state);
    if (open.count > 0) {
        throw new Error(`winsock: not idle, ${open.count} thing(s) open: ${open.names.slice(0, 4).join(', ')}${open.count > 4 ? ', …' : ''}`);
    }
    const generation = state.table.generation, buffers = state.buffers;
    return {
        ...state.counter.captureState(),
        nextSocket: open.nextSocket,
        nextAsyncTask: wsaAsyncTaskCounter(),
        hostent: [...buffers.hostent].filter(([, buffer]) => buffer.generation === generation)
            .map(([thread, buffer]): [number, number] => [thread, buffer.ptr]).sort((a, b) => a[0] - b[0]),
        protoent: buffers.protoent,
        servent: buffers.servent,
        addrinfo: [...buffers.addrinfo].map(([head, blocks]): [number, number[]] => [head, [...blocks]]).sort((a, b) => a[0] - b[0]),
    };
}

export function restoreWinsockSavestate(process: Process, state: WsaProcessState, saved: WinsockState): void {
    const open = winsockOpenForSavestate(process, state);
    if (open.count > 0) throw new Error(`winsock: the fresh session is not idle: ${open.names.slice(0, 4).join(', ')}`);
    const generation = state.table.generation, buffers = state.buffers;
    state.counter.restoreState(saved.startups, saved.version);
    state.table.advanceHandles(saved.nextSocket);
    wsaAsyncTaskCounter(saved.nextAsyncTask);
    buffers.hostent.clear();
    for (const [thread, ptr] of saved.hostent) buffers.hostent.set(thread, { generation, ptr });
    buffers.protoent = saved.protoent;
    buffers.servent = saved.servent;
    buffers.addrinfo.clear();
    for (const [head, blocks] of saved.addrinfo) buffers.addrinfo.set(head, [...blocks]);
}

export function registerWinsockSavestate(process: Process, state: WsaProcessState): () => void {
    return savestateParticipants.add({
        id: 'winsock', version: 1, order: 77, covers: ['wsock32', 'ws2_32'], schema: WINSOCK_SCHEMA as unknown as SaveValue,
        capture: () => {
            try {
                return captureWinsockSavestate(process, state) as unknown as SaveValue;
            } catch (e) {
                throw e instanceof CaptureRefusal ? e : new CaptureRefusal(e instanceof Error ? e.message : String(e));
            }
        },
        restore: (saved) => restoreWinsockSavestate(process, state, saved as unknown as WinsockState),
    });
}
