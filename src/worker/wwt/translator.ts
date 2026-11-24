import type { WwtAbi } from "./cpu-provider";
// wwt_translate C ABI flags (crates/wwt-wasm/src/lib.rs).
const FLAG_GUEST_MMIO = 1 << 5;
const FLAG_FLAT_RAM = 1 << 6;
const FLAG_PAGE_LOCAL_PE = 1 << 7;
const FLAG_INLINE_PAGE_WALK = 1 << 8;
const FLAG_LINKED_PE = 1 << 9;
const FLAG_SMC_DEOPT = 1 << 10;
const FLAG_MEM_TRAPS = 1 << 4;

// @transient(browser WebAssembly trap stack capability, independent of the guest)
let supportsTrapOffsets: boolean | undefined;
function canMapWasmTrap(): boolean {
    if (supportsTrapOffsets !== undefined) return supportsTrapOffsets;
    // (module (func (export "f") unreachable))
    const probe = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0,
        1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0, 0, 10, 5, 1, 3, 0, 0, 11);
    const f = new WebAssembly.Instance(new WebAssembly.Module(probe)).exports.f as () => void;
    try {
        f();
    } catch (error) {
        return supportsTrapOffsets = error instanceof WebAssembly.RuntimeError &&
            /wasm-function\[\d+\]:0x[0-9a-f]+/i.test(error.stack ?? "");
    }
    return supportsTrapOffsets = false;
}

interface TranslatorExports {
    memory: WebAssembly.Memory;
    wwt_alloc(length: number): number;
    wwt_free(address: number, length: number): void;
    wwt_kernel(): number;
    wwt_abi(): number;
    wwt_pe_aot_policy_version?(): number;
    wwt_translate_pe(file: number, length: number, profile: number, profileCount: number, optLevel: number, flags: number): number;
    wwt_translate(code: number, length: number, base: bigint, entries: number, entryCount: number,
        known: number, knownCount: number, optLevel: number, flags: number): number;
}

export class WwtTranslationStackOverflow extends Error {}

/** Owns the allocations returned by the CPU compiler's C API. Its heap is separate from guest RAM. */
export class WwtCompiler {
    readonly abi: WwtAbi;
    readonly memTraps: boolean;
    private wasm: TranslatorExports;

    private constructor(private readonly module: WebAssembly.Module, readonly flatRam: boolean,
        private readonly inlinePageWalk: boolean, readonly cacheId: string) {
        this.wasm = this.instantiate();
        this.abi = JSON.parse(new TextDecoder().decode(this.take(this.wasm.wwt_abi())));
        this.memTraps = this.abi.version === 11 && canMapWasmTrap();
    }

    static async load(url: string, flatRam = false, inlinePageWalk = false): Promise<WwtCompiler> {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`WWT CPU compiler: HTTP ${response.status} at ${url}`);
        return WwtCompiler.fromBytes(await response.arrayBuffer(), flatRam, inlinePageWalk);
    }

    static async fromBytes(bytes: BufferSource, flatRam = false, inlinePageWalk = false): Promise<WwtCompiler> {
        const [module, digest] = await Promise.all([
            WebAssembly.compile(bytes), crypto.subtle.digest("SHA-256", bytes),
        ]);
        const cacheId = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,"0")).join("");
        return new WwtCompiler(module, flatRam, inlinePageWalk, cacheId);
    }

    flags(guestLimit: number, guestMmio = false): number {
        const fixedLimit = guestLimit % (1 << 20) === 0 ? (guestLimit / (1 << 20)) << 16 : 0;
        if (this.abi.version === 11) {
            if (guestMmio) throw new Error("WWT ABI11 has no MMIO lowering. Use protected WWT.");
            return fixedLimit | (this.memTraps ? FLAG_MEM_TRAPS : 0);
        }
        return fixedLimit | (guestMmio ? FLAG_GUEST_MMIO : this.flatRam ? FLAG_FLAT_RAM : 0)
            | (this.inlinePageWalk ? FLAG_INLINE_PAGE_WALK : 0)
            | (this.abi.fault.SMC_RESUME !== undefined ? FLAG_SMC_DEOPT : 0);
    }

    kernel(): Uint8Array<ArrayBuffer> {
        return this.take(this.wasm.wwt_kernel());
    }

    translate(memory: Uint8Array, address: number, known: number[], guestLimit: number, guestMmio = false, optLevel = 1): Uint8Array<ArrayBuffer> {
        const ex = this.wasm;
        const code = ex.wwt_alloc(memory.length);
        const count = known.length + 1;
        const entries = ex.wwt_alloc(count * 8);
        try {
            new Uint8Array(ex.memory.buffer, code, memory.length).set(memory);
            const args = new DataView(ex.memory.buffer, entries, count * 8);
            args.setBigUint64(0, BigInt(address), true);
            known.forEach((value, index) => args.setBigUint64((index + 1) * 8, BigInt(value), true));
            const flags = this.flags(guestLimit, guestMmio);
            const output = this.invokeTranslation(() => ex.wwt_translate(code, memory.length, BigInt(address), entries, 1,
                entries + 8, known.length, optLevel, flags));
            if (output.length === 0) throw new Error(`WWT translation failed at 0x${address.toString(16)}`);
            return output;
        } finally {
            if (ex === this.wasm) {
                ex.wwt_free(entries, count * 8);
                ex.wwt_free(code, memory.length);
            }
        }
    }

    translatePe(file: Uint8Array, profile: number[], guestLimit: number, guestMmio: boolean, pageLocal = true): Uint8Array<ArrayBuffer> {
        const ex = this.wasm;
        const policy = ex.wwt_pe_aot_policy_version?.() ?? 0;
        if (this.abi.version !== 11 && (policy < (pageLocal ? 1 : 2) || !pageLocal && this.abi.fault.SMC_RESUME === undefined)) {
            throw new Error("WWT compiler lacks the requested PE AOT policy");
        }
        const input = ex.wwt_alloc(file.length);
        const profileBytes = Math.max(profile.length, 1) * 8;
        const seeds = ex.wwt_alloc(profileBytes);
        try {
            new Uint8Array(ex.memory.buffer, input, file.length).set(file);
            const view = new DataView(ex.memory.buffer, seeds, profileBytes);
            profile.forEach((value, index) => view.setBigUint64(index * 8, BigInt(value), true));
            const flags = this.flags(guestLimit, guestMmio) |
                (this.abi.version === 11 ? 0 : pageLocal ? FLAG_PAGE_LOCAL_PE : FLAG_LINKED_PE);
            const wasm = this.invokeTranslation(() => ex.wwt_translate_pe(input, file.length, seeds, profile.length, 1, flags));
            if (wasm.length === 0) throw new Error("WWT could not translate the linked PE");
            return wasm;
        } finally {
            if (ex === this.wasm) {
                ex.wwt_free(seeds, profileBytes);
                ex.wwt_free(input, file.length);
            }
        }
    }

    private instantiate(): TranslatorExports {
        return new WebAssembly.Instance(this.module).exports as unknown as TranslatorExports;
    }

    private invokeTranslation(translate: () => number): Uint8Array<ArrayBuffer> {
        let result: number;
        try {
            result = translate();
        } catch (error) {
            if (!(error instanceof Error) || !/^(Maximum call stack size exceeded\.?|too much recursion)$/i.test(error.message)) {
                throw error;
            }
            // A Wasm stack overflow can leave the Rust stack pointer and heap
            // in use by abandoned frames. Discard that instance before retrying.
            this.wasm = this.instantiate();
            throw new WwtTranslationStackOverflow(error.message, { cause: error });
        }
        return this.take(result);
    }

    private take(address: number): Uint8Array<ArrayBuffer> {
        const length = new DataView(this.wasm.memory.buffer).getUint32(address, true);
        try {
            return new Uint8Array(this.wasm.memory.buffer, address + 4, length).slice();
        } finally {
            this.wasm.wwt_free(address, length + 4);
        }
    }
}
