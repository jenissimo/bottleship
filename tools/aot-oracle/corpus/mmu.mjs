// aot-oracle — real MMU scenarios: page faults, permissions, A/D metadata, mapping changes.
//
// A translator that skips v86's per-access permission work is judged against #PF identity (CR2,
// error code, faulting EIP), which effects completed before the fault, and the page-table state
// afterwards. The corpus's `faults` mutate input bytes and answer none of that.
//
// Three capabilities live here:
//
//   1. PTE patching. The driver builds an identity map with `stosd`, so a build-time poke at
//      the page tables is overwritten. Patches are therefore EMITTED, either before CR0.PG
//      (the mapping was always like this) or after it with an INVLPG (the mapping CHANGED
//      under the running code, which is the case a scope-lifetime proof has to survive).
//
//   2. Fault capture. v86 enters multiboot with fake selectors and no descriptor tables, so a
//      #PF has nowhere to go and triple-faults, destroying the state we came to read. A
//      scenario image installs a flat GDT, reloads CS through a far jump, and points a real IDT
//      gate at a handler that spills fault identity plus the register file, then halts. Both
//      descriptors are base=0 limit=4GB, so the state flags v86 keys its JIT cache on are the
//      same ones a timing image runs under.
//
//   3. A/D observation. The PTE dwords are exposed as an ordinary compared region, so accessed
//      and dirty bits become effects the differential checks like any other bytes, instead of
//      a promise in a document.

import * as L from "./layout.mjs";

/** PTE flag bits (vendor/v86/src/rust/cpu/cpu.rs PAGE_TABLE_*). */
export const PTE = Object.freeze({
    PRESENT: 1 << 0,
    RW: 1 << 1,
    USER: 1 << 2,
    ACCESSED: 1 << 5,
    DIRTY: 1 << 6,
});

/** #PF error-code bits, for reading a captured code without a manual. */
export const PF_ERR = Object.freeze({
    PRESENT: 1 << 0,   // 0 = not-present, 1 = protection violation
    WRITE: 1 << 1,
    USER: 1 << 2,
    RESERVED: 1 << 3,
    FETCH: 1 << 4,
});

export function describeErrorCode(code) {
    if (typeof code !== "number") return null;
    return {
        raw: code,
        cause: code & PF_ERR.PRESENT ? "protection-violation" : "not-present",
        access: code & PF_ERR.WRITE ? "write" : "read",
        cpl: code & PF_ERR.USER ? "user" : "supervisor",
        reserved_bit: Boolean(code & PF_ERR.RESERVED),
        instruction_fetch: Boolean(code & PF_ERR.FETCH),
    };
}

/**
 * How a scenario rewrites one page's PTE.
 *   absent   — clear PRESENT. Any touch faults with error bit0 = 0.
 *   readonly — keep PRESENT, clear RW. At CPL0 this only faults with CR0.WP set, which is
 *              why `wp` is a separate, explicit switch rather than something implied.
 *   identity — the value the driver's own loop would have written (present, RW).
 */
const PTE_VALUE = {
    absent: (phys) => phys & ~0xfff,
    readonly: (phys) => ((phys & ~0xfff) | PTE.PRESENT) >>> 0,
    identity: (phys) => ((phys & ~0xfff) | PTE.PRESENT | PTE.RW) >>> 0,
};

/**
 * @typedef {object} MmuScenario
 * @property {string} id
 * @property {string} why what this scenario is evidence for
 * @property {"pre-paging"|"post-paging"} when `post-paging` also emits INVLPG, i.e. the mapping
 *   changes under code that may already hold a proof about it
 * @property {boolean} wp set CR0.WP so a supervisor store honours a read-only page
 * @property {{target:string, mode:"absent"|"readonly"|"identity"}[]} patches `target` names a
 *   key of the case's `mmuTargets`
 * @property {"fault"|"clean"} expect
 * @property {string} [expect_access] "read" | "write", checked against the captured error code
 */

/**
 * The scenario catalogue. Each entry is applied to a case that declares the named targets, so
 * one scenario covers every case that has the shape rather than being written per kernel.
 */
export const MMU_SCENARIOS = Object.freeze({
    "ad-observe": {
        id: "ad-observe",
        why: "No patch at all: the run must complete, and the PTE region shows which pages the "
            + "walker marked accessed and dirty. This is the positive control for every scenario "
            + "below — without it an absent PTE region and a working one look alike.",
        when: "pre-paging", wp: false, patches: [], expect: "clean",
    },
    "pf-absent-src": {
        id: "pf-absent-src",
        why: "The kernel's source page is not present. The read faults; every store the kernel "
            + "already completed must still be visible, and no store past the faulting "
            + "instruction may be.",
        when: "pre-paging", wp: false,
        patches: [{ target: "src", mode: "absent" }],
        expect: "fault", expect_access: "read",
        requires_distinct_pages: [["code", "src"]],
    },
    "pf-absent-dst": {
        id: "pf-absent-dst",
        why: "The destination page is not present, so the fault happens on the STORE after the "
            + "read has already been performed. Fault order, not just fault existence.",
        when: "pre-paging", wp: false,
        patches: [{ target: "dst", mode: "absent" }],
        expect: "fault", expect_access: "write",
        requires_distinct_pages: [["src", "dst"], ["code", "dst"]],
    },
    "pf-readonly-dst": {
        id: "pf-readonly-dst",
        why: "The destination is mapped read-only and CR0.WP is set, so a supervisor store "
            + "faults with a protection violation rather than a not-present code. A scoped "
            + "memory proof that checks presence but not writability passes this and is wrong.",
        when: "pre-paging", wp: true,
        patches: [{ target: "dst", mode: "readonly" }],
        expect: "fault", expect_access: "write",
        // A read-only page still READS, so the source may safely share it; only executing from
        // it would break, since a code fetch from a read-only page is fine but WP is not the
        // issue there.
        requires_distinct_pages: [["code", "dst"]],
    },
    "readonly-dst-no-wp": {
        id: "readonly-dst-no-wp",
        why: "The destination is mapped read-only and CR0.WP is NOT set, so a supervisor store "
            + "goes through unimpeded and the run completes. This is what makes `pf-readonly-dst` "
            + "evidence about WP: without it, that scenario would pass identically on a CPU that "
            + "faulted on every read-only store regardless of WP.",
        when: "pre-paging", wp: false,
        patches: [{ target: "dst", mode: "readonly" }],
        expect: "clean",
        requires_distinct_pages: [["code", "dst"]],
    },
    "mapping-change-src": {
        id: "mapping-change-src",
        why: "The source page is READ under a valid mapping, so a TLB entry exists, and only then "
            + "is the mapping revoked and INVLPG issued. Without the prior touch there is no "
            + "cached translation to invalidate and the scenario degenerates into `pf-absent-src` "
            + "under a second name. `touch` is what makes this the mapping-CHANGED case a scope "
            + "whose proof was taken at entry has to survive.",
        when: "post-paging", wp: false, touch: ["src"], invalidate: true,
        patches: [{ target: "src", mode: "absent" }],
        expect: "fault", expect_access: "read",
        requires_distinct_pages: [["code", "src"]],
    },
    "mapping-change-src-no-invlpg": {
        id: "mapping-change-src-no-invlpg",
        why: "The control for the one above: same touch, same PTE write, no INVLPG. The stale TLB "
            + "entry keeps serving the old translation, so the run completes. If this faulted too, "
            + "the paired scenario would be proving that a PTE write is visible immediately rather "
            + "than that INVLPG is what makes it visible — and the pair would be measuring nothing.",
        when: "post-paging", wp: false, touch: ["src"], invalidate: false,
        patches: [{ target: "src", mode: "absent" }],
        expect: "clean",
        // The touch fills a READ entry, and a read entry does not authorize a write: a kernel
        // that also stores to that page re-walks, sees the revoked PTE and faults with no INVLPG
        // involved. So the control only means what it says when the page is read and not written.
        requires_distinct_pages: [["code", "src"], ["dst", "src"]],
    },
    "warm-clean": {
        id: "warm-clean",
        why: "No patch, but both data pages are READ before the kernel runs, so their translations "
            + "are cached and permitted. Every other scenario leaves the TLB cold at the first "
            + "call, and a scope guard then declines over an unfilled entry no matter what else "
            + "is true — which means the PROVEN path is never the thing under test. This is the "
            + "scenario in which it is.",
        when: "post-paging", wp: false, invalidate: false,
        touch_after: ["src"], touch_write_after: ["dst"],
        patches: [], expect: "clean",
    },
    "pf-readonly-dst-cached": {
        id: "pf-readonly-dst-cached",
        why: "The destination is mapped read-only, the mapping change is made VISIBLE, and only "
            + "then is the page READ — so a valid TLB entry exists that permits reads and refuses "
            + "writes. Every other read-only scenario leaves the entry invalid, and a guard that "
            + "checks presence but not writability declines them for the wrong reason and looks "
            + "correct. This is the one that separates the two: a scope proving writes with the "
            + "read mask proves this page and stores into it without faulting. BOTH pages are "
            + "warmed, or the scope declines over the cold source and the destination permission "
            + "is never the reason for anything.",
        when: "post-paging", wp: true, invalidate: true, touch_after: ["src", "dst"],
        patches: [{ target: "dst", mode: "readonly" }],
        expect: "fault", expect_access: "write",
        requires_distinct_pages: [["code", "dst"], ["src", "dst"]],
    },
    "pf-absent-code": {
        id: "pf-absent-code",
        why: "The page holding the kernel body is not present, so the fault is an instruction "
            + "FETCH. Without CR4.PAE+NX — which v86 rejects — x86 does NOT set the error "
            + "code's I/D bit, so the witness that this was a fetch is CR2 == the faulting EIP, "
            + "not a flag. A translator that infers 'data access' from the error code alone is "
            + "reading it the way the hardware does not write it.",
        when: "post-paging", wp: false,
        patches: [{ target: "code", mode: "absent" }],
        expect: "fault", expect_access: "read",
    },
    "pf-partial-dst": {
        id: "pf-partial-dst",
        why: "The destination page is fine; the page AFTER it is not. The loop therefore "
            + "completes a run of stores and then faults part-way through, which is the only "
            + "scenario that can catch the mistake a guard is most likely to make: restarting "
            + "a scope whose earlier stores already landed, and performing them twice. Needs "
            + "enough elements to reach the next page (AOT_ORACLE_COUNT=1024 for k3).",
        when: "pre-paging", wp: false,
        patches: [{ target: "dstNext", mode: "absent" }],
        expect: "fault", expect_access: "write",
        requires_distinct_pages: [["src", "dstNext"], ["code", "dstNext"], ["dst", "dstNext"]],
        requires_span_past_page: { target: "dst" },
    },
});

/**
 * Whether a scenario can mean what it says on a given case.
 *
 * A scenario is a claim about WHICH access faults, and a case's layout can quietly make that
 * claim unachievable. k5 keeps its source string and its destination bitmap on ONE page, so
 * revoking "the destination page" revokes the source too and the first fault is the read — a
 * run that looks like a successful write-fault scenario and is not. Preconditions are therefore
 * checked and refused rather than left to be noticed in the numbers.
 *
 * @returns {{applicable:boolean, reason:string|null}}
 */
export function applicability(c, scenario) {
    const targets = c.mmuTargets ?? {};
    const page = (name) => (targets[name] === undefined ? null : targets[name] & ~0xfff);

    for (const name of scenario.patches.map((p) => p.target)) {
        if (targets[name] === undefined) {
            return { applicable: false, reason: `case '${c.id}' declares no mmuTargets.${name}` };
        }
    }
    for (const [a, b] of scenario.requires_distinct_pages ?? []) {
        if (page(a) !== null && page(a) === page(b)) {
            return {
                applicable: false,
                reason: `case '${c.id}' keeps ${a} and ${b} on the same page `
                    + `(0x${page(a).toString(16)}), so revoking one revokes the other and the fault `
                    + `this scenario claims to produce is not the one that would happen`,
            };
        }
    }
    const span = scenario.requires_span_past_page;
    if (span) {
        const base = targets[span.target];
        const bytes = typeof c.mmuSpanBytes?.[span.target] === "function"
            ? c.mmuSpanBytes[span.target]()
            : c.mmuSpanBytes?.[span.target];
        if (bytes === undefined) {
            return { applicable: false, reason: `case '${c.id}' declares no mmuSpanBytes.${span.target}` };
        }
        if ((base & ~0xfff) === ((base + bytes - 1) & ~0xfff)) {
            return {
                applicable: false,
                reason: `case '${c.id}' writes only 0x${bytes.toString(16)} bytes at `
                    + `0x${base.toString(16)}, which never leaves its page, so the page AFTER it is `
                    + "never touched and this scenario cannot fault",
            };
        }
    }
    return { applicable: true, reason: null };
}

export function getScenario(id) {
    const s = MMU_SCENARIOS[id];
    if (!s) {
        throw new Error(`unknown MMU scenario '${id}'. Known: ${Object.keys(MMU_SCENARIOS).join(", ")}`);
    }
    return s;
}

/**
 * Resolve a scenario against one case into concrete PTE writes.
 * @param {{id:string, mmuTargets?:Record<string, number>}} c
 * @param {MmuScenario} scenario
 */
/** Guest pages a scenario reads before patching, to guarantee a cached translation exists. */
export function resolveTouch(c, scenario, key = "touch") {
    const targets = c.mmuTargets ?? {};
    return (scenario[key] ?? []).map((name) => {
        if (targets[name] === undefined) {
            throw new Error(`case '${c.id}' declares no mmuTargets.${name} for scenario '${scenario.id}' to touch`);
        }
        return targets[name] & ~0xfff;
    });
}

export function resolvePatches(c, scenario) {
    const targets = c.mmuTargets ?? {};
    return scenario.patches.map(({ target, mode }) => {
        const addr = targets[target];
        if (addr === undefined) {
            throw new Error(
                `case '${c.id}' declares no mmuTargets.${target}, so scenario '${scenario.id}' `
                + `cannot be applied to it. Known targets: ${Object.keys(targets).join(", ") || "(none)"}`);
        }
        const page = addr & ~0xfff;
        return {
            target, mode, page,
            pte_addr: L.pteAddr(page),
            // Identity map: physical == virtual, which is also what BottleShip runs.
            value: PTE_VALUE[mode](page),
        };
    });
}

/**
 * Pages whose PTE dwords are worth comparing: every target the case names, plus the pages its
 * compared regions live on. Sorted and de-duplicated so the region is stable across runs.
 */
export function ptePagesForCase(c) {
    const pages = new Set();
    for (const addr of Object.values(c.mmuTargets ?? {})) pages.add(addr & ~0xfff);
    for (const r of c.regions ?? []) {
        for (let p = r.addr & ~0xfff; p < r.addr + r.len; p += 0x1000) pages.add(p >>> 0);
    }
    return [...pages].sort((a, b) => a - b);
}

/**
 * The compared PTE region for a case: one contiguous span of PT0 covering every interesting
 * page. Contiguous rather than scattered because the differential compares byte ranges, and a
 * span with uninteresting PTEs in the middle is still deterministic.
 */
export function pteRegion(c) {
    const pages = ptePagesForCase(c);
    if (pages.length === 0) return null;
    const first = L.pteAddr(pages[0]);
    const last = L.pteAddr(pages[pages.length - 1]);
    return {
        name: "PTE",
        addr: first,
        len: last - first + 4,
        // Named fields make a diff say "DST3 page accessed+dirty" instead of "byte 0x2c".
        fields: pages.map((p) => [`pte_0x${p.toString(16)}`, L.pteAddr(p) - first, 4]),
    };
}

/** Decode one PTE dword for a report. */
export function describePte(value) {
    return {
        raw: value >>> 0,
        frame: (value & ~0xfff) >>> 0,
        present: Boolean(value & PTE.PRESENT),
        writable: Boolean(value & PTE.RW),
        user: Boolean(value & PTE.USER),
        accessed: Boolean(value & PTE.ACCESSED),
        dirty: Boolean(value & PTE.DIRTY),
    };
}

// ── code emission ─────────────────────────────────────────────────────────────────────────

/** Flat 32-bit descriptor bytes: base 0, limit 4GB, granularity 4K, D/B = 1. */
function flatDescriptor(access) {
    return [0xff, 0xff, 0x00, 0x00, 0x00, access, 0xcf, 0x00];
}

/**
 * Write the static MMU data structures into the image buffer. The IDT is zeroed except for
 * vector 14: every other vector stays not-present, so an unexpected exception triple-faults
 * loudly instead of being silently absorbed by a catch-all gate.
 * @param {DataView} dv view whose byte 0 is guest address `origin`
 */
export function writeMmuData(dv, origin, handlerAddr) {
    const at = (addr) => addr - origin;
    const bytes = (addr, list) => list.forEach((b, i) => dv.setUint8(at(addr) + i, b));

    bytes(L.GDT_ADDR + 0x00, [0, 0, 0, 0, 0, 0, 0, 0]);        // null descriptor
    bytes(L.GDT_ADDR + 0x08, flatDescriptor(0x9a));            // code32: present, DPL0, exec/read
    bytes(L.GDT_ADDR + 0x10, flatDescriptor(0x92));            // data32: present, DPL0, read/write
    dv.setUint16(at(L.GDTR_ADDR), 0x17, true);                 // limit = 3 descriptors - 1
    dv.setUint32(at(L.GDTR_ADDR) + 2, L.GDT_ADDR, true);
    dv.setUint16(at(L.IDTR_ADDR), 0x7ff, true);                // limit = 256 gates - 1
    dv.setUint32(at(L.IDTR_ADDR) + 2, L.IDT_ADDR, true);

    const gate = L.IDT_ADDR + 14 * 8;                          // vector 14 = #PF
    dv.setUint16(at(gate) + 0, handlerAddr & 0xffff, true);
    dv.setUint16(at(gate) + 2, L.GDT_CODE_SEL, true);
    dv.setUint16(at(gate) + 4, 0x8e00, true);                  // present, DPL0, 32-bit interrupt gate
    dv.setUint16(at(gate) + 6, (handlerAddr >>> 16) & 0xffff, true);
}

/**
 * Emit the #PF handler at `L.MMU_CODE`.
 *
 * On entry the CPU has pushed error code, EIP, CS and EFLAGS — and nothing else, because this
 * is a CPL0 fault taken from CPL0, so there is no SS:ESP pair. EAX is spilled FIRST and used as
 * the only scratch afterwards, so the recorded register file is the one the faulting
 * instruction saw rather than the handler's.
 */
export function emitFaultHandler(a) {
    a.at(L.MMU_CODE);
    a.movMemReg(L.SFAULT + 0x00, 0 /* eax */);
    a.movMemReg(L.SFAULT + 0x04, 1 /* ecx */);
    a.movMemReg(L.SFAULT + 0x08, 2 /* edx */);
    a.movMemReg(L.SFAULT + 0x0c, 3 /* ebx */);
    a.movMemReg(L.SFAULT + 0x14, 5 /* ebp */);
    a.movMemReg(L.SFAULT + 0x18, 6 /* esi */);
    a.movMemReg(L.SFAULT + 0x1c, 7 /* edi */);
    // The faulting ESP is this one plus the four dwords the CPU pushed.
    a.movEaxEsp();
    a.addEaxImm(16);
    a.movMemReg(L.SFAULT + 0x10, 0);
    a.movEaxEspDisp8(12); a.movMemReg(L.SFAULT + 0x20, 0);   // faulting EFLAGS
    a.movEaxEspDisp8(0);  a.movMemReg(L.FAULT + 0x04, 0);    // error code
    a.movEaxEspDisp8(4);  a.movMemReg(L.FAULT + 0x08, 0);    // faulting EIP
    a.movEaxEspDisp8(8);  a.movMemReg(L.FAULT + 0x0c, 0);    // faulting CS
    a.movEaxCr2();        a.movMemReg(L.FAULT + 0x00, 0);
    a.movMemImm32(L.FAULT + 0x10, 1);                        // `taken`, written last
    a.hlt();
}

/**
 * Emit descriptor-table installation, immediately after the driver has enabled paging.
 * Segment registers are reloaded from the new GDT; both descriptors are flat, so nothing the
 * kernels compute changes.
 */
export function emitInstallTables(a) {
    a.lgdt(L.GDTR_ADDR);
    a.jmpFar(L.GDT_CODE_SEL, "mmu_cs_reloaded");
    a.label("mmu_cs_reloaded");
    a.movAxImm16(L.GDT_DATA_SEL);
    a.movSregAx("ds"); a.movSregAx("es"); a.movSregAx("fs"); a.movSregAx("gs"); a.movSregAx("ss");
    a.movEspImm(L.STACK_TOP);   // SS was just reloaded; re-establish the stack explicitly
    a.lidt(L.IDTR_ADDR);
}

/** Emit `or cr0, WP` so a supervisor store honours a read-only page. */
export function emitEnableWp(a) {
    a.movEaxCr0();
    a.orEaxImm(0x00010000);
    a.movCr0Eax();
}

/**
 * Emit the scenario's PTE writes, and the INVLPG that makes them visible.
 *
 * `invalidate` is the scenario's, not a property of when the patch runs: a post-paging patch
 * WITHOUT it is the control that proves the stale TLB entry was really there.
 */
export function emitPatches(a, patches, { invalidate }) {
    for (const p of patches) {
        a.movMemImm32(p.pte_addr, p.value);
        if (invalidate) a.invlpg(p.page);
    }
}

/**
 * Read one dword from each named page so the walker fills a TLB entry for it.
 *
 * EAX is bracketed by push/pop: the descriptor tables and the stack are already installed at this
 * point, and every wrapper re-seeds its own inputs afterwards, but leaving a clobbered register
 * behind would make the scenario image differ from the clean one in a second, unrelated way.
 */
/**
 * Read a page and write the SAME value back.
 *
 * A read alone is not enough to make a page writable in the eyes of a scope guard: v86 fills the
 * entry READONLY until the page has actually been written, because that is how it forces a
 * re-walk to set the PTE dirty bit. So a write range can only be proven for a page that is
 * already dirty — which is the plan A/D obligation, enforced by the same mask and for free.
 */
export function emitTouchWrite(a, pages) {
    for (const page of pages) {
        a.pushEax();
        a.movEaxMem(page);
        a.movMemReg(page, 0);   // REG.eax
        a.popEax();
    }
}

export function emitTouch(a, pages) {
    for (const page of pages) {
        a.pushEax();
        a.movEaxMem(page);
        a.popEax();
    }
}
