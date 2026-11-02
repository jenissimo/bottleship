import type { Process } from '../core/process';
import type { DeferredWrite, ThunkImplementation, ThunkResult } from '../core/thunking/thunk-dispatcher';
import type { WsaErrorSetter } from './wsa-network-api';
import { WsaFailure, type WsaSocketTable } from './wsa-network';
import { Mem } from '../core/memory/mem-accessor';

export interface NamespaceHost { canonicalName: string; addresses: Uint8Array[]; scopeIds?: number[]; }
type Resolve = (name: string, signal?: AbortSignal, family?: 0 | 4 | 6) => NamespaceHost | Promise<NamespaceHost>;
interface Protocol { family: number; protocol: number; }
interface Query {
    name: string; classId: Uint8Array; flags: number; protocols: Protocol[]; controller: AbortController;
    generation: number; closed: boolean; consumed: boolean; host?: NamespaceHost; resolving?: Promise<NamespaceHost>;
}
interface NamespaceState { generation: number; next: number; queries: Map<number, Query>; }
const states = new WeakMap<WsaSocketTable, NamespaceState>();
const DNS_PROVIDER = Uint8Array.of(0x8c,0x8f,0x51,0x4d,0x42,0x53,0x41,0x4c,0x92,0x4e,0x42,0x53,0x44,0x4e,0x53,1);
const SAME = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
const fail = (code: number): never => { throw new WsaFailure(code); };
const word = (address: number, value: number): DeferredWrite => ({ address, value: value >>> 0, size: 4 });
function patches(address: number, bytes: Uint8Array): DeferredWrite[] {
    const writes: DeferredWrite[] = []; let i = 0;
    for (; i + 4 <= bytes.length; i += 4) writes.push(word(address + i, new DataView(bytes.buffer, bytes.byteOffset + i, 4).getUint32(0, true)));
    for (; i < bytes.length; i++) writes.push({ address: address + i, value: bytes[i], size: 1 });
    return writes;
}
function textBytes(value: string, wide: boolean): Uint8Array {
    if (!wide) return new TextEncoder().encode(value + '\0');
    const result = new Uint8Array((value.length + 1) * 2), view = new DataView(result.buffer);
    for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true);
    return result;
}
function context(process: Process, table: WsaSocketTable): NamespaceState {
    let state = states.get(table); if (state) return state;
    state = { generation: table.generation, next: 0x70000000, queries: new Map() };
    states.set(table, state); const owned = state;
    const clear = () => {
        for (const query of owned.queries.values()) { query.closed = true; query.controller.abort(); }
        owned.queries.clear(); owned.generation = table.generation;
    };
    table.subscribe(() => { if (owned.generation !== table.generation) clear(); });
    process.onReset(clear);
    return state;
}
/** A contiguous WSAQUERYSET image owns all referenced strings, CSADDR_INFOs and HOSTENT data. */
function queryImage(base: number, query: Query, host: NamespaceHost, wide: boolean): Uint8Array {
    const parts: Array<{ offset: number; bytes: Uint8Array }> = [];
    let end = 60;
    const allocate = (bytes: Uint8Array) => { const offset = (end + 3) & ~3; parts.push({ offset, bytes }); end = offset + bytes.length; return offset; };
    const header = new Uint8Array(60), out = new DataView(header.buffer);
    const service = new DataView(query.classId.buffer, query.classId.byteOffset, 16);
    const kind = service.getUint16(2, true);
    const internetService = (kind === 9 || kind === 10) && service.getUint16(4, true) === 0 &&
        SAME(query.classId.subarray(8), Uint8Array.of(0xc0,0,0,0,0,0,0,0x46));
    const serviceProtocol = internetService ? kind === 9 ? 6 : 17 : 0;
    const servicePort = internetService ? service.getUint16(0, true) : 0;
    out.setUint32(0, 60, true); out.setUint32(20, 12, true);
    if (query.flags & 0x20) out.setUint32(8, base + allocate(query.classId), true);
    const addresses = host.addresses.flatMap((ip, index) => query.protocols
        .filter(protocol => protocol.family === (ip.length === 4 ? 2 : 23))
        .map(protocol => ({ ip, scope: host.scopeIds?.[index] ?? 0, ...protocol })));
    if ((query.flags & 0x100) && addresses.length) {
        const entries = new Uint8Array(24 * addresses.length), view = new DataView(entries.buffer);
        out.setUint32(44, addresses.length, true); out.setUint32(48, base + allocate(entries), true);
        addresses.forEach((address, index) => {
            const size = address.family === 2 ? 16 : 28, local = new Uint8Array(size), remote = new Uint8Array(size);
            new DataView(local.buffer).setUint16(0, address.family, true);
            const sock = new DataView(remote.buffer); sock.setUint16(0, address.family, true);
            if (address.protocol === serviceProtocol) sock.setUint16(2, servicePort, false);
            remote.set(address.ip, address.family === 2 ? 4 : 8);
            if (size === 28) sock.setUint32(24, address.scope, true);
            view.setUint32(index * 24, base + allocate(local), true); view.setUint32(index * 24 + 4, size, true);
            view.setUint32(index * 24 + 8, base + allocate(remote), true); view.setUint32(index * 24 + 12, size, true);
            view.setUint32(index * 24 + 16, address.protocol === 6 ? 1 : 2, true); view.setUint32(index * 24 + 20, address.protocol, true);
        });
    }
    if ((query.flags & 0x200) && host.addresses.length) {
        const first = host.addresses[0], ips = host.addresses.filter(ip => ip.length === first.length);
        const name = textBytes(host.canonicalName, false), list = 20, data = list + 4 * (ips.length + 1), nameAt = data + ips.length * first.length;
        const blob = new Uint8Array(nameAt + name.length), image = new DataView(blob.buffer);
        image.setUint32(0, nameAt, true); image.setUint32(4, 16, true);
        image.setUint16(8, first.length === 4 ? 2 : 23, true); image.setUint16(10, first.length, true);
        image.setUint32(12, list, true); blob.set(name, nameAt);
        ips.forEach((ip, index) => { image.setUint32(list + index * 4, data + index * first.length, true); blob.set(ip, data + index * first.length); });
        const descriptor = new Uint8Array(8), fields = new DataView(descriptor.buffer);
        out.setUint32(56, base + allocate(descriptor), true);
        fields.setUint32(0, blob.length, true); fields.setUint32(4, base + allocate(blob), true);
    }
    if (query.flags & 0x10) {
        out.setUint32(4, base + allocate(textBytes(host.canonicalName, wide)), true);
        out.setUint32(40, base + allocate(textBytes(host.canonicalName, wide)), true);
    }
    const result = new Uint8Array(end); result.set(header);
    for (const part of parts) result.set(part.bytes, part.offset);
    return result;
}

/** The DNS namespace resolves through the same scoped, cancellable resolver as getaddrinfo. */
export function makeNamespaceExports(process: Process, table: WsaSocketTable, counter: { started: boolean }, setError: WsaErrorSetter,
    resolve: Resolve, resolveError: (error: unknown) => number): Record<string, ThunkImplementation> {
    const api: Record<string, ThunkImplementation> = {};
    const guard = (address: number, size: number, permission: 'r' | 'rw' = 'r') => {
        if (!address || !process.addressSpace.validateRange(address, size, permission)) fail(10014);
    };
    const readText = (address: number, wide: boolean): string => {
        if (!address) fail(10022); const units: number[] = [], step = wide ? 2 : 1;
        for (let i = 0; i < 32768; i++) {
            guard(address + i * step, step);
            const value = wide ? Mem.readUint16(address + i * step)! : Mem.readUint8(address + i)!;
            if (!value) return wide ? String.fromCharCode(...units) : new TextDecoder('windows-1252').decode(Uint8Array.from(units));
            units.push(value);
        }
        return fail(10014);
    };
    const invoke = (handler: (args: number[]) => number | ThunkResult | Promise<ThunkResult>): ThunkImplementation => (_ctx, _mem, args) => {
        const report = setError.capture?.() ?? setError;
        const failed = (error: unknown): number => { report(error instanceof WsaFailure ? error.code : resolveError(error)); return -1; };
        try {
            if (!counter.started) fail(10093);
            const answer = handler(args.map(value => value >>> 0));
            return answer instanceof Promise ? answer.catch(error => ({ value: failed(error) })) : answer;
        } catch (error) { return failed(error); }
    };
    for (const wide of [false, true]) {
        const suffix = wide ? 'W' : 'A';
        api['WSAEnumNameSpaceProviders' + suffix] = invoke(args => {
            guard(args[0], 4, 'rw'); const capacity = Mem.readUint32(args[0])!;
            const name = textBytes('BottleShip DNS namespace', wide), length = 32 + name.length;
            if (capacity < length || !args[1]) { Mem.writeUint32(args[0], length); return fail(10014); }
            guard(args[1], capacity, 'rw');
            const bytes = new Uint8Array(length), out = new DataView(bytes.buffer); bytes.set(DNS_PROVIDER);
            out.setUint32(16, 12, true); out.setUint32(20, 1, true); out.setUint32(24, 1, true); out.setUint32(28, args[1] + 32, true);
            bytes.set(name, 32); Mem.writeBytes(args[1], bytes); return 1;
        });
        api['WSALookupServiceBegin' + suffix] = invoke(args => {
            guard(args[2], 4, 'rw'); guard(args[0], 60);
            const reject = (code: number): never => { Mem.writeUint32(args[2], 0); return fail(code); };
            if (Mem.readUint32(args[0])! < 60) return reject(10014);
            const namePointer = Mem.readUint32(args[0] + 4)!, cls = Mem.readUint32(args[0] + 8)!;
            const name = namePointer ? readText(namePointer, wide) : '';
            if (!cls) return reject(87);
            const namespace = Mem.readUint32(args[0] + 20)!, provider = Mem.readUint32(args[0] + 24)!;
            if (cls) guard(cls, 16);
            if (provider) guard(provider, 16);
            const classId = Mem.readBytes(cls, 16)!.slice();
            if (provider && !SAME(Mem.readBytes(provider, 16)!, DNS_PROVIDER)) return reject(10022);
            if (namespace !== 0 && namespace !== 12) return reject(10108);
            const protocols: Protocol[] = [], count = Mem.readUint32(args[0] + 32)!, pairs = Mem.readUint32(args[0] + 36)!;
            if (pairs && count > 1024) return reject(10022);
            if (count && pairs) {
                guard(pairs, count * 8);
                for (let i = 0; i < count; i++) {
                    const family = Mem.readUint32(pairs + i * 8)!, protocol = Mem.readUint32(pairs + i * 8 + 4)!;
                    for (const af of [2, 23]) for (const ip of [6, 17]) if ((!family || family === af) && protocol === ip &&
                        !protocols.some(pair => pair.family === af && pair.protocol === ip)) protocols.push({ family: af, protocol: ip });
                }
            } else for (const family of [2, 23]) for (const protocol of [6, 17]) protocols.push({ family, protocol });
            if (!protocols.length) { Mem.writeUint32(args[2], 0); return fail(11004); }
            const state = context(process, table);
            if (state.queries.size >= 4096 || state.next > 0xfffffffc) return fail(10055);
            const handle = state.next; state.next += 4;
            state.queries.set(handle, { name, classId, flags: args[1], protocols, generation: table.generation,
                controller: new AbortController(), closed: false, consumed: false });
            Mem.writeUint32(args[2], handle); setError(0); return 0;
        });
        api['WSALookupServiceNext' + suffix] = invoke(args => {
            guard(args[2], 4, 'rw'); const capacity = Mem.readUint32(args[2])!;
            if (capacity) guard(args[3], capacity, 'rw');
            const query = context(process, table).queries.get(args[0]); if (!query) return fail(6);
            const epoch = process.resetGeneration, report = setError.capture?.() ?? setError;
            const deliver = (host: NamespaceHost): ThunkResult => {
                if (epoch !== process.resetGeneration) return { value: -1 };
                if (query.closed || query.generation !== table.generation) return fail(10103);
                if (args[1] & 0x2000) query.consumed = true;
                if (query.consumed) return fail(10110);
                const image = queryImage(args[3], query, host, wide);
                if (!args[3] || capacity < image.length) {
                    report(10014); return { value: -1, deferredWrites: [word(args[2], image.length)] };
                }
                query.consumed = true; report(0);
                return { value: 0, deferredWrites: patches(args[3], image) };
            };
            if (query.consumed) return fail(10110);
            if (query.host) {
                const result = deliver(query.host);
                for (const patch of result.deferredWrites ?? []) if (patch.size === 4) Mem.writeUint32(patch.address, patch.value); else Mem.writeUint8(patch.address, patch.value);
                return result.value;
            }
            if (!query.resolving) {
                const families = new Set(query.protocols.map(pair => pair.family)), family = families.size === 1 ? families.has(2) ? 4 : 6 : 0;
                const resolved = resolve(query.name, query.controller.signal, family);
                if (!(resolved instanceof Promise)) {
                    query.host = resolved; const result = deliver(resolved);
                    for (const patch of result.deferredWrites ?? []) if (patch.size === 4) Mem.writeUint32(patch.address, patch.value); else Mem.writeUint8(patch.address, patch.value);
                    return result.value;
                }
                query.resolving = resolved.then(host => { query.host = host; return host; });
            }
            return query.resolving.then(deliver, error => { if (query.closed) return fail(10103); throw error; });
        });
    }
    api.WSALookupServiceEnd = invoke(args => {
        const state = context(process, table), query = state.queries.get(args[0]); if (!query) return fail(6);
        query.closed = true; query.controller.abort(); state.queries.delete(args[0]); return 0;
    });
    return api;
}
