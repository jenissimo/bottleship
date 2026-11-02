import { afterEach, describe, expect, it } from "bun:test";
import { GuestDataRoutes } from "../../src/worker/core/memory/guest-data-routes";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

const PAGE = 0x1000, A = 0x4000, B = 0x8000;
function fixture() {
    let ram = new Uint8Array(0x10000);
    ram.fill(0x5a);
    let denied: { address: number; size: number; writeOnly: boolean } | null = null;
    const routes = new GuestDataRoutes(() => ram, (address, size, write) =>
        !denied || (denied.writeOnly && !write) ||
        address + size <= denied.address || address >= denied.address + denied.size);
    const backing = new SharedArrayBuffer(2 * PAGE), bytes = new Uint8Array(backing);
    const a = routes.map(A, backing, 0, 2 * PAGE), b = routes.map(B, backing, 0, 2 * PAGE);
    return { routes, backing, bytes, a, b, ram: () => ram,
        replaceRam: (fresh: Uint8Array) => { ram = fresh; },
        deny: (value: typeof denied) => { denied = value; } };
}
afterEach(() => Mem.bind(() => new Uint8Array()));

describe("opt-in external guest data routes", () => {
    it("shares scalars between VA aliases without touching RAM shadow", () => {
        const f = fixture();
        f.routes.writeUint(A, 0x13579bdf, 4);
        expect(f.routes.readUint(B, 4)).toBe(0x13579bdf);
        f.routes.writeUint(B + 4, 0x2468, 2);
        expect(f.routes.readUint(A + 4, 2)).toBe(0x2468);
        expect(f.ram()[A]).toBe(0x5a); expect(f.ram()[B]).toBe(0x5a);
    });
    it("splits a scalar across ordinary RAM and a mapped page", () => {
        const f = fixture();
        f.routes.writeUint(A - 2, 0x12345678, 4);
        expect(Array.from(f.ram().slice(A - 2, A))).toEqual([0x78, 0x56]);
        expect(Array.from(f.bytes.slice(0, 2))).toEqual([0x34, 0x12]);
        expect(f.routes.readUint(A - 2, 4)).toBe(0x12345678);
        expect(f.ram()[A]).toBe(0x5a);
    });
    it("routes mixed bulk spans and returns snapshots for external reads", () => {
        const f = fixture(), input = Uint8Array.from({ length: 12 }, (_, i) => i + 1);
        f.routes.writeBytes(A - 4, input);
        expect(Array.from(f.routes.readBytes(A - 4, input.length))).toEqual(Array.from(input));
        const snapshot = f.routes.readBytes(B, 8);
        snapshot.fill(0xee);
        expect(f.bytes[0]).toBe(5);
        expect(Array.from(f.ram().slice(A, A + 8))).toEqual(new Array(8).fill(0x5a));
    });
    it("copies through physically overlapping aliases using the original bytes", () => {
        const f = fixture();
        f.bytes.set([1, 2, 3, 4, 5, 6, 7, 8]);
        f.routes.copy(B + 2, A, 6);
        expect(Array.from(f.bytes.slice(0, 8))).toEqual([1, 2, 1, 2, 3, 4, 5, 6]);
    });
    it("handles source SAB alias overlap across segmented writes", () => {
        const f = fixture();
        for (let i = 0; i < f.bytes.length; i++) f.bytes[i] = i % 251;
        const before = f.bytes.slice();
        f.routes.writeBytes(A + 3, f.bytes.subarray(0, PAGE + 5));
        expect(Array.from(f.bytes.slice(3, PAGE + 8))).toEqual(Array.from(before.slice(0, PAGE + 5)));
    });
    it("routes floats crossing a mapped-page boundary", () => {
        const f = fixture();
        f.routes.writeFloat(A + PAGE - 3, Math.PI, 8);
        expect(f.routes.readFloat(B + PAGE - 3, 8)).toBe(Math.PI);
        f.routes.writeFloat(B + 8, 1.25, 4);
        expect(f.routes.readFloat(A + 8, 4)).toBe(1.25);
    });
    it("rejects a full write/copy before mutating a protected tail", () => {
        const f = fixture();
        f.bytes.fill(0xab); const before = f.bytes.slice();
        f.deny({ address: A + PAGE, size: PAGE, writeOnly: true });
        expect(() => f.routes.writeUint(A + PAGE - 2, 0, 4)).toThrow();
        expect(() => f.routes.copy(A + PAGE - 2, B, 4)).toThrow();
        expect(f.bytes).toEqual(before);
        expect(f.routes.readUint(A + PAGE - 2, 4)).toBe(0xabababab);
    });
    it("rejects overflow/fractional/short backing and overlap before publication", () => {
        const f = fixture(), before = f.bytes.slice();
        expect(() => f.routes.map(0xc000, f.backing, PAGE, 2 * PAGE)).toThrow();
        expect(() => f.routes.map(0xc001, f.backing, 0, PAGE)).toThrow();
        expect(() => f.routes.map(A - PAGE, f.backing, 0, 2 * PAGE)).toThrow();
        expect(() => f.routes.writeUint(0xffffffff, 0, 4)).toThrow();
        expect(() => f.routes.writeUint(0.5, 0, 4)).toThrow();
        expect(f.bytes).toEqual(before);
        expect(f.routes.readUint(A - PAGE, 4)).toBe(0x5a5a5a5a);
    });
    it("keeps replacement routes safe from an old release after clear", () => {
        const f = fixture();
        f.routes.clear();
        const fresh = new SharedArrayBuffer(PAGE);
        const lease = f.routes.map(A, fresh, 0, PAGE);
        f.a.release(); f.a.release(); f.b.release();
        f.routes.writeUint(A, 0x1234, 4);
        expect(new Uint32Array(fresh)[0]).toBe(0x1234);
        lease.release();
        expect(f.routes.readUint(A, 4)).toBe(0x5a5a5a5a);
    });
    it("reads fallback RAM freshly after the owner replaces its buffer", () => {
        const f = fixture(), fresh = new Uint8Array(0x10000);
        fresh.fill(0x73); f.replaceRam(fresh);
        f.routes.writeUint(A, 0x33445566, 4);
        expect(f.routes.readUint(B, 4)).toBe(0x33445566);
        expect(f.routes.readUint(0x100, 4)).toBe(0x73737373);
        expect(fresh[A]).toBe(0x73);
    });
    it("opts Mem scalars/floats/bulk/copies in, without exporting an incoherent full view", () => {
        const f = fixture();
        Mem.bind(f.ram, undefined, undefined, f.routes);
        expect(() => Mem.getView()).toThrow();
        expect(Mem.writeUint32(A, 0x87654321)).toBe(true);
        expect(Mem.readInt32(B)).toBe(0x87654321 | 0);
        expect(Mem.writeUint8(B + 4, 0xab)).toBe(true); expect(Mem.readUint8(A + 4)).toBe(0xab);
        expect(Mem.writeUint16(A + 5, 0xfedc)).toBe(true); expect(Mem.readInt16(B + 5)).toBe(0xfedc - 0x10000);
        expect(Mem.writeFloat64(A + PAGE - 3, Math.PI)).toBe(true);
        expect(Mem.readFloat64(B + PAGE - 3)).toBe(Math.PI);
        expect(Mem.writeFloat32(A + 16, 1.25)).toBe(true);
        const floats = new Float32Array(1);
        expect(Mem.readFloat32Into(B + 16, 1, floats)).toBe(true); expect(floats[0]).toBe(1.25);
        expect(Mem.readFloat32(B + 16)).toBe(1.25);
        expect(Mem.writeBytes(A + 32, new Uint8Array([1, 2, 3, 4]))).toBe(4);
        expect(Mem.memcpy(B + 40, A + 32, 4)).toBe(true);
        expect(Mem.memmove(A + 41, B + 40, 3)).toBe(true);
        expect(Array.from(Mem.readBytes(B + 40, 4)!)).toEqual([1, 1, 2, 3]);
        Mem.bind(f.ram);
        expect(Mem.getView()).toBe(f.ram());
        expect(Mem.readUint32(A)).toBe(0x5a5a5a5a);
    });
});
