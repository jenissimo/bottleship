// Basic-block discovery and dead-flag liveness for one guest page.
//
// The liveness half is a transcription, not an invention: `classifyFlagClass` and
// `shouldElideCurrentFlags` mirror `vendor/v86/src/rust/jit.rs:1266-1430` instruction for
// instruction, including the condition the engine's comment calls out — only a NON-FAULTING
// full overwriter proves the flags dead, because a faulting one could #PF before overwriting
// and the fault frame would need the (now elided) architectural flags (contract N27 / C5).
//
// Matching it exactly is not optional: the differential oracle compares the RAW lazy 5-tuple,
// so a unit that elides differently from the JIT diverges on a state the architecture would
// call equivalent (contract N28). Being *more* conservative is not safe either — it is simply
// a different tuple.

import { decodeOne, terminator } from "./decode.mjs";

const PAGE = 4096;

// ── flag liveness (jit.rs:1266-1430) ───────────────────────────────────────
const PREFIXES = new Set([0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65, 0x66, 0x67, 0xF0, 0xF2, 0xF3]);

function decodeJitOpcode(bytes, off) {
    let a = off;
    while (PREFIXES.has(bytes[a])) a++;
    const opcode = bytes[a];
    if (opcode === 0x0F) return { opcode: 0x100 | bytes[a + 1], operandAt: a + 2 };
    return { opcode, operandAt: a + 1 };
}

const OVERWRITE = (nonFaulting) => ({ cls: "overwrite", nonFaulting });
const NEUTRAL = { cls: "neutral" };
const STOP = { cls: "stop" };

const inR = (v, lo, hi) => v >= lo && v <= hi;

/** jit.rs:1266 classify_flag_class */
export function classifyFlagClass(bytes, off) {
    const { opcode, operandAt } = decodeJitOpcode(bytes, off);
    const modrm = bytes[operandAt];
    const regOnly = (modrm & 0xC0) === 0xC0;

    if (inR(opcode, 0x00, 0x03) || inR(opcode, 0x08, 0x0B) || inR(opcode, 0x20, 0x23) ||
        inR(opcode, 0x28, 0x2B) || inR(opcode, 0x30, 0x33) || inR(opcode, 0x38, 0x3B) ||
        opcode === 0x84 || opcode === 0x85) return OVERWRITE(regOnly);

    if ([0x04, 0x05, 0x0C, 0x0D, 0x24, 0x25, 0x2C, 0x2D, 0x34, 0x35, 0x3C, 0x3D, 0xA8, 0xA9]
        .includes(opcode)) return OVERWRITE(true);

    if (opcode === 0x80 || opcode === 0x81 || opcode === 0x82 || opcode === 0x83) {
        const g = (modrm >> 3) & 7;
        return [0, 1, 4, 5, 6, 7].includes(g) ? OVERWRITE(regOnly) : STOP;
    }
    if (opcode === 0xF6 || opcode === 0xF7) {
        return ((modrm >> 3) & 7) === 0 ? OVERWRITE(regOnly) : STOP;
    }
    if (opcode === 0x88 || opcode === 0x89 || opcode === 0x8A || opcode === 0x8B) {
        return regOnly ? NEUTRAL : STOP;
    }
    if (opcode === 0x8D) return NEUTRAL;
    if (inR(opcode, 0xB0, 0xBF)) return NEUTRAL;
    if (opcode === 0xC6 || opcode === 0xC7) return regOnly ? NEUTRAL : STOP;
    if (opcode === 0x90) return NEUTRAL;
    if ([0x1B6, 0x1B7, 0x1BE, 0x1BF].includes(opcode)) return regOnly ? NEUTRAL : STOP;
    return STOP;
}

const WALK_LIMIT = 8;   // jit.rs:1326 FLAG_LIVENESS_WALK_LIMIT

// ── block discovery ────────────────────────────────────────────────────────

/**
 * @param {Uint8Array} pageBytes the page's FINAL in-guest content
 * @param {number} pageBase guest address of pageBytes[0]
 * @param {number[]} entryAddrs guest addresses the dispatcher may enter at
 * @returns {{blocks:object[], byAddr:Map<number,object>, unsupported:object[]}}
 */
/** MAX_INSTRUCTION_LENGTH (vendor/v86/src/rust/jit.rs:1267). */
const MAX_INSTRUCTION_LENGTH = 16;

/**
 * v86's `is_near_end_of_page` (jit.rs:1599-1601), and the reason it must be reproduced here.
 *
 * Every EIP this producer publishes is `(eip & ~0xFFF) | (addr & 0xFFF)`. That encoding is
 * faithful ONLY while no published address can land on the next page — and v86 guarantees
 * exactly that by excluding the last 16 bytes of every page from compilation: no block may
 * start there (jit.rs:2234), the linear run is cut there (jit.rs:2478), a conditional's
 * fallthrough is dropped there (jit.rs:2331), no entry point is recorded there (jit.rs:4520),
 * and codegen asserts it (jit.rs:4359). Together with `instruction_length < 16` that makes
 * `end_addr < pageEnd` a theorem, which is what makes `stop_addr & 0xFFF` sound.
 *
 * Without the cut-off a block could end AT `pageBase + 0x1000`, whose low 12 bits are 0, so
 * the exit EIP, an off-page jump target, and — worst — a `call rel32`'s pushed RETURN ADDRESS
 * all came out one page too low: the guest resumes at the top of the wrong page with an intact
 * stack, silently. Three independent reviews reproduced it by execution, and it passed all 36
 * verifier checks, because C4/D9 proves the high 20 bits are PRESERVED and cannot see that the
 * low 12 denote the wrong address. Refusing the zone makes the class unrepresentable instead.
 */
function isNearEndOfPage(addr) {
    return (addr & (PAGE - 1)) >= PAGE - MAX_INSTRUCTION_LENGTH;
}

export function discoverBlocks(pageBytes, pageBase, entryAddrs) {
    const pageEnd = pageBase + PAGE;
    const starts = new Set(entryAddrs);
    const unsupported = [];
    /** @type {Map<number, object>} */
    const blocks = new Map();

    // Pass 1: decode reachable instructions, collect block starts.
    const decoded = new Map();          // addr -> ins
    const seen = new Set();
    const work = [...entryAddrs];
    while (work.length) {
        let a = work.pop();
        if (seen.has(a)) continue;
        for (;;) {
            if (a < pageBase || a >= pageEnd) break;
            // The end-of-page margin: nothing in it is decoded, so no block starts there and
            // every linear run stops before it (see isNearEndOfPage).
            if (isNearEndOfPage(a)) break;
            if (seen.has(a)) break;
            seen.add(a);
            const ins = decodeOne(pageBytes, a - pageBase, a);
            decoded.set(a, ins);
            if (ins.kind === "unsupported") { unsupported.push(ins); break; }
            const end = a + ins.len;
            if (end > pageEnd) { unsupported.push({ addr: a, kind: "unsupported", why: "crosses page end", len: 0 }); decoded.set(a, { addr: a, kind: "unsupported", why: "crosses page end", len: 0 }); break; }
            const t = terminator(ins);
            if (!t) { a = end; continue; }
            if (t.type === "cond") {
                starts.add(end);
                if (t.target >= pageBase && t.target < pageEnd) { starts.add(t.target); work.push(t.target); }
                work.push(end);
            }
            else if (t.type === "jmp") {
                if (t.target >= pageBase && t.target < pageEnd) { starts.add(t.target); work.push(t.target); }
            }
            else if (t.type === "call") {
                // The callee's target AND the return point are both block heads — the engine's
                // analyzer registers the next instruction too (no `no_next_instruction`), and
                // the totality law (design §4.2) makes publishing it mandatory, not optional.
                if (t.target >= pageBase && t.target < pageEnd) { starts.add(t.target); work.push(t.target); }
                starts.add(t.next);
                work.push(t.next);
            }
            else if (t.type === "absolute" && t.next !== undefined) {
                // Indirect near CALL (FF /2): the target is dynamic, so nothing follows it in
                // THIS unit — but the guest returns to `next`, and if that address is not a
                // published entry the return dispatches to a miss, the interpreter records it as
                // a new entry point and the JIT then displaces this unit (design §4.2). So the
                // return point is a head for exactly the same reason `call rel32`'s is.
                starts.add(t.next);
                work.push(t.next);
            }
            break;   // terminator ends the linear run
        }
    }

    // Pass 2: cut the decoded stream at every start.
    const sorted = [...starts].filter((a) => decoded.has(a)).sort((x, y) => x - y);
    for (const start of sorted) {
        let a = start, count = 0, lastAddr = start, ty = null;
        for (;;) {
            const ins = decoded.get(a);
            if (!ins) { ty = { type: "exit", eip: a }; break; }               // fell into undecoded
            if (ins.kind === "unsupported") { ty = { type: "exit", eip: a, why: ins.why }; break; }
            count++; lastAddr = a;
            const end = a + ins.len;
            const t = terminator(ins);
            if (t) {
                if (t.type === "cond") ty = { type: "cond", cond: ins.cond, target: t.target, fall: end, ins };
                else if (t.type === "jmp") ty = { type: "jmp", target: t.target, ins };
                else if (t.type === "call") ty = { type: "call", target: t.target, next: t.next, ins };
                else ty = { type: "absolute", ins };
                a = end; break;
            }
            if (starts.has(end) && end !== start) { ty = { type: "fall", next: end }; a = end; break; }
            a = end;
            // Same cut as pass 1: end the block BEFORE the margin, so `endAddr & 0xFFF`
            // always denotes an address on this page (see isNearEndOfPage).
            if (a >= pageEnd || isNearEndOfPage(a)) { ty = { type: "exit", eip: a }; break; }
        }
        // Fail closed rather than emit an EIP that loses its page. Pass 1 makes this
        // unreachable; it is here because the emitter's `& 0xFFF` correctness depends on it
        // and a future edit to the walk above must not be able to break that silently.
        if (a >= pageEnd) {
            throw new Error(`cfg: block 0x${start.toString(16)} ends at 0x${a.toString(16)}, not on its own page — ` +
                `every EIP derived from it would lose a page (isNearEndOfPage margin violated)`);
        }
        blocks.set(start, {
            addr: start, endAddr: a, lastInsAddr: lastAddr, numInstructions: count, ty,
        });
    }

    const list = [...blocks.values()].sort((x, y) => x.addr - y.addr);
    list.forEach((b, i) => { b.index = i; });
    return { blocks: list, byAddr: blocks, unsupported, decoded };
}

// ── the elision decision, per instruction ──────────────────────────────────

/**
 * jit.rs:1408 should_elide_current_flags, with jit.rs:1346 flags_dead_from_addr inlined.
 * @returns {boolean}
 */
export function shouldElideCurrentFlags(env, block, addr) {
    if (!env.deadFlagElision) return false;
    const here = classifyFlagClass(env.pageBytes, addr - env.pageBase);
    if (here.cls !== "overwrite") return false;
    const ins = env.decoded.get(addr);
    if (!ins || ins.kind === "unsupported") return false;
    return walk(env, addr, addr + ins.len, block, { steps: 0 });
}

function walk(env, originAddr, addrIn, block, st) {
    let addr = addrIn;
    while (addr > originAddr && addr < block.endAddr && st.steps < WALK_LIMIT) {
        const c = classifyFlagClass(env.pageBytes, addr - env.pageBase);
        if (c.cls === "overwrite") return c.nonFaulting;
        if (c.cls === "stop") return false;
        // NeutralNoFault: step over it. Its length must be computable — every NeutralNoFault
        // form is inside this slice by construction, so failure here is a compiler bug, not a
        // reason to guess.
        const ins = env.decoded.get(addr);
        if (!ins || ins.kind === "unsupported") {
            throw new Error(`flag-liveness walk hit an undecodable NeutralNoFault at 0x${addr.toString(16)}`);
        }
        addr += ins.len;
        st.steps++;
    }
    if (addr !== block.endAddr || st.steps >= WALK_LIMIT) return false;
    // Only a Normal edge with a known successor continues the walk (jit.rs:1377-1385).
    const nextAddr = block.ty?.type === "fall" ? block.ty.next
        : block.ty?.type === "jmp" ? block.ty.target : null;
    if (nextAddr === null) return false;
    const nextBlock = env.byAddr.get(nextAddr);
    if (!nextBlock) return false;
    return walk(env, originAddr, nextAddr, nextBlock, st);
}
