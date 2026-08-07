/**
 * Durable guest-fault recorder.
 *
 * Intermittent guest crashes (a thread derailing to a near-NULL deref, a wild
 * jump, a stack/context corruption) are hard to catch: the streamed log is a
 * firehose that routinely drops the crash line, and post-mortem register dumps
 * only show the wreckage. This keeps a small ring of the last N guest faults —
 * faulting EIP, fault address (CR2), error code, owning thread, the last WinAPI
 * thunk, and the live (non-clobbered) registers — populated straight from the
 * #PF handler. Read it live via the harness `faults()` verb with ZERO log
 * firehose and ZERO perturbation (it's a plain array push on the fault path).
 *
 * This is the observability that turns "the emulator froze, wtf" into "thread T7
 * faulted reading 0x<addr> at EIP=0x<eip>, last thunk dsound:…" — diagnosable.
 */

export interface FaultRecord {
    /** performance.now()-ish timestamp (ms). */
    ts: number;
    /** Faulting instruction pointer (guest EIP). */
    eip: number;
    /** Faulting linear address (CR2). */
    faultAddr: number;
    /** #PF error code (bit0 present, bit1 write, bit2 user). */
    errorCode: number;
    /** Owning guest thread id, or null if unknown. */
    threadId: number | null;
    /** Last WinAPI thunk before the fault (breadcrumb). */
    lastThunk: string;
    /** Recoverable (CoW/decommit/write-trap) vs delivered-as-AV. */
    kind: "recoverable" | "unhandled";
    /** Guest registers at the fault. eax/edx come from the #PF stub's saved copies. */
    regs: { eax?: number; ecx: number; edx?: number; ebx: number; esp: number; ebp: number; esi: number; edi: number };
    /**
     * Registers r for which `r + disp == CR2` with a small |disp| — i.e. the plausible
     * `[reg+field]` operands of the faulting instruction. A near-NULL fault names the
     * object pointer that was NULL, which is what the fault is actually about.
     */
    cr2Candidates?: string[];
    /**
     * False when no instruction at `eip` can produce CR2 (see isFaultEipConsistent): v86
     * materializes only the LOW 12 BITS of eip on a jit fault, so the reported page —
     * and on some paths the offset — can belong to an earlier block. Treat `eip` as a
     * hint, not ground truth, when this is false.
     */
    eipTrusted?: boolean;
    /** Tail of the WinAPI call ring leading up to the fault (newest last). */
    recentCalls: string[];
    /** Guest ESP at the fault (above the #PF interrupt frame). */
    gameEsp: number;
    /** 32 stack words from gameEsp (return-address chain + locals/args). */
    stackDump: number[];
    /** How the fault was resolved once SEH ran (set after the fact by annotateLast). */
    outcome?: string;
    /** Set when the fault is an indirect CALL that fetched a bad target (see analyzeIndirectCallFault).
     *  `slotAddr` is -1 for the register form (`call reg`), where the target came from a
     *  register rather than a memory slot. */
    badCall?: { callSite: number; slotAddr: number; slotValue: number; operand: string };
}

const REG_NAMES = ["EAX", "ECX", "EDX", "EBX", "ESP", "EBP", "ESI", "EDI"];

/**
 * Name the `[reg+disp]` operands that could have produced CR2.
 *
 * A near-NULL fault is only ever interesting as "object X was NULL, field +disp was
 * read" — this turns the raw CR2 into exactly that sentence without a disassembler.
 * `maxDisp` bounds it to plausible struct offsets so unrelated registers don't match.
 */
export function cr2RegisterCandidates(
    faultAddr: number,
    regs: Partial<Record<"eax" | "ecx" | "edx" | "ebx" | "esp" | "ebp" | "esi" | "edi", number>>,
    maxDisp = 0x1000,
): string[] {
    const values = [regs.eax, regs.ecx, regs.edx, regs.ebx, regs.esp, regs.ebp, regs.esi, regs.edi];
    const out: string[] = [];
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === undefined) continue;
        const disp = (faultAddr >>> 0) - (v >>> 0);
        if (disp >= 0 && disp <= maxDisp) {
            out.push(`${REG_NAMES[i]}(0x${(v >>> 0).toString(16)})+0x${disp.toString(16)}`);
        }
    }
    return out;
}

const PREFIXES = new Set([0x66, 0x67, 0xf0, 0xf2, 0xf3, 0x2e, 0x36, 0x3e, 0x26, 0x64, 0x65]);

/**
 * Does the instruction at `eip` address CR2?
 *
 * v86 materializes only the LOW 12 BITS of eip when a jit-compiled access faults
 * (codegen::gen_set_previous_eip_offset_from_eip_with_low_bits) — the page comes from
 * whatever instruction_pointer happened to hold, and on paths that never reached a
 * per-instruction update the offset is stale too. The pushed EIP is therefore a hint.
 * Decoding the ModRM at `eip` and comparing its effective address against CR2 tells us
 * whether to believe it, so a stale EIP can no longer send an investigation to a
 * function that never ran. Advisory only: an unrecognised encoding reports `null`.
 */
export function isFaultEipConsistent(
    mem: Uint8Array,
    eip: number,
    faultAddr: number,
    regs: { eax: number; ecx: number; edx: number; ebx: number; esp: number; ebp: number; esi: number; edi: number },
): boolean | null {
    if (eip <= 0 || eip + 16 > mem.length) return null;
    const r = [regs.eax, regs.ecx, regs.edx, regs.ebx, regs.esp, regs.ebp, regs.esi, regs.edi].map((v) => v >>> 0);
    let p = eip;
    let guard = 0;
    while (PREFIXES.has(mem[p]) && guard++ < 4) p++;
    let op = mem[p++];
    if (op === 0x0f) op = 0x100 | mem[p++];
    // String ops address [ESI]/[EDI] with no ModRM.
    if ((op >= 0xa4 && op <= 0xa7) || (op >= 0xaa && op <= 0xaf)) {
        return (faultAddr >>> 0) === r[6] || (faultAddr >>> 0) === r[7];
    }
    // Implicit-stack forms (push/pop r32, push imm, pushfd/popfd, call rel32, ret,
    // enter/leave) carry no ModRM — they can only fault near ESP.
    if ((op >= 0x50 && op <= 0x5f) || op === 0x68 || op === 0x6a || op === 0x9c || op === 0x9d ||
        op === 0xc2 || op === 0xc3 || op === 0xc8 || op === 0xc9 || op === 0xe8 || op === 0xcf) {
        return Math.abs(((faultAddr >>> 0) - r[4]) | 0) <= 32;
    }
    // MOV moffs32 <-> EAX: the imm32 is the whole address.
    if (op >= 0xa0 && op <= 0xa3) {
        const imm = (mem[p] | (mem[p + 1] << 8) | (mem[p + 2] << 16) | (mem[p + 3] << 24)) >>> 0;
        return imm === (faultAddr >>> 0);
    }
    if (p + 1 > mem.length) return null;
    const modrm = mem[p++];
    const mod = modrm >> 6;
    const rm = modrm & 7;
    if (mod === 3) return false; // register form — cannot touch memory
    let ea = 0;
    let noBaseDisp32 = false; // mod=00 with rm/base=101 → disp32 supplies the base
    if (rm === 4) {
        const sib = mem[p++];
        const base = sib & 7;
        const index = (sib >> 3) & 7;
        const scale = sib >> 6;
        noBaseDisp32 = base === 5 && mod === 0;
        ea = noBaseDisp32 ? 0 : r[base];
        if (index !== 4) ea = (ea + (r[index] << scale)) >>> 0;
    } else {
        noBaseDisp32 = rm === 5 && mod === 0;
        ea = noBaseDisp32 ? 0 : r[rm];
    }
    if (noBaseDisp32 || mod === 2) {
        ea = (ea + (mem[p] | (mem[p + 1] << 8) | (mem[p + 2] << 16) | (mem[p + 3] << 24))) >>> 0;
    } else if (mod === 1) {
        ea = (ea + ((mem[p] << 24) >> 24)) >>> 0;
    }
    return ea === (faultAddr >>> 0);
}

/**
 * Explain a fault that no register can account for as "the last indirect CALL
 * fetched a bad target".
 *
 * A guest that vanishes mid-frame is usually a `call dword ptr [reg+disp]` — a COM
 * vtable slot or an IAT entry — whose slot held garbage: the CPU pushes the return
 * address, jumps to it, and the instruction FETCH faults. CR2 is then the bogus target,
 * matches no register, and the reported EIP is meaningless — the exact shape that costs
 * hours by hand. Since [ESP] still holds the return address, the call site is one
 * backwards decode away, and with it the slot the target came from.
 *
 * Returns null when the stack top isn't a return address into an indirect call.
 */
export function analyzeIndirectCallFault(
    mem: Uint8Array,
    gameEsp: number,
    regs: { eax: number; ecx: number; edx: number; ebx: number; esp: number; ebp: number; esi: number; edi: number },
): { callSite: number; slotAddr: number; slotValue: number; operand: string } | null {
    if (gameEsp <= 0 || gameEsp + 4 > mem.length) return null;
    const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const retAddr = dv.getUint32(gameEsp, true) >>> 0;
    if (retAddr < 0x1000 || retAddr + 4 > mem.length) return null;
    const r = [regs.eax, regs.ecx, regs.edx, regs.ebx, regs.esp, regs.ebp, regs.esi, regs.edi].map((v) => v >>> 0);

    // CALL r/m32 is FF /2. Try every encoding length that would end exactly at retAddr.
    for (let len = 2; len <= 7; len++) {
        const site = retAddr - len;
        if (site < 0 || mem[site] !== 0xff) continue;
        const modrm = mem[site + 1];
        if (((modrm >> 3) & 7) !== 2) continue; // /2 = CALL near indirect
        const mod = modrm >> 6;
        const rm = modrm & 7;
        // `call reg` reads no memory, so there is no slot to name — but the call SITE and
        // which register held the bad target are most of the answer, and reporting nothing
        // here sends the reader looking for a vtable that was never involved.
        if (mod === 3) {
            if (site + 2 !== retAddr) continue;
            return { callSite: site, slotAddr: -1, slotValue: r[rm], operand: REG_NAMES[rm] };
        }
        let p = site + 2;
        let base = 0;
        let label = "";
        let noBaseDisp32 = false; // mod=00 with rm/base=101 → disp32 supplies the base
        if (rm === 4) {
            const sib = mem[p++];
            const b = sib & 7;
            const index = (sib >> 3) & 7;
            noBaseDisp32 = b === 5 && mod === 0;
            base = noBaseDisp32 ? 0 : r[b];
            if (index !== 4) base = (base + (r[index] << (sib >> 6))) >>> 0;
            label = noBaseDisp32 ? "[idx" : `[${REG_NAMES[b]}+idx`;
        } else {
            noBaseDisp32 = rm === 5 && mod === 0;
            base = noBaseDisp32 ? 0 : r[rm];
            label = noBaseDisp32 ? "[abs" : `[${REG_NAMES[rm]}`;
        }
        let disp = 0;
        if (mod === 1) { disp = (mem[p] << 24) >> 24; p += 1; }
        else if (mod === 2 || noBaseDisp32) {
            disp = mem[p] | (mem[p + 1] << 8) | (mem[p + 2] << 16) | (mem[p + 3] << 24);
            p += 4;
        }
        if (p !== retAddr) continue; // encoding length must land exactly on the return address
        const slotAddr = (base + disp) >>> 0;
        if (slotAddr + 4 > mem.length) continue;
        return {
            callSite: site,
            slotAddr,
            slotValue: dv.getUint32(slotAddr, true) >>> 0,
            operand: `${label}${disp ? `+0x${disp.toString(16)}` : ""}]`,
        };
    }
    return null;
}

const MAX_RECORDS = 64;

class FaultRecorder {
    private ring: FaultRecord[] = [];

    record(r: FaultRecord): void {
        this.ring.push(r);
        if (this.ring.length > MAX_RECORDS) this.ring.shift();
    }

    /** Most recent fault, or null. */
    last(): FaultRecord | null {
        return this.ring.length ? this.ring[this.ring.length - 1] : null;
    }

    /** Record how the last fault ended (SEH caught it, halted, …) once that is known. */
    annotateLast(outcome: string): void {
        const rec = this.last();
        if (rec) rec.outcome = outcome;
    }

    /** Last `n` faults, newest last. */
    recent(n = 16): FaultRecord[] {
        return this.ring.slice(-Math.max(1, n));
    }

    clear(): void {
        this.ring = [];
    }
}

/** Worker-wide singleton — imported by the #PF handler and the harness. */
export const faultRecorder = new FaultRecorder();
