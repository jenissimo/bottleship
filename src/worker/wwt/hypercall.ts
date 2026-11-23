import type { WwtMachine } from "./cpu-provider";

const ABI_VERSION = 1;
const PAGE_SIZE = 0x14000;
const STACK_SIZE = 0x10000;

interface HypercallExports extends WebAssembly.Exports {
    __stack_pointer: WebAssembly.Global;
    abi_version(): number;
    supports_handler(handlerId: number): number;
    dispatch(page: number, storeMap: number, cpuStateBase: number, functionId: number): number;
    guest_span_readable(cpuStateBase: number, address: number, length: number): number;
    dispatch_integer_native(config: number, wwtCpu: number): number;
}

export interface WwtHypercall {
    readonly pageAddress: number;
    readonly d3d9ArenaExports: WebAssembly.Exports;
    readonly directInteger?: {
        readonly configAddress: number;
        dispatch(configAddress: number, wwtCpu: number): number;
    };
    supportsHandler(handlerId: number): boolean;
    dispatch(functionId: number): boolean;
    dispatchInteger(functionId: number): boolean | null;
}

async function loadWasmAsset(file: string): Promise<ArrayBuffer> {
    const base = import.meta.env?.BASE_URL ?? "/";
    const response = await fetch(base + file);
    if (!response.ok) throw new Error(`WWT could not load ${file} (${response.status})`);
    return response.arrayBuffer();
}

export async function installWwtHypercall(
    machine: WwtMachine,
    guestSize: number,
    cpuStateBase: number,
    assets?: { hypercall: BufferSource; d3d9Arena: BufferSource },
): Promise<WwtHypercall> {
    const [bytes, arenaBytes] = await Promise.all([
        assets?.hypercall ?? loadWasmAsset("wwt-hypercall.wasm"),
        assets?.d3d9Arena ?? loadWasmAsset("wwt-d3d9-arena.wasm"),
    ]);
    if (!Number.isSafeInteger(machine.storeMap) || machine.storeMap < machine.guestLimit) {
        throw new Error("WWT provider did not expose its native store map");
    }
    if (!Number.isSafeInteger(cpuStateBase) || cpuStateBase < machine.guestLimit ||
        (cpuStateBase & 0xfff) !== 0 || cpuStateBase + 0x1000 > machine.memory.buffer.byteLength) {
        throw new Error("WWT CPU compatibility state must be in reserved native memory");
    }
    const pageAddress = machine.nativeAlloc(PAGE_SIZE, 64);
    const stackBottom = machine.nativeAlloc(STACK_SIZE, 64);
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory: machine.memory } });
    const wasm = instance.exports as HypercallExports;
    if (wasm.abi_version?.() !== ABI_VERSION) throw new Error("WWT hypercall ABI mismatch");
    wasm.__stack_pointer.value = stackBottom + STACK_SIZE;
    const storeMap = machine.storeMap;
    const page = new Uint8Array(machine.memory.buffer, pageAddress, PAGE_SIZE);
    const dispatch = (id: number) => wasm.dispatch(pageAddress, storeMap, cpuStateBase, id) !== 0;
    const supported = Uint8Array.from({ length: 256 }, (_unused, id) => wasm.supports_handler(id));
    const { GPR, RETIRED_INSNS, SIZE } = machine.abi?.cpu ?? {};
    let directInteger: WwtHypercall["directInteger"];
    if (GPR !== undefined && RETIRED_INSNS !== undefined && SIZE !== undefined &&
        Number.isInteger(GPR) && GPR >= 0 && GPR % 4 === 0 && GPR + 32 <= SIZE &&
        Number.isInteger(RETIRED_INSNS) && RETIRED_INSNS >= 0 && RETIRED_INSNS % 4 === 0 && RETIRED_INSNS + 4 <= SIZE) {
        const configAddress = machine.nativeAlloc(20, 4);
        new Uint32Array(machine.memory.buffer, configAddress, 5).set([pageAddress, storeMap, cpuStateBase, GPR, RETIRED_INSNS]);
        directInteger = { configAddress, dispatch: wasm.dispatch_integer_native };
    }

    // The D3D9 arena owns its buffers. Its original DrawUP kernel gets a single
    // guarded copy from WWT memory using the crate's existing GuestMem interface.
    const guest = new Uint8Array(machine.memory.buffer, 0, guestSize);
    let arenaMemory: WebAssembly.Memory;
    const { instance: arena } = await WebAssembly.instantiate(arenaBytes, { env: {
        read_guest: (address: number, destination: number, length: number): number => {
            const src = address >>> 0, dst = destination >>> 0, size = length >>> 0;
            const memory = new Uint8Array(arenaMemory.buffer);
            if (src + size > guestSize || dst + size > memory.length || !wasm.guest_span_readable(cpuStateBase, src, size)) return 0;
            memory.set(guest.subarray(src, src + size), dst);
            return 1;
        },
    } });
    arenaMemory = arena.exports.memory as WebAssembly.Memory;
    (arena.exports.initialize_guest_reader as () => void)();

    return {
        pageAddress,
        d3d9ArenaExports: arena.exports,
        directInteger,
        supportsHandler: id => supported[id] === 1,
        dispatch,
        dispatchInteger: id => {
            if (id <= 0 || id >= 0x10000 || page[8] === 0) return null;
            const handler = page[id < 4096 ? 0x100 + id : 0x4000 + id - 4096];
            if ((handler >= 17 && handler <= 45) || supported[handler] !== 1) return null;
            return dispatch(id);
        },
    };
}
