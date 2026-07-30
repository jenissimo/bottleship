// aot-oracle — K6, the SYNTHETIC conformance body for the compiler's instruction slice.
//
// Why a synthetic case exists next to four byte-exact NFSU kernels: a retail kernel proves the
// shapes it happens to contain. `tools/aot/slice-census.mjs` says the hot pages carry 597 8-bit
// ALU sites, 176 `call rel32`, 119 `push r/m32`, 123 adc/sbb and 62 `leave` — and not one
// self-contained, position-independent loop that contains them together (measured: the scan in
// this session found 735 candidate loops, none on the five hot pages). So the retail corpus
// cannot cover the slice, and "the rest is probably fine" is not a verification.
//
// This body is therefore a differential CONFORMANCE vector: every instruction form the slice
// claims, once, executed against v86's own lowering of the same bytes, with the oracle comparing
// guest memory, the register file, the RAW lazy-flag 5-tuple and the instruction counter. It
// makes no claim about NFSU's hot code — the retail kernels do that.
//
// Rules the body obeys, each for a reason:
//   - straight-line and terminating (one `call +0` is the only control transfer);
//   - every scratch slot is re-seeded from an immediate before use, so the body is IDEMPOTENT
//     over the image and repeated phase calls converge on the same bytes;
//   - push/pop are balanced, and `leave` (which overwrites ESP by definition) is bracketed by an
//     absolute-addressed save/restore, so the wrapper's `ret` still works;
//   - no instruction outside the slice, asserted by decoding the finished bytes with the
//     compiler's OWN decoder (`selfCheck` below) — an assembler that silently emitted an
//     out-of-slice byte would produce a unit that exits early and a test that proves nothing.

import * as L from "./layout.mjs";

const S = L.SAVE6;          // absolute-addressed slots (moffs + the ESP save)
const ESP_SAVE = S + 0x00;
const ABS_W = S + 0x08;     // moffs32 dword
const ABS_B = S + 0x10;     // moffs8 byte

/** A byte assembler that records one line of provenance per instruction. */
class Asm {
    constructor() { this.b = []; this.lines = []; }
    put(text, ...bytes) {
        this.lines.push({ off: this.b.length, text, bytes: bytes.length });
        for (const x of bytes) this.b.push(x & 0xFF);
        return this;
    }
    u32(v) { const o = []; for (let i = 0; i < 4; i++) o.push((v >>> (8 * i)) & 0xFF); return o; }
}

export function buildK6() {
    const a = new Asm();
    const P = (d) => d & 0xFF;                     // [ebp+disp8]
    const modEbp = (reg, disp) => [0x45 | (reg << 3), P(disp)];

    // ── seed the scratch slots (idempotency) ───────────────────────────────
    a.put("mov dword [ebp+0], 0x89abcdef", 0xC7, ...modEbp(0, 0), ...a.u32(0x89ABCDEF));
    a.put("mov dword [ebp+8], 0x00000000", 0xC7, ...modEbp(0, 8), ...a.u32(0));
    a.put("mov byte [ebp+4], 0x5a", 0xC6, ...modEbp(0, 4), 0x5A);
    a.put("mov dword [ebp+0xc], 0", 0xC7, ...modEbp(0, 0x0C), ...a.u32(0));
    a.put("mov dword [abs_w], 0x0f0e0d0c", 0xC7, 0x05, ...a.u32(ABS_W), ...a.u32(0x0F0E0D0C));
    a.put("mov byte [abs_b], 0x7b", 0xC6, 0x05, ...a.u32(ABS_B), 0x7B);
    a.put("mov eax, 0x1234abcd", 0xB8, ...a.u32(0x1234ABCD));
    a.put("mov ebx, 0x00ff0011", 0xBB, ...a.u32(0x00FF0011));
    a.put("mov cl, 0x03", 0xB1, 0x03);

    // ── 8-bit ALU, register forms, across the AH/AL alias boundary ─────────
    a.put("mov al, 0x37", 0xB0, 0x37);
    a.put("mov ah, 0x9c", 0xB4, 0x9C);
    a.put("add ah, al", 0x00, 0xC4);        // rm=ah(4) reg=al(0): high-byte DEST
    a.put("add al, ah", 0x00, 0xE0);        // rm=al   reg=ah   : high-byte SOURCE
    a.put("sub al, ah", 0x28, 0xE0);
    a.put("and al, ah", 0x20, 0xE0);
    a.put("or  al, ah", 0x08, 0xE0);
    a.put("xor al, ah", 0x30, 0xE0);
    a.put("adc al, ah", 0x10, 0xE0);        // adc8 helper
    a.put("sbb al, ah", 0x18, 0xE0);        // sbb8 helper
    a.put("cmp al, ah", 0x38, 0xE0);
    a.put("test al, ah", 0x84, 0xE0);
    a.put("test ah, ah", 0x84, 0xE4);       // aliasing pair that is NOT a self-test in v86
    a.put("test cl, cl", 0x84, 0xC9);       // the real self-test (same local)
    a.put("xchg al, ah", 0x86, 0xE0);
    a.put("add dh, bl", 0x00, 0xDE);        // both operands high/low of different registers

    // ── 8-bit ALU, r8 <- r/m8 (memory source) ──────────────────────────────
    a.put("add al, [ebp+4]", 0x02, ...modEbp(0, 4));
    a.put("sub bh, [ebp+4]", 0x2A, ...modEbp(7, 4));
    a.put("or  al, [ebp+4]", 0x0A, ...modEbp(0, 4));
    a.put("and al, [ebp+4]", 0x22, ...modEbp(0, 4));
    a.put("xor al, [ebp+4]", 0x32, ...modEbp(0, 4));
    a.put("adc al, [ebp+4]", 0x12, ...modEbp(0, 4));
    a.put("sbb al, [ebp+4]", 0x1A, ...modEbp(0, 4));
    a.put("cmp al, [ebp+4]", 0x3A, ...modEbp(0, 4));

    // ── 8-bit ALU, r/m8 <- r8 (the BYTE read-modify-write shape) ───────────
    a.put("add [ebp+4], al", 0x00, ...modEbp(0, 4));
    a.put("or  [ebp+4], al", 0x08, ...modEbp(0, 4));
    a.put("adc [ebp+4], al", 0x10, ...modEbp(0, 4));
    a.put("sbb [ebp+4], al", 0x18, ...modEbp(0, 4));
    a.put("and [ebp+4], al", 0x20, ...modEbp(0, 4));
    a.put("sub [ebp+4], al", 0x28, ...modEbp(0, 4));
    a.put("xor [ebp+4], al", 0x30, ...modEbp(0, 4));
    a.put("cmp [ebp+4], al", 0x38, ...modEbp(0, 4));   // read-only, not an RMW
    a.put("add [ebp+4], ah", 0x00, ...modEbp(4, 4));   // high-byte source into memory
    a.put("test [ebp+4], al", 0x84, ...modEbp(0, 4));

    // ── group 1, 8-bit immediate (0x80 and its 0x82 alias) ─────────────────
    a.put("add byte [ebp+4], 0x11", 0x80, ...modEbp(0, 4), 0x11);
    a.put("or  byte [ebp+4], 0x22", 0x80, ...modEbp(1, 4), 0x22);
    a.put("adc byte [ebp+4], 0x33", 0x80, ...modEbp(2, 4), 0x33);
    a.put("sbb byte [ebp+4], 0x44", 0x80, ...modEbp(3, 4), 0x44);
    a.put("and byte [ebp+4], 0xf0", 0x80, ...modEbp(4, 4), 0xF0);
    a.put("sub byte [ebp+4], 0x05", 0x80, ...modEbp(5, 4), 0x05);
    a.put("xor byte [ebp+4], 0x5a", 0x80, ...modEbp(6, 4), 0x5A);
    a.put("cmp byte [ebp+4], 0x0f", 0x80, ...modEbp(7, 4), 0x0F);
    a.put("add byte [ebp+4], 0x05 (0x82)", 0x82, ...modEbp(0, 4), 0x05);
    a.put("add cl, 0x7f", 0x80, 0xC1, 0x7F);
    a.put("adc ch, 0x01", 0x80, 0xD5, 0x01);
    a.put("cmp cl, 0x10", 0x80, 0xF9, 0x10);

    // ── acc,imm8 / acc,imm32 ───────────────────────────────────────────────
    a.put("add al, 0x21", 0x04, 0x21);
    a.put("or  al, 0x42", 0x0C, 0x42);
    a.put("adc al, 0x08", 0x14, 0x08);
    a.put("sbb al, 0x03", 0x1C, 0x03);
    a.put("and al, 0x7e", 0x24, 0x7E);
    a.put("sub al, 0x11", 0x2C, 0x11);
    a.put("xor al, 0x55", 0x34, 0x55);
    a.put("cmp al, 0x40", 0x3C, 0x40);
    a.put("test al, 0x0f", 0xA8, 0x0F);
    a.put("test eax, 0x12345678", 0xA9, ...a.u32(0x12345678));

    // ── 8-bit unary + shift/rotate (every one a helper call in v86) ────────
    a.put("not byte [ebp+4]", 0xF6, ...modEbp(2, 4));
    a.put("neg byte [ebp+4]", 0xF6, ...modEbp(3, 4));
    a.put("inc byte [ebp+4]", 0xFE, ...modEbp(0, 4));
    a.put("dec byte [ebp+4]", 0xFE, ...modEbp(1, 4));
    a.put("test byte [ebp+4], 0x33", 0xF6, ...modEbp(0, 4), 0x33);
    a.put("not cl", 0xF6, 0xD1);
    a.put("neg cl", 0xF6, 0xD9);
    a.put("inc dh", 0xFE, 0xC6);
    a.put("dec dh", 0xFE, 0xCE);
    a.put("rol byte [ebp+4], 3", 0xC0, ...modEbp(0, 4), 0x03);
    a.put("ror byte [ebp+4], 3", 0xC0, ...modEbp(1, 4), 0x03);
    a.put("rcl byte [ebp+4], 1", 0xC0, ...modEbp(2, 4), 0x01);
    a.put("rcr byte [ebp+4], 1", 0xC0, ...modEbp(3, 4), 0x01);
    a.put("shl byte [ebp+4], 3", 0xC0, ...modEbp(4, 4), 0x03);
    a.put("shr byte [ebp+4], 2", 0xC0, ...modEbp(5, 4), 0x02);
    a.put("sar byte [ebp+4], 1", 0xC0, ...modEbp(7, 4), 0x01);
    a.put("shl byte [ebp+4], 1 (D0)", 0xD0, ...modEbp(4, 4));
    a.put("mov cl, 0x05", 0xB1, 0x05);
    a.put("shl bl, cl", 0xD2, 0xE3);
    a.put("sar byte [ebp+4], cl", 0xD2, ...modEbp(7, 4));
    a.put("shl dl, 4", 0xC0, 0xE2, 0x04);

    // ── 32-bit adc / sbb, every operand shape ──────────────────────────────
    // [esi] is the one operand the body does NOT seed: it is image DATA, so a byte flipped there
    // is a negative control that perturbs an INPUT rather than the code page (a code-page fault
    // would only prove the comparison notices different instructions).
    a.put("adc eax, [esi]", 0x13, 0x06);
    a.put("adc eax, ebx", 0x11, 0xD8);
    a.put("sbb eax, ebx", 0x19, 0xD8);
    a.put("adc eax, [ebp+0]", 0x13, ...modEbp(0, 0));
    a.put("sbb eax, [ebp+0]", 0x1B, ...modEbp(0, 0));
    a.put("adc [ebp+0], eax", 0x11, ...modEbp(0, 0));   // 32-bit RMW
    a.put("sbb [ebp+0], eax", 0x19, ...modEbp(0, 0));
    a.put("adc eax, 0x0000dead", 0x15, ...a.u32(0x0000DEAD));
    a.put("sbb eax, 0x00001234", 0x1D, ...a.u32(0x00001234));
    a.put("adc dword [ebp+0], 0x11223344", 0x81, ...modEbp(2, 0), ...a.u32(0x11223344));
    a.put("sbb dword [ebp+0], 0x07", 0x83, ...modEbp(3, 0), 0x07);
    a.put("adc ebx, 0x05", 0x83, 0xD3, 0x05);
    a.put("sbb ebx, ebx", 0x19, 0xDB);                  // source aliases dest

    // ── 32-bit rotates (helper calls) ──────────────────────────────────────
    a.put("rol eax, 5", 0xC1, 0xC0, 0x05);
    a.put("ror eax, 7", 0xC1, 0xC8, 0x07);
    a.put("rcl eax, 1", 0xC1, 0xD0, 0x01);
    a.put("rcr eax, 1", 0xC1, 0xD8, 0x01);
    a.put("rol eax, 1 (D1)", 0xD1, 0xC0);
    a.put("ror dword [ebp+0], cl", 0xD3, ...modEbp(1, 0));
    a.put("rol eax, cl", 0xD3, 0xC0);

    // ── push/pop r/m, xchg, cwde/cdq, moffs ────────────────────────────────
    a.put("push dword [ebp+0]", 0xFF, ...modEbp(6, 0));
    a.put("pop dword [ebp+8]", 0x8F, ...modEbp(0, 8));
    a.put("push ebx", 0x53);
    a.put("pop ecx (8F /0 reg)", 0x8F, 0xC1);
    a.put("xchg eax, ecx", 0x91);
    a.put("xchg eax, edi", 0x97);
    a.put("xchg eax, ebx (0x87)", 0x87, 0xD8);
    a.put("cwde", 0x98);
    a.put("cdq", 0x99);
    a.put("mov eax, [abs_w]", 0xA1, ...a.u32(ABS_W));
    a.put("mov [abs_w], eax", 0xA3, ...a.u32(ABS_W));
    a.put("mov al, [abs_b]", 0xA0, ...a.u32(ABS_B));
    a.put("mov [abs_b], al", 0xA2, ...a.u32(ABS_B));

    // ── call rel32: the return-address push, then the return point ─────────
    a.put("call +0", 0xE8, ...a.u32(0));
    a.put("pop edx", 0x5A);

    // ── indirect near CALL / JMP (FF /2, FF /4), register and memory forms ─
    // These END the unit: the successor is a run-time value, so the compiler writes EIP and
    // exits to the dispatcher, which must re-enter at a PUBLISHED entry — so the four stages
    // below are the only shapes in this vector that exercise exit-and-re-entry rather than
    // straight-line lowering, and a unit that published the wrong return point would show up
    // here as `aot.alive=false` instead of as a wrong value.
    //
    // Every target is derived from a `call +0` return address rather than from a link-time
    // constant, so the section is position-independent: the body is emitted after a wrapper
    // prologue whose length is not the body's business (corpus/image.mjs). `cmp edx,edx` is the
    // flag setter because it forces ZF=1 while clobbering nothing — `edx` is carrying the
    // address, and the Jcc exists only to make the indirect JMP's landing address a published
    // block head (FF /4 sets `no_next_instruction`, so unlike FF /2 it publishes none itself).
    //
    // The two `add [ebp+0xc], edx` folds are not decoration. Without them the vector cannot
    // fail on the RETURN ADDRESS a `call r/m32` pushes: each stage pops it and the next stage
    // immediately overwrites edx, so an emitter that pushed `next + 1` produced a unit the
    // oracle still called CORRECT (measured, by injecting exactly that fault). Folding both
    // addresses into a compared slot is what makes the push observable.
    a.put("call +0", 0xE8, ...a.u32(0));
    a.put("pop edx", 0x5A);                          // edx = the address of THIS `pop`
    a.put("add edx, 6", 0x83, 0xC2, 0x06);           // -> the `pop edx` after `call edx`
    a.put("call edx", 0xFF, 0xD2);                   // FF /2 reg
    a.put("pop edx", 0x5A);                          // balances the pushed return address
    a.put("add [ebp+0xc], edx", 0x01, ...modEbp(2, 0x0C));   // ...and LANDS it: see below

    a.put("call +0", 0xE8, ...a.u32(0));
    a.put("pop edx", 0x5A);
    a.put("add edx, 10", 0x83, 0xC2, 0x0A);
    a.put("mov [ebp+8], edx", 0x89, ...modEbp(2, 8));
    a.put("call dword [ebp+8]", 0xFF, ...modEbp(2, 8));   // FF /2 mem
    a.put("pop edx", 0x5A);
    a.put("add [ebp+0xc], edx", 0x01, ...modEbp(2, 0x0C));

    a.put("call +0", 0xE8, ...a.u32(0));
    a.put("pop edx", 0x5A);
    a.put("add edx, 10", 0x83, 0xC2, 0x0A);
    a.put("cmp edx, edx", 0x39, 0xD2);               // ZF = 1, no register touched
    a.put("jnz +2", 0x75, 0x02);                     // not taken; publishes the landing address
    a.put("jmp edx", 0xFF, 0xE2);                    // FF /4 reg -> the next instruction

    a.put("call +0", 0xE8, ...a.u32(0));
    a.put("pop edx", 0x5A);
    a.put("add edx, 14", 0x83, 0xC2, 0x0E);
    a.put("mov [ebp+8], edx", 0x89, ...modEbp(2, 8));
    a.put("cmp edx, edx", 0x39, 0xD2);
    a.put("jnz +3", 0x75, 0x03);
    a.put("jmp dword [ebp+8]", 0xFF, ...modEbp(4, 8));    // FF /4 mem

    // ── LEAVE, bracketed so ESP survives for the wrapper's ret ─────────────
    a.put("mov [esp_save], esp", 0x89, 0x25, ...a.u32(ESP_SAVE));
    a.put("mov dword [ebp+0], FRAME6", 0xC7, ...modEbp(0, 0), ...a.u32(L.FRAME6));
    a.put("leave", 0xC9);
    a.put("mov esp, [esp_save]", 0x8B, 0x25, ...a.u32(ESP_SAVE));
    a.put("mov ebp, FRAME6", 0xBD, ...a.u32(L.FRAME6));

    // ── land the volatile parts in memory so the diff sees them ────────────
    a.put("mov [ebp+0x10], eax", 0x89, ...modEbp(0, 0x10));
    a.put("mov [ebp+0x14], ebx", 0x89, ...modEbp(3, 0x14));
    a.put("mov [ebp+0x18], ecx", 0x89, ...modEbp(1, 0x18));
    a.put("mov [ebp+0x1c], edx", 0x89, ...modEbp(2, 0x1C));

    // ──────────────────────────────────────────────────────────────────────
    // Stage 2 forms (imul / mul / bswap / bsf / bsr / cmovcc / clc-stc-cld-std / the loop
    // family). Every landing slot below is written EXACTLY ONCE and none of them is a scratch
    // slot of stage 1 (0x00/0x04/0x08/0x0c) or one of its final register landings (0x10..0x1c):
    // a value written into a slot something else later overwrites is not a compared value, which
    // is the same "executed but never observed" hole the FF /2 return address had before the two
    // `add [ebp+0xc], edx` folds were added.
    //
    // The slots past +0x7c use the mod=2 (disp32) ModRM form, which also covers an addressing
    // shape stage 1 never emits.
    //
    // And stage 2 runs AFTER stage 1's register landings, not before, because it re-seeds every
    // GPR: written the other way round it silently killed the case's negative control — the
    // `src-first` fault still produced `CORRECT`, because the only carrier of the perturbation
    // (stage 1's `adc eax, [esi]` chain) had been overwritten before anything stored it.
    // ──────────────────────────────────────────────────────────────────────
    const modEbpW = (reg, disp) => [0x85 | (reg << 3), ...a.u32(disp)];

    // ── IMUL: every operand shape, plus both sides of the CF/OF predicate ──
    // jit_instructions.rs:2087 gen_imul3_reg32 computes the full 64-bit product and sets CF|OF
    // iff the low half does not sign-extend to it, so each form needs a non-overflowing AND an
    // overflowing operand pair or the predicate is only half covered.
    a.put("mov dword [ebp+0], 0x00000101", 0xC7, ...modEbp(0, 0), ...a.u32(0x00000101));
    a.put("mov eax, 7", 0xB8, ...a.u32(7));
    a.put("mov ebx, 3", 0xBB, ...a.u32(3));
    a.put("imul eax, ebx", 0x0F, 0xAF, 0xC3);                          // 0F AF reg, no overflow
    a.put("imul eax, [ebp+0]", 0x0F, 0xAF, ...modEbp(0, 0));           // 0F AF mem
    a.put("mov [ebp+0x20], eax", 0x89, ...modEbp(0, 0x20));
    a.put("mov eax, 0x40000000", 0xB8, ...a.u32(0x40000000));
    a.put("imul eax, ebx", 0x0F, 0xAF, 0xC3);                          // overflows -> CF|OF set
    a.put("mov [ebp+0x24], eax", 0x89, ...modEbp(0, 0x24));
    a.put("imul ecx, ebx, 0x1234", 0x69, 0xCB, ...a.u32(0x1234));      // 69 reg
    a.put("mov [ebp+0x28], ecx", 0x89, ...modEbp(1, 0x28));
    a.put("imul edi, [ebp+0], 0xffff", 0x69, ...modEbp(7, 0), ...a.u32(0xFFFF));   // 69 mem
    a.put("mov [ebp+0x2c], edi", 0x89, ...modEbp(7, 0x2C));
    a.put("imul esi, ebx, 0x7f", 0x6B, 0xF3, 0x7F);                    // 6B reg
    a.put("mov [ebp+0x30], esi", 0x89, ...modEbp(6, 0x30));
    a.put("imul ebx, [ebp+0], -3", 0x6B, ...modEbp(3, 0), 0xFD);       // 6B mem, negative imm8
    a.put("mov [ebp+0x34], ebx", 0x89, ...modEbp(3, 0x34));
    a.put("mov eax, 0x12345678", 0xB8, ...a.u32(0x12345678));
    a.put("imul eax, eax, 0x11", 0x6B, 0xC0, 0x11);                    // dest ALIASES src1
    a.put("mov [ebp+0x38], eax", 0x89, ...modEbp(0, 0x38));

    // ── one-operand MUL / IMUL (edx:eax), both CF/OF directions ────────────
    a.put("mov ebx, 3", 0xBB, ...a.u32(3));
    a.put("mov eax, 0x00010001", 0xB8, ...a.u32(0x00010001));
    a.put("mul ebx", 0xF7, 0xE3);                        // edx == 0  -> CF|OF cleared
    a.put("mov [ebp+0x3c], eax", 0x89, ...modEbp(0, 0x3C));
    a.put("mov [ebp+0x40], edx", 0x89, ...modEbp(2, 0x40));
    a.put("mov eax, 0xffff0000", 0xB8, ...a.u32(0xFFFF0000));
    a.put("mul dword [ebp+0]", 0xF7, ...modEbp(4, 0));   // edx != 0  -> CF|OF set
    a.put("mov [ebp+0x44], edx", 0x89, ...modEbp(2, 0x44));
    a.put("mov eax, 0xfffffffe", 0xB8, ...a.u32(0xFFFFFFFE));
    a.put("imul ebx", 0xF7, 0xEB);                       // -2 * 3: edx sign-extends eax
    a.put("mov [ebp+0x48], eax", 0x89, ...modEbp(0, 0x48));
    a.put("mov [ebp+0x4c], edx", 0x89, ...modEbp(2, 0x4C));
    a.put("mov eax, 0x40000000", 0xB8, ...a.u32(0x40000000));
    a.put("imul dword [ebp+0]", 0xF7, ...modEbp(5, 0));  // it does not -> CF|OF set
    a.put("mov [ebp+0x50], edx", 0x89, ...modEbp(2, 0x50));

    // ── BSWAP, BSF, BSR (incl. the source-is-zero arm the helper owns) ──────
    a.put("mov eax, 0x11223344", 0xB8, ...a.u32(0x11223344));
    a.put("bswap eax", 0x0F, 0xC8);
    a.put("mov [ebp+0x54], eax", 0x89, ...modEbp(0, 0x54));
    a.put("mov dword [ebp+0], 0x00500000", 0xC7, ...modEbp(0, 0), ...a.u32(0x00500000));
    a.put("bsf ecx, [ebp+0]", 0x0F, 0xBC, ...modEbp(1, 0));
    a.put("mov [ebp+0x58], ecx", 0x89, ...modEbp(1, 0x58));
    a.put("bsr edx, [ebp+0]", 0x0F, 0xBD, ...modEbp(2, 0));
    a.put("mov [ebp+0x5c], edx", 0x89, ...modEbp(2, 0x5C));
    a.put("mov ebx, 0x00008000", 0xBB, ...a.u32(0x8000));
    a.put("bsf esi, ebx", 0x0F, 0xBC, 0xF3);
    a.put("bsr edi, ebx", 0x0F, 0xBD, 0xFB);
    a.put("mov [ebp+0x60], esi", 0x89, ...modEbp(6, 0x60));
    a.put("mov esi, 0x0f0f0f0f", 0xBE, ...a.u32(0x0F0F0F0F));
    a.put("xor ebx, ebx", 0x31, 0xDB);
    a.put("bsf esi, ebx", 0x0F, 0xBC, 0xF3);             // source 0: dest UNCHANGED, ZF set
    a.put("mov [ebp+0x64], esi", 0x89, ...modEbp(6, 0x64));
    a.put("bsr edi, ebx", 0x0F, 0xBD, 0xFB);
    a.put("bswap edi", 0x0F, 0xCF);
    a.put("mov [ebp+0x68], edi", 0x89, ...modEbp(7, 0x68));

    // ── CMOVcc, both taken and not taken, register and memory source ───────
    a.put("mov dword [ebp+0], 0x0badc0de", 0xC7, ...modEbp(0, 0), ...a.u32(0x0BADC0DE));
    a.put("mov eax, 1", 0xB8, ...a.u32(1));
    a.put("mov ebx, 0xff", 0xBB, ...a.u32(0xFF));
    a.put("mov ecx, 0x11111111", 0xB9, ...a.u32(0x11111111));
    a.put("mov edx, 0x22222222", 0xBA, ...a.u32(0x22222222));
    a.put("mov esi, 0x33333333", 0xBE, ...a.u32(0x33333333));
    a.put("mov edi, 0x44444444", 0xBF, ...a.u32(0x44444444));
    a.put("cmp eax, eax", 0x39, 0xC0);                   // ZF = 1
    a.put("cmove ecx, ebx", 0x0F, 0x44, 0xCB);           // taken, register source
    a.put("cmovne edx, ebx", 0x0F, 0x45, 0xD3);          // not taken
    a.put("cmove esi, [ebp+0]", 0x0F, 0x44, ...modEbp(6, 0));     // taken, memory source
    a.put("cmovne edi, [ebp+0]", 0x0F, 0x45, ...modEbp(7, 0));    // not taken; read still happens
    a.put("mov [ebp+0x6c], ecx", 0x89, ...modEbp(1, 0x6C));
    a.put("mov [ebp+0x70], edx", 0x89, ...modEbp(2, 0x70));
    a.put("mov [ebp+0x74], esi", 0x89, ...modEbp(6, 0x74));
    a.put("mov [ebp+0x78], edi", 0x89, ...modEbp(7, 0x78));

    // ── CLC / STC / CLD / STD ──────────────────────────────────────────────
    // CF is landed through setcc + adc because that is what the guest can observe. DF is landed
    // only in the raw `flags` word, which the oracle's state block compares (contract §10 C10) —
    // which is exactly the point of C14/N106: a rebuilt flags word drops DF, and neither a memory
    // diff nor a get_eflags()-only flag diff can see it.
    a.put("stc", 0xF9);
    a.put("clc", 0xF8);
    a.put("setc al", 0x0F, 0x92, 0xC0);                  // 0 — via the flags_changed CF clear
    a.put("adc eax, 0", 0x83, 0xD0, 0x00);
    a.put("mov [ebp+0x7c], eax", 0x89, ...modEbp(0, 0x7C));
    a.put("stc", 0xF9);
    a.put("setc bl", 0x0F, 0x92, 0xC3);                  // 1
    a.put("adc ebx, 0", 0x83, 0xD3, 0x00);
    a.put("mov [ebp+0x80], ebx", 0x89, ...modEbpW(3, 0x80));
    a.put("cld", 0xFC);
    a.put("std", 0xFD);                                  // DF stays SET at the capture point

    // ── LOOP / LOOPNE / LOOPE / JECXZ ──────────────────────────────────────
    // The first bodies in this vector that are not straight line. A self-loop is the shape the
    // emitter lowers as a wasm `loop` whose head carries the B7 bounded exit and its EIP store
    // (jit.rs:4131-4149), so these are also what makes that guard reachable at all.
    a.put("mov dword [ebp+0x84], 0", 0xC7, ...modEbpW(0, 0x84), ...a.u32(0));
    a.put("mov ecx, 4", 0xB9, ...a.u32(4));
    const lLoop = a.b.length;
    a.put("inc dword [ebp+0x84]", 0xFF, ...modEbpW(0, 0x84));
    a.put("loop -n", 0xE2, (lLoop - (a.b.length + 2)) & 0xFF);          // 4 iterations

    a.put("mov dword [ebp+0x88], 0", 0xC7, ...modEbpW(0, 0x88), ...a.u32(0));
    a.put("mov ecx, 4", 0xB9, ...a.u32(4));
    const lLoopne = a.b.length;
    a.put("inc dword [ebp+0x88]", 0xFF, ...modEbpW(0, 0x88));           // result never 0 => ZF=0
    a.put("loopne -n", 0xE0, (lLoopne - (a.b.length + 2)) & 0xFF);      // runs ecx out

    a.put("mov dword [ebp+0x8c], 1", 0xC7, ...modEbpW(0, 0x8C), ...a.u32(1));
    a.put("mov ecx, 4", 0xB9, ...a.u32(4));
    const lLoope = a.b.length;
    a.put("dec dword [ebp+0x8c]", 0xFF, ...modEbpW(1, 0x8C));          // 1->0 ZF=1, 0->-1 ZF=0
    a.put("loope -n", 0xE1, (lLoope - (a.b.length + 2)) & 0xFF);       // taken once, then not
    a.put("mov [ebp+0x90], ecx", 0x89, ...modEbpW(1, 0x90));

    a.put("mov dword [ebp+0x94], 0", 0xC7, ...modEbpW(0, 0x94), ...a.u32(0));
    a.put("xor ecx, ecx", 0x31, 0xC9);
    a.put("jecxz +6", 0xE3, 0x06);                                      // taken
    a.put("inc dword [ebp+0x94]", 0xFF, ...modEbpW(0, 0x94));           // skipped
    a.put("mov ecx, 1", 0xB9, ...a.u32(1));
    a.put("jecxz +6", 0xE3, 0x06);                                      // not taken
    a.put("inc dword [ebp+0x94]", 0xFF, ...modEbpW(0, 0x94));           // executed

    return { bytes: Uint8Array.from(a.b), lines: a.lines };
}

/**
 * Decode the finished body with the COMPILER'S OWN decoder and refuse anything that is not a
 * complete, in-slice decode landing exactly on the assembler's own instruction boundaries.
 * Without this the case could silently contain a byte sequence the slice bails on, and a unit
 * that exits early still produces correct memory — a test that cannot fail.
 */
export async function selfCheck(bytes, lines, addr) {
    const { decodeOne } = await import("../../aot/lib/decode.mjs");
    const bounds = new Set(lines.map((l) => l.off));
    let off = 0, n = 0;
    while (off < bytes.length) {
        if (!bounds.has(off)) throw new Error(`k6: decode desynchronised at +0x${off.toString(16)}`);
        const ins = decodeOne(bytes, off, addr + off);
        if (ins.kind === "unsupported") {
            throw new Error(`k6: "${lines.find((l) => l.off === off).text}" is outside the slice (${ins.why})`);
        }
        const declared = lines.find((l) => l.off === off).bytes;
        if (ins.len !== declared) {
            throw new Error(`k6: length mismatch at +0x${off.toString(16)}: decoded ${ins.len}, assembled ${declared}`);
        }
        off += ins.len; n++;
    }
    if (n !== lines.length) throw new Error(`k6: decoded ${n} instructions, assembled ${lines.length}`);
    return { instructions: n, bytes: bytes.length };
}
