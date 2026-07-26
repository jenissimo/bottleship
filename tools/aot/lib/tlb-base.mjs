// Locate v86's `tlb_data` array in the engine's linear memory, by measurement.
//
// The TLB fast path an AOT unit must emit reads `tlb_data[addr >> 12]`
// (`codegen.rs:707-708` / `:1382-1383`). `tlb_data` is a Rust `static mut [i32; 0x100000]`
// (`cpu.rs:330`) placed by the linker — the engine exports no pointer to it, so an offline
// compiler cannot know its address. It is therefore emitted as a RELOCATION (design §S3) and
// resolved here, against the live instance, at publication time.
//
// The measurement: for a page whose translation is cached, the entry is
//   entry = (phys_page_base + mem8) ^ (virt_page << 12) | info_bits     (cpu.rs:2293)
// with `info_bits` confined to the low 12 bits and TLB_VALID set. Under an identity map
// phys == virt, so the high 20 bits are a value we can predict from `mem8` alone. Scanning
// for a 4-aligned base at which EVERY probed page matches, and requiring the answer to be
// unique, is a direct observation rather than a guess.

const TLB_VALID = 1;

/**
 * @param {WebAssembly.Memory} mem the engine's linear memory
 * @param {number} mem8 byte offset of guest RAM inside it (cpu.mem8.byteOffset)
 * @param {number[]} identityPages guest pages that MAY be identity-mapped and cached
 * @param {number} [minSupport] how many of them must agree before the answer is believed
 * @returns {{base:number, support:number, agreeing:number[], runnersUp:object[]}}
 */
export function findTlbDataBase(mem, mem8, identityPages, minSupport = 3) {
    const u32 = new Uint32Array(mem.buffer);
    const expectHi = (p) => (((p * 4096 + mem8) ^ (p * 4096)) & ~0xFFF) >>> 0;

    // tlb_data is 4 MB (0x100000 i32s); a base beyond (len - 4MB) cannot hold it.
    const maxWord = u32.length - 0x100000;
    // A page whose translation was never cached contributes nothing, and a page whose entry
    // happens to collide with an unrelated word contributes a wrong base — so vote instead of
    // requiring unanimity, and demand the winner be unique with enough support to exclude
    // coincidence (a wrong base must be hit by minSupport independent pages at the right stride).
    const support = new Map();
    for (const p of identityPages) {
        const want = expectHi(p);
        for (let w = p; w < maxWord + p; w++) {
            const e = u32[w] >>> 0;
            if ((e & TLB_VALID) === 0 || ((e & ~0xFFF) >>> 0) !== want) continue;
            const base = (w - p) * 4;
            let s = support.get(base);
            if (!s) support.set(base, (s = []));
            s.push(p);
        }
    }
    const ranked = [...support.entries()]
        .map(([base, pages]) => ({ base, support: pages.length, agreeing: pages }))
        .sort((a, b) => b.support - a.support);
    const top = ranked[0];
    if (!top || top.support < minSupport) {
        throw new Error(`tlb_data base not found: best support ${top?.support ?? 0} < ${minSupport}`);
    }
    if (ranked[1] && ranked[1].support === top.support) {
        throw new Error(`tlb_data base ambiguous: 0x${top.base.toString(16)} and ` +
            `0x${ranked[1].base.toString(16)} both have support ${top.support}`);
    }
    return { ...top, runnersUp: ranked.slice(1, 4) };
}

/** Pages the aot-oracle guest image always touches, hence always has cached. */
export const ORACLE_PROBE_PAGES = [0x100, 0x101, 0x10b, 0x10c, 0x10d, 0x10e];
