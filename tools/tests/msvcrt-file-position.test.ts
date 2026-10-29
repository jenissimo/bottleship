import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Msvcrt } from '../../src/worker/modules/msvcrt';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';
import { msvcrtModule } from '../../src/worker/api/msvcrt.api';
import { installFakeOpfs } from './fixtures/fake-opfs';
let crt: any, vfs: VirtualFileSystem, mem: Uint8Array, fp: number, errno: number;
let saved: any, oldMem: any, oldNavigator: unknown, seq = 0;
let deny: (p: number, n: number, perms: string) => boolean;
const POS = 0x103;
const setPos = (n: bigint) => new DataView(mem.buffer).setBigInt64(POS, n, true);
const handle = () => crt.fileStreams.get(fp).handle;
const stream = () => crt.fileStreams.get(fp);
beforeEach(async () => {
    const sys = System.getInstance() as any;
    saved = { fileSystem: sys.fileSystem, process: sys.process };
    oldMem = Object.fromEntries(['memoryGetter', 'validateRange', 'getRegion'].map(k => [k, (Mem as any)[k]]));
    oldNavigator = globalThis.navigator;
    installFakeOpfs();
    vfs = new VirtualFileSystem();
    await vfs.initOverlay(`test:fpos-${++seq}`);
    mem = new Uint8Array(0x10000);
    deny = () => false;
    const check = (p: number, n: number, perms: string) => p > 0 && p + n <= mem.length && !deny(p, n, perms);
    Mem.bind(() => mem, check);
    let heap = 0x1000;
    errno = 0x77;
    crt = Object.create(Msvcrt.prototype);
    Object.assign(crt, { fileStreams: new Map(), temporaryFiles: new Map(), fds: new Map(),
        useRealFileStructs: false, currentLocale: 'C',
        malloc: (n: number) => { const p = heap; heap += n; return p; },
        free: () => {}, setErrno: (n: number) => { errno = n; return true; },
        memset: (p: number, c: number, n: number) => mem.fill(c, p, p + n),
    });
    sys.fileSystem = vfs;
    sys.process = { addressSpace: { validateRange: check } };
    const h = vfs.openSync('C:\\data.bin', 0xc0000000, 2)!;
    vfs.writeSync(h, Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x41, 0]));
    vfs.setPosition(h, 0, 0);
    crt.fds.set(3, h);
    fp = crt.createFileStream(3, h, 'r+b');
});
afterEach(async () => {
    await vfs.flushAll();
    Object.assign(System.getInstance(), saved);
    Object.assign(Mem, oldMem);
    (globalThis as any).navigator = oldNavigator;
});
test('fgetpos/fsetpos are cdecl with two arguments', () => {
    for (const name of ['fgetpos', 'fsetpos']) {
        const descriptor = msvcrtModule.functions.find(f => f.name === name)!;
        expect(descriptor.callingConvention).toBe('cdecl'); expect(descriptor.params.length).toBe(2);
    }
});
test('a negative position fails with EINVAL and leaves the stream where it was', () => {
    setPos(-1n);
    expect(crt.fsetpos(fp, POS)).toBe(-1); expect(errno).toBe(22);
    expect(handle().position).toBe(0); expect(crt.fgetc(fp)).toBe(0xff); expect(handle().position).toBe(1);
});
for (const position of [0n, 0x80000000n, 0x100000007n, BigInt(Number.MAX_SAFE_INTEGER)]) {
    test(`fpos_t roundtrip writes and reads all eight bytes at ${position}`, () => {
        mem.fill(0x7d, POS - 1, POS + 9);
        vfs.setPosition(handle(), Number(position), 0);
        expect(crt.fgetpos(fp, POS)).toBe(0);
        expect(new DataView(mem.buffer).getBigInt64(POS, true)).toBe(position);
        expect(mem[POS - 1]).toBe(0x7d); expect(mem[POS + 8]).toBe(0x7d);
        vfs.setPosition(handle(), 1, 0);
        expect(crt.fsetpos(fp, POS)).toBe(0); expect(handle().position).toBe(Number(position));
        expect(errno).toBe(0x77);
    });
}
test('invalid signed or inexact 64-bit positions preserve cursor, EOF, errors and pushback', () => {
    vfs.setPosition(handle(), 4, 0);
    stream().eof = true; stream().err = true; stream().ungetChar = 0x41; stream().ungetWide = 0x42;
    for (const n of [-1n, -0x100000000n, -0x8000000000000000n, 0x20000000000000n, 0x7fffffffffffffffn]) {
        setPos(n); expect(crt.fsetpos(fp, POS)).toBe(-1); expect(errno).toBe(22);
        expect(handle().position).toBe(4); expect(stream().eof).toBe(true); expect(stream().err).toBe(true);
        expect(stream().ungetChar).toBe(0x41); expect(stream().ungetWide).toBe(0x42);
    }
});
test('successful fsetpos clears EOF and both pushbacks but preserves existing error', () => {
    stream().eof = true; stream().err = true; stream().ungetChar = 0x41; stream().ungetWide = 0x42;
    setPos(2n); expect(crt.fsetpos(fp, POS)).toBe(0); expect(handle().position).toBe(2);
    expect(stream().eof).toBe(false); expect(stream().err).toBe(true);
    expect(stream().ungetChar).toBe(-1); expect(stream().ungetWide).toBeUndefined();
    expect(crt.fgetc(fp)).toBe(0xff); expect(errno).toBe(0x77);
});
test('both APIs reject null, wrapped, truncated and denied full-width position pointers atomically', () => {
    vfs.setPosition(handle(), 2, 0); stream().eof = true;
    for (const api of ['fgetpos', 'fsetpos']) for (const ptr of [0, -1, 0xfffffffc, mem.length - 4]) {
        const before = mem.slice(); expect(crt[api](fp, ptr)).toBe(-1); expect(errno).toBe(22);
        expect(mem).toEqual(before); expect(handle().position).toBe(2); expect(stream().eof).toBe(true);
    }
    deny = (p, n) => p <= POS + 7 && p + n > POS + 7;
    for (const api of ['fgetpos', 'fsetpos']) {
        const before = mem.slice(); expect(crt[api](fp, POS)).toBe(-1); expect(errno).toBe(22);
        expect(mem).toEqual(before); expect(handle().position).toBe(2);
    }
});
test('fsetpos reads a read-only fpos_t while fgetpos requires a writable whole record', () => {
    setPos(3n); deny = (p, n, perms) => p <= POS + 7 && p + n > POS && perms.includes('w');
    expect(crt.fsetpos(fp, POS)).toBe(0); expect(handle().position).toBe(3);
    expect(crt.fgetpos(fp, POS)).toBe(-1); expect(errno).toBe(22);
    expect(new DataView(mem.buffer).getBigInt64(POS, true)).toBe(3n);
});
test('fgetpos observes binary pushback without consuming it or clearing indicators', () => {
    expect(crt.fgetc(fp)).toBe(0xff); expect(crt.ungetc(0xab, fp)).toBe(0xab); stream().err = true;
    expect(crt.fgetpos(fp, POS)).toBe(0); expect(new DataView(mem.buffer).getBigInt64(POS, true)).toBe(0n);
    expect(handle().position).toBe(1); expect(stream().ungetChar).toBe(0xab); expect(stream().err).toBe(true);
    expect(crt.fgetc(fp)).toBe(0xab);
});
test('fgetpos rejects an inexact VFS position without changing output', () => {
    handle().position = 2 ** 53; mem.fill(0xcd, POS, POS + 8);
    expect(crt.fgetpos(fp, POS)).toBe(-1); expect(errno).toBe(22);
    expect(mem.slice(POS, POS + 8)).toEqual(new Uint8Array(8).fill(0xcd));
});
