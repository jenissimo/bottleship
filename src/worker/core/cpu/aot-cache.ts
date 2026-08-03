/**
 * AOT unit cache — stage 1 of the MS-A track.
 *
 * The point of stage 1 is NOT a better compiler. It is the CONTRACT: can a wasm module that
 * did not come out of the live compile path be published into JitState, entered by the
 * dispatcher, exited from correctly, invalidated by SMC, and bound to page content — while
 * the guest keeps running. Once that holds, "AOT" is only a question of who produces the
 * bytes (§4.1: an AOT unit pretends to be a JIT module; only the byte source changes).
 *
 * So the producer here is deliberately the cheapest one that is provably correct: OUR OWN
 * codegen from an earlier point in the same session, captured through the `__wasmDump` hook
 * that already exists in codegen_finalize. That makes every claim in this file checkable
 * (replayed bytes are byte-identical to what the JIT would have emitted) and leaves the
 * interesting half — a real ahead-of-time compiler — as a drop-in replacement for `bytes`.
 *
 * Content binding (§5.1) is enforced here rather than in Rust, which keeps the engine-side
 * surface at registration only: a unit replays only if the SHA-256 of the guest's page
 * matches what it had when captured — i.e. after relocation, IAT patching and hle-lib
 * patches. A patched or differently-built page simply does not register and falls back to
 * the ordinary JIT. Self-correcting by construction.
 */

import { Logger, LogCategory } from "../logger";
import { getContainerDir } from "../../runtime/filesystem/container-store";

/** v86 places JIT slot i at wasm_table[i + WASM_TABLE_OFFSET] (vendor/v86/src/const.js). */
const WASM_TABLE_OFFSET = 1024;
/** Legal JIT slots are 1..WASM_TABLE_SIZE-1 (jit.rs: `(1..=(WASM_TABLE_SIZE - 1))`). The
 *  transaction API reserves the persisted index exactly, so malformed values are rejected
 *  before staging rather than being disguised as an ordinary unavailable slot. */
const WASM_TABLE_SIZE = 900;
const PAGE_SIZE = 4096;

/** One published page of a unit: its own entry points, state flags and content hash. */
export interface AotPage {
    physPage: number;
    /** CachedStateFlags the page was published under — dispatch refuses a mismatch. */
    stateFlags: number;
    /** (page_offset, initial_state) pairs, exactly as the engine published them. */
    entries: Array<[number, number]>;
    /** SHA-256 of the 4 KiB guest page at capture time (hex). */
    sha: string;
}

export interface AotUnit {
    /** Page whose compilation produced these bytes (the module's entry). */
    entryPage: number;
    /** Module bytes on a NON-shared buffer — WebAssembly.Module refuses a shared one. */
    bytes: Uint8Array<ArrayBuffer>;
    /**
     * The wasm table index the module was COMPILED FOR — part of its contract, not an
     * allocation detail. jit_generate_module bakes this constant into the body and passes
     * it to `jit_find_cache_entry_in_page`, which answers "is this eip still MY code?" by
     * comparing it against the page's published owner. Republish the same bytes under a
     * different slot and that question is asked about a stranger: when some other live
     * module happens to own the slot number baked in here, the helper returns ITS entry
     * block, and this module branches to that block number in its own br_table — running
     * unrelated guest code. So a unit is only replayable in its original slot.
     */
    tableIndex: number;
    /** Compiled ahead of the publish point by prepare(), so the boot hook does not pay
     *  megabytes of synchronous WebAssembly.Module on the critical path. */
    module?: WebAssembly.Module;
    /** EVERY page the module covers. A module spans up to MAX_PAGES and each page is
     *  published separately pointing at the same table index; registering only the entry
     *  page would leave the rest for the JIT to compile again, so two modules would end up
     *  covering overlapping code. */
    pages: AotPage[];
}

/** What replay() actually published. Kept so "was this unit entered?" can be answered
 *  soundly: a freed slot is recycled by the very next compilation, so the page's slot
 *  having entries proves nothing without checking WHOSE function still sits in it. */
interface LiveUnit { unit: AotUnit; idx: number; fn: unknown; }

interface WasmDumpRecord { start: number; table_index: number; len: number; bytes: Uint8Array }

function hex(buf: ArrayBuffer): string {
    const b = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
    return s;
}

/**
 * Remove everything in `dir` that `keep` does not name. Best-effort: a directory we cannot
 * enumerate or an entry we cannot remove is logged, never fatal — pruning is housekeeping and
 * must not be able to fail a save.
 */
async function pruneDirectory(
    dir: FileSystemDirectoryHandle,
    keep: (name: string) => boolean,
    label: string,
): Promise<void> {
    const entries = (dir as unknown as { keys?: () => AsyncIterableIterator<string> }).keys;
    if (typeof entries !== "function") return;
    const doomed: string[] = [];
    try {
        for await (const name of entries.call(dir)) {
            if (!keep(name)) doomed.push(name);
        }
    } catch (e) {
        Logger.warn(LogCategory.SYSTEM, `[AOT] could not enumerate ${label} for pruning: ${e}`);
        return;
    }
    for (const name of doomed) {
        try {
            await dir.removeEntry(name, { recursive: true });
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `[AOT] could not prune ${label}/${name}: ${e}`);
        }
    }
    if (doomed.length) Logger.log(LogCategory.SYSTEM, `[AOT] pruned ${doomed.length} stale entr(ies) from ${label}`);
}

/** SHA-256 of one guest page. The copy is not defensive tidiness: guest memory is backed by
 *  a SharedArrayBuffer and crypto.subtle refuses shared buffers outright. */
async function sha256Page(mem: Uint8Array, addr: number): Promise<string> {
    const page = new Uint8Array(PAGE_SIZE);
    page.set(mem.subarray(addr, addr + PAGE_SIZE));
    return hex(await crypto.subtle.digest("SHA-256", page));
}

/**
 * Everything a unit's bytes were compiled against (§5.4). A unit is only valid when ALL of
 * it matches — mismatch means the module encodes a different contract than the engine now
 * implements, and the failure would be silent (wrong FPU precision, a fastmem guard that no
 * longer matches the layout), not a crash. Hence: check BEFORE persistence is ever used.
 */
interface AotVersion {
    /** Contract version of this file's own format. Bump on any layout change. */
    abi: number;
    /** SHA-256 of the engine binary — the honest stand-in for "codegen commit". */
    engine: string;
    /** Version and supported-index set of Rust's JIT configuration ABI. */
    jitConfigAbi: number;
    jitConfigSupportedMask: number;
    /** Rust-authoritative 64-bit hash of every input that changes emitted JIT wasm. */
    jitCodegenFingerprintLo: number;
    jitCodegenFingerprintHi: number;
    ramSize: number;
}

const AOT_ABI = 5;

export class AotCache {
    private units: AotUnit[] = [];
    private live: LiveUnit[] = [];
    private engineSha: string | null = null;
    private loadedVersion: AotVersion | null = null;

    private cpu(): any {
        const sys = (globalThis as any).System?.getInstance?.() ?? null;
        const proc = sys?.process ?? (globalThis as any).__bsSystem?.process;
        return proc?.v86?.cpu ?? proc?.v86?.v86?.cpu ?? null;
    }

    private wasm(): any {
        return (globalThis as any).preemption?.getWasmExports?.() ?? null;
    }

    /**
     * Arm byte capture for a set of physical pages. Passing no list defaults to the pages
     * the engine itself already called hot (tier-2 promoted) — the same set a PGO-driven
     * AOT build would target, so the recording is not biased by a guess of mine.
     */
    arm(pages?: number[]): { armed: number; pages: number[] } {
        const w = this.wasm();
        let list = pages;
        if (!list || list.length === 0) {
            list = [];
            const n = w?.jit_get_tier2_page_count ? w.jit_get_tier2_page_count() >>> 0 : 0;
            for (let i = 0; i < n; i++) {
                const addr = w.jit_get_tier2_page_at(i) >>> 0;
                if (addr) list.push(addr >>> 12);
            }
        }
        // keepLatestPerPage: a capture over a long session sees each hot page recompiled on
        // every tier-2 promotion, and only the newest module describes the live page anyway.
        (globalThis as any).__wasmDump = { pages: new Set(list), out: [], keepLatestPerPage: true };
        return { armed: list.length, pages: list };
    }

    disarm(): void { (globalThis as any).__wasmDump = undefined; }

    /**
     * Pair captured bytes with the engine's publication record for the same page.
     *
     * Entry points live in Rust and are invisible to the JS side that owns the bytes, so a
     * capture alone is not a replayable unit — this is where the two halves meet. A record
     * is kept only while the engine still has that exact module published for the page
     * (table index unchanged): anything else means the module was freed or overwritten
     * between capture and snapshot and its bytes no longer describe the live page.
     */
    async snapshot(): Promise<{ units: number; skipped: number }> {
        const w = this.wasm();
        const cpu = this.cpu();
        const dump = (globalThis as any).__wasmDump;
        const out: WasmDumpRecord[] = dump?.out ?? [];
        const mem: Uint8Array | undefined = cpu?.mem8;
        if (!w?.jit_aot_page_table_index || !mem) return { units: 0, skipped: out.length };

        // version() reads the mutable wasm identity synchronously before awaiting the immutable
        // engine hash. Start it before capture, but do not await until every selected page has
        // been copied: one event-loop turn is the capture boundary.
        const sourceVersionPromise = this.version();

        let skipped = 0;
        const seen = new Set<number>();
        const captured: Array<{ entryPage: number; bytes: Uint8Array<ArrayBuffer>; tableIndex: number;
            pages: Array<{ physPage: number; stateFlags: number; entries: Array<[number, number]>; bytes: Uint8Array<ArrayBuffer> }> }> = [];
        // Later captures supersede earlier ones for the same page.
        for (let i = out.length - 1; i >= 0; i--) {
            const rec = out[i];
            const physPage = rec.start >>> 12;
            if (seen.has(physPage)) continue;
            seen.add(physPage);

            const addr = physPage * PAGE_SIZE;
            const idx = rec.table_index >>> 0;
            if ((w.jit_aot_page_table_index(addr) >>> 0) !== idx) { skipped++; continue; }

            // Take EVERY page the module covers, not just its entry — see AotUnit.pages.
            const pageCount = w.jit_aot_module_page_count ? w.jit_aot_module_page_count(idx) >>> 0 : 1;
            const pages: Array<{ physPage: number; stateFlags: number; entries: Array<[number, number]>; bytes: Uint8Array<ArrayBuffer> }> = [];
            for (let p = 0; p < pageCount; p++) {
                const pAddr = w.jit_aot_module_page_at ? w.jit_aot_module_page_at(idx, p) >>> 0 : addr;
                if (pAddr === 0xFFFFFFFF) continue;
                const n = w.jit_aot_page_entry_count(pAddr) >>> 0;
                const entries: Array<[number, number]> = [];
                for (let e = 0; e < n; e++) {
                    const packed = w.jit_aot_page_entry_at(pAddr, e) >>> 0;
                    if (packed === 0xFFFFFFFF) continue;
                    entries.push([packed >>> 16, packed & 0xFFFF]);
                }
                const pageBytes: Uint8Array<ArrayBuffer> = new Uint8Array(PAGE_SIZE);
                pageBytes.set(mem.subarray(pAddr, pAddr + PAGE_SIZE));
                pages.push({
                    physPage: pAddr >>> 12,
                    stateFlags: w.jit_aot_page_state_flags(pAddr) >>> 0,
                    entries,
                    // Immutable 4 KiB copy; hashing happens after the whole unit set is captured.
                    bytes: pageBytes,
                });
                seen.add(pAddr >>> 12);
            }
            if (!pages.length) { skipped++; continue; }

            // Copy off the capture buffer: it lives on the wasm (shared) heap, and
            // WebAssembly.Module rejects a shared backing store at replay time.
            const bytes = new Uint8Array(rec.bytes.length);
            bytes.set(rec.bytes);
            captured.push({ entryPage: physPage, bytes, tableIndex: idx, pages });
        }
        let sourceVersion: AotVersion;
        try {
            sourceVersion = await sourceVersionPromise;
            if (this.loadedVersion && !this.sameVersion(this.loadedVersion, sourceVersion)) {
                this.units = [];
            }
            const snapshotUnits: AotUnit[] = [];
            for (const unit of captured) {
                snapshotUnits.push({
                    entryPage: unit.entryPage, bytes: unit.bytes, tableIndex: unit.tableIndex,
                    pages: await Promise.all(unit.pages.map(async page => ({
                        physPage: page.physPage, stateFlags: page.stateFlags, entries: page.entries,
                        sha: await sha256Page(page.bytes, 0),
                    }))),
                });
            }
            if (!this.sameVersion(sourceVersion, await this.version())) {
                Logger.warn(LogCategory.SYSTEM, "[AOT] snapshot refused: JIT version identity changed while hashing");
                return { units: 0, skipped: skipped + captured.length };
            }
            this.units.push(...snapshotUnits);
            this.loadedVersion = sourceVersion;
        } catch {
            Logger.warn(LogCategory.SYSTEM, "[AOT] snapshot refused: cannot recheck JIT version identity");
            return { units: 0, skipped: skipped + captured.length };
        }
        Logger.log(LogCategory.SYSTEM, `[AOT] snapshot: ${this.units.length} units, ${skipped} skipped`);
        return { units: this.units.length, skipped };
    }

    /**
     * Re-hash every page of every loaded unit against guest memory WITHOUT registering.
     *
     * This is the instrument for one specific question: does a page still hold the bytes the
     * unit was built from, at THIS moment? Called right after boot and again once the game is
     * running, it shows whether pages are being rewritten after registration time (IAT / the
     * hle-lib patches) — a write that does not go through the guest's dirty-page path would
     * leave a registered unit silently describing code that no longer exists.
     */
    async verify(): Promise<{ units: number; pages: number; match: number; mismatch: number; changed: string[] }> {
        const mem: Uint8Array | undefined = this.cpu()?.mem8;
        if (!mem) return { units: 0, pages: 0, match: 0, mismatch: 0, changed: [] };
        let pages = 0, match = 0;
        const changed: string[] = [];
        for (const u of this.units) {
            for (const p of u.pages) {
                pages++;
                if ((await sha256Page(mem, p.physPage * PAGE_SIZE)) === p.sha) match++;
                else changed.push(`0x${p.physPage.toString(16)}`);
            }
        }
        return { units: this.units.length, pages, match, mismatch: pages - match, changed: changed.slice(0, 20) };
    }

    getUnits(): AotUnit[] { return this.units; }
    clear(): void {
        this.units = [];
        this.live = [];
        this.loadedVersion = null;
    }

    /** SHA-256 of the engine binary. Fetched once — the browser already has it cached, and
     *  this only ever runs on a save/load, never on a hot path. */
    private async engineFingerprint(): Promise<string> {
        if (this.engineSha) return this.engineSha;
        // No fallback key on failure. A shared placeholder would make units captured under one
        // codegen loadable into another, and the dangerous case is silent: if the imports still
        // match and only codegen SEMANTICS changed (fastmem layout, relaxed FPU), nothing throws
        // and wrong code gets published. Refusing to save/load is the safe failure.
        const r = await fetch("/v86.wasm");
        this.engineSha = hex(await crypto.subtle.digest("SHA-256", await r.arrayBuffer()));
        return this.engineSha;
    }

    async version(): Promise<AotVersion> {
        const w = this.wasm();
        const cpu = this.cpu();
        const required = [
            "jit_config_abi_version",
            "jit_config_supported_mask",
            "jit_codegen_fingerprint_lo",
            "jit_codegen_fingerprint_hi",
        ];
        if (!required.every((name) => typeof w?.[name] === "function")) {
            throw new Error("JIT config ABI exports unavailable; refusing AOT cache identity");
        }
        // Copy every mutable engine identity input before the first await. snapshot() deliberately
        // starts this method before it copies pages, then waits on the immutable engine hash after
        // that copy; reading these exports in the object literal below would instead read them
        // after the hash yield and could relabel old page bytes with a newer codegen identity.
        const jitConfigAbi = w.jit_config_abi_version() >>> 0;
        const jitConfigSupportedMask = w.jit_config_supported_mask() >>> 0;
        const jitCodegenFingerprintLo = w.jit_codegen_fingerprint_lo() >>> 0;
        const jitCodegenFingerprintHi = w.jit_codegen_fingerprint_hi() >>> 0;
        const ramSize = cpu?.memory_size ? cpu.memory_size[0] >>> 0 : -1;
        const engine = await this.engineFingerprint();
        return {
            abi: AOT_ABI,
            engine,
            jitConfigAbi,
            jitConfigSupportedMask,
            jitCodegenFingerprintLo,
            jitCodegenFingerprintHi,
            ramSize,
        };
    }

    private async versionKey(version: AotVersion): Promise<string> {
        const json = JSON.stringify(version);
        return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json))).slice(0, 16);
    }

    private sameVersion(a: AotVersion, b: AotVersion): boolean {
        return JSON.stringify(a) === JSON.stringify(b);
    }

    /**
     * Persist the captured units under the game's container, keyed by the version tuple —
     * so a rebuilt engine or a flipped codegen flag simply lands in a different directory
     * and the stale one is never read. This is the step that makes the track actually
     * "ahead of time" rather than re-registration inside one session.
     */
    async save(gameId: string): Promise<{ saved: number; key: string; dir: string } | { error: string }> {
        if (!this.units.length) return { error: "no units captured" };
        const container = await getContainerDir(gameId, true);
        if (!container) return { error: "no container" };
        // Persist under the identity that bound these captured bytes, never a later mutable
        // engine identity read after snapshot hashing completed.
        const version = this.loadedVersion;
        if (!version) return { error: "snapshot has no capture-time version identity" };
        try {
            if (!this.sameVersion(version, await this.version())) {
                return { error: "capture-time version identity no longer matches live engine" };
            }
        } catch { return { error: "cannot recheck live JIT version identity" }; }
        const key = await this.versionKey(version);
        const aot = await container.getDirectoryHandle("aot", { create: true });
        const dir = await aot.getDirectoryHandle(key, { create: true });

        // Every engine rebuild or codegen-flag flip mints a NEW versionKey directory, and the
        // old one is dead the moment it does — nothing will ever match its key again. Drop the
        // siblings, and the unit files this save did not produce, or the game's OPFS container
        // accumulates megabytes per rebuild forever.
        const wanted = new Set(this.units.map(u => `${u.entryPage.toString(16)}.wasm`));
        wanted.add("index.json");
        await pruneDirectory(aot, (name) => name === key, "aot");
        await pruneDirectory(dir, (name) => wanted.has(name), `aot/${key}`);

        for (const u of this.units) {
            const h = await dir.getFileHandle(`${u.entryPage.toString(16)}.wasm`, { create: true });
            const w = await h.createWritable();
            await w.write(u.bytes);
            await w.close();
        }
        const index = {
            version,
            units: this.units.map((u) => ({
                entryPage: u.entryPage, tableIndex: u.tableIndex, pages: u.pages,
                file: `${u.entryPage.toString(16)}.wasm`, bytes: u.bytes.length,
            })),
        };
        const ih = await dir.getFileHandle("index.json", { create: true });
        const iw = await ih.createWritable();
        await iw.write(new TextEncoder().encode(JSON.stringify(index)));
        await iw.close();
        Logger.log(LogCategory.SYSTEM, `[AOT] saved ${this.units.length} units under aot/${key}`);
        return { saved: this.units.length, key, dir: `aot/${key}` };
    }

    /** Load units persisted by an EARLIER SESSION. Version mismatch is not an error — it is
     *  the design working: the directory for this engine simply does not exist yet. */
    async load(gameId: string): Promise<{ loaded: number; key: string } | { error: string; key?: string }> {
        this.clear();
        const container = await getContainerDir(gameId, false);
        if (!container) return { error: "no container" };
        const version = await this.version();
        const key = await this.versionKey(version);
        try {
            const dir = await (await container.getDirectoryHandle("aot")).getDirectoryHandle(key);
            const index = JSON.parse(await (await (await dir.getFileHandle("index.json")).getFile()).text());
            if (!index.version || !this.sameVersion(index.version, version)) {
                return { error: "stored version identity mismatch", key };
            }
            const loaded: AotUnit[] = [];
            for (const u of index.units) {
                const f = await (await dir.getFileHandle(u.file)).getFile();
                const bytes = new Uint8Array(await f.arrayBuffer());
                loaded.push({ entryPage: u.entryPage, tableIndex: u.tableIndex, pages: u.pages, bytes });
            }
            this.units = loaded;
            this.loadedVersion = index.version;
            Logger.log(LogCategory.SYSTEM, `[AOT] loaded ${loaded.length} units from aot/${key}`);
            return { loaded: loaded.length, key };
        } catch {
            return { error: "no units for this engine version", key };
        }
    }

    /**
     * Everything a boot-time publish can do WITHOUT the guest image: read the units off OPFS
     * and compile their bytes. Kicked as soon as the gameId is known so it overlaps the
     * bundle's own loading; WebAssembly.compile also hands the work to V8's background
     * threads, which the synchronous constructor in replay() cannot do. Only the parts that
     * genuinely need final guest memory — the per-page SHA and registration — are left on
     * the critical path.
     */
    async prepare(gameId: string): Promise<{ loaded: number; key: string } | { error: string; key?: string }> {
        const r = await this.load(gameId);
        if (!("loaded" in r) || r.loaded === 0) return r;
        await Promise.all(this.units.map(async (u) => {
            try { u.module = await WebAssembly.compile(u.bytes); } catch { /* replay recompiles */ }
        }));
        return r;
    }

    /**
     * Per-unit liveness. `jit_aot_page_table_index(page) === idx` alone is not evidence: a
     * freed slot goes straight back on the free list and the next compilation of that very
     * page lands in it, so the page would still "point at our index" while running a JIT
     * module. Comparing the installed function object settles whose code it is.
     */
    entered(): { units: number; alive: number; evicted: number; entries: number; enteredUnits: number } {
        const w = this.wasm();
        const table = this.cpu()?.wm?.wasm_table;
        let alive = 0, entries = 0, enteredUnits = 0;
        if (!w?.jit_aot_page_table_index || !table) return { units: this.units.length, alive, evicted: 0, entries, enteredUnits };
        for (const l of this.live) {
            const ours = table?.get(l.idx + WASM_TABLE_OFFSET) === l.fn
                && l.unit.pages.some((p) => (w.jit_aot_page_table_index(p.physPage * PAGE_SIZE) >>> 0) === l.idx);
            if (!ours) continue;
            alive++;
            const n = w.jit_get_module_entry_total(l.idx) >>> 0;
            entries += n;
            if (n > 0) enteredUnits++;
        }
        return { units: this.units.length, alive, evicted: this.live.length - alive, entries, enteredUnits };
    }

    /**
     * Publish the captured units. Refusal is always safe — the page keeps the ordinary JIT
     * path — so every failure mode here degrades performance, never correctness.
     */
    async replay(): Promise<{ registered: number; refused: Record<string, number> }> {
        if (this.loadedVersion) {
            let liveVersion: AotVersion;
            try {
                liveVersion = await this.version();
            } catch (e) {
                Logger.warn(LogCategory.SYSTEM, `[AOT] replay refused: cannot read live JIT version identity: ${e}`);
                return { registered: 0, refused: { "version-unavailable": this.units.length } };
            }
            if (!this.sameVersion(this.loadedVersion, liveVersion)) {
                Logger.warn(LogCategory.SYSTEM, "[AOT] replay refused: live JIT version identity changed after load");
                return { registered: 0, refused: { "version-mismatch": this.units.length } };
            }
        }
        const w = this.wasm();
        const cpu = this.cpu();
        const table = cpu?.wm?.wasm_table;
        const imports = cpu?.["jit_imports"];
        const mem: Uint8Array | undefined = cpu?.mem8;
        const refused: Record<string, number> = {};
        const no = (why: string) => { refused[why] = (refused[why] ?? 0) + 1; };
        const txExports = [
            "jit_aot_tx_begin", "jit_aot_tx_page_begin", "jit_aot_tx_entry_push",
            "jit_aot_tx_page_finish", "jit_aot_tx_prepare_finish", "jit_aot_tx_commit",
            "jit_aot_tx_abort",
        ];
        if (!txExports.every((name) => typeof w?.[name] === "function") || !table || !imports || !mem) {
            return { registered: 0, refused: { "engine-not-ready": this.units.length } };
        }

        // PASS 1 (async) — content binding, §5.1. EVERY page the module covers must still be
        // byte-for-byte what it was; a module whose other pages changed would be dispatched
        // into for code that no longer matches it. Kept separate from publication because
        // sha256 awaits, and the guest must not run in the middle of the second pass.
        const candidates: Array<{ unit: AotUnit; fn: unknown }> = [];
        for (const u of this.units) {
            // With no pages the publication loop would publish nothing and still count as a
            // success. snapshot() never produces that; a truncated index.json could.
            if (!u.pages?.length) { no("no-pages"); continue; }
            if (!(u.tableIndex > 0 && u.tableIndex < WASM_TABLE_SIZE)) { no("no-table-index"); continue; }
            let contentOk = true;
            for (const p of u.pages) {
                if (!Number.isInteger(p.physPage) || p.physPage < 0 || p.physPage > 0xFFFFF) {
                    contentOk = false;
                    break;
                }
                if ((await sha256Page(mem, p.physPage * PAGE_SIZE)) !== p.sha) { contentOk = false; break; }
            }
            if (!contentOk) { no("content-mismatch"); continue; }
            try {
                // This is intentionally before transaction begin: WebAssembly.Module/Instance
                // construction may fail, but once Rust owns a slot pass 2 contains no await.
                const inst = new WebAssembly.Instance(u.module ?? new WebAssembly.Module(u.bytes), { "e": imports });
                const fn = (inst.exports as any)["f"];
                if (typeof fn !== "function") { no("no-export-f"); continue; }
                candidates.push({ unit: u, fn });
            } catch (e) {
                no(`instantiate:${String(e).slice(0, 40)}`);
            }
        }

        // A content hash can take an arbitrary time. Re-read the persisted identity after that
        // async pass and immediately before any Rust transaction reserves its exact slot.
        if (this.loadedVersion) {
            try {
                if (!this.sameVersion(this.loadedVersion, await this.version())) {
                    return { registered: 0, refused: { "version-mismatch-after-validation": candidates.length } };
                }
            } catch {
                return { registered: 0, refused: { "version-unavailable-after-validation": candidates.length } };
            }
        }

        // PASS 2 — strictly SYNCHRONOUS. Rust owns an exact slot from tx_begin until commit
        // or abort; no await may interleave with that ownership. Instances were constructed
        // in pass 1, so this pass is only stage → table.set → commit.
        let registered = 0;
        this.live = [];
        for (const { unit: u, fn } of candidates) {
            const fingerprintLo = this.loadedVersion?.jitCodegenFingerprintLo;
            const fingerprintHi = this.loadedVersion?.jitCodegenFingerprintHi;
            if (fingerprintLo === undefined || fingerprintHi === undefined) { no("missing-persisted-fingerprint"); continue; }
            let rc = w.jit_aot_tx_begin(u.tableIndex, u.pages.length, fingerprintLo, fingerprintHi) >>> 0;
            if (rc !== 0) { no(`tx-begin-${rc}`); continue; }
            const abort = (): boolean => {
                const abortRc = w.jit_aot_tx_abort() >>> 0;
                if (abortRc !== 0) { no(`tx-abort-${abortRc}`); return false; }
                return true;
            };
            for (const p of u.pages) {
                rc = w.jit_aot_tx_page_begin(p.physPage * PAGE_SIZE, p.stateFlags, p.entries.length) >>> 0;
                if (rc !== 0) break;
                for (const [off, st] of p.entries) {
                    rc = w.jit_aot_tx_entry_push(off, st) >>> 0;
                    if (rc !== 0) break;
                }
                if (rc !== 0) break;
                rc = w.jit_aot_tx_page_finish() >>> 0;
                if (rc !== 0) break;
            }
            if (rc === 0) rc = w.jit_aot_tx_prepare_finish() >>> 0;
            if (rc !== 0) {
                no(`tx-prepare-${rc}`);
                if (!abort()) break;
                continue;
            }

            // Rust owns the exact slot now. Do not await: clear JS's table entry before abort
            // on every post-set exception so a released slot can never dispatch this function.
            let tableMayHaveBeenWritten = false;
            try {
                tableMayHaveBeenWritten = true;
                table.set(u.tableIndex + WASM_TABLE_OFFSET, fn as any);
                rc = w.jit_aot_tx_commit() >>> 0;
                if (rc !== 0) throw new Error(`commit-${rc}`);
                this.live.push({ unit: u, idx: u.tableIndex, fn });
                registered++;
            } catch (e) {
                if (tableMayHaveBeenWritten) {
                    try { table.set(u.tableIndex + WASM_TABLE_OFFSET, null); }
                    catch { no("tx-table-clear-failed"); break; }
                }
                no(`tx-post-set:${String(e).slice(0, 40)}`);
                if (!abort()) break;
            }
        }
        if (registered > 0 && w.jit_aot_flush_tlb) w.jit_aot_flush_tlb();
        Logger.log(LogCategory.SYSTEM, `[AOT] replay: registered=${registered} refused=${JSON.stringify(refused)}`);
        return { registered, refused };
    }
}

export const aotCache = new AotCache();
