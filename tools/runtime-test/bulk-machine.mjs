/** Synthetic 32-bit CALL/OUT/RET guest used by Node and Chromium tests/benchmarks. */
import { V86 } from '../../vendor/v86/build/libv86.mjs';
export const BASE = 0x100000, ENTRY = BASE + 0x40, LEAF = BASE + 0x1000;
export const DONE = BASE + 0x80, STACK = 0x300000, LEFT = 0x400000, RIGHT = 0x800000;
export const RAM = 32 * 1024 * 1024, PD = 0x80000, PT = 0x81000;
// Mirrors HANDLER_* in src/worker/core/cpu/hypercall-data.ts. 82/83 are taken here by
// get_capture/resume_thread, so the bulk leaves sit at 84/85; strchr/strrchr have no
// handler on this tree and are deliberately absent rather than pointed somewhere wrong.
export const IDS = {
    memcpy: 56, memset: 57, memcmp: 62, memmove: 84, memchr: 85,
    strlen: 58, wcslen: 51, strcmp: 59, stricmp: 61, wcsicmp: 54,
    wcschr: 55, strcpy: 60, wcscpy: 52,
};
function image(halt) {
    const bytes = new Uint8Array(0x2000), v = new DataView(bytes.buffer);
    const fields = [0x1badb002, 0x10000, -(0x1badb002 + 0x10000), BASE, BASE, BASE + bytes.length, BASE + bytes.length, ENTRY];
    fields.forEach((x, i) => v.setUint32(i * 4, x >>> 0, true));
    let at = 0x40;
    const emit = (...xs) => { bytes.set(xs, at); at += xs.length; };
    // Arguments already occupy [esp .. esp+12), EDI is the iteration count.
    emit(0xe8); v.setInt32(at, LEAF - (BASE + at + 4), true); at += 4;
    emit(0x4f, 0x75, 0xf8); // dec edi; jnz ENTRY (8-byte loop)
    emit(0xe9); v.setInt32(at, DONE - (BASE + at + 4), true);
    bytes.set(halt ? [0xf4] : [0xeb, 0xfe], 0x80); // HLT avoids burning a JIT quantum; ring-3 guard tests use the nonprivileged stop.
    bytes.set([0xb8, 1, 0, 0, 0, 0xba, 0x77, 0xb0, 0, 0, 0xef, 0xc3], 0x1000);
    return bytes;
}
export async function createMachine(binary, { jit = false, halt = false } = {}) {
    const emulator = new V86({ memory_size: RAM, autostart: false, disable_jit: jit ? 0 : 1,
        wasm_fn: async imports => (await WebAssembly.instantiate(binary, imports)).instance.exports });
    await new Promise(resolve => emulator.add_listener('emulator-loaded', resolve));
    const cpu = emulator.v86.cpu, api = cpu.wm.exports;
    cpu.reboot_internal(); cpu.reset_memory(); cpu.load_multiboot(image(halt).buffer);
    let hostCalls = 0, fallback = null, finalized = 0;
    cpu.test_hook_did_finalize_wasm = () => { finalized++; };
    cpu.io.register_write(0xb077, null, undefined, undefined, value => {
        hostCalls++;
        if (fallback) fallback(value);
    });
    const guest = () => new Uint8Array(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
    const hp = api.get_hypercall_page_ptr() >>> 0;
    new DataView(cpu.wasm_memory.buffer).setUint32(hp + 8, 1, true);
    const reg = () => new Int32Array(cpu.wasm_memory.buffer, 64, 8);
    const state = () => new DataView(cpu.wasm_memory.buffer);
    function map(page, physical = page, flags = 7) {
        new DataView(guest().buffer, guest().byteOffset).setUint32(PT + page * 4, (physical << 12) | flags, true);
    }
    function paging() {
        const mem = guest(), dv = new DataView(mem.buffer, mem.byteOffset);
        for (let i = 0; i < RAM / 4096; i++) map(i);
        for (let i = 0; i < RAM / 0x400000; i++) dv.setUint32(PD + i * 4, (PT + i * 4096) | 7, true);
        cpu.cr[3] = PD; cpu.cr[0] |= 0x80010000; api.full_clear_tlb(); cpu.update_state_flags();
    }
    function warm(start, length, write = false) {
        if (!length) return;
        for (let at = start; at < start + length; at = (at | 4095) + 1) {
            if (write) api.safe_write8_slow_jit(at, guest()[at], ENTRY);
            else api.safe_read8_slow_jit(at, ENTRY);
        }
    }
    function prepare(name, a, b, len, count = 1) {
        if (!Number.isInteger(count) || count < 1) throw new Error('Invalid iteration count');
        new Uint8Array(cpu.wasm_memory.buffer)[hp + 0x101] = IDS[name];
        const mem = guest(), dv = new DataView(mem.buffer, mem.byteOffset), regs = reg();
        dv.setUint32(STACK, a >>> 0, true); dv.setUint32(STACK + 4, b >>> 0, true); dv.setUint32(STACK + 8, len >>> 0, true);
        regs[4] = STACK; regs[7] = count;
        state().setUint32(556, ENTRY, true); cpu.in_hlt[0] = 0;
    }
    function execute(maxBlocks = 10000000) {
        const status = api.run_guest_until(DONE, LEAF, maxBlocks, 0, 0);
        if (status !== 0 && !(status === 2 && state().getUint32(556, true) === DONE + 1)) throw new Error(`Guest status ${status}, EIP=${state().getUint32(556, true).toString(16)}, EDI=${reg()[7]}`);
        return reg()[0];
    }
    return { cpu, api, guest, reg, state, map, paging, warm, prepare, execute,
        call(name, a, b, len, count = 1) { prepare(name, a, b, len, count); return execute(); },
        setFallback(fn) { fallback = fn; },
        get hostCalls() { return hostCalls; }, get finalized() { return finalized; },
        stats() { return api.get_bulk_memory_stats_ptr ? Array.from(new Uint32Array(cpu.wasm_memory.buffer, api.get_bulk_memory_stats_ptr() >>> 0, 6)) : null; },
        stringStats() { return api.get_string_memory_stats_ptr ? Array.from(new Uint32Array(cpu.wasm_memory.buffer, api.get_string_memory_stats_ptr() >>> 0, 11)) : null; },
        close() { emulator.destroy(); },
    };
}
