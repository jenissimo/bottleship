import { beforeEach, expect, test } from "bun:test";
import { d3d9WasmArena } from "../../src/worker/backends/webgpu/d3d9/d3d9-wasm-arena";
import { cpuViewsForBuffer } from "../../src/worker/core/cpu/cpu-views";
import type { WwtMachine } from "../../src/worker/wwt/cpu-provider";
import { installWwtHypercall, type WwtHypercall } from "../../src/worker/wwt/hypercall";

const hypercall = Bun.file(new URL("../../public/wwt-hypercall.wasm", import.meta.url));
const d3d9Arena = Bun.file(new URL("../../public/wwt-d3d9-arena.wasm", import.meta.url));
const guestSize = 0x40000;
const stack = 0x14000;
const storeMap = guestSize;
const totalPages = 16;
const cpuStateBase = 0x4f000;
let memory: WebAssembly.Memory;
let bytes: Uint8Array;
let view: DataView;
let cpu: ReturnType<typeof cpuViewsForBuffer>;
let portable: WwtHypercall;
let page: number;

function set32(address: number, value: number): void {
    view.setUint32(address, value, true);
}

function get32(address: number): number {
    return view.getUint32(address, true);
}

function bind(functionId: number, handler: number, args: number[]): void {
    const offset = functionId < 4096 ? 0x100 + functionId : 0x4000 + functionId - 4096;
    bytes[page + offset] = handler;
    cpu.reg32[4] = stack;
    cpu.reg32[0] = functionId;
    args.forEach((value, index) => set32(stack + (index + 1) * 4, value));
}

beforeEach(async () => {
    memory = new WebAssembly.Memory({ initial: totalPages, maximum: totalPages, shared: true });
    bytes = new Uint8Array(memory.buffer);
    view = new DataView(memory.buffer);
    cpu = cpuViewsForBuffer(memory.buffer, cpuStateBase);
    cpu.memorySize[0] = guestSize;
    let next = 0x50000;
    const machine = {
        memory, guestLimit: guestSize, storeMap,
        abi: { cpu: { GPR: 32, RETIRED_INSNS: 128, SIZE: 512 } },
        nativeAlloc(size: number, align: number) {
            const address = Math.ceil(next / align) * align;
            next = address + size;
            return address;
        },
    } as WwtMachine;
    bytes.fill(0x39, 0, 0x12000);
    portable = await installWwtHypercall(machine, guestSize, cpuStateBase, {
        hypercall: await hypercall.arrayBuffer(), d3d9Arena: await d3d9Arena.arrayBuffer(),
    });
    page = portable.pageAddress;
    set32(page + 8, 1);
    expect(bytes.subarray(0, 0x12000).every(value => value === 0x39)).toBe(true);
});

test("extended dispatch IDs honor executable-page guards and count both routes", () => {
    const id = 65535, handler = 60, src = 0x21000, dst = 0x20000;
    bytes.set([65, 66, 67, 0], src);

    bind(id, handler, [dst, src]);
    expect(portable.dispatch(id)).toBe(true);
    expect(cpu.reg32[0]).toBe(dst);
    expect([...bytes.subarray(dst, dst + 4)]).toEqual([65, 66, 67, 0]);
    expect(get32(page + 0x2000 + handler * 4)).toBe(1);

    bytes[storeMap + (dst >>> 12)] = 1;
    bytes.fill(0x7b, dst, dst + 4);
    bind(id, handler, [dst, src]);
    expect(portable.dispatch(id)).toBe(false);
    expect(cpu.reg32[0]).toBe(id);
    expect([...bytes.subarray(dst, dst + 4)]).toEqual([0x7b, 0x7b, 0x7b, 0x7b]);
    expect(get32(page + 0x2400 + handler * 4)).toBe(1);
});

test("direct native dispatch reads WWT registers and updates only WWT EAX", () => {
    const native = 0x80000;
    const direct = portable.directInteger!;
    bind(12, 58, [0x20000]);
    bytes.set([65, 66, 0], 0x20000);
    set32(native + 32, 12);
    set32(native + 32 + 16, stack);
    cpu.reg32[0] = 0xabcdef;
    expect(direct.dispatch(direct.configAddress, native)).toBe(0);
    expect(get32(native + 128)).toBe(0);
    set32(native + 32 + 8, 0xb077);
    expect(direct.dispatch(direct.configAddress, native)).toBe(1);
    expect(get32(native + 32)).toBe(2);
    expect(get32(native + 128)).toBe(1);
    expect(cpu.reg32[0]).toBe(0xabcdef);

    bind(12, 58, [guestSize]);
    set32(native + 32, 12);
    expect(direct.dispatch(direct.configAddress, native)).toBe(-1);
    expect(get32(native + 32)).toBe(12);
    expect(get32(native + 128)).toBe(1);
    expect(get32(page + 0x2400 + 58 * 4)).toBe(1);
});

test("native clock interpolation uses WWT's retired OUT and preserves wrapping counters", () => {
    const native = 0x80000;
    const direct = portable.directInteger!;
    bind(11, 1, []);
    set32(native + 32, 11);
    set32(native + 40, 0xb077);
    set32(native + 128, 4999);
    set32(page + 0x10, 100);
    set32(page + 0x2c, 0);
    set32(page + 0x30, 5);
    set32(page + 0xc, 0xffffffff);
    set32(page + 0x2004, 0xffffffff);
    expect(direct.dispatch(direct.configAddress, native)).toBe(1);
    expect(get32(native + 32)).toBe(101);
    expect(get32(native + 128)).toBe(5000);
    expect(get32(page + 0xc)).toBe(0);
    expect(get32(page + 0x2004)).toBe(0xffffffff);
});

test("guarded memory reads decline on a non-present guest page", () => {
    cpu.cr[0] = 0x80010000;
    cpu.cr[3] = 0x30000;
    set32(0x30000, 0x31007);
    set32(0x31000 + (stack >>> 12) * 4, stack | 7);
    const str = 0x20000;
    bytes.set([65, 0], str);
    bind(4, 58, [str]);
    expect(portable.dispatch(4)).toBe(false);
    set32(0x31000 + (str >>> 12) * 4, str | 7);
    expect(portable.dispatch(4)).toBe(true);
    expect(cpu.reg32[0]).toBe(1);
});

test("portable _ftol pops x87 and returns the full integer", () => {
    bytes[cpuStateBase + 816] = 0xfe;
    view.setFloat64(cpuStateBase + 1152, 0x1_00000005 + 0.75, true);
    view.setUint16(cpuStateBase + 1160, 0x7ffe, true);
    bind(7, 17, []);
    expect(portable.dispatch(7)).toBe(true);
    expect(cpu.reg32[0]).toBe(5);
    expect(cpu.reg32[2]).toBe(1);
    expect(bytes[cpuStateBase + 1032]).toBe(1);
    expect(bytes[cpuStateBase + 816]).toBe(0xff);
});

test("EAGL register converter applies guest data and advances all cursors", () => {
    const descriptorCell = 0x20000, sourceCell = 0x20004, targetCell = 0x20008, budget = 0x2000c;
    const descriptor = 0x21000, source = 0x22000, target = 0x23000;
    set32(descriptorCell, descriptor);
    set32(sourceCell, source);
    set32(targetCell, target);
    set32(budget, 1);
    set32(descriptor, 1); // signed int -> float
    set32(descriptor + 0x14, 2);
    set32(descriptor + 0x18, 1);
    set32(source, 14);
    set32(source + 4, -6);
    bind(13, 129, [descriptorCell, sourceCell, targetCell, budget]);
    expect(portable.dispatch(13)).toBe(true);
    expect(cpu.reg32[0]).toBe(0);
    expect(view.getFloat32(target, true)).toBe(14);
    expect(view.getFloat32(target + 4, true)).toBe(-6);
    expect([get32(descriptorCell), get32(sourceCell), get32(targetCell), get32(budget)]).toEqual([
        descriptor + 0x1c, source + 8, target + 16, 0,
    ]);
});

test("RTTI resolves a single-inheritance cast against WWT memory", () => {
    const object = 0x21000, vtable = 0x22000, locator = 0x23000;
    const hierarchy = 0x24000, bases = 0x25000, entry = 0x26000, targetType = 0x27000;
    set32(object, vtable);
    set32(vtable - 4, locator);
    set32(locator + 4, 8);
    set32(locator + 16, hierarchy);
    set32(hierarchy + 8, 1);
    set32(hierarchy + 12, bases);
    set32(bases, entry);
    set32(entry, targetType);
    set32(entry + 8, 12);
    set32(entry + 12, -1); // non-virtual base
    bind(25, 77, [object, 0, targetType, targetType, 0]);
    expect(portable.dispatch(25)).toBe(true);
    expect(cpu.reg32[0]).toBe(object + 4);
});

test("slab bump, free and reuse preserve the guest heap headers and counters", () => {
    const control = 0x20000, base = 0x21000;
    set32(page + 0x1444, control);
    set32(control, base);
    set32(control + 4, 0x29000);
    set32(control + 8, base);
    bytes.fill(0x42, base + 16, base + 48);
    bind(20, 70, [0, 8, 17]);
    expect(portable.dispatch(20)).toBe(true);
    expect(cpu.reg32[0]).toBe(base + 16);
    expect(get32(base + 12)).toBe(0x534c4101);
    expect(get32(control + 8)).toBe(base + 48);
    expect(bytes.subarray(base + 16, base + 48).every(value => value === 0)).toBe(true);

    set32(base + 16, 0xabcdef);
    bind(21, 71, [0, 0, base + 16]);
    expect(portable.dispatch(21)).toBe(true);
    expect(get32(base + 12)).toBe(0x534c4601);
    expect(get32(base + 16)).toBe(0xabcdef);
    expect(portable.dispatch(21)).toBe(false);
    bind(20, 70, [0, 0, 17]);
    expect(portable.dispatch(20)).toBe(true);
    expect(cpu.reg32[0]).toBe(base + 16);
    expect(get32(control + 0x10)).toBe(2);
    expect(get32(control + 0x14)).toBe(1);
    expect(get32(control + 0x24)).toBe(0);
});

test("EAGL token routing appends validated state and class-6 records to the existing WBUF", () => {
    const config = 0x20000, table = 0x21000, control = 0x22000, ring = 0x23000;
    const context = 0x24000, device = 0x25000, vtable = 0x26000, stub = 0x27000, node = 0x28000;
    const setter = 19, fvf = 20;
    set32(page + 0x1c54, config);
    set32(config, 2);
    set32(config + 4, table);
    set32(config + 8, control);
    set32(config + 12, ring);
    set32(config + 0x10, 256);
    set32(config + 0x18, setter);
    set32(config + 0x3c, fvf);
    set32(context + 8, device);
    set32(device, vtable);
    set32(vtable + 0xe4, stub);
    set32(vtable + 0x164, stub + 16);
    bytes[stub] = bytes[stub + 16] = 0xb8;
    set32(stub + 1, setter);
    set32(stub + 17, fvf);
    set32(node + 0x68, 0x12345678);
    set32(table, 0x01000055);
    cpu.reg32[1] = context;
    bind(14, 132, [node, 0]);
    expect(portable.dispatch(14)).toBe(true);
    expect(get32(control)).toBe(16);
    expect([0, 4, 8, 12].map(offset => get32(ring + offset))).toEqual([setter, device, 0x55, 0x12345678]);

    set32(table, 0x06000008);
    expect(portable.dispatch(14)).toBe(true);
    expect(get32(control)).toBe(28);
    expect([16, 20, 24].map(offset => get32(ring + offset))).toEqual([fvf, device, 0x12345678]);

    bytes[storeMap + (ring >>> 12)] = 1;
    expect(portable.dispatch(14)).toBe(false);
    expect(get32(control)).toBe(28);
});

test("original D3D9 arena copies WWT guest vertices into a programmable draw", () => {
    const originalGuest = bytes.subarray(0x22000, 0x22030);
    originalGuest.fill(0x3a);
    d3d9WasmArena.initialize({ wm: { exports: portable.d3d9ArenaExports } });
    expect(d3d9WasmArena.isInitialized()).toBe(true);
    d3d9WasmArena.setVertexShader(17);
    d3d9WasmArena.setPixelShader(23);
    d3d9WasmArena.setVertexDeclaration(42);
    const record = portable.d3d9ArenaExports.d3d9_record_draw_up as (
        topology: number, vertices: number, pointer: number, stride: number, byteLen: number, forceCullNone: number,
    ) => bigint;
    expect(record(0, 3, 0x22000, 16, 48, 0)).not.toBe(-1n);
    const commandCount = d3d9WasmArena.getCommandCount();
    expect(commandCount).toBeGreaterThanOrEqual(3);
    expect(d3d9WasmArena.getCommandTypes()[commandCount - 1]).toBe(7);
    expect(record(0, 3, guestSize - 32, 16, 48, 0)).toBe(-1n);
});
