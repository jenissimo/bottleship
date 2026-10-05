/**
 * EAGL→D3D9 state-token dispatcher hook.
 *
 * Target: NFSU retail `FUN_005c97cb` — the per-token commit switch that
 * translates an EAGL token node into IDirect3DDevice9 calls. In-race at max
 * settings the dispatcher's pages are 22.5% of ALL guest execution and the hook
 * removes 81% of that (measured, plan/experiments/e18 — an earlier "36.9%" in
 * this header was a share of watched hot pages, not of execution). Token-class census:
 * class 8 SetSamplerState 46.6%, class 1 SetRenderState 31.8%, class 2
 * SetTextureStageState 1.9% — the three pure-state-set classes = 80.4% of all
 * dispatches.
 *
 * Architecture (four tiers, faithful at each):
 *   0. TIER 0 — inside the guest filter, no boundary crossing at all. 73.9% of
 *      the tokens a frame dispatches are REDUNDANT sets whose whole answer is
 *      "the shadow already holds this value, return D3D_OK". The filter now
 *      evaluates that predicate itself (token-dispatch-filter.ts) and RETs, so
 *      ~15.9K crossings a frame stop existing rather than getting cheaper.
 *      Its predicate is `eagl_dispatch_simple`'s, gate for gate and in order,
 *      because cfg skipMode 2 turns it into an oracle: the filter predicts, the
 *      handler decides, and `eaglTokenCounts` demands the two agree exactly.
 *      Consequence to read counters by: a class-1/8 skip taken here no longer
 *      bumps the SHADOW trampoline's srsSkip/sampSkip — it lands in the cfg's
 *      own Tier-0 cells instead, which is what `filterSkip` reports.
 *   1. GUEST FILTER (built by buildTokenDispatchFilter, installed as the
 *      patch-JMP target): resolves the token exactly like the original
 *      prologue (param==-1 alias at node[0x19]) and classifies via the token
 *      descriptor table. Classes {1,2,8} and class 6 outside record mode
 *      ([ecx+0x84] != 2) → the OUT stub; everything else → the
 *      relocated-prologue trampoline = the ORIGINAL function at native
 *      speed. Also gated on a guest-RAM "enabled" flag so every call runs
 *      the original until the D3D9 WBUF ring + setter shadows exist.
 *   2. WASM handler 132 (cpu/hypercall_eagl.rs handle_eagl_token_dispatch):
 *      classes 1/2/8 single-pass — the same virtual call the guest would
 *      make, short-circuiting the KNOWN callee shape (our WBUF setter stub +
 *      value-shadow trampoline): shadow compare/skip/update + ring append.
 *      Class 6 = the BATCH boundary (one crossing per shader token):
 *      SetFVF / direct constant-F uploads / vs-ps bind + default-constant
 *      walk + type-3 sub-pass recursion, scan-then-commit. Declines (false)
 *      on anything off-script (mode 2, int/bool constants, classes
 *      3/4/5/7/9/10 inside a batch, bounds).
 *   3. JS fall-through (tokenDispatchHandler below): classes 1/2/8 — same
 *      replication in JS for the rare declines (ring near-full — which the
 *      pre-dispatch drain has just resolved — transient unmapped reads).
 *      Class 6 — no re-implementation: complete THIS call via the sync
 *      original (expected rare, counted). First
 *      STRUCTURAL doubt (vtable not pointing at our setter stub) unpatches
 *      the hook and completes via the sync original — fail-safe to 100%
 *      guest behavior.
 *
 * Faithfulness inventory of the classes-1/2/8 case bodies (RE, `re decompile`):
 *   entry:  stage==-1 → stage = node[1] (RAW node, pre-alias);
 *           node[0]==-1 → node = node[0x19]
 *   desc  = tokenTable[token*0x1c].u32[0]; class = desc>>24; enum = desc&0xffffff
 *   value = node[0x1a]
 *   dev   = *(this+8); call [*dev + 0xe4|0x10c|0x114](dev, [stage,] enum, value)
 *   return 0 (the trampolines return 0; negative-HRESULT handling is
 *   unreachable on these paths)
 */

import { Logger, LogCategory } from '../../../logger';
import { writeGuestCode } from '../../../memory/guest-code';
import { Mem } from '../../../memory/mem-accessor';
import { System } from '../../../system';
import { hypercallDataManager } from '../../../cpu/hypercall-data';
import { libHleManager, recordHleHit } from '../../lib-hle-manager';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';
import type { EntryFilterInfo } from '../../types';
import {
    FILTER_ENABLED_FLAG_OFF,
    FILTER_SKIP_MODE_OFF,
    FILTER_CFG_RING_LIMIT,
    FILTER_CFG_SKIP_SRS,
    FILTER_CFG_SKIP_SAMP,
    assembleTokenDispatchFilter,
    tokenDispatchFilterSize,
} from './token-dispatch-filter';

const LIB_ID = 'eagl';
const FN_NAME = 'state_token_dispatch';

// Byte offsets inside the ORIGINAL function body (RE-verified, NFSU retail):
// the `mov ecx,[eax+tokenTable]` (8B 88 disp32) sits at entry+0x4D; its disp32
// (the token descriptor table base) at entry+0x4F. Both survive the 5-byte
// entry patch. Verified against the byte-exact detection pattern anyway.
const TOKEN_TABLE_MOV_OFF = 0x4d;
const TOKEN_TABLE_DISP_OFF = 0x4f;

// Config block layout — MUST match hypercall_eagl.rs handle_eagl_token_dispatch.
const CFG_SIZE = 0x84;
const CFG_VERSION_VALUE = 3; // cfg block layout version (must match the Rust handler)
const CFG_VERSION = 0x00;
const CFG_TOKEN_TABLE = 0x04;
const CFG_RING_CTRL = 0x08;
const CFG_RING_DATA = 0x0c;
const CFG_RING_CAP = 0x10;
const CFG_OWNER_GLOBAL = 0x14;
const CFG_SRS_FID = 0x18;
const CFG_SRS_SHADOW = 0x1c;
const CFG_SRS_SKIP = 0x20;
const CFG_SAMP_FID = 0x24;
const CFG_SAMP_SHADOW = 0x28;
const CFG_SAMP_SKIP = 0x2c;
const CFG_TSS_FID = 0x30;
const CFG_ENABLED_FLAG = FILTER_ENABLED_FLAG_OFF; // guest-filter gate byte (not read by Rust)
const CFG_GENERATION = 0x38; // bumped on every arm — the WASM handler's config-cache key
const CFG_FVF_FID = 0x3c;
const CFG_SVS_FID = 0x40;
const CFG_SPS_FID = 0x44;
const CFG_VSCF_FID = 0x48;
const CFG_PSCF_FID = 0x4c;
const CFG_TEX_FID = 0x50;
// Guest-filter–private cells. hypercall_eagl.rs reads 0x00..0x50 only, so these
// need no cfg version bump — the Rust handler cannot see them.
const CFG_RING_LIMIT = FILTER_CFG_RING_LIMIT;   // ring capacity - 36
const CFG_SKIP_SRS = FILTER_CFG_SKIP_SRS;       // guest Tier-0 skip counters
const CFG_SKIP_SAMP = FILTER_CFG_SKIP_SAMP;
const CFG_SKIP_MODE = FILTER_SKIP_MODE_OFF;     // 0 off, 1 live, 2 oracle

/**
 * Tier 0 — the guest filter answers a redundant state set without crossing the
 * boundary. Default ON: it is the same predicate handler 132 already evaluates,
 * one tier earlier. `__eaglNoFilterSkip` is the A/B arm; `__eaglFilterSkipOracle`
 * makes the filter predict and still cross, so its counters can be compared with
 * the handler's own skip delta (see eaglTokenCounts).
 */
interface FilterSkipFlags {
    __eaglNoFilterSkip?: boolean;
    __eaglFilterSkipOracle?: boolean;
}
function filterSkipMode(): number {
    const f = globalThis as FilterSkipFlags;
    if (f.__eaglFilterSkipOracle) return 2;
    return f.__eaglNoFilterSkip ? 0 : 1;
}

const SETTERS = {
    srs: ['d3d9', 'IDirect3DDevice9_SetRenderState'] as const,
    samp: ['d3d9', 'IDirect3DDevice9_SetSamplerState'] as const,
    tss: ['d3d9', 'IDirect3DDevice9_SetTextureStageState'] as const,
    fvf: ['d3d9', 'IDirect3DDevice9_SetFVF'] as const,
    svs: ['d3d9', 'IDirect3DDevice9_SetVertexShader'] as const,
    sps: ['d3d9', 'IDirect3DDevice9_SetPixelShader'] as const,
    vscf: ['d3d9', 'IDirect3DDevice9_SetVertexShaderConstantF'] as const,
    pscf: ['d3d9', 'IDirect3DDevice9_SetPixelShaderConstantF'] as const,
    tex: ['d3d9', 'IDirect3DDevice9_SetTexture'] as const,
};

// Module state (one hooked binary at a time; reset via onActivated re-entry).
let cfgAddr = 0;
let tokenTableBase = 0;
let armed = false;
let armPollTimer: ReturnType<typeof setInterval> | null = null;
let cfgGeneration = 0;
let structuralBailDone = false;
let class6Declines = 0;
// Decline attribution: desc → count (capped), plus last-seen mode. Cheap
// enough to keep always-on; read via getTokenDispatchStats.
const class6DeclineByDesc = new Map<number, number>();
let class6DeclineLastMode = -1;
let class6DeclineProbe: Record<string, unknown> | null = null;

/** Allocate + zero the shared config block once (used by handler 132). */
function ensureCfg(dv: DataView): boolean {
    if (cfgAddr !== 0) return true;
    const memMgr = System.getInstance().process?.memory;
    if (!memMgr) {
        Logger.error(LogCategory.SYSTEM, '[HLE-eagl] no process memory for config block — refusing filter');
        return false;
    }
    cfgAddr = memMgr.alloc(CFG_SIZE) >>> 0;
    if (!cfgAddr) return false;
    for (let i = 0; i < CFG_SIZE; i += 4) dv.setUint32(cfgAddr + i, 0, true);
    armed = false;
    structuralBailDone = false;
    return true;
}

/**
 * Guest-side classifier codegen (HookedFunction.entryFilter). Emits:
 *
 *   cmp byte [cfg+0x34], 0 ; jz .orig       — armed gate
 *   mov edx, [esp+4] ; test edx,edx ; jz .orig
 *   mov eax, [edx] ; cmp eax,-1 ; jne .cls
 *   mov edx, [edx+0x64] ; mov eax, [edx]    — alias node (same #PF surface as
 *                                             the original's unchecked loads)
 * .cls:
 *   imul eax, eax, 0x1c
 *   mov eax, [eax + tokenTable]
 *   shr eax, 24
 *   cmp eax,1 ; je .hyp ; cmp eax,2 ; je .hyp ; cmp eax,8 ; je .hyp
 * .orig: jmp trampoline                      — original, native speed
 * .hyp:  jmp stub                            — OUT → WASM 132 / JS fallback
 *
 * EAX/EDX are caller-saved and dead at function entry; flags are callee-
 * clobberable at a call boundary. No stack writes, no RMW state → preemption-
 * safe without a non-preemptible registration.
 */
export function buildTokenDispatchFilter(info: EntryFilterInfo): number | null {
    const { mem, targetAddress, stubAddress, trampolineAddress } = info;

    // Extract the token descriptor table base from the original body, with an
    // opcode check so a layout drift refuses the hook instead of mis-reading.
    if (mem[targetAddress + TOKEN_TABLE_MOV_OFF] !== 0x8b ||
        mem[targetAddress + TOKEN_TABLE_MOV_OFF + 1] !== 0x88) {
        Logger.error(LogCategory.SYSTEM,
            `[HLE-eagl] token-dispatch: expected 8B 88 (mov ecx,[eax+disp32]) at +0x${TOKEN_TABLE_MOV_OFF.toString(16)}, ` +
            `found ${mem[targetAddress + TOKEN_TABLE_MOV_OFF]?.toString(16)} ${mem[targetAddress + TOKEN_TABLE_MOV_OFF + 1]?.toString(16)} — refusing filter`);
        return null;
    }
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    tokenTableBase = dv.getUint32(targetAddress + TOKEN_TABLE_DISP_OFF, true);

    // Config block in guest HEAP RAM (readable by the WASM handler via
    // safe_read32s). Zeroed: version stays 0 (Rust declines) and the enabled
    // bytes stay 0 (filters route everything to the original) until armed.
    if (!ensureCfg(dv)) return null;

    const size = tokenDispatchFilterSize();
    const filterAddr = info.allocCode(size);
    if (!filterAddr || filterAddr + size > mem.length) return null;
    const { code, commitRanges } = assembleTokenDispatchFilter(
        filterAddr, cfgAddr, tokenTableBase, stubAddress, trampolineAddress);
    writeGuestCode(mem, code, filterAddr);
    // The Tier-0 skip counters are non-atomic RMWs on cells shared by every
    // guest thread; only those two windows need the quantum held off.
    const scheduler = System.getInstance().scheduler;
    for (const r of commitRanges) {
        try { scheduler?.registerNonPreemptibleRange(r.start, r.end); } catch { /* non-fatal */ }
    }
    Logger.log(LogCategory.SYSTEM,
        `[HLE-eagl] token-dispatch filter @0x${filterAddr.toString(16)} (${code.length}B) ` +
        `tokenTable=0x${tokenTableBase.toString(16)} cfg=0x${cfgAddr.toString(16)} (disarmed until D3D9 WBUF ready)`);
    return filterAddr;
}

/**
 * Poll until the D3D9 WBUF ring + setter registrations exist, then fill the
 * config block, set the guest filter gate and publish the pointer to the
 * WASM handler. Boot-time only; the interval dies on success or game switch.
 */
export function armTokenDispatchWhenReady(): void {
    if (armPollTimer !== null) { clearInterval(armPollTimer); armPollTimer = null; }
    armed = false;
    // The guest filter gates on cfg RAM, not on `armed` — so a re-arm must close the
    // gate too, or the filter keeps routing dispatches into the WASM handler against
    // the PREVIOUS config (stale function ids, ring and shadow addresses) until the
    // poll happens to succeed. tryArm() re-opens it once the snapshot is valid again.
    if (cfgAddr !== 0) {
        Mem.writeUint8(cfgAddr + CFG_ENABLED_FLAG, 0);
        hypercallDataManager.setEaglTokenConfigPtr(0);
    }
    armPollTimer = setInterval(() => {
        if (cfgAddr === 0) { clearInterval(armPollTimer!); armPollTimer = null; return; }
        if (tryArm()) {
            clearInterval(armPollTimer!);
            armPollTimer = null;
        }
    }, 250);
}

function tryArm(): boolean {
    const d = libHleManager.dispatcher;
    if (!d) return false;
    const ring = d.getWbufRingInfo?.();
    if (!ring || !ring.ctrlAddr) return false;
    const stubs = {} as Record<keyof typeof SETTERS, { address: number; functionId: number }>;
    for (const key of Object.keys(SETTERS) as Array<keyof typeof SETTERS>) {
        const stub = d.getThunkStubInfo?.(SETTERS[key][0], SETTERS[key][1]);
        if (!stub) return false;
        // WBUF-patched stubs carry a JMP at +5 (0xE9); an un-patched stub
        // still OUTs directly — ring entries for it would never drain.
        // Wait for all 8 (they register together at device creation).
        if (Mem.readUint8(stub.address + 5) !== 0xe9) return false;
        stubs[key] = stub;
    }

    const srsShadow = d.getShadowTrampolineInfo?.(...SETTERS.srs);
    const sampShadow = d.getShadowTrampolineInfo?.(...SETTERS.samp);

    const w = (off: number, v: number) => Mem.writeUint32(cfgAddr + off, v >>> 0);
    w(CFG_TOKEN_TABLE, tokenTableBase);
    w(CFG_RING_CTRL, ring.ctrlAddr);
    w(CFG_RING_DATA, ring.dataBase);
    w(CFG_RING_CAP, ring.capacity);
    w(CFG_OWNER_GLOBAL, ring.ownerGlobalAddr);
    w(CFG_SRS_FID, stubs.srs.functionId);
    w(CFG_SRS_SHADOW, srsShadow?.shadowBase ?? 0);
    w(CFG_SRS_SKIP, srsShadow?.skipCounterAddr ?? 0);
    w(CFG_SAMP_FID, stubs.samp.functionId);
    w(CFG_SAMP_SHADOW, sampShadow?.shadowBase ?? 0);
    w(CFG_SAMP_SKIP, sampShadow?.skipCounterAddr ?? 0);
    w(CFG_TSS_FID, stubs.tss.functionId);
    w(CFG_FVF_FID, stubs.fvf.functionId);
    w(CFG_SVS_FID, stubs.svs.functionId);
    w(CFG_SPS_FID, stubs.sps.functionId);
    w(CFG_VSCF_FID, stubs.vscf.functionId);
    w(CFG_PSCF_FID, stubs.pscf.functionId);
    w(CFG_TEX_FID, stubs.tex.functionId);
    // Tier-0 cells. The ring gate is a compare against a precomputed limit so
    // the guest filter's decline predicate is bit-identical to the handler's
    // `head >= capacity - 36`.
    w(CFG_RING_LIMIT, (ring.capacity - 36) | 0);
    w(CFG_SKIP_SRS, 0);
    w(CFG_SKIP_SAMP, 0);
    w(CFG_GENERATION, ++cfgGeneration);
    w(CFG_VERSION, CFG_VERSION_VALUE);
    // Tier 0 needs BOTH shadows: without one, its class declines to the stub
    // and the mode byte only decides how loudly. Written before the gate so a
    // dispatch can never see an armed filter with a stale mode.
    Mem.writeUint8(cfgAddr + CFG_SKIP_MODE, filterSkipMode());
    Mem.writeUint8(cfgAddr + CFG_ENABLED_FLAG, 1); // guest filter gate
    hypercallDataManager.setEaglTokenConfigPtr(cfgAddr);
    armed = true;
    Logger.log(LogCategory.SYSTEM,
        `[HLE-eagl] token-dispatch ARMED (v${CFG_VERSION_VALUE}): cfg=0x${cfgAddr.toString(16)} ring=0x${ring.ctrlAddr.toString(16)} ` +
        `srs=${stubs.srs.functionId}${srsShadow ? '(shadowed)' : '(plain)'} samp=${stubs.samp.functionId}${sampShadow ? '(shadowed)' : '(plain)'} ` +
        `tss=${stubs.tss.functionId} fvf=${stubs.fvf.functionId} svs=${stubs.svs.functionId} sps=${stubs.sps.functionId} ` +
        `vscf=${stubs.vscf.functionId} pscf=${stubs.pscf.functionId}`);
    return true;
}

/** True while the WASM/JS fast path is armed (harness/dbg introspection). */
export function isTokenDispatchArmed(): boolean {
    return armed;
}

/** Decline/arm counters for harness/dbg introspection (gate: declines ≈ 0). */
export function getTokenDispatchStats(): Record<string, unknown> {
    const cfg: Record<string, number> = {};
    if (cfgAddr !== 0) {
        for (const [name, off] of Object.entries({
            version: CFG_VERSION, srsFid: CFG_SRS_FID, sampFid: CFG_SAMP_FID, tssFid: CFG_TSS_FID,
            fvfFid: CFG_FVF_FID, svsFid: CFG_SVS_FID, spsFid: CFG_SPS_FID,
            vscfFid: CFG_VSCF_FID, pscfFid: CFG_PSCF_FID, texFid: CFG_TEX_FID,
        })) cfg[name] = Mem.readUint32(cfgAddr + off) ?? -1;
    }
    const declineByDesc: Record<string, number> = {};
    for (const [d, n] of class6DeclineByDesc) declineByDesc['0x' + (d >>> 0).toString(16)] = n;
    return {
        armed, class6Declines, class6DeclineLastMode, declineByDesc, class6DeclineProbe, cfgAddr, cfg,
        filterSkip: getFilterSkipCounters(),
    };
}

/**
 * Tier-0 readout. `mode` is what the GUEST is running, read back from the cfg
 * cell rather than from the flag, so a filter armed before the flag changed
 * reports what it actually does.
 *
 * In oracle mode `srs + samp` must equal the handler's own skip delta over the
 * same window (harness `eaglTokenCounts`) — the filter predicted and crossed
 * anyway, so both tiers decided on the same calls. An inequality names a wrong
 * offset or a missing gate; equality with `srs + samp === 0` says the oracle
 * never ran, which is not the same as agreement.
 */
export function getFilterSkipCounters(): {
    mode: number; modeName: string; srs: number; samp: number; total: number;
} {
    const mode = cfgAddr !== 0 ? (Mem.readUint8(cfgAddr + CFG_SKIP_MODE) ?? 0) : 0;
    const srs = cfgAddr !== 0 ? (Mem.readUint32(cfgAddr + CFG_SKIP_SRS) ?? 0) : 0;
    const samp = cfgAddr !== 0 ? (Mem.readUint32(cfgAddr + CFG_SKIP_SAMP) ?? 0) : 0;
    return {
        mode,
        modeName: mode === 2 ? 'oracle' : mode === 1 ? 'live' : 'off',
        srs, samp, total: srs + samp,
    };
}

/** Zero the Tier-0 counters so a window is a difference, not a lifetime total. */
export function resetFilterSkipCounters(): void {
    if (cfgAddr === 0) return;
    Mem.writeUint32(cfgAddr + CFG_SKIP_SRS, 0);
    Mem.writeUint32(cfgAddr + CFG_SKIP_SAMP, 0);
}

/**
 * Re-publish the Tier-0 mode from the current flags without re-arming. The
 * filter reads the cell on every class-1/8 dispatch, so this is a live A/B
 * switch — unlike the stub patching in guest-release-stub.ts, which is
 * boot-time only.
 */
export function setFilterSkipMode(mode?: number): number {
    if (cfgAddr === 0) return -1;
    const m = mode === undefined ? filterSkipMode() : (mode | 0);
    if (m < 0 || m > 2) return -1;
    Mem.writeUint8(cfgAddr + CFG_SKIP_MODE, m);
    return m;
}
// Same worker-global pattern as hleStatus — reachable from dbg/harness eval.
(globalThis as any).eaglTokenDispatchStats = getTokenDispatchStats;
(globalThis as any).eaglFilterSkipCounters = getFilterSkipCounters;
(globalThis as any).eaglSetFilterSkipMode = setFilterSkipMode;
(globalThis as any).eaglResetFilterSkipCounters = resetFilterSkipCounters;


/**
 * JS fall-through for WASM-handler declines. Mirrors handle_eagl_token_dispatch
 * exactly; runs AFTER the dispatcher's pre-dispatch drainWriteBuffer(), so the
 * ring always has room here. Structural doubt → one-time bail: complete this
 * call via the sync original (thunk-region abort disabled — the original
 * legitimately executes our WBUF trampolines), then unpatch.
 */
export const tokenDispatchHandler: ThunkImplementation = (ctx, memory, args) => {
    recordHleHit(LIB_ID, FN_NAME);
    const node = args[0] >>> 0;
    let stage = args[1] | 0;
    const dv = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    const r32 = (a: number) => dv.getUint32(a >>> 0, true);

    const bail = (why: string): number => {
        if (!structuralBailDone) {
            structuralBailDone = true;
            Logger.error(LogCategory.SYSTEM, `[HLE-eagl] token-dispatch STRUCTURAL BAIL (${why}) — completing via sync original, then unpatching`);
            const res = libHleManager.callOriginalSync(LIB_ID, FN_NAME, [node, stage], 'stdcall', true);
            libHleManager.unpatch(LIB_ID, FN_NAME);
            Mem.writeUint8(cfgAddr + CFG_ENABLED_FLAG, 0);
            hypercallDataManager.setEaglTokenConfigPtr(0);
            armed = false;
            return res.ok ? res.eax : 0;
        }
        return 0;
    };

    try {
        if (!armed || cfgAddr === 0) return bail('not armed');
        if (stage === -1) stage = r32(node + 4) | 0;
        let n = node;
        let tok = r32(n) | 0;
        if (tok === -1) { n = r32(node + 0x64); tok = r32(n) | 0; }
        const desc = r32((tokenTableBase + tok * 0x1c) >>> 0);
        const cls = desc >>> 24;
        const d3dEnum = desc & 0xffffff;
        const value = r32(n + 0x68) | 0;
        const dev = r32((ctx.ecx + 8) >>> 0);
        const vt = r32(dev);

        let vtOff: number, fidOff: number, shadowOff: number, skipOff: number, slot: number, argc: number;
        if (cls === 1) {
            vtOff = 0xe4; fidOff = CFG_SRS_FID; shadowOff = CFG_SRS_SHADOW; skipOff = CFG_SRS_SKIP;
            slot = d3dEnum < 256 ? d3dEnum : -1; argc = 3;
        } else if (cls === 2) {
            vtOff = 0x10c; fidOff = CFG_TSS_FID; shadowOff = 0; skipOff = 0; slot = -1; argc = 4;
        } else if (cls === 8) {
            vtOff = 0x114; fidOff = CFG_SAMP_FID; shadowOff = CFG_SAMP_SHADOW; skipOff = CFG_SAMP_SKIP;
            slot = (stage >>> 0) < 16 && d3dEnum < 16 ? ((stage << 4) | d3dEnum) : -1; argc = 4;
        } else if (cls === 6) {
            // WASM batch-handler decline (record mode racing the filter,
            // int/bool constants, off-allowlist sub-token, bounds, ring
            // room). The contract is: the JS tier NEVER re-implements the
            // class-6 walk — it completes this one call via the sync
            // original, ring untouched by the WASM scan pass. Expected rare;
            // a hot decline stream here is a re-attribution signal, not a
            // correctness problem.
            class6Declines++;
            class6DeclineLastMode = r32((ctx.ecx + 0x84) >>> 0) | 0;
            if (class6DeclineByDesc.size < 64) {
                class6DeclineByDesc.set(desc, (class6DeclineByDesc.get(desc) ?? 0) + 1);
            }
            if (!class6DeclineProbe) {
                // One-shot stub-shape probe for the bind-path callees — tells
                // a vtable/stub mismatch apart from a walk/recursion decline.
                const probe = (off: number) => {
                    const t = r32(vt + off);
                    return { target: t, b0: memory[t], fid: r32(t + 1) | 0 };
                };
                class6DeclineProbe = {
                    desc: '0x' + desc.toString(16), mode: class6DeclineLastMode,
                    dev, vt, svs: probe(0x170), sps: probe(0x1ac),
                    vscf: probe(0x178), pscf: probe(0x1b4),
                };
            }
            const res = libHleManager.callOriginalSync(LIB_ID, FN_NAME, [node, args[1] | 0], 'stdcall', true);
            return res.ok ? res.eax : 0;
        } else {
            // The guest filter only routes {1,2,8,6} here — any other class
            // means the descriptor table changed under us.
            return bail(`unexpected class ${cls}`);
        }

        const target = r32(vt + vtOff);
        if (memory[target] !== 0xb8) return bail(`vtable+0x${vtOff.toString(16)} → 0x${target.toString(16)} not our stub`);
        const fid = r32(target + 1) | 0;
        if (fid !== (Mem.readUint32(cfgAddr + fidOff) ?? -1) || fid === 0) return bail(`funcId ${fid} mismatch`);

        const ringCtrl = r32(cfgAddr + CFG_RING_CTRL);
        const ringData = r32(cfgAddr + CFG_RING_DATA);
        const cap = r32(cfgAddr + CFG_RING_CAP) | 0;
        const head = r32(ringCtrl) | 0;
        if (head < 0 || head >= cap - 36) {
            // Should not happen post-drain; complete this ONE call via the
            // original (no unpatch — transient).
            Logger.warn(LogCategory.SYSTEM, '[HLE-eagl] token-dispatch: ring full after drain — completing via sync original');
            const res = libHleManager.callOriginalSync(LIB_ID, FN_NAME, [node, stage], 'stdcall', true);
            return res.ok ? res.eax : 0;
        }

        let shadowSlotAddr = 0;
        if (shadowOff !== 0 && slot >= 0) {
            const shadowBase = r32(cfgAddr + shadowOff);
            const ownerGlobal = r32(cfgAddr + CFG_OWNER_GLOBAL);
            if (shadowBase !== 0 && ownerGlobal !== 0 && (r32(ownerGlobal) | 0) === (dev | 0)) {
                const slotAddr = shadowBase + slot * 4;
                if ((r32(slotAddr) | 0) === value) {
                    const skipAddr = r32(cfgAddr + skipOff);
                    if (skipAddr !== 0) dv.setUint32(skipAddr, (r32(skipAddr) + 1) >>> 0, true);
                    return { value: 0 };
                }
                shadowSlotAddr = slotAddr;
            }
        }

        const entry = ringData + head;
        dv.setUint32(entry, fid >>> 0, true);
        dv.setUint32(entry + 4, dev >>> 0, true);
        if (argc === 3) {
            dv.setUint32(entry + 8, d3dEnum >>> 0, true);
            dv.setUint32(entry + 12, value >>> 0, true);
        } else {
            dv.setUint32(entry + 8, stage >>> 0, true);
            dv.setUint32(entry + 12, d3dEnum >>> 0, true);
            dv.setUint32(entry + 16, value >>> 0, true);
        }
        if (shadowSlotAddr !== 0) dv.setUint32(shadowSlotAddr, value >>> 0, true);
        dv.setUint32(ringCtrl, (head + (argc + 1) * 4) >>> 0, true);
        return { value: 0 };
    } catch (e) {
        return bail(`threw: ${e}`);
    }
};
