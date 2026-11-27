import type { WwtAbi } from "./cpu-provider";

interface Site { eip: number; flags: number; displacement: number }

export class WwtTrapMap {
    private readonly modules = new Map<number, Set<Uint32Array>>();

    register(entries: Uint32Array, section: ArrayBuffer): void {
        if (section.byteLength < 4 || section.byteLength % 16 !== 4) {
            throw new Error("Invalid WWT trap map");
        }
        const words = new Uint32Array(section);
        if (words[0] * 4 !== words.length - 1) throw new Error("Invalid WWT trap count");
        let previous = -1;
        for (let i = 1; i < words.length; i += 4) {
            if (words[i] <= previous) throw new Error("Unordered WWT trap offsets");
            previous = words[i];
        }
        for (const pc of entries) {
            let modules = this.modules.get(pc);
            if (!modules) this.modules.set(pc, modules = new Set());
            modules.add(words);
        }
    }

    remove(pc: number): void { this.modules.delete(pc); }
    clear(): void { this.modules.clear(); }

    find(error: unknown): Site | undefined {
        if (!(error instanceof WebAssembly.RuntimeError)) return undefined;
        const frame = error.stack?.split("\n").find(line => line.includes("wasm-function["));
        const offset = frame && /wasm-function\[\d+\]:0x([0-9a-f]+)/i.exec(frame);
        if (!frame || !offset) return undefined;
        const label = /^\s*at (\S+) \(/.exec(frame)?.[1] ?? /^(.*?)@[a-z-]+:/.exec(frame)?.[1];
        const entry = label && /(?:@|^x86_)([0-9a-f]+)$/i.exec(label);
        if (!entry) return undefined;
        const target = Number.parseInt(offset[1], 16);
        let result: Site | undefined;
        for (const words of this.modules.get(Number.parseInt(entry[1], 16)) ?? []) {
            let lo = 0, hi = words[0];
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (words[mid * 4 + 1] < target) lo = mid + 1;
                else hi = mid;
            }
            const index = lo * 4 + 1;
            if (words[index] !== target) continue;
            const site = { eip: words[index + 1], flags: words[index + 2], displacement: words[index + 3] };
            if (result && (result.eip !== site.eip || result.flags !== site.flags ||
                result.displacement !== site.displacement)) return undefined;
            result = site;
        }
        return result;
    }
}

export function trapAddress(words: Uint32Array, abi: WwtAbi, cpu: number, site: Site): number {
    const trap = abi.trap!;
    if (!(site.flags & trap.OPERAND)) return 0;
    const register = (shift: number): number => {
        const index = (site.flags >>> shift) & 15;
        return index ? words[((cpu + abi.cpu.GPR) >>> 2) + index - 1] : 0;
    };
    const segment = (site.flags >>> trap.SEG_SHIFT) & 3;
    const base = segment ? words[(cpu + (segment === 1 ? abi.cpu.FS_BASE : abi.cpu.GS_BASE)) >>> 2] : 0;
    const scale = (site.flags >>> trap.SCALE_SHIFT) & 3;
    return (register(trap.BASE_SHIFT) + register(trap.INDEX_SHIFT) * (1 << scale) + site.displacement + base) >>> 0;
}
