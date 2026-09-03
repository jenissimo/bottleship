/**
 * EAGL token-dispatch guest filter — PURE assembler, dependency-free so the
 * byte layout is unit-testable (tools/tests/eagl-token-dispatch.test.ts)
 * without worker singletons. Instruction-level commentary and the config
 * block contract live in ./token-dispatch.ts; the emitted shape is:
 *
 *   cmp byte [cfg+CFG_ENABLED_FLAG], 0 ; jz .orig      — armed gate
 *   mov edx, [esp+4] ; test edx, edx ; jz .orig        — node
 *   mov eax, [edx] ; cmp eax, -1 ; jne .cls
 *   mov edx, [edx+0x64] ; mov eax, [edx]               — alias node
 * .cls:
 *   imul eax, eax, 0x1c
 *   mov eax, [eax + tokenTable]                        — descriptor u32
 *   rol eax, 8                                         — AL = class, eax>>8 = enum
 *   cmp al,8 ; je .samp  ; cmp al,1 ; je .srs          — TIER 0 candidates first:
 *                                                        class 8 is 46.6% of tokens
 *   cmp al,2 ; je .hyp
 *   cmp al,6 ; jne .orig                               — class-6 batch path:
 *   cmp dword [ecx+0x84], 2 ; jne .hyp                 — record mode (2) must
 *                                                        run the original
 *                                                        (BeginStateBlock)
 * .orig: jmp trampoline                                — original, native
 * .hyp:  jmp stub                                      — OUT → handler 132
 * .srs/.samp: TIER 0 — see below
 *
 * The class is read through AL after a `rol`, not through a scratch register, so the
 * dispatch spills nothing on the ~80% of tokens that are classes 1/2/8. The rotate leaves
 * the enum in the high bits, so each Tier-0 body recovers it with one `shr` and no mask.
 *
 * ECX = `this` (EAGL device ctx) — thiscall, untouched by the filter; the
 * [ecx+0x84] commit-mode load has the same #PF surface as the original's own
 * unchecked ctx dereferences.
 *
 * TIER 0 — THE REDUNDANT SET, ANSWERED WITHOUT A BOUNDARY CROSSING.
 * 73.9% of the EAGL tokens a frame dispatches are redundant state sets: the
 * value already equals the shadow, so handler 132 compares, bumps a counter and
 * returns D3D_OK. That answer costs an OUT trap plus the handler prologue —
 * ~15.9K crossings a frame doing no work. `.srs` (class 1, SetRenderState) and
 * `.samp` (class 8, SetSamplerState) replicate that compare IN GUEST CODE and
 * `ret 8` with EAX = 0, so the redundant set never leaves the guest at all.
 *
 * The predicate is the one in hypercall_eagl.rs `eagl_dispatch_simple`, in the
 * SAME ORDER and with the same declines, because the oracle below depends on
 * the two answering identically:
 *   slot   — class 1: enum, valid < 256; class 8: (stage<<4)|enum, both < 16,
 *            with the original's `stage == -1 → rawNode[1]` fallback.
 *   value  — n[0x1a] (the ALIAS-resolved node, as the handler reads it).
 *   fid    — [*dev + vtOff] must be our WBUF setter stub (`B8 <funcId>`) and
 *            the funcId must be the armed one, non-zero.
 *   ring   — head must be in range; the handler declines otherwise and the JS
 *            tier completes the call after a drain. Skipping writes nothing to
 *            the ring, so this gate buys no safety — it is here so that
 *            "the guest skipped" and "the handler would have skipped" are the
 *            SAME predicate and the oracle can demand exact equality.
 *   owner  — the shadow only describes the currently bound device.
 *   shadow — shadowBase must exist and [shadowBase + slot*4] == value.
 *
 * ORACLE (cfg skipMode = 2): the filter evaluates the whole predicate and bumps
 * its counter, then falls to .hyp anyway. Handler 132 then makes its own
 * decision, so `filterSkipSrs + filterSkipSamp` over a window must equal the
 * handler's own skip delta exactly. A wrong offset, a wrong fold or a missing
 * gate shows up as an inequality instead of as a state set that silently never
 * reached the device.
 *
 * REGISTER DISCIPLINE. EAX/EDX are caller-saved and dead at function entry;
 * ECX (`this`) is never written. EBX/ESI are callee-saved and are pushed ONLY inside a
 * Tier-0 body, after its last decline that can still reach `.hyp` with an untouched stack;
 * every exit below that point restores both. The only RMW is `inc dword [counter]`; the
 * window around it is reported as {@link FilterCode.commitRanges} for the caller to register
 * non-preemptible, so a quantum switch cannot lose a count.
 */

/** Offsets inside the config block that the FILTER reads. Must match the
 *  CFG_* constants in token-dispatch.ts. Everything at 0x54 and above is
 *  guest-filter–private: hypercall_eagl.rs reads 0x00..0x50 only. */
export const FILTER_ENABLED_FLAG_OFF = 0x34;
/** u8: 0 = Tier 0 off (classes 1/8 always cross), 1 = live, 2 = oracle. */
export const FILTER_SKIP_MODE_OFF = 0x35;
export const FILTER_CFG_RING_CTRL = 0x08;
export const FILTER_CFG_OWNER_GLOBAL = 0x14;
export const FILTER_CFG_SRS_FID = 0x18;
export const FILTER_CFG_SRS_SHADOW = 0x1c;
export const FILTER_CFG_SAMP_FID = 0x24;
export const FILTER_CFG_SAMP_SHADOW = 0x28;
/** u32: ring capacity - 36, precomputed so the guest gate is one compare. */
export const FILTER_CFG_RING_LIMIT = 0x54;
/** u32 counters, incremented BY THE GUEST (live and oracle alike). */
export const FILTER_CFG_SKIP_SRS = 0x58;
export const FILTER_CFG_SKIP_SAMP = 0x5c;

/** Device vtable offsets of the two shadowed setters (IDirect3DDevice9). */
const VT_SET_RENDER_STATE = 0xe4;
const VT_SET_SAMPLER_STATE = 0x114;

/** stdcall RET imm16 for the hooked `dispatch(node, stage)`. */
const RET_POP = 8;

type Label = 'orig' | 'hyp' | 'hypPop2';

export interface FilterCode {
    /** The assembled filter body. */
    code: Uint8Array;
    /**
     * Half-open [start, end) ABSOLUTE guest ranges covering the non-atomic
     * counter increments. Register non-preemptible; nothing else in the filter
     * holds state across an instruction.
     */
    commitRanges: Array<{ start: number; end: number }>;
}

export function assembleTokenDispatchFilter(
    filterAddr: number,
    cfgBase: number,
    tokenTable: number,
    stubAddress: number,
    trampolineAddress: number,
): FilterCode {
    const code: number[] = [];
    const rel32Patches: Array<{ at: number; label: Label }> = [];
    const commitRanges: Array<{ start: number; end: number }> = [];
    const labels = {} as Record<Label, number>;

    const emit = (...bytes: number[]) => { code.push(...bytes); };
    const emitU32 = (v: number) => {
        code.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    };
    /** Jcc rel32 to a label; `opcode2` is the 0F-prefixed condition byte. */
    const jcc = (opcode2: number, label: Label) => {
        emit(0x0f, opcode2);
        rel32Patches.push({ at: code.length, label });
        emitU32(0);
    };
    const mark = (label: Label) => { labels[label] = code.length; };
    const cfg = (off: number) => (cfgBase + off) >>> 0;
    // The two Tier-0 bodies are emitted after the exits, so their targets are not
    // known when the class dispatch branches to them.
    const tier0Patches: Array<{ at: number; body: 'srs' | 'samp' }> = [];
    const jccTier0 = (opcode2: number, body: 'srs' | 'samp') => {
        emit(0x0f, opcode2);
        tier0Patches.push({ at: code.length, body });
        emitU32(0);
    };

    // ── prologue: armed gate, node, alias resolution, descriptor ────────────
    emit(0x80, 0x3d); emitU32(cfg(FILTER_ENABLED_FLAG_OFF)); emit(0x00); // cmp byte [flag],0
    jcc(0x84, 'orig');                                                   // jz .orig
    emit(0x8b, 0x54, 0x24, 0x04);                                        // mov edx,[esp+4]
    emit(0x85, 0xd2);                                                    // test edx,edx
    jcc(0x84, 'orig');                                                   // jz .orig
    emit(0x8b, 0x02);                                                    // mov eax,[edx]
    emit(0x83, 0xf8, 0xff);                                              // cmp eax,-1
    emit(0x75, 0x05);                                                    // jne .cls (+5)
    emit(0x8b, 0x52, 0x64);                                              // mov edx,[edx+0x64]
    emit(0x8b, 0x02);                                                    // mov eax,[edx]
    // .cls:  EAX = token, EDX = resolved node
    emit(0x6b, 0xc0, 0x1c);                                              // imul eax,eax,0x1c
    emit(0x8b, 0x80); emitU32(tokenTable);                               // mov eax,[eax+tbl]

    // ── class dispatch. The descriptor STAYS in EAX (Tier 0 needs the enum), so the
    //    class is read through AL after a rotate rather than through a callee-saved
    //    scratch the whole token stream would pay to save. Class 8 is tested first:
    //    it is 46.6% of the tokens a frame carries.
    emit(0xc1, 0xc0, 0x08);                                              // rol eax,8
    emit(0x3c, 0x08);                                                    // cmp al,8
    jccTier0(0x84, 'samp');                                              // je .samp
    emit(0x3c, 0x01);                                                    // cmp al,1
    jccTier0(0x84, 'srs');                                               // je .srs
    emit(0x3c, 0x02);                                                    // cmp al,2
    jcc(0x84, 'hyp');                                                    // je .hyp
    emit(0x3c, 0x06);                                                    // cmp al,6
    jcc(0x85, 'orig');                                                   // jne .orig
    emit(0x83, 0xb9, 0x84, 0x00, 0x00, 0x00, 0x02);                      // cmp dword [ecx+0x84],2
    jcc(0x85, 'hyp');                                                    // jne .hyp (mode 2 -> .orig)

    // ── exits ───────────────────────────────────────────────────────────────
    mark('orig');
    const origJmpOff = code.length; emit(0xe9, 0, 0, 0, 0);              // jmp trampoline
    mark('hyp');
    const hypJmpOff = code.length; emit(0xe9, 0, 0, 0, 0);               // jmp stub

    // ── Tier 0 bodies ───────────────────────────────────────────────────────
    /**
     * Shared tail: EAX = folded slot, EDX = value, ECX = this, EBX+ESI pushed.
     * Declines jump to .hypPop2 (restores both, then the stub).
     */
    const emitTier0Tail = (
        vtOff: number, fidOff: number, shadowOff: number, counterOff: number,
    ) => {
        emit(0x8b, 0x71, 0x08);                                          // mov esi,[ecx+8]   dev
        emit(0x8b, 0x1e);                                                // mov ebx,[esi]     vtable
        emit(0x8b, 0x9b); emitU32(vtOff);                                // mov ebx,[ebx+vtOff]
        emit(0x80, 0x3b, 0xb8);                                          // cmp byte [ebx],0xB8
        jcc(0x85, 'hypPop2');                                            // jne .hypPop2
        emit(0x8b, 0x5b, 0x01);                                          // mov ebx,[ebx+1]   funcId
        emit(0x3b, 0x1d); emitU32(cfg(fidOff));                          // cmp ebx,[cfg+fid]
        jcc(0x85, 'hypPop2');                                            // jne .hypPop2
        emit(0x85, 0xdb);                                                // test ebx,ebx
        jcc(0x84, 'hypPop2');                                            // jz  .hypPop2  (fid == 0)
        emit(0x8b, 0x1d); emitU32(cfg(FILTER_CFG_RING_CTRL));            // mov ebx,[cfg+ringCtrl]
        emit(0x8b, 0x1b);                                                // mov ebx,[ebx]     head
        emit(0x85, 0xdb);                                                // test ebx,ebx
        jcc(0x88, 'hypPop2');                                            // js  .hypPop2  (head < 0)
        emit(0x3b, 0x1d); emitU32(cfg(FILTER_CFG_RING_LIMIT));           // cmp ebx,[cfg+ringLimit]
        jcc(0x8d, 'hypPop2');                                            // jge .hypPop2
        emit(0x8b, 0x1d); emitU32(cfg(FILTER_CFG_OWNER_GLOBAL));         // mov ebx,[cfg+ownerGlobal]
        emit(0x85, 0xdb);                                                // test ebx,ebx
        jcc(0x84, 'hypPop2');                                            // jz  .hypPop2
        emit(0x3b, 0x33);                                                // cmp esi,[ebx]     owner==dev
        jcc(0x85, 'hypPop2');                                            // jne .hypPop2
        emit(0x8b, 0x1d); emitU32(cfg(shadowOff));                       // mov ebx,[cfg+shadow]
        emit(0x85, 0xdb);                                                // test ebx,ebx
        jcc(0x84, 'hypPop2');                                            // jz  .hypPop2
        emit(0x39, 0x14, 0x83);                                          // cmp [ebx+eax*4],edx
        jcc(0x85, 'hypPop2');                                            // jne .hypPop2
        // Redundant set. The counter and the mode read are one window: a
        // preemption between them would drop a count on a shared cell.
        const commitStart = code.length;
        emit(0xff, 0x05); emitU32(cfg(counterOff));                      // inc dword [cfg+ctr]
        const commitEnd = code.length;
        commitRanges.push({ start: commitStart, end: commitEnd });
        emit(0x80, 0x3d); emitU32(cfg(FILTER_SKIP_MODE_OFF)); emit(0x02); // cmp byte [mode],2
        jcc(0x84, 'hypPop2');                                            // je .hypPop2 (oracle)
        emit(0x5e);                                                      // pop esi
        emit(0x5b);                                                      // pop ebx
        emit(0x31, 0xc0);                                                // xor eax,eax
        emit(0xc2, RET_POP & 0xff, (RET_POP >>> 8) & 0xff);              // ret 8
    };

    // .srs — class 1, SetRenderState: slot = enum, valid below 256.
    const srsOff = code.length;
    emit(0x80, 0x3d); emitU32(cfg(FILTER_SKIP_MODE_OFF)); emit(0x01);    // cmp byte [mode],1
    jcc(0x82, 'hyp');                                                    // jb .hyp (mode 0)
    emit(0xc1, 0xe8, 0x08);                                              // shr eax,8  -> enum
    emit(0x3d); emitU32(0x100);                                          // cmp eax,0x100
    jcc(0x83, 'hyp');                                                    // jae .hyp
    emit(0x8b, 0x52, 0x68);                                              // mov edx,[edx+0x68] value
    emit(0x53);                                                          // push ebx
    emit(0x56);                                                          // push esi
    emitTier0Tail(VT_SET_RENDER_STATE, FILTER_CFG_SRS_FID,
        FILTER_CFG_SRS_SHADOW, FILTER_CFG_SKIP_SRS);

    // .samp — class 8, SetSamplerState: slot = (stage<<4)|enum, both below 16.
    // After `push ebx; push esi` the original args sit at [esp+12] / [esp+16].
    const sampOff = code.length;
    emit(0x80, 0x3d); emitU32(cfg(FILTER_SKIP_MODE_OFF)); emit(0x01);    // cmp byte [mode],1
    jcc(0x82, 'hyp');                                                    // jb .hyp (mode 0)
    emit(0xc1, 0xe8, 0x08);                                              // shr eax,8  -> enum
    emit(0x3d); emitU32(0x10);                                           // cmp eax,16
    jcc(0x83, 'hyp');                                                    // jae .hyp
    emit(0x8b, 0x52, 0x68);                                              // mov edx,[edx+0x68] value
    emit(0x53);                                                          // push ebx
    emit(0x56);                                                          // push esi
    emit(0x8b, 0x74, 0x24, 0x10);                                        // mov esi,[esp+16]  stage
    emit(0x83, 0xfe, 0xff);                                              // cmp esi,-1
    emit(0x75, 0x07);                                                    // jne .haveStage (+7)
    emit(0x8b, 0x74, 0x24, 0x0c);                                        // mov esi,[esp+12]  raw node
    emit(0x8b, 0x76, 0x04);                                              // mov esi,[esi+4]
    // .haveStage:
    emit(0x83, 0xfe, 0x10);                                              // cmp esi,16
    jcc(0x83, 'hypPop2');                                                // jae .hypPop2
    emit(0xc1, 0xe6, 0x04);                                              // shl esi,4
    emit(0x09, 0xf0);                                                    // or eax,esi
    emitTier0Tail(VT_SET_SAMPLER_STATE, FILTER_CFG_SAMP_FID,
        FILTER_CFG_SAMP_SHADOW, FILTER_CFG_SKIP_SAMP);

    // .hypPop2 — the Tier-0 decline exit (both callee-saved regs restored).
    mark('hypPop2');
    emit(0x5e);                                                          // pop esi
    emit(0x5b);                                                          // pop ebx
    const hyp2JmpOff = code.length; emit(0xe9, 0, 0, 0, 0);              // jmp stub

    // ── relocation ──────────────────────────────────────────────────────────
    const patchRel32 = (at: number, targetOff: number) => {
        const rel = (targetOff - (at + 4)) | 0;
        code[at] = rel & 0xff; code[at + 1] = (rel >>> 8) & 0xff;
        code[at + 2] = (rel >>> 16) & 0xff; code[at + 3] = (rel >>> 24) & 0xff;
    };
    for (const p of rel32Patches) patchRel32(p.at, labels[p.label]);
    for (const p of tier0Patches) patchRel32(p.at, p.body === 'srs' ? srsOff : sampOff);
    const patchJmpAbs = (at: number, target: number) => {
        const rel = (target - (filterAddr + at + 5)) | 0;
        code[at + 1] = rel & 0xff; code[at + 2] = (rel >>> 8) & 0xff;
        code[at + 3] = (rel >>> 16) & 0xff; code[at + 4] = (rel >>> 24) & 0xff;
    };
    patchJmpAbs(origJmpOff, trampolineAddress);
    patchJmpAbs(hypJmpOff, stubAddress);
    patchJmpAbs(hyp2JmpOff, stubAddress);

    return {
        code: Uint8Array.from(code),
        commitRanges: commitRanges.map(r => ({
            start: filterAddr + r.start, end: filterAddr + r.end,
        })),
    };
}

/** Byte length of the assembled filter (address-independent). */
export function tokenDispatchFilterSize(): number {
    return assembleTokenDispatchFilter(0x1000, 0, 0, 0x2000, 0x3000).code.length;
}
