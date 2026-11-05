import {expect, test} from 'bun:test';
import {Mem} from '../../src/worker/core/memory/mem-accessor';
import {Msvcrt} from '../../src/worker/modules/msvcrt';
import {msvcrtModule} from '../../src/worker/api/msvcrt.api';

function crtWithHeap(mem: Uint8Array, heap: {next: number, fail?: boolean}) {
    Mem.bind(() => mem);
    const crt = new Msvcrt() as any;
    crt.process = {v86: {mem8: mem}, addressSpace: {getRegion: () => ({base: 0, size: mem.length})}};
    crt.errnoAddr = 0x200;
    crt.malloc = (size: number) => {
        if (heap.fail) return 0;
        const p = heap.next;
        heap.next += size;
        return p;
    };
    return crt;
}

test('_wcsdup copies a UTF-16 string, terminator included, into fresh heap memory', () => {
    const mem = new Uint8Array(0x8000);
    const heap = {next: 0x4000};
    const crt = crtWithHeap(mem, heap);
    const text = 'Bass Ж日';
    for (let i = 0; i < text.length; i++) Mem.writeUint16(0x1000 + i * 2, text.charCodeAt(i));
    Mem.writeUint16(0x1000 + text.length * 2, 0);
    mem.fill(0xcc, 0x4000, 0x4100);
    const out = crt.wcsdup(0x1000);
    expect(out).toBe(0x4000);
    expect(heap.next).toBe(0x4000 + (text.length + 1) * 2);
    let s = '';
    for (let i = 0; Mem.readUint16(out + i * 2); i++) s += String.fromCharCode(Mem.readUint16(out + i * 2)!);
    expect(s).toBe(text);
    expect(Mem.readUint16(out + text.length * 2)).toBe(0);
});

test('_wcsdup of an empty string allocates just the terminator; NULL in gives NULL out', () => {
    const mem = new Uint8Array(0x8000);
    const heap = {next: 0x4000};
    const crt = crtWithHeap(mem, heap);
    mem.fill(0xcc, 0x4000, 0x4010);
    expect(crt.wcsdup(0x1000)).toBe(0x4000);
    expect(Mem.readUint16(0x4000)).toBe(0);
    expect(heap.next).toBe(0x4002);
    expect(crt.wcsdup(0)).toBe(0);
    expect(heap.next).toBe(0x4002);
});

test('_wcsdup reports ENOMEM when the allocation fails', () => {
    const mem = new Uint8Array(0x8000);
    const crt = crtWithHeap(mem, {next: 0x4000, fail: true});
    Mem.writeUint16(0x1000, 0x41);
    expect(crt.wcsdup(0x1000)).toBe(0);
    expect(Mem.readUint32(0x200)).toBe(12);
});

test('_wcsdup is a cdecl export taking one argument', () => {
    const f = msvcrtModule.functions.find(x => x.name === '_wcsdup');
    expect(f?.callingConvention).toBe('cdecl');
    expect(f?.params.length).toBe(1);
});
