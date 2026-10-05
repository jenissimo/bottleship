#!/usr/bin/env node
/**
 * What a scoped-memory unit does when the state it assumed is not the state it gets.
 *
 * The engine differential compares one kernel under one mapping. Everything a guard can be wrong
 * about — a virtual page whose neighbour lives elsewhere physically, a pointer advanced before the
 * access rather than after, a trip count that overflows the arithmetic the range is sized with, a
 * counter some other instruction also writes — is absent from that kernel by construction. So it
 * is checked here, on the emitted Wasm, against a page table this file owns.
 *
 * Every scenario compares the SCOPED unit against the CONSERVATIVE one on identical state. The
 * conservative form asks the TLB at every access, so it is the answer; a scoped unit that differs
 * from it has proven something that was not true.
 *
 *   node tools/aot/opt/scope-conformance.mjs
 */

import { Stand, lower, fill, TLB, REG } from "./wasm-stand.mjs";

const SCOPED = "flag-liveness,scoped-memory";
const PLAIN = "flag-liveness";

const checks = [];
function check(id, ok, detail) {
    checks.push({ id, ok });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}${detail ? `  ${detail}` : ""}`);
}

/**
 * Build both arms of one program.
 *
 * `scopeFormed` says whether the two arms are even different. A scenario that compares a scoped
 * unit with a conservative one when no scope was formed compares a unit with itself, and passes
 * for the one reason that means nothing.
 */
function arms(entry, code, opts = {}) {
    const scoped = lower(entry, code, { ...opts, passes: SCOPED });
    const plain = lower(entry, code, { ...opts, passes: PLAIN });
    return { scoped, plain, scopeFormed: scoped.bytes.length !== plain.bytes.length };
}

/**
 * Each program starts AT its own loop head, so the `jnz` displacement is `-(next - 0)`. Getting
 * that wrong produces a region with no back edge, no scope, and two arms that agree because
 * neither of them did anything — which is what the first version of this file measured.
 */
const back = (nextOffset) => 0x100 - nextOffset;

// cmp [ecx+edi], edx / setne dl / mov [ecx], edx / add ecx,4 / dec eax / jnz
const K3_LOOP = [
    0x39, 0x14, 0x39, 0x0f, 0x95, 0xc2, 0x89, 0x11, 0x83, 0xc1, 0x04, 0x48, 0x75, back(14),
];
// mov edx,[ecx] / add ecx,4 / dec eax / jnz  — the access BEFORE the advance.
const READ_THEN_ADVANCE = [0x8b, 0x11, 0x83, 0xc1, 0x04, 0x48, 0x75, back(8)];
// add ecx,4 / mov edx,[ecx] / dec eax / jnz  — the advance BEFORE the access.
const ADVANCE_THEN_READ = [0x83, 0xc1, 0x04, 0x8b, 0x11, 0x48, 0x75, back(8)];
// mov edx,[ecx] / add ecx,4 / dec eax / add eax,1 / jnz — a counter something else also writes.
const DEC_THEN_INC = [0x8b, 0x11, 0x83, 0xc1, 0x04, 0x48, 0x83, 0xc0, 0x01, 0x75, back(11)];

console.log("### scoped-memory conformance — emitted Wasm against a page table we own\n");

// ── 1. adjacent virtual pages, unrelated physical frames ──────────────────────────────────────
{
    const built = arms(0x1000, READ_THEN_ADVANCE);
    const run = (unit) => {
        const s = new Stand();
        // Two ADJACENT virtual pages on frames that are not adjacent. Both are mapped and both
        // permit the access, so a guard that only checks permission proves the range.
        s.map(0x20000, { physical: 0x9000 });
        s.map(0x21000, { physical: 0x30000 });
        // The dword at 0x20ffe straddles the boundary: two bytes in one frame, two in the other.
        // Byte writes, because a dword accessor would round the address down to its own frame.
        s.u8[s.physical(0x20ffe) + 0] = 0x11;
        s.u8[s.physical(0x20fff) + 0] = 0x22;
        s.u8[s.physical(0x21000) + 0] = 0x33;
        s.u8[s.physical(0x21001) + 0] = 0x44;
        // What the byte AFTER the first frame happens to hold, so a single-frame read is not
        // accidentally right.
        s.u8[0x9000 + 0x1000] = 0xaa;
        s.u8[0x9000 + 0x1001] = 0xbb;
        s.setReg("ecx", 0x20ffe);
        s.setReg("eax", 1);
        s.run(unit.bytes, 0);
        return s.reg("edx");
    };
    const want = run(built.plain);
    const got = run(built.scoped);
    check("cross-page:a scope is formed at all", built.scopeFormed);
    check("cross-page:the proven path reads what the guarded path reads",
        got === want, `guarded 0x${want.toString(16)} vs proven 0x${got.toString(16)}`);
}

// ── 2. the pointer moves before the access ────────────────────────────────────────────────────
{
    const built = arms(0x1000, ADVANCE_THEN_READ);
    const run = (unit) => {
        const s = new Stand();
        s.map(0x1000, { physical: 0x9000 });   // the page the guard would look at
        s.writeGuest32(0x1ffc, 0xdeadbeef);
        // 0x2000 is deliberately ABSENT: the loop reads there, so a range sized from the value at
        // the guard proves the wrong page and the access must still go through the slow helper.
        s.setReg("ecx", 0x1ffc);
        s.setReg("eax", 1);
        s.run(unit.bytes, 0);
        return { slow: s.calls.read32, faults: s.faults.length };
    };
    const want = run(built.plain);
    const got = run(built.scoped);
    check("advance-before-access:a scope is formed at all", built.scopeFormed);
    check("advance-before-access:the unmapped page still reaches the slow helper",
        got.slow === want.slow && got.faults === want.faults,
        `guarded slow=${want.slow} faults=${want.faults} vs proven slow=${got.slow} faults=${got.faults}`);
}

// ── 3. a trip count that overflows the range arithmetic ───────────────────────────────────────
{
    // Enough budget to walk past the one mapped page: 1024 dwords is 4096 retired instructions.
    const built = arms(0x1000, READ_THEN_ADVANCE, { loopBound: 100_000 });
    const run = (unit) => {
        const s = new Stand();
        s.map(0x20000, { physical: 0x9000 });
        // Only ONE page is mapped. With `(trip-1) * 4` wrapping to zero, a guard that sizes the
        // range with 32-bit arithmetic proves that one page and the loop walks off it.
        s.setReg("ecx", 0x20000);
        s.setReg("eax", 0x40000001);
        s.run(unit.bytes, 0);
        return { slow: s.calls.read32, faults: s.faults.length };
    };
    const want = run(built.plain);
    const got = run(built.scoped);
    check("trip-overflow:a scope is formed at all", built.scopeFormed);
    check("trip-overflow:a wrapping range does not prove one page for all of them",
        got.slow === want.slow && got.faults === want.faults,
        `guarded slow=${want.slow} faults=${want.faults} vs proven slow=${got.slow} faults=${got.faults}`);
}

// ── 4. a counter another instruction also writes ──────────────────────────────────────────────
{
    const built = arms(0x1000, DEC_THEN_INC, { loopBound: 100_000 });
    const run = (unit) => {
        const s = new Stand();
        s.map(0x20000, { physical: 0x9000 });
        s.setReg("ecx", 0x20000);
        s.setReg("eax", 1);
        s.run(unit.bytes, 0);
        return { slow: s.calls.read32, faults: s.faults.length };
    };
    const want = run(built.plain);
    const got = run(built.scoped);
    // Here the right outcome is a REFUSAL, so "a scope was formed" would be the wrong assertion.
    // What keeps it from being vacuous is the pair: the same loop without the second write to the
    // counter is accepted, so the refusal is about that write and not about the shape in general.
    const withoutTheSecondWrite = arms(0x1000, READ_THEN_ADVANCE);
    check("counter-not-a-trip-count:the shape is refused, and only because of the extra write",
        !built.scopeFormed && withoutTheSecondWrite.scopeFormed);
    check("counter-not-a-trip-count:a loop whose counter does not decrease is not proven",
        got.slow === want.slow && got.faults === want.faults,
        `guarded slow=${want.slow} faults=${want.faults} vs proven slow=${got.slow} faults=${got.faults}`);
}

// ── 4b. a scaled index moves the address further than the register ────────────────────────────
{
    // mov edx,[ecx+edi*4] / add edi,4 / dec eax / jnz — the register advances by 4, the ADDRESS
    // by 16. A range sized by the register's own stride covers a quarter of what is read.
    const SCALED = [0x8b, 0x14, 0xb9, 0x83, 0xc7, 0x04, 0x48, 0x75, back(9)];
    const built = arms(0x1000, SCALED, { loopBound: 100_000 });
    const run = (unit) => {
        const s = new Stand();
        s.map(0x1000, { physical: 0x9000 });
        // 0x2000 is absent. Two iterations read 0x1ff0 and 0x2000, so the second must fault.
        s.setReg("ecx", 0x1ff0);
        s.setReg("edi", 0);
        s.setReg("eax", 2);
        s.run(unit.bytes, 0);
        return { slow: s.calls.read32, faults: s.faults.length, eax: s.reg("eax") };
    };
    const want = run(built.plain);
    const got = run(built.scoped);
    check("scaled-index:the address stride is the register stride times the scale",
        got.slow === want.slow && got.faults === want.faults && got.eax === want.eax,
        `guarded slow=${want.slow} faults=${want.faults} eax=${want.eax} `
        + `vs proven slow=${got.slow} faults=${got.faults} eax=${got.eax}`);
}

// ── 4c. a branch inside the loop skips the advance ────────────────────────────────────────────
{
    // add edx,1 / jnz +3 / add ecx,4 / mov edx,[ecx] / mov esi,[edi] / dec eax / jnz
    //
    // The advance LIES between the head and the access and is jumped over. A guard sized by
    // counting the instructions in between proves the page above the one the loop reads, and the
    // read below it then translates with nobody having checked it.
    const BRANCH_SKIPS_ADVANCE = [
        0x83, 0xc2, 0x01, 0x75, 0x03, 0x83, 0xc1, 0x04,
        0x8b, 0x11, 0x8b, 0x37, 0x48, 0x75, back(15),
    ];
    const built = arms(0x1000, BRANCH_SKIPS_ADVANCE);
    const run = (unit) => {
        const s = new Stand();
        // 0x2000 is mapped and 0x1000 is NOT: exactly the state in which proving the page a
        // stride further on succeeds while the access the loop actually makes must fault.
        s.map(0x2000, { physical: 0x9000 });
        s.map(0x30000, { physical: 0x11000 });
        s.setReg("ecx", 0x1ffc);
        s.setReg("edi", 0x30000);
        s.setReg("edx", 1);        // so the branch is taken and the advance is skipped
        s.setReg("eax", 1);
        s.run(unit.bytes, 0);
        return { slow: s.calls.read32, faults: s.faults.length };
    };
    const want = run(built.plain);
    const got = run(built.scoped);
    // Non-vacuous by construction: the invariant access through `edi` still forms a scope, so the
    // arms differ and the comparison is between a proven unit and a guarded one.
    check("branch-skips-advance:a scope is formed at all", built.scopeFormed);
    check("branch-skips-advance:only the invariant range is proven",
        / ranges: 1, invariant: 1 /.test(built.scoped.info.scope), built.scoped.info.scope);
    check("branch-skips-advance:the page the loop really reads still faults",
        got.slow === want.slow && got.faults === want.faults && want.faults === 1,
        `guarded slow=${want.slow} faults=${want.faults} vs proven slow=${got.slow} faults=${got.faults}`);
}

// ── 5. permissions and page class, with the entry VALID ───────────────────────────────────────
// The engine matrix reaches these through page tables; here they are set directly, which is the
// only way to ask about an entry that is valid AND refuses the access. An entry that is simply
// absent declines for a reason that says nothing about permission.
{
    // mov [ecx],edx / add ecx,4 / dec eax / jnz — a WRITE loop, so the write mask decides.
    const STORE_LOOP = [0x89, 0x11, 0x83, 0xc1, 0x04, 0x48, 0x75, back(8)];
    const built = arms(0x1000, STORE_LOOP);
    const run = (unit, bits) => {
        const s = new Stand();
        s.map(0x20000, { physical: 0x9000, bits });
        s.setReg("ecx", 0x20000);
        s.setReg("eax", 1);
        s.run(unit.bytes, 0);
        return s.calls.write32;
    };
    check("permissions:a scope is formed at all", built.scopeFormed);
    for (const [name, bits] of [
        ["read-only", TLB.VALID | TLB.READONLY],
        ["carries-code", TLB.VALID | TLB.HAS_CODE],
    ]) {
        const want = run(built.plain, bits);
        const got = run(built.scoped, bits);
        check(`permissions:${name} still reaches the slow helper`,
            got === want && want > 0, `guarded slow=${want} vs proven slow=${got}`);
    }
    // …and the same loop on a plain writable page does NOT, or the two above pass because the
    // scope never proves anything.
    const clean = run(built.scoped, TLB.VALID);
    check("permissions:a writable page is still proven", clean === 0, `slow=${clean}`);
}

// ── 6. the shapes the guard must decline outright ──────────────────────────────────────────────
{
    const built = arms(0x1000, READ_THEN_ADVANCE, { loopBound: 100_000 });
    const run = (unit, setup) => {
        const s = new Stand();
        setup(s);
        s.run(unit.bytes, 0);
        return { slow: s.calls.read32, faults: s.faults.length };
    };
    const cases = [
        ["misaligned-start", (s) => {
            // A dword walk from an address that is not 4-aligned crosses a page eventually, and
            // the proven path cannot assemble such an access.
            s.map(0x20000, { physical: 0x9000 });
            s.setReg("ecx", 0x20002);
            s.setReg("eax", 2000);
        }],
        ["zero-trip-count", (s) => {
            // `dec` from zero wraps: the loop runs 2^32 times, not zero. A range sized from the
            // entry value would prove one page for all of them.
            s.map(0x20000, { physical: 0x9000 });
            s.setReg("ecx", 0x20000);
            s.setReg("eax", 0);
        }],
        ["range-past-the-budget", (s) => {
            // Seven mapped pages and an eighth that is not. The unrolled walk covers four, so a
            // guard without a budget check proves those, runs unguarded, and reaches the eighth
            // page without ever asking about it — while the conservative form faults there.
            for (let p = 0; p < 7; p++) s.map(0x20000 + p * 0x1000, { physical: 0x9000 + p * 0x1000 });
            s.setReg("ecx", 0x20000);
            s.setReg("eax", 8 * 1024);
        }],
    ];
    for (const [name, setup] of cases) {
        const want = run(built.plain, setup);
        const got = run(built.scoped, setup);
        check(`decline:${name} behaves exactly like the conservative form`,
            got.slow === want.slow && got.faults === want.faults,
            `guarded slow=${want.slow} faults=${want.faults} vs proven slow=${got.slow} faults=${got.faults}`);
    }
}

// ── 7. the shape the mechanism is FOR still takes the fast path ───────────────────────────────
// Without this the four above are satisfied by a pass that proves nothing at all.
{
    const built = arms(0x1000, K3_LOOP);
    const s = new Stand();
    for (let p = 0; p < 2; p++) s.map(0x20000 + p * 0x1000, { physical: 0x9000 + p * 0x1000 });
    s.map(0x40000, { physical: 0x20000 });
    fill(s, 0x40000, new Array(64).fill(1));
    s.setReg("ecx", 0x20000);
    s.setReg("edi", (0x40000 - 0x20000) >>> 0);
    s.setReg("eax", 64);
    // A write range is only provable on a page the guest has already dirtied, so the stand marks
    // it the way the engine would after a store.
    s.map(0x20000, { physical: 0x9000, bits: TLB.VALID });
    s.run(built.scoped.bytes, 0);
    check("fast-path:the k3 shape still proves and skips the per-access helper",
        s.calls.read32 === 0 && s.calls.write32 === 0,
        `read32=${s.calls.read32} write32=${s.calls.write32}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n=== ${failed.length === 0 ? "PASS" : "FAIL"} — ${checks.length - failed.length}/${checks.length} checks ===`);
process.exit(failed.length === 0 ? 0 : 1);
