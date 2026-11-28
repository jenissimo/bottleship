import {readCompoundStreams, writeCompoundStreams, compoundNameKey, isCompoundStreamName} from '@bottleship/formats/msi';
import type {Process} from '../core/process';
import {System} from '../core/system';
import type {VfsFileHandle} from '../runtime/filesystem/vfs';
import {allocateComObject, freeComObject} from '../core/com/com-memory';
import {installComVtable} from '../core/com/install-com-vtable';
import type {ThunkImplementation} from '../core/thunking/thunk-dispatcher';
import {readGuidFromMem} from '../core/com/typelib/typelib-types';
import {Mem} from '../core/memory/mem-accessor';
import {isValidUserAddress} from '../core/memory/address-guard';

const S_OK = 0;
const S_FALSE = 1;
const E_POINTER = 0x80004003;
const E_NOINTERFACE = 0x80004002;
const E_OUTOFMEMORY = 0x8007000e;
const STG_E_INVALIDFUNCTION = 0x80030001;
const STG_E_FILENOTFOUND = 0x80030002;
const STG_E_ACCESSDENIED = 0x80030005;
const STG_E_WRITEFAULT = 0x8003001d;
const STG_E_SHAREVIOLATION = 0x80030020;
const STG_E_FILEALREADYEXISTS = 0x80030050;
const STG_E_INVALIDPARAMETER = 0x80030057;
const STG_E_MEDIUMFULL = 0x80030070;
const STG_E_INVALIDNAME = 0x800300fc;
const STG_E_INVALIDFLAG = 0x800300ff;
const STG_E_INVALIDHEADER = 0x800300fb;
const STG_E_REVERTED = 0x80030102;

const STGM_CREATE = 0x1000;
const STGM_SHARE_EXCLUSIVE = 0x10;
const STGM_SHARE_DENY_WRITE = 0x20;
const CREATE_NEW = 1;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;
const READ_WRITE = 0xc0000000;
const MAX_STREAM_SIZE = 0x7fffffff;

const IUNKNOWN = '00000000-0000-0000-c000-000000000046';
const ISTORAGE = '0000000b-0000-0000-c000-000000000046';
const ISTREAM = '0000000c-0000-0000-c000-000000000046';
const ISEQUENTIALSTREAM = '0c733a30-2a1c-11ce-ade5-00aa0044773d';

const unknownMethods = [['QueryInterface', 3], ['AddRef', 1], ['Release', 1]] as const;
const storageMethods = [...unknownMethods,
    ['CreateStream', 6], ['OpenStream', 6], ['CreateStorage', 6], ['OpenStorage', 7],
    ['CopyTo', 5], ['MoveElementTo', 5], ['Commit', 2], ['Revert', 1], ['EnumElements', 5],
    ['DestroyElement', 2], ['RenameElement', 3], ['SetElementTimes', 5], ['SetClass', 2],
    ['SetStateBits', 3], ['Stat', 3]] as const;
const streamMethods = [...unknownMethods,
    ['Read', 4], ['Write', 4], ['Seek', 5], ['SetSize', 3], ['CopyTo', 6],
    ['Commit', 2], ['Revert', 1], ['LockRegion', 6], ['UnlockRegion', 6], ['Stat', 3], ['Clone', 2]] as const;

interface StreamData {
    name: string;
    data: Uint8Array;
    size: number;
    handles: number;
}

interface DocumentData {
    path: string;
    key: string;
    streams: Map<string, StreamData>;
    revision: number;
    committed: number;
    writing: Promise<number>;
    closed: boolean;
}

interface StorageHandle {
    doc: DocumentData;
    mode: number;
    refs: number;
}

interface StreamHandle extends StorageHandle {
    stream: StreamData;
    pos: number;
}

function valid(mem: Uint8Array, ptr: number, size: number, access: 'r' | 'rw' = 'r'): boolean {
    return isValidUserAddress(mem, ptr, size, access);
}

function dataView(mem: Uint8Array): DataView {
    return new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
}

function readWide(mem: Uint8Array, ptr: number, limit: number): string | null {
    if (!valid(mem, ptr, 2)) return null;
    const view = dataView(mem);
    let out = '';
    for (let i = 0; i < limit && ptr + i * 2 + 2 <= mem.length; i++) {
        const ch = view.getUint16(ptr + i * 2, true);
        if (ch === 0) return out;
        out += String.fromCharCode(ch);
    }
    return null;
}

function exclusiveMode(mode: number, create: boolean): boolean {
    return (mode & ~(create ? STGM_CREATE | 3 : 3)) === STGM_SHARE_EXCLUSIVE
        && (mode & 3) !== 3 && (!create || (mode & 3) !== 0);
}

export class StructuredStorage {
    private readonly storage = new Map<number, StorageHandle>();
    private readonly streams = new Map<number, StreamHandle>();
    private readonly openPaths = new Map<string, { sharedRead: boolean; count: number }>();
    private readonly storageVtable: number;
    private readonly streamVtable: number;

    constructor(private readonly process: Process, private readonly allocTask: (bytes: number) => number) {
        this.storageVtable = this.install('ole32-istorage', storageMethods, {
            ...this.unknown(this.storage, ISTORAGE),
            CreateStream: (_ctx, mem, args) => this.openStream(mem, args, true),
            OpenStream: (_ctx, mem, args) => this.openStream(mem, args, false),
            Commit: (_ctx, _mem, [ptr, flags]) => flags ? STG_E_INVALIDFLAG : this.commitHandle(this.storage.get(ptr)),
            Stat: (_ctx, mem, [ptr, stat, flags]) => this.stat(mem, this.storage.get(ptr), stat, flags),
        });
        this.streamVtable = this.install('ole32-istream', streamMethods, {
            ...this.unknown(this.streams, ISTREAM, ISEQUENTIALSTREAM),
            Read: (_ctx, mem, args) => this.readStream(mem, args),
            Write: (_ctx, mem, args) => this.writeStream(mem, args),
            Seek: (_ctx, mem, args) => this.seekStream(mem, args),
            SetSize: (_ctx, _mem, [ptr, low, high]) => this.setSize(ptr, low, high),
            Commit: (_ctx, _mem, [ptr, flags]) => flags ? STG_E_INVALIDFLAG : this.commitHandle(this.streams.get(ptr)),
            Stat: (_ctx, mem, [ptr, stat, flags]) => this.stat(mem, this.streams.get(ptr), stat, flags),
            Clone: (_ctx, mem, [ptr, out]) => this.cloneStream(mem, ptr, out),
        });
    }

    get hasOpenObjects(): boolean {
        return this.openPaths.size > 0 || this.storage.size > 0 || this.streams.size > 0;
    }

    private install(moduleName: string, slots: ReadonlyArray<readonly [string, number]>, handlers: Record<string, ThunkImplementation>): number {
        for (const [name] of slots) handlers[name] ??= () => STG_E_INVALIDFUNCTION;
        const methods = slots.map(([name, argCount]) => ({name, argCount, stackCleanupBytes: argCount * 4}));
        return installComVtable(this.process, {moduleName, methods, handlers})?.vtableAddr ?? 0;
    }

    private unknown<T extends StorageHandle>(handles: Map<number, T>, ...interfaces: string[]): Record<string, ThunkImplementation> {
        return {
            QueryInterface: (_ctx, mem, [ptr, iid, out]) => {
                if (!valid(mem, out, 4, 'rw')) return E_POINTER;
                const view = dataView(mem);
                view.setUint32(out, 0, true);
                const handle = handles.get(ptr);
                if (!handle || !valid(mem, iid, 16)) return E_POINTER;
                const name = readGuidFromMem(mem, iid);
                if (name !== IUNKNOWN && !interfaces.includes(name)) return E_NOINTERFACE;
                view.setUint32(out, ptr, true);
                handle.refs++;
                return S_OK;
            },
            AddRef: (_ctx, _mem, [ptr]) => {
                const handle = handles.get(ptr);
                return handle ? ++handle.refs : 0;
            },
            Release: (_ctx, _mem, [ptr]) => {
                const handle = handles.get(ptr);
                if (!handle) return 0;
                const refs = --handle.refs;
                if (refs) return refs;
                handles.delete(ptr);
                freeComObject(this.process.memory, ptr);
                if ('stream' in handle) {
                    (handle as unknown as StreamHandle).stream.handles--;
                    return 0;
                }
                return this.releaseDocument(handle.doc);
            },
        };
    }

    async open(mem: Uint8Array, args: number[], create: boolean): Promise<number> {
        const [pathPtr, arg1, arg2, arg3, arg4, arg5] = args;
        const out = create ? arg3 : arg5;
        const mode = create ? arg1 : arg2;
        if (!valid(mem, out, 4, 'rw')) return E_POINTER;
        Mem.writeUint32(out, 0);
        if (!pathPtr || (create ? arg2 : arg1 || arg3 || arg4)) return STG_E_INVALIDPARAMETER;
        const sharedRead = !create && mode === STGM_SHARE_DENY_WRITE;
        if (!sharedRead && !exclusiveMode(mode, create)) return STG_E_INVALIDFLAG;
        const path = readWide(mem, pathPtr, 32768);
        if (!path) return STG_E_INVALIDNAME;
        if (!this.storageVtable || !this.streamVtable) return E_OUTOFMEMORY;
        const vfs = System.getInstance().fileSystem;
        const full = vfs.resolvePath(path);
        const key = full.toLowerCase();
        const lock = this.openPaths.get(key);
        if (lock && (!sharedRead || !lock.sharedRead)) return STG_E_SHAREVIOLATION;
        if (lock) lock.count++;
        else this.openPaths.set(key, {sharedRead, count: 1});
        let status = STG_E_ACCESSDENIED;
        let address = 0;
        try {
            const doc: DocumentData = {
                path: full, key, streams: new Map(), revision: 0, committed: 0,
                writing: Promise.resolve(S_OK), closed: false,
            };
            if (create) {
                const overwrite = (mode & STGM_CREATE) !== 0;
                if (!overwrite && vfs.resolveStoredFile(full)) return STG_E_FILEALREADYEXISTS;
                const created = await vfs.open(full, READ_WRITE, overwrite ? CREATE_ALWAYS : CREATE_NEW);
                if (!created) return status;
                status = await this.writeDocument(doc, created);
                if (status !== S_OK) return status;
            } else {
                const file = await vfs.open(full, mode & 3 ? READ_WRITE : 0x80000000, OPEN_EXISTING);
                if (!file) return STG_E_FILENOTFOUND;
                const size = vfs.getFileSize(full);
                if (size < 512 || size > MAX_STREAM_SIZE) return STG_E_INVALIDHEADER;
                status = STG_E_INVALIDHEADER;
                const bytes = await vfs.read(file, size);
                for (const [name, data] of readCompoundStreams(bytes, true)) {
                    const key = compoundNameKey(name);
                    if (doc.streams.has(key)) return STG_E_INVALIDHEADER;
                    doc.streams.set(key, {name, data, size: data.length, handles: 0});
                }
            }
            status = E_OUTOFMEMORY;
            address = allocateComObject(this.process.memory, this.process.getCurrentMemory(), this.storageVtable);
            this.storage.set(address, {doc, mode, refs: 1});
            Mem.writeUint32(out, address);
            return S_OK;
        } catch {
            return status;
        } finally {
            if (!address) this.releasePath(key);
        }
    }

    private releasePath(key: string): void {
        const lock = this.openPaths.get(key);
        if (lock && --lock.count === 0) this.openPaths.delete(key);
    }

    private async writeDocument(doc: DocumentData, handle?: VfsFileHandle): Promise<number> {
        const vfs = System.getInstance().fileSystem;
        try {
            const streams = new Map(Array.from(doc.streams.values(), item => [item.name, item.data.subarray(0, item.size)]));
            const bytes = writeCompoundStreams(streams);
            const file = handle ?? await vfs.open(doc.path, READ_WRITE, CREATE_ALWAYS);
            if (!file || await vfs.write(file, bytes) !== bytes.length) return STG_E_WRITEFAULT;
            await vfs.flushFile(doc.path, true);
            return S_OK;
        } catch {
            return STG_E_WRITEFAULT;
        }
    }

    private commitDocument(doc: DocumentData): Promise<number> {
        if (doc.committed === doc.revision) return doc.writing;
        doc.writing = doc.writing.then(async () => {
            if (doc.committed === doc.revision) return S_OK;
            const revision = doc.revision;
            const result = await this.writeDocument(doc);
            if (!result) doc.committed = revision;
            return result;
        });
        return doc.writing;
    }

    private async releaseDocument(doc: DocumentData): Promise<number> {
        doc.closed = true;
        try {
            await this.commitDocument(doc);
        } finally {
            this.releasePath(doc.key);
        }
        return 0;
    }

    private commitHandle(handle?: StorageHandle): number | Promise<number> {
        if (!handle || handle.doc.closed) return STG_E_REVERTED;
        return this.commitDocument(handle.doc);
    }

    private openStream(mem: Uint8Array, args: number[], create: boolean): number {
        const [ptr, namePtr, arg2, arg3, reserved, out] = args;
        if (!valid(mem, out, 4, 'rw')) return E_POINTER;
        Mem.writeUint32(out, 0);
        const handle = this.storage.get(ptr);
        if (!handle || handle.doc.closed) return STG_E_REVERTED;
        if (reserved || (create ? arg3 : arg2)) return STG_E_INVALIDPARAMETER;
        const mode = create ? arg2 : arg3;
        if (!exclusiveMode(mode, create)) return STG_E_INVALIDFLAG;
        if (((create || (mode & 3) !== 0) && (handle.mode & 3) === 0)) return STG_E_ACCESSDENIED;
        const name = readWide(mem, namePtr, 32);
        if (name === null || !isCompoundStreamName(name)) return STG_E_INVALIDNAME;
        const key = compoundNameKey(name);
        const existing = handle.doc.streams.get(key);
        if (existing?.handles) return STG_E_SHAREVIOLATION;
        if (!create && !existing) return STG_E_FILENOTFOUND;
        if (create && existing && !(mode & STGM_CREATE)) return STG_E_FILEALREADYEXISTS;

        const stream = create ? {name, data: new Uint8Array(), size: 0, handles: 0} : existing!;
        const result = this.newStream(handle.doc, stream, mode, 0, out);
        if (result === S_OK && create) {
            handle.doc.streams.set(key, stream);
            handle.doc.revision++;
        }
        return result;
    }

    private newStream(doc: DocumentData, stream: StreamData, mode: number, pos: number, out: number): number {
        try {
            const ptr = allocateComObject(this.process.memory, this.process.getCurrentMemory(), this.streamVtable);
            this.streams.set(ptr, {doc, stream, mode, pos, refs: 1});
            stream.handles++;
            Mem.writeUint32(out, ptr);
            return S_OK;
        } catch {
            return E_OUTOFMEMORY;
        }
    }

    private cloneStream(mem: Uint8Array, ptr: number, out: number): number {
        if (!valid(mem, out, 4, 'rw')) return E_POINTER;
        Mem.writeUint32(out, 0);
        const handle = this.streams.get(ptr);
        if (!handle || handle.doc.closed) return STG_E_REVERTED;
        return this.newStream(handle.doc, handle.stream, handle.mode, handle.pos, out);
    }

    private readStream(mem: Uint8Array, [ptr, buffer, count, out]: number[]): number {
        if ((count !== 0 && !valid(mem, buffer, count, 'rw')) || (out && !valid(mem, out, 4, 'rw'))) return E_POINTER;
        const view = dataView(mem);
        if (out) view.setUint32(out, 0, true);
        const handle = this.streams.get(ptr);
        if (!handle || handle.doc.closed) return STG_E_REVERTED;
        if ((handle.mode & 3) === 1) return STG_E_ACCESSDENIED;
        const read = Math.min(count, Math.max(0, handle.stream.size - handle.pos));
        if (read) mem.set(handle.stream.data.subarray(handle.pos, handle.pos + read), buffer);
        handle.pos += read;
        if (out) view.setUint32(out, read, true);
        return read === count ? S_OK : S_FALSE;
    }

    private grow(stream: StreamData, size: number): boolean {
        if (size > MAX_STREAM_SIZE) return false;
        if (size > stream.data.length) {
            try {
                const buffer = new Uint8Array(Math.max(size, Math.min(MAX_STREAM_SIZE, stream.data.length * 2)));
                buffer.set(stream.data);
                stream.data = buffer;
            } catch {
                return false;
            }
        }
        if (size > stream.size) stream.data.fill(0, stream.size, size);
        stream.size = size;
        return true;
    }

    private writeStream(mem: Uint8Array, [ptr, buffer, count, out]: number[]): number {
        if ((count !== 0 && !valid(mem, buffer, count)) || (out && !valid(mem, out, 4, 'rw'))) return E_POINTER;
        const view = dataView(mem);
        if (out) view.setUint32(out, 0, true);
        const handle = this.streams.get(ptr);
        if (!handle || handle.doc.closed) return STG_E_REVERTED;
        if ((handle.mode & 3) === 0) return STG_E_ACCESSDENIED;
        if (count) {
            const end = handle.pos + count;
            if (end > handle.stream.size && !this.grow(handle.stream, end)) return STG_E_MEDIUMFULL;
            handle.stream.data.set(mem.subarray(buffer, buffer + count), handle.pos);
            handle.pos = end;
            handle.doc.revision++;
            if (out) view.setUint32(out, count, true);
        }
        return S_OK;
    }

    private seekStream(mem: Uint8Array, [ptr, low, high, origin, out]: number[]): number {
        if (out && !valid(mem, out, 8, 'rw')) return E_POINTER;
        const handle = this.streams.get(ptr);
        if (!handle || handle.doc.closed) return STG_E_REVERTED;
        if (origin > 2) return STG_E_INVALIDFUNCTION;
        const base = [0, handle.pos, handle.stream.size][origin]!;
        const next = BigInt(base) + (BigInt(high | 0) << 32n) + BigInt(low >>> 0);
        if (next < 0 || next > BigInt(Number.MAX_SAFE_INTEGER)) return STG_E_INVALIDFUNCTION;
        handle.pos = Number(next);
        if (out) dataView(mem).setBigUint64(out, next, true);
        return S_OK;
    }

    private setSize(ptr: number, low: number, high: number): number {
        const handle = this.streams.get(ptr);
        if (!handle || handle.doc.closed) return STG_E_REVERTED;
        if ((handle.mode & 3) === 0) return STG_E_ACCESSDENIED;
        if (high || !this.grow(handle.stream, low >>> 0)) return STG_E_MEDIUMFULL;
        handle.doc.revision++;
        return S_OK;
    }

    private stat(mem: Uint8Array, handle: StorageHandle | StreamHandle | undefined, out: number, flags: number): number {
        if (!valid(mem, out, 72, 'rw')) return E_POINTER;
        if (!handle || handle.doc.closed) return STG_E_REVERTED;
        if (flags > 1) return STG_E_INVALIDFLAG;
        const stream = 'stream' in handle ? handle.stream : null;
        const name = stream?.name ?? handle.doc.path;
        const namePtr = flags === 0 ? this.allocTask((name.length + 1) * 2) : 0;
        if (flags === 0 && !namePtr) return E_OUTOFMEMORY;
        const fresh = this.process.getCurrentMemory();
        const view = dataView(fresh);
        if (namePtr) {
            for (let i = 0; i < name.length; i++) view.setUint16(namePtr + i * 2, name.charCodeAt(i), true);
            view.setUint16(namePtr + name.length * 2, 0, true);
        }
        fresh.fill(0, out, out + 72);
        view.setUint32(out, namePtr, true);
        view.setUint32(out + 4, stream ? 2 : 1, true);
        view.setUint32(out + 8, stream?.size ?? 0, true);
        view.setUint32(out + 40, handle.mode & ~STGM_CREATE, true);
        return S_OK;
    }
}
