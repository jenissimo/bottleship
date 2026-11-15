import { aotCache } from "../../src/worker/core/cpu/aot-cache";
import { installFakeOpfs } from "./fixtures/fake-opfs";
import { getContainerDir } from "../../src/worker/runtime/filesystem/container-store";

const PAGE = 4096;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
};

type Identity = { lo: number; hi: number; abi: number; mask: number };

const hostScript = { status: 200, bytes: new Uint8Array([0x48, 0x41]) };

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
    (globalThis as any).location = { href: "https://host.invalid/assets/emulator.worker.js" };
    (globalThis as any).fetch = async (url: string) => {
        if (url !== "https://host.invalid/assets/emulator.worker.js") throw new Error(`unexpected fetch ${url}`);
        return new Response(hostScript.bytes.slice(), { status: hostScript.status });
    };
    (aotCache as any).hostSha = null;
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

// install() replaces globals and deferEngineHash() an aotCache method; `bun test` runs every file
// in one process, so both go back when this file is done, pass or fail.
const replacedGlobals = ["System", "preemption", "__wasmDump", "navigator", "location", "fetch"].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
const ownFingerprint = Object.getOwnPropertyDescriptor(aotCache, "engineFingerprint");
try {
    // Persist a marked unit, load it in a new session with the SAME version identity,
    // then capture unrelated pages. Loading is not evidence that its dependencies
    // still match: even unchanged guest pages cannot establish host compatibility.
    for (const captureFresh of [true, false]) {
        installFakeOpfs();
        const memory = new Uint8Array(PAGE * 4);
        install(memory);
        deferEngineHash().resolve("engine");
        const wasm = (globalThis as any).preemption.getWasmExports();
        wasm.jit_aot_module_page_at = (_idx: number, n: number) => (n + 2) * PAGE;
        (globalThis as any).__wasmDump.out = [{ start: 2 * PAGE, table_index: 7,
            len: 4, bytes: new Uint8Array([0x36, 0x2, 0xAA, 0xBB]) }];
        assert((await aotCache.snapshot()).units === 1, "old fixture not captured");
        assert("saved" in await aotCache.save("app:snapshot-regression"), "old fixture not persisted");

        install(memory);
        deferEngineHash().resolve("engine");
        if (captureFresh) memory[2 * PAGE] = 0xFF;
        const loaded = await aotCache.load("app:snapshot-regression");
        assert("loaded" in loaded && loaded.loaded === 1, "old fixture not loaded");
        assert(aotCache.getUnits()[0].bytes[0] === 0x36, "old marker missing before snapshot");
        assert((await aotCache.verify()).mismatch === Number(captureFresh), "fixture page mismatch not established");
        if (!captureFresh) (globalThis as any).__wasmDump.out = [];
        const result = await aotCache.snapshot();
        const stale = aotCache.getUnits().some(u => u.bytes[0] === 0x36);
        console.log(`snapshot carry-over: loaded=1 fresh=${Number(captureFresh)} units=${result.units} oldMarker=${stale}`);
        assert(!stale, "snapshot carried a loaded unit into the new recording");
        assert(result.units === Number(captureFresh), "snapshot did not contain exactly the fresh capture");
        if (captureFresh) {
            assert(aotCache.getUnits()[0].pages.length === 2, "fresh multi-page unit lost");
            assert("saved" in await aotCache.save("app:snapshot-regression"), "fresh snapshot not persisted");
            const reloaded = await aotCache.load("app:snapshot-regression");
            assert("loaded" in reloaded && reloaded.loaded === 1, "new store contains old units");
            assert(aotCache.getUnits()[0].bytes[0] === 0, "old bytes survived save/load");
        }
    }

    // The same engine under a different host build is a different identity: units saved by
    // one worker script must not load into another, and still load into the one that saved them.
    {
        installFakeOpfs();
        const memory = new Uint8Array(PAGE * 4);
        const hostA = new Uint8Array([0x41, 0x01]);
        const hostB = new Uint8Array([0x42, 0x02]);
        hostScript.bytes = hostA;
        install(memory);
        deferEngineHash().resolve("engine");
        assert((await aotCache.snapshot()).units === 1, "host fixture not captured");
        const saved = await aotCache.save("app:host-identity");
        assert("saved" in saved, "host fixture not persisted");

        hostScript.bytes = hostB;
        install(memory);
        deferEngineHash().resolve("engine");
        const other = await aotCache.load("app:host-identity");
        console.log(`host identity: other host -> ${JSON.stringify(other)}`);
        assert(!("loaded" in other), "units saved under one host build loaded under another");
        assert(aotCache.getUnits().length === 0, "foreign host units reached the cache");
        assert("key" in other && "key" in saved && other.key !== saved.key, "host build did not change the key");

        hostScript.bytes = hostA;
        install(memory);
        deferEngineHash().resolve("engine");
        const same = await aotCache.load("app:host-identity");
        assert("loaded" in same && same.loaded === 1, "units did not load under the host that saved them");

        const container = await getContainerDir("app:host-identity", false);
        const dir = await (await container!.getDirectoryHandle("aot")).getDirectoryHandle((saved as { key: string }).key);
        const indexHandle = await dir.getFileHandle("index.json");
        const original = await (await indexHandle.getFile()).text();
        for (const legacy of [{ abi: 6 }, { host: undefined }]) {
            const index = JSON.parse(original);
            index.version = { ...index.version, ...legacy };
            const w = await indexHandle.createWritable();
            await w.write(new TextEncoder().encode(JSON.stringify(index)));
            await w.close();
            install(memory);
            deferEngineHash().resolve("engine");
            const old = await aotCache.load("app:host-identity");
            assert(!("loaded" in old) && aotCache.getUnits().length === 0,
                `a stored identity with ${JSON.stringify(legacy)} was accepted`);
        }
        const restore = await indexHandle.createWritable();
        await restore.write(new TextEncoder().encode(original));
        await restore.close();

        process.env.DEV = "1";
        install(memory);
        deferEngineHash().resolve("engine");
        const dev = await aotCache.version().then(() => null, (e: unknown) => String(e));
        delete process.env.DEV;
        assert(dev?.includes("dev server"), "a dev-server worker produced a persistence identity");

        hostScript.status = 404;
        install(memory);
        deferEngineHash().resolve("engine");
        const unreadable = await aotCache.version().then(() => null, (e: unknown) => String(e));
        assert(unreadable?.includes("host script unreadable"), "an unreadable host script produced an identity");
        const refused = await aotCache.load("app:host-identity").catch((e: unknown) => ({ error: String(e) }));
        assert(!("loaded" in refused) && aotCache.getUnits().length === 0, "units loaded without a host identity");
        hostScript.status = 200;
        hostScript.bytes = new Uint8Array([0x48, 0x41]);
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
} finally {
    for (const [key, descriptor] of replacedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as any)[key];
    }
    if (ownFingerprint) Object.defineProperty(aotCache, "engineFingerprint", ownFingerprint);
    else delete (aotCache as any).engineFingerprint;
    aotCache.clear();
}

console.log("PASS aot-cache-versioning: host-identity (A->B refused, A->A loads, old ABI/missing host refused, dev refused, unreadable refused) + no-loaded-carry-over + empty-capture + save/load + coherent-copy + production-version identity-refusal");
