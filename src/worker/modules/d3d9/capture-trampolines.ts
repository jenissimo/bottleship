// Guest-side WBUF-ring trampoline emitters for high-volume D3D9 setter/draw paths:
// value-shadow skip, owner-disarm scalar, struct-capture and DrawPrimitiveUP capture.
// Codegen primitives are module-agnostic; registrations are the D3D9 device wave.
// Byte layout pinned by tools/tests/thunk-stub-emitters.test.ts.
// Caller: thunk-dispatcher's register*WriteBufferFunction family, passing
// ThunkMemoryManager.stubAllocator.

import { Logger, LogCategory } from '../../core/logger';
import type { StubAllocator } from '../../core/thunking/thunk-memory-manager';

/**
 * Describes a high-volume, idempotent stdcall setter that a module wants to short-circuit in
 * guest code via {@link writeShadowTrampoline}. Module-agnostic: the module
 * supplies the arg layout and the slot-folding rule; core only emits codegen from it.
 */
export interface ShadowTrampolineSpec {
    /** Total stdcall args (e.g. 3 for SetRenderState this/State/Value). */
    argCount: number;
    /** 0-based stdcall-arg index of the value to compare/shadow (e.g. 2 = Value). */
    valueArgIndex: number;
    /** Shadow table size (entries); must cover every reachable folded slot index. */
    slotCount: number;
    /**
     * Key args folded into the shadow slot: `slot = OR( (arg[argIndex] < max ? arg : →ring) << shift )`.
     * Each part is range-guarded to `< max` (out-of-range falls back to the ring-write path).
     * e.g. SetRenderState: [{argIndex:1, shift:0, max:256}];
     *      SetSamplerState: [{argIndex:1, shift:4, max:16}, {argIndex:2, shift:0, max:16}].
     */
    keyParts: Array<{ argIndex: number; shift: number; max: number }>;
}

/**
 * GENERIC guest-side value-shadow trampoline emitter. Given a {@link ShadowTrampolineSpec},
 * emits an x86 trampoline that compares an incoming "value" argument against a per-owner
 * shadow table in guest RAM and RETs immediately (EAX = 0) on a match — no WBUF ring entry,
 * no JS drain, no downstream work. On a real change it updates the shadow and falls through
 * to the SAME ring-write as the generic WBUF trampoline (writeWriteBufTrampolines).
 *
 * This is a pure codegen primitive — it knows nothing about D3D9 (or any module). Callers
 * (a module registering its own high-volume idempotent setters) supply the arg layout, the
 * Value-arg index, and how to fold the key args into a shadow slot. The classic instance is a
 * COM `this`-keyed render/sampler state setter, but nothing here is graphics-specific.
 *
 * Coherence invariant the caller must uphold (the only way to behave wrong): the shadow must
 * NEVER report equality when the real state differs. The shadow starts at a SENTINEL so the
 * first set of every slot passes through; the caller re-seeds/invalidates it on any external
 * state reset. The single-owner fast path (lastOwnerGlobal) routes any other/unknown owner
 * straight to the ring-write (no shadow), keeping it generic and safe for multi-owner cases.
 *
 * On entry the setter's OUT-trap stub prologue has already run `mov eax, funcId`, so
 * EAX = funcId and the stdcall args are on the stack at [ESP+4..]. The caller points the
 * setter's stub JMP at the returned `trampAddr` (in place of the generic trampoline) when
 * enabled, and restores the generic target to disable (pure A/B). The returned code region
 * should be registered non-preemptible (the shadow cmp/mov RMW must not interleave a quantum
 * switch), mirroring the heap/getc inline stubs.
 *
 * @param lastOwnerGlobal guest-RAM addr of a shared u32 holding the "active owner" pointer
 *        (e.g. the bound COM device `this`); the caller owns/seeds it. Args matched against it
 *        come from stdcall arg 0. Pass 0 to disable the owner gate (always shadow).
 */
export function writeShadowTrampoline(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    ctrlAddr: number,
    dataBase: number,
    capacity: number,
    lastOwnerGlobal: number,
    spec: ShadowTrampolineSpec,
): {
    trampAddr: number; shadowBase: number; slotCount: number; sentinel: number;
    skipCounterAddr: number;
    dataRegionBase: number; dataRegionEnd: number;
    codeRegionBase: number; codeRegionEnd: number;
} {
    const SENTINEL = 0x80000000; // "never set" marker; caller overwrites with seeded defaults
    const { argCount, valueArgIndex, slotCount, keyParts } = spec;

    // --- shadow table in guest RAM (THUNK_DATA, rw): [+0]=u32 skip counter, [+4..]=slots ---
    // The skip is invisible to JS by design (the trampoline RETs in guest code), so the
    // trampoline bumps this counter on each skip — the only direct A/B signal of the win.
    const DATA_SIZE = 4 + slotCount * 4;
    const dataRegionBase = allocator.alloc(DATA_SIZE, 'THUNK_DATA', 'rw');
    const skipCounterAddr = dataRegionBase;
    const shadowBase = dataRegionBase + 4;
    {
        const m = getMemory();
        const d = new DataView(m.buffer, m.byteOffset, m.byteLength);
        d.setUint32(skipCounterAddr, 0, true);
        for (let i = 0; i < slotCount; i++) d.setUint32(shadowBase + i * 4, SENTINEL, true);
    }

    // --- code region (THUNK_CODE, rx) ---
    const CODE_SIZE = 256;
    const codeRegionBase = allocator.alloc(CODE_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = codeRegionBase;
    const w8 = (v: number) => { mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };
    // cmp r/m32 (EDX or ECX) against an unsigned bound — imm8 form when it fits.
    const cmpEdxImm = (m: number) => { if (m <= 0x7F) { w8(0x83); w8(0xFA); w8(m); } else { w8(0x81); w8(0xFA); w32(m); } };
    const cmpEcxImm = (m: number) => { if (m <= 0x7F) { w8(0x83); w8(0xF9); w8(m); } else { w8(0x81); w8(0xF9); w32(m); } };
    const capacityLimit = capacity - 36;
    const stride = (argCount + 1) * 4;
    const retPop = argCount * 4;
    // After 4 pushes (flags/edx/ebx/ecx) + retAddr, stdcall args are at [ESP+20 + i*4].
    const argDisp = (i: number) => 20 + i * 4;
    const valueDisp = argDisp(valueArgIndex);

    const trampStart = off;
    const ringPatch: number[] = []; // rel32 sites → .ringwrite (owner mismatch / out-of-range)

    // pushfd; push edx; push ebx; push ecx
    w8(0x9C); w8(0x52); w8(0x53); w8(0x51);

    // Owner gate: mov ebx,[esp+20] (arg0); cmp ebx,[lastOwnerGlobal]; jne .ringwrite
    if (lastOwnerGlobal !== 0) {
        w8(0x8B); w8(0x5C); w8(0x24); w8(argDisp(0));
        w8(0x3B); w8(0x1D); w32(lastOwnerGlobal);
        w8(0x0F); w8(0x85); ringPatch.push(off); w32(0);
    }

    // Compute shadow slot into EDX = OR over keyParts of (arg[part] range-guarded) << shift.
    // A spec with no key parts is a SINGLE-slot shadow (the whole setter is one piece of
    // state, e.g. SetVertexShader): EDX must still be zeroed — it holds the caller's value
    // at this point, and the compare below indexes the table with it.
    if (keyParts.length === 0) { w8(0x31); w8(0xD2); }  // xor edx, edx
    for (let pi = 0; pi < keyParts.length; pi++) {
        const part = keyParts[pi];
        if (pi === 0) {
            // mov edx, [esp+disp]
            w8(0x8B); w8(0x54); w8(0x24); w8(argDisp(part.argIndex));
            cmpEdxImm(part.max);
            // jae .ringwrite
            w8(0x0F); w8(0x83); ringPatch.push(off); w32(0);
            if (part.shift) { w8(0xC1); w8(0xE2); w8(part.shift); } // shl edx, shift
        } else {
            // mov ecx, [esp+disp]
            w8(0x8B); w8(0x4C); w8(0x24); w8(argDisp(part.argIndex));
            cmpEcxImm(part.max);
            // jae .ringwrite
            w8(0x0F); w8(0x83); ringPatch.push(off); w32(0);
            if (part.shift) { w8(0xC1); w8(0xE1); w8(part.shift); } // shl ecx, shift
            w8(0x09); w8(0xCA);                                     // or edx, ecx
        }
    }

    // mov ecx,[esp+valueDisp]; mov ebx,shadowBase; cmp [ebx+edx*4],ecx; je .skip; mov [ebx+edx*4],ecx
    w8(0x8B); w8(0x4C); w8(0x24); w8(valueDisp);
    w8(0xBB); w32(shadowBase);
    w8(0x39); w8(0x0C); w8(0x93);
    w8(0x0F); w8(0x84); const skipPatch = off; w32(0);
    w8(0x89); w8(0x0C); w8(0x93);

    // .ringwrite: (identical to the generic scalar trampoline; EAX still = funcId)
    const ringAddr = off;
    w8(0x8B); w8(0x15); w32(ctrlAddr);                 // mov edx, [ctrlAddr]
    w8(0x81); w8(0xFA); w32(capacityLimit);            // cmp edx, capacityLimit
    w8(0x0F); w8(0x8D); const ovfPatch = off; w32(0);  // jge .overflow
    w8(0xBB); w32(dataBase);                           // mov ebx, dataBase
    w8(0x03); w8(0xDA);                                // add ebx, edx
    w8(0x89); w8(0x03);                                // mov [ebx], eax (funcId)
    for (let i = 0; i < argCount; i++) {
        w8(0x8B); w8(0x44); w8(0x24); w8(argDisp(i));  // mov eax, [esp+20+i*4]
        w8(0x89); w8(0x43); w8((i + 1) * 4);           // mov [ebx+(i+1)*4], eax
    }
    w8(0x83); w8(0x05); w32(ctrlAddr); w8(stride);     // add dword [ctrlAddr], stride

    // .tail: pop ecx; pop ebx; pop edx; mov edx,0xB077; xor eax,eax; popfd; ret retPop
    w8(0x59); w8(0x5B); w8(0x5A);
    w8(0xBA); w32(0xB077);
    w8(0x31); w8(0xC0);
    w8(0x9D);
    w8(0xC2); w8(retPop & 0xFF); w8((retPop >> 8) & 0xFF);

    // .skip: inc [skipCounter]; pop ecx; pop ebx; pop edx; xor eax,eax; popfd; ret retPop
    // (inc dirties EFLAGS, but the following popfd restores the caller's flags.)
    const skipAddr = off;
    w8(0xFF); w8(0x05); w32(skipCounterAddr);  // inc dword [skipCounterAddr]
    w8(0x59); w8(0x5B); w8(0x5A);
    w8(0x31); w8(0xC0);
    w8(0x9D);
    w8(0xC2); w8(retPop & 0xFF); w8((retPop >> 8) & 0xFF);

    // .overflow: pop ecx; pop ebx; pop edx; popfd; mov edx,0xB077; out dx,eax; ret retPop
    const ovfAddr = off;
    w8(0x59); w8(0x5B); w8(0x5A);
    w8(0x9D);
    w8(0xBA); w32(0xB077);
    w8(0xEF);
    w8(0xC2); w8(retPop & 0xFF); w8((retPop >> 8) & 0xFF);

    for (const p of ringPatch) dv.setInt32(p, ringAddr - (p + 4), true);
    dv.setInt32(skipPatch, skipAddr - (skipPatch + 4), true);
    dv.setInt32(ovfPatch, ovfAddr - (ovfPatch + 4), true);

    Logger.log(LogCategory.SYSTEM,
        `Shadow trampoline emitted: 0x${trampStart.toString(16)} ` +
        `(argCount=${argCount} valueArg=${valueArgIndex} slots=${slotCount} shadow@0x${shadowBase.toString(16)})`);

    return {
        trampAddr: trampStart, shadowBase, slotCount, sentinel: SENTINEL,
        skipCounterAddr,
        dataRegionBase, dataRegionEnd: dataRegionBase + DATA_SIZE,
        codeRegionBase, codeRegionEnd: codeRegionBase + CODE_SIZE,
    };
}

/**
 * GENERIC guest-side INC-AND-RETURN trampoline for a COM AddRef whose refcount lives in the
 * object itself (`this[fieldOffset]`), the layout real COM uses. The whole method becomes
 * `inc [this+off]; mov eax,[this+off]; ret 4` in guest code — no OUT trap, no JS at all —
 * which is the point: a trivial crossing costs microseconds and this one is 40% of every
 * WASM exit an in-game D3D9 title makes.
 *
 * VALIDITY. `this` is only trusted when its vptr still equals the dword at
 * `expectVtableAddr` (the module publishes the interface's installed vtable address there,
 * and 0 while none is published, which routes everything to the OUT trap). That is what
 * keeps a stale pointer from silently incrementing a recycled block: a block recycled into
 * a DIFFERENT interface no longer carries this vtable, and a poisoned one carries the
 * released-COM trap's. A block recycled into the SAME interface is not a new hazard — the
 * JS handler's address-keyed registry increments the new object there too — and a freed
 * block not yet recycled takes a write that allocateComObject's zero-fill erases.
 *
 * VERIFY MODE (`predictAddr !== 0`) mutates NOTHING: it computes the value the real stub
 * WOULD have returned, stores it at `predictAddr` (with a validity byte at `predictAddr+4`),
 * and falls through to the OUT trap so the JS handler still does the work and can compare.
 * That runs both paths on every real call, which is the only honest evidence.
 */
export function writeIncRefStubTrampoline(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    spec: {
        fieldOffset: number;
        popBytes: number;
        expectVtableAddr: number;
        /** 0 = live stub; non-zero = non-mutating oracle writing its prediction here. */
        predictAddr?: number;
    },
): { trampAddr: number; codeRegionBase: number; codeRegionEnd: number } {
    const { fieldOffset, popBytes, expectVtableAddr } = spec;
    const predictAddr = spec.predictAddr ?? 0;
    if (fieldOffset < 0 || fieldOffset > 0x7f) {
        throw new Error(`writeIncRefStubTrampoline: fieldOffset ${fieldOffset} needs a disp8`);
    }
    const CODE_SIZE = 96;
    const codeRegionBase = allocator.alloc(CODE_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = codeRegionBase;
    const w8 = (v: number) => { mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };
    const outPatch: number[] = [];

    const trampAddr = off;
    // pushfd; push ecx; push edx — 3 pushes + retAddr, so `this` sits at [esp+16].
    w8(0x9C); w8(0x51); w8(0x52);
    if (predictAddr) {
        w8(0xC6); w8(0x05); w32(predictAddr + 4); w8(0x00);   // mov byte [predict+4], 0
    }
    w8(0x8B); w8(0x4C); w8(0x24); w8(16);                     // mov ecx, [esp+16]
    w8(0x85); w8(0xC9);                                       // test ecx, ecx
    w8(0x0F); w8(0x84); outPatch.push(off); w32(0);           // jz .out
    w8(0x8B); w8(0x11);                                       // mov edx, [ecx]
    w8(0x3B); w8(0x15); w32(expectVtableAddr);                // cmp edx, [expectVtableAddr]
    w8(0x0F); w8(0x85); outPatch.push(off); w32(0);           // jne .out
    if (predictAddr) {
        w8(0x8B); w8(0x51); w8(fieldOffset);                  // mov edx, [ecx+off]
        w8(0x42);                                             // inc edx
        w8(0x89); w8(0x15); w32(predictAddr);                 // mov [predict], edx
        w8(0xC6); w8(0x05); w32(predictAddr + 4); w8(0x01);   // mov byte [predict+4], 1
        // fall through to .out — the JS handler stays the one that mutates.
    } else {
        w8(0xFF); w8(0x41); w8(fieldOffset);                  // inc dword [ecx+off]
        w8(0x8B); w8(0x41); w8(fieldOffset);                  // mov eax, [ecx+off]
        w8(0x5A); w8(0x59); w8(0x9D);                         // pop edx; pop ecx; popfd
        w8(0xC2); w8(popBytes & 0xFF); w8((popBytes >> 8) & 0xFF);
    }

    const outAddr = off;                                      // .out: original OUT-trap tail
    w8(0x5A); w8(0x59); w8(0x9D);                             // pop edx; pop ecx; popfd
    w8(0xBA); w32(0xB077);                                    // mov edx, 0xB077
    w8(0xEF);                                                 // out dx, eax  (EAX = funcId)
    w8(0xC2); w8(popBytes & 0xFF); w8((popBytes >> 8) & 0xFF);
    for (const p of outPatch) dv.setInt32(p, outAddr - (p + 4), true);

    if (off > codeRegionBase + CODE_SIZE) throw new Error('writeIncRefStubTrampoline: code overflow');
    Logger.log(LogCategory.SYSTEM,
        `IncRef stub trampoline: 0x${trampAddr.toString(16)} (field=+${fieldOffset} ret ${popBytes}` +
        `${predictAddr ? ` VERIFY predict@0x${predictAddr.toString(16)}` : ''})`);
    return { trampAddr, codeRegionBase, codeRegionEnd: codeRegionBase + CODE_SIZE };
}

/**
 * GENERIC guest-side DEC-AND-RETURN trampoline for a COM Release whose refcount lives in the
 * object itself (`this[fieldOffset]`) — the Release counterpart of
 * {@link writeIncRefStubTrampoline}, and the other half of the same 40 %-of-all-WASM-exits pair.
 *
 * THE ZERO TRANSITION MUST REACH JS: at 1→0 the JS handler runs the finalizer and the disposer.
 * So the body TESTS BEFORE IT DECREMENTS — `cmp edx,1; jbe .out` — and falls through to the
 * ordinary OUT trap with the count UNTOUCHED whenever it is 1 or less. The alternative
 * (decrement, then decide to trap) would need JS to know the guest already decremented: a
 * second contract, invisible at the trap, that turns any route reaching the handler another way
 * into a double decrement. Testing first has no such secret, and it is `jbe` rather than `je`
 * so a count that is already 0 — a block freed but still carrying this vtable — traps instead
 * of wrapping to 0xFFFFFFFF.
 *
 * It also preserves, for free, the ordering the WBUF ring depends on: destruction still happens
 * at an OUT trap, and handlePortWrite drains the ring before dispatching one, so anything the
 * ring has buffered against the object is applied before the object dies.
 *
 * VALIDITY: identical gate to the inc-ref stub — `this` is touched only while its vptr equals
 * the dword at `expectVtableAddr` (0 while none is published ⇒ everything traps).
 *
 * VERIFY MODE (`predictAddr !== 0`) mutates NOTHING and always traps. It publishes
 * `[predictAddr] = value` and a CODE byte at `predictAddr+4`:
 *   0 — no prediction (null `this`, or the vtable gate refused)
 *   1 — the live stub would have answered `value` in guest code (count-1)
 *   2 — the live stub would have DECLINED and let JS run; `value` is the count it read.
 * Code 2 is the whole point: it is how the oracle gets to check the zero transition, which is
 * the one place a wrong answer destroys a live object.
 */
export function writeDecRefStubTrampoline(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    spec: {
        fieldOffset: number;
        popBytes: number;
        expectVtableAddr: number;
        /** 0 = live stub; non-zero = non-mutating oracle writing its prediction here. */
        predictAddr?: number;
    },
): { trampAddr: number; codeRegionBase: number; codeRegionEnd: number } {
    const { fieldOffset, popBytes, expectVtableAddr } = spec;
    const predictAddr = spec.predictAddr ?? 0;
    if (fieldOffset < 0 || fieldOffset > 0x7f) {
        throw new Error(`writeDecRefStubTrampoline: fieldOffset ${fieldOffset} needs a disp8`);
    }
    const CODE_SIZE = 96;
    const codeRegionBase = allocator.alloc(CODE_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = codeRegionBase;
    const w8 = (v: number) => { mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };
    const outPatch: number[] = [];

    const trampAddr = off;
    // pushfd; push ecx; push edx — 3 pushes + retAddr, so `this` sits at [esp+16].
    w8(0x9C); w8(0x51); w8(0x52);
    if (predictAddr) {
        w8(0xC6); w8(0x05); w32(predictAddr + 4); w8(0x00);   // mov byte [predict+4], 0
    }
    w8(0x8B); w8(0x4C); w8(0x24); w8(16);                     // mov ecx, [esp+16]
    w8(0x85); w8(0xC9);                                       // test ecx, ecx
    w8(0x0F); w8(0x84); outPatch.push(off); w32(0);           // jz .out
    w8(0x8B); w8(0x11);                                       // mov edx, [ecx]
    w8(0x3B); w8(0x15); w32(expectVtableAddr);                // cmp edx, [expectVtableAddr]
    w8(0x0F); w8(0x85); outPatch.push(off); w32(0);           // jne .out
    w8(0x8B); w8(0x51); w8(fieldOffset);                      // mov edx, [ecx+off]
    if (predictAddr) {
        w8(0x89); w8(0x15); w32(predictAddr);                 // mov [predict], edx (the raw count)
        w8(0x83); w8(0xFA); w8(0x01);                         // cmp edx, 1
        w8(0x76); const declineRel8 = off; w8(0);             // jbe .decline
        w8(0x4A);                                             // dec edx
        w8(0x89); w8(0x15); w32(predictAddr);                 // mov [predict], edx (guest answer)
        w8(0xC6); w8(0x05); w32(predictAddr + 4); w8(0x01);   // mov byte [predict+4], 1
        w8(0xEB); const skipDecline = off; w8(0);             // jmp .out
        mem[declineRel8] = off - (declineRel8 + 1);           // .decline:
        w8(0xC6); w8(0x05); w32(predictAddr + 4); w8(0x02);   // mov byte [predict+4], 2
        mem[skipDecline] = off - (skipDecline + 1);
        // fall through to .out — the JS handler stays the one that mutates.
    } else {
        w8(0x83); w8(0xFA); w8(0x01);                         // cmp edx, 1
        w8(0x0F); w8(0x86); outPatch.push(off); w32(0);       // jbe .out  (the 1→0, and a bogus 0)
        w8(0xFF); w8(0x49); w8(fieldOffset);                  // dec dword [ecx+off]
        w8(0x8B); w8(0x41); w8(fieldOffset);                  // mov eax, [ecx+off]
        w8(0x5A); w8(0x59); w8(0x9D);                         // pop edx; pop ecx; popfd
        w8(0xC2); w8(popBytes & 0xFF); w8((popBytes >> 8) & 0xFF);
    }

    const outAddr = off;                                      // .out: original OUT-trap tail
    w8(0x5A); w8(0x59); w8(0x9D);                             // pop edx; pop ecx; popfd
    w8(0xBA); w32(0xB077);                                    // mov edx, 0xB077
    w8(0xEF);                                                 // out dx, eax  (EAX = funcId)
    w8(0xC2); w8(popBytes & 0xFF); w8((popBytes >> 8) & 0xFF);
    for (const p of outPatch) dv.setInt32(p, outAddr - (p + 4), true);

    if (off > codeRegionBase + CODE_SIZE) throw new Error('writeDecRefStubTrampoline: code overflow');
    Logger.log(LogCategory.SYSTEM,
        `DecRef stub trampoline: 0x${trampAddr.toString(16)} (field=+${fieldOffset} ret ${popBytes}` +
        `${predictAddr ? ` VERIFY predict@0x${predictAddr.toString(16)}` : ''})`);
    return { trampAddr, codeRegionBase, codeRegionEnd: codeRegionBase + CODE_SIZE };
}

/**
 * GENERIC scalar WBUF trampoline that additionally DISARMS the setter-shadow owner gate
 * (one `mov dword [ownerGlobal], 0`) before writing its ring entry. For ring-deferred
 * operations that WRITE state the shadow tables mirror (the canonical case: D3D9
 * IDirect3DStateBlock9_Apply): with the owner zeroed, every subsequent shadowed setter
 * takes its owner-mismatch path straight to the ring (correct program order, no
 * stale-shadow skip) until the operation's DRAIN handler re-arms the owner
 * (dispatcher.setShadowOwner) after syncing the shadows. The overflow path falls back
 * to the OUT trap — the operation then runs synchronously at the trap (drain-first),
 * so no disarm is needed there and none is emitted on that path.
 *
 * Same entry contract as writeWriteBufTrampolines (EAX = funcId, stdcall args at
 * [ESP+4..]); scalar args only.
 */
export function writeOwnerDisarmScalarTrampoline(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    ctrlAddr: number,
    dataBase: number,
    capacity: number,
    argCount: number,
    ownerGlobalAddr: number,
): { trampAddr: number; codeRegionBase: number; codeRegionEnd: number } {
    const CODE_SIZE = 128;
    const codeRegionBase = allocator.alloc(CODE_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = codeRegionBase;
    const w8 = (v: number) => { mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };
    const capacityLimit = capacity - 36;
    const bytesToPop = argCount * 4;

    const trampAddr = off;
    // pushfd; push edx; push ebx
    w8(0x9C); w8(0x52); w8(0x53);
    // mov edx, [ctrlAddr]; cmp edx, capacityLimit; jge .overflow
    w8(0x8B); w8(0x15); w32(ctrlAddr);
    w8(0x81); w8(0xFA); w32(capacityLimit);
    w8(0x0F); w8(0x8D); const jgePatchOff = off; w32(0);
    // mov dword [ownerGlobalAddr], 0 — disarm shadow skipping until drain re-arms
    w8(0xC7); w8(0x05); w32(ownerGlobalAddr); w32(0);
    // mov ebx, dataBase; add ebx, edx; mov [ebx], eax (funcId)
    w8(0xBB); w32(dataBase);
    w8(0x03); w8(0xDA);
    w8(0x89); w8(0x03);
    for (let i = 0; i < argCount; i++) {
        // mov eax, [esp + 16 + i*4]; mov [ebx + (i+1)*4], eax
        w8(0x8B); w8(0x44); w8(0x24); w8(16 + i * 4);
        w8(0x89); w8(0x43); w8((i + 1) * 4);
    }
    // add dword [ctrlAddr], stride
    w8(0x83); w8(0x05); w32(ctrlAddr); w8((argCount + 1) * 4);
    // pop ebx; pop edx; mov edx,0xB077; xor eax,eax; popfd; ret N
    w8(0x5B); w8(0x5A);
    w8(0xBA); w32(0xB077);
    w8(0x31); w8(0xC0);
    w8(0x9D);
    w8(0xC2); w8(bytesToPop & 0xFF); w8((bytesToPop >> 8) & 0xFF);
    // .overflow: pop ebx; pop edx; popfd; mov edx,0xB077; out dx,eax; ret N
    const overflowAddr = off;
    w8(0x5B); w8(0x5A);
    w8(0x9D);
    w8(0xBA); w32(0xB077);
    w8(0xEF);
    w8(0xC2); w8(bytesToPop & 0xFF); w8((bytesToPop >> 8) & 0xFF);
    dv.setInt32(jgePatchOff, overflowAddr - (jgePatchOff + 4), true);

    Logger.log(LogCategory.SYSTEM,
        `Owner-disarm WBUF trampoline emitted: 0x${trampAddr.toString(16)} ` +
        `(argCount=${argCount} owner@0x${ownerGlobalAddr.toString(16)})`);
    return { trampAddr, codeRegionBase, codeRegionEnd: codeRegionBase + CODE_SIZE };
}

/**
 * GENERIC capture-at-call WBUF trampoline for a stdcall function with one pointer-to-struct
 * argument of a FIXED byte size (SetTransform/SetMaterial/SetLight/SetViewport/SetClipPlane
 * class). Ring entry layout: [funcId][all scalar args verbatim, incl. the raw ptr slot]
 * [payloadDwords copied inline from *ptr] — so the drain-side stride is the standard
 * (argCountTable+1)*4 with argCountTable = argCount + payloadDwords, and the drain handler
 * reads the payload from the RING (guest RAM) instead of dereferencing the (possibly reused)
 * guest pointer. Null/out-of-RAM pointers and ring-full fall back to the OUT trap (the
 * FastPath handler stays registered and validates as before).
 *
 * The returned code region must be scheduler-registered non-preemptible by the caller (the
 * head read→bump RMW plus rep movsd must not interleave a quantum switch — same rule as the
 * shadow/heap stubs; the fixed trampoline block is covered by the parked-thread head-reset
 * deferral instead, which does not know about dynamically allocated regions).
 */
export function writeStructCaptureTrampoline(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    ctrlAddr: number,
    dataBase: number,
    capacity: number,
    spec: { argCount: number; ptrArgIndex: number; payloadDwords: number },
): { trampAddr: number; codeRegionBase: number; codeRegionEnd: number } {
    const { argCount, ptrArgIndex, payloadDwords } = spec;
    if (argCount < 1 || argCount > 8 || ptrArgIndex < 0 || ptrArgIndex >= argCount || payloadDwords < 1 || payloadDwords > 64) {
        throw new Error(`writeStructCaptureTrampoline: bad spec ${JSON.stringify(spec)}`);
    }
    const CODE_SIZE = 224;
    const codeRegionBase = allocator.alloc(CODE_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = codeRegionBase;
    const w8 = (v: number) => { mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };

    const strideBytes = (1 + argCount + payloadDwords) * 4;
    const payloadBytes = payloadDwords * 4;
    const retPop = argCount * 4;
    // 6 pushes (flags,edx,ebx,ecx,esi,edi) + retAddr → stdcall arg i at [esp+28+4i].
    const argDisp = (i: number) => 28 + i * 4;
    const ramLimit = mem.length >>> 0;
    const ovfPatch: number[] = [];

    const trampStart = off;
    w8(0x9C); w8(0x52); w8(0x53); w8(0x51); w8(0x56); w8(0x57); // pushfd; push edx,ebx,ecx,esi,edi
    w8(0x89); w8(0xC7);                                          // mov edi, eax (funcId)
    w8(0x8B); w8(0x74); w8(0x24); w8(argDisp(ptrArgIndex));      // mov esi, [esp+ptrDisp]
    w8(0x85); w8(0xF6);                                          // test esi, esi
    w8(0x0F); w8(0x84); ovfPatch.push(off); w32(0);              // jz .ovf
    w8(0x81); w8(0xFE); w32(ramLimit - payloadBytes);            // cmp esi, ramLimit-payload
    w8(0x0F); w8(0x87); ovfPatch.push(off); w32(0);              // ja .ovf
    w8(0x8B); w8(0x15); w32(ctrlAddr);                           // mov edx, [ctrlAddr]
    w8(0x81); w8(0xFA); w32(capacity - strideBytes);             // cmp edx, capacity-stride
    w8(0x0F); w8(0x8D); ovfPatch.push(off); w32(0);              // jge .ovf
    w8(0xBB); w32(dataBase);                                     // mov ebx, dataBase
    w8(0x03); w8(0xDA);                                          // add ebx, edx
    w8(0x89); w8(0x3B);                                          // mov [ebx], edi (funcId)
    for (let i = 0; i < argCount; i++) {
        w8(0x8B); w8(0x44); w8(0x24); w8(argDisp(i));            // mov eax, [esp+disp]
        w8(0x89); w8(0x43); w8((i + 1) * 4);                     // mov [ebx+(i+1)*4], eax
    }
    w8(0x8D); w8(0x7B); w8((1 + argCount) * 4);                  // lea edi, [ebx+(1+argCount)*4]
    w8(0xB9); w32(payloadDwords);                                // mov ecx, payloadDwords
    w8(0xF3); w8(0xA5);                                          // rep movsd
    w8(0x81); w8(0x05); w32(ctrlAddr); w32(strideBytes);         // add dword [ctrlAddr], stride
    w8(0x5F); w8(0x5E); w8(0x59); w8(0x5B); w8(0x5A);            // pop edi,esi,ecx,ebx,edx
    w8(0xBA); w32(0xB077);                                       // mov edx, 0xB077
    w8(0x31); w8(0xC0);                                          // xor eax, eax
    w8(0x9D);                                                    // popfd
    w8(0xC2); w8(retPop & 0xFF); w8((retPop >> 8) & 0xFF);       // ret retPop

    const ovfAddr = off;                                         // .ovf: OUT-trap fallback
    w8(0x89); w8(0xF8);                                          // mov eax, edi (funcId)
    w8(0x5F); w8(0x5E); w8(0x59); w8(0x5B); w8(0x5A);
    w8(0x9D);                                                    // popfd
    w8(0xBA); w32(0xB077);
    w8(0xEF);                                                    // out dx, eax
    w8(0xC2); w8(retPop & 0xFF); w8((retPop >> 8) & 0xFF);
    for (const p of ovfPatch) dv.setInt32(p, ovfAddr - (p + 4), true);

    if (off > codeRegionBase + CODE_SIZE) throw new Error('writeStructCaptureTrampoline: code overflow');
    Logger.log(LogCategory.SYSTEM,
        `StructCapture trampoline: 0x${trampStart.toString(16)} (args=${argCount} ptrIdx=${ptrArgIndex} payload=${payloadDwords}dw stride=${strideBytes})`);
    return { trampAddr: trampStart, codeRegionBase, codeRegionEnd: codeRegionBase + CODE_SIZE };
}

/**
 * Capture-at-call WBUF trampoline for IDirect3DDevice9_DrawPrimitiveUP
 * (this, PrimitiveType, PrimitiveCount, pVertexStreamZeroData, VertexStreamZeroStride).
 * Computes vertexCount from (PrimitiveType, PrimitiveCount) in x86, copies
 * vertexCount×stride bytes inline into the ring. Ring entry (variable stride):
 * [funcId][this][primType][primCount][stride][byteCount][payload…] — drain stride is
 * 24 + byteCount (see WBUF_ARG_UP_DRAW in the dispatcher). Falls back to the OUT trap on:
 * unknown primType, primCount=0, stride 0/unaligned/>512, byteCount>64KiB, null/OOB
 * pointer, or ring-full. Register the code region non-preemptible (same rule as above).
 */
export function writeUpDrawCaptureTrampoline(
    allocator: StubAllocator,
    getMemory: () => Uint8Array,
    ctrlAddr: number,
    dataBase: number,
    capacity: number,
): { trampAddr: number; codeRegionBase: number; codeRegionEnd: number } {
    const CODE_SIZE = 384;
    const codeRegionBase = allocator.alloc(CODE_SIZE, 'THUNK_CODE', 'rx');
    const mem = getMemory();
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    let off = codeRegionBase;
    const w8 = (v: number) => { mem[off++] = v & 0xFF; };
    const w32 = (v: number) => { dv.setUint32(off, v >>> 0, true); off += 4; };
    const ramLimit = mem.length >>> 0;
    const ovfPatch: number[] = [];
    const havePatch: number[] = []; // rel8 sites → .have
    // 6 pushes + retAddr: this@28, primType@32, primCount@36, pData@40, stride@44.

    const trampStart = off;
    w8(0x9C); w8(0x52); w8(0x53); w8(0x51); w8(0x56); w8(0x57);
    w8(0x89); w8(0xC7);                                     // mov edi, eax (funcId)
    w8(0x8B); w8(0x44); w8(0x24); w8(32);                   // mov eax, [esp+32] primType
    w8(0x8B); w8(0x4C); w8(0x24); w8(36);                   // mov ecx, [esp+36] primCount
    w8(0x85); w8(0xC9);                                     // test ecx, ecx
    w8(0x0F); w8(0x84); ovfPatch.push(off); w32(0);         // jz .ovf
    // vertexCount by primType: 4→*3, 5/6→+2, 3→+1, 2→*2, else .ovf
    w8(0x83); w8(0xF8); w8(4); w8(0x75); w8(0x05);          // cmp eax,4; jne +5
    w8(0x8D); w8(0x0C); w8(0x49);                           //   lea ecx,[ecx+ecx*2]
    w8(0xEB); havePatch.push(off); w8(0);                   //   jmp .have
    w8(0x83); w8(0xF8); w8(5);                              // cmp eax,5
    const je5 = off + 1; w8(0x74); w8(0);                   // je .plus2
    w8(0x83); w8(0xF8); w8(6);                              // cmp eax,6
    const je6 = off + 1; w8(0x74); w8(0);                   // je .plus2
    w8(0x83); w8(0xF8); w8(3); w8(0x75); w8(0x03);          // cmp eax,3; jne +3
    w8(0x41);                                               //   inc ecx
    w8(0xEB); havePatch.push(off); w8(0);                   //   jmp .have
    w8(0x83); w8(0xF8); w8(2);                              // cmp eax,2
    w8(0x0F); w8(0x85); ovfPatch.push(off); w32(0);         // jne .ovf
    w8(0xD1); w8(0xE1);                                     // shl ecx,1
    w8(0xEB); havePatch.push(off); w8(0);                   // jmp .have
    const plus2Addr = off;                                  // .plus2:
    mem[je5] = plus2Addr - (je5 + 1);
    mem[je6] = plus2Addr - (je6 + 1);
    w8(0x83); w8(0xC1); w8(2);                              // add ecx,2
    const haveAddr = off;                                   // .have:
    for (const p of havePatch) mem[p] = haveAddr - (p + 1);
    w8(0x8B); w8(0x44); w8(0x24); w8(44);                   // mov eax, [esp+44] stride
    w8(0x85); w8(0xC0);                                     // test eax, eax
    w8(0x0F); w8(0x84); ovfPatch.push(off); w32(0);         // jz .ovf
    w8(0xA8); w8(0x03);                                     // test al, 3 (dword-multiple only)
    w8(0x0F); w8(0x85); ovfPatch.push(off); w32(0);         // jnz .ovf
    w8(0x3D); w32(512);                                     // cmp eax, 512
    w8(0x0F); w8(0x87); ovfPatch.push(off); w32(0);         // ja .ovf
    w8(0x0F); w8(0xAF); w8(0xC8);                           // imul ecx, eax → byteCount
    w8(0x81); w8(0xF9); w32(65536);                         // cmp ecx, 64KiB
    w8(0x0F); w8(0x87); ovfPatch.push(off); w32(0);         // ja .ovf
    w8(0x8B); w8(0x74); w8(0x24); w8(40);                   // mov esi, [esp+40] pData
    w8(0x85); w8(0xF6);                                     // test esi, esi
    w8(0x0F); w8(0x84); ovfPatch.push(off); w32(0);         // jz .ovf
    w8(0x81); w8(0xFE); w32(ramLimit);                      // cmp esi, ramLimit (kills lea wrap)
    w8(0x0F); w8(0x83); ovfPatch.push(off); w32(0);         // jae .ovf
    w8(0x8D); w8(0x04); w8(0x0E);                           // lea eax, [esi+ecx] (end)
    w8(0x3D); w32(ramLimit);                                // cmp eax, ramLimit
    w8(0x0F); w8(0x87); ovfPatch.push(off); w32(0);         // ja .ovf
    w8(0x8B); w8(0x15); w32(ctrlAddr);                      // mov edx, [ctrlAddr]
    w8(0x8D); w8(0x44); w8(0x0A); w8(24);                   // lea eax, [edx+ecx+24]
    w8(0x3D); w32(capacity);                                // cmp eax, capacity
    w8(0x0F); w8(0x87); ovfPatch.push(off); w32(0);         // ja .ovf
    w8(0xBB); w32(dataBase);                                // mov ebx, dataBase
    w8(0x03); w8(0xDA);                                     // add ebx, edx
    w8(0x89); w8(0x3B);                                     // mov [ebx], edi (funcId)
    w8(0x8B); w8(0x44); w8(0x24); w8(28); w8(0x89); w8(0x43); w8(4);   // this
    w8(0x8B); w8(0x44); w8(0x24); w8(32); w8(0x89); w8(0x43); w8(8);   // primType
    w8(0x8B); w8(0x44); w8(0x24); w8(36); w8(0x89); w8(0x43); w8(12);  // primCount
    w8(0x8B); w8(0x44); w8(0x24); w8(44); w8(0x89); w8(0x43); w8(16);  // stride
    w8(0x89); w8(0x4B); w8(20);                             // mov [ebx+20], ecx (byteCount)
    w8(0x8D); w8(0x7B); w8(24);                             // lea edi, [ebx+24]
    w8(0xC1); w8(0xE9); w8(2);                              // shr ecx, 2
    w8(0xF3); w8(0xA5);                                     // rep movsd
    w8(0x8B); w8(0x43); w8(20);                             // mov eax, [ebx+20]
    w8(0x83); w8(0xC0); w8(24);                             // add eax, 24
    w8(0x01); w8(0x05); w32(ctrlAddr);                      // add [ctrlAddr], eax
    w8(0x5F); w8(0x5E); w8(0x59); w8(0x5B); w8(0x5A);       // pops
    w8(0xBA); w32(0xB077);
    w8(0x31); w8(0xC0);                                     // xor eax, eax
    w8(0x9D);                                               // popfd
    w8(0xC2); w8(20); w8(0);                                // ret 20

    const ovfAddr = off;                                    // .ovf: OUT-trap fallback
    w8(0x89); w8(0xF8);                                     // mov eax, edi
    w8(0x5F); w8(0x5E); w8(0x59); w8(0x5B); w8(0x5A);
    w8(0x9D);
    w8(0xBA); w32(0xB077);
    w8(0xEF);
    w8(0xC2); w8(20); w8(0);
    for (const p of ovfPatch) dv.setInt32(p, ovfAddr - (p + 4), true);

    if (off > codeRegionBase + CODE_SIZE) throw new Error('writeUpDrawCaptureTrampoline: code overflow');
    Logger.log(LogCategory.SYSTEM, `UpDrawCapture trampoline: 0x${trampStart.toString(16)}`);
    return { trampAddr: trampStart, codeRegionBase, codeRegionEnd: codeRegionBase + CODE_SIZE };
}
