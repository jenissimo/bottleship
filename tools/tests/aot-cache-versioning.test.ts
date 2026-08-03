import { aotCache } from "../../src/worker/core/cpu/aot-cache";

const PAGE = 4096;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
};

type Identity = { lo: number; hi: number; abi: number; mask: number };

function install(memory: Uint8Array, identity: Identity = { lo: 1, hi: 0, abi: 1, mask: 0x01FB_FDEF }) {
    const wasm = {
        jit_aot_page_table_index: () => 7,
        jit_aot_module_page_count: () => 2,
        jit_aot_module_page_at: (_idx: number, n: number) => n * PAGE,
        jit_aot_page_entry_count: () => 1,
        jit_aot_page_entry_at: () => 0,
        jit_aot_page_state_flags: () => 0,
        jit_config_abi_version: () => identity.abi,
        jit_config_supported_mask: () => identity.mask,
        jit_codegen_fingerprint_lo: () => identity.lo,
        jit_codegen_fingerprint_hi: () => identity.hi,
    };
    const cpu = { mem8: memory, memory_size: new Uint32Array([memory.length]), wm: { exports: wasm } };
    (globalThis as any).System = { getInstance: () => ({ process: { v86: { cpu } } }) };
    (globalThis as any).preemption = { getWasmExports: () => wasm };
    (globalThis as any).__wasmDump = { out: [{ start: 0, table_index: 7, len: 4, bytes: new Uint8Array([0, 1, 2, 3]) }] };
    aotCache.clear();
    return identity;
}

function deferEngineHash() {
    const hash = deferred<string>();
    // Deliberately mock only the asynchronous fetch/hash boundary. version() remains production
    // code, including the ordering of its synchronous wasm identity reads and first await.
    (aotCache as any).engineFingerprint = () => hash.promise;
    return hash;
}

// snapshot must copy both pages before awaiting the capture-time engine hash.
{
    const memory = new Uint8Array(PAGE * 4); memory[0] = 0x11; memory[PAGE] = 0x22;
    install(memory);
    const hash = deferEngineHash();
    const run = aotCache.snapshot();
    memory[0] = 0xAA; memory[PAGE] = 0xBB;
    hash.resolve("engine");
    const result = await run;
    assert(result.units === 1, "coherent snapshot refused");
    const pages = (aotCache as any).units[0].pages;
    assert(pages.length === 2, "multi-page metadata was not captured");
    const hashes = await Promise.all([new Uint8Array([0x11, ...new Uint8Array(PAGE - 1)]), new Uint8Array([0x22, ...new Uint8Array(PAGE - 1)])]
        .map(async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(x => x.toString(16).padStart(2, "0")).join("")));
    assert(pages[0].sha === hashes[0] && pages[1].sha === hashes[1], "snapshot was torn by post-yield memory mutation");
}

// version() must bind the pre-yield fingerprint to the copied pages. With the old object-literal
// order (`engine: await ...` before fingerprint reads), both reads would observe 2 and this would
// wrongly accept. Do not replace aotCache.version here: that would mask the ordering regression.
{
    const memory = new Uint8Array(PAGE * 4); memory[0] = 0x33; memory[PAGE] = 0x44;
    const identity = install(memory, { lo: 1, hi: 0, abi: 1, mask: 0x01FB_FDEF });
    const hash = deferEngineHash();
    const run = aotCache.snapshot();
    identity.lo = 2;
    hash.resolve("engine");
    const result = await run;
    assert(result.units === 0 && (aotCache as any).units.length === 0,
        "post-boundary JIT fingerprint change relabeled captured bytes");
}

console.log("PASS aot-cache-versioning: coherent-copy + production-version identity-refusal");
