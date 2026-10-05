/**
 * StackWalk / StackWalk64 and the two symbol lookups a caller needs alongside them.
 *
 * A crash handler that cannot walk the stack is a crash handler that tells us nothing,
 * so this is a real unwind rather than an honest FALSE: it reuses the dispatcher's own
 * call-stack reconstruction — the same machinery behind the harness `backtrace` verb and
 * every fault snapshot — and feeds it out one STACKFRAME at a time, which is the shape
 * the API's iterate-until-FALSE contract demands.
 *
 * Windows keeps the walk's position in the caller's own STACKFRAME, not in a handle, so
 * the state here is keyed by that buffer's address and re-seeded whenever the AddrPC we
 * last wrote is no longer the one sitting there — a caller starting a second walk over
 * the same buffer therefore restarts instead of resuming somebody else's frames.
 */

import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { isValidAddress } from "../core/memory/address-guard";
import { System } from "../core/system";
import { hleModuleNameByBase } from "../core/hle-module-images";
import { HLE_IMAGE_SLOT_SIZE, MEM_HLE_IMAGE_BASE, MEM_HLE_IMAGE_SIZE } from "../core/cpu/emulator-config";

const ERROR_INVALID_PARAMETER = 87;
const IMAGE_FILE_MACHINE_I386 = 0x014c;
/** ADDRESS_MODE.AddrModeFlat — the only mode a flat 32-bit process ever reports. */
const ADDR_MODE_FLAT = 3;

/** CONTEXT (i386) register offsets, as kernel32's exception path writes them. */
const CTX_EBP = 0xb4;
const CTX_EIP = 0xb8;
const CTX_ESP = 0xc4;
const CONTEXT_I386_SIZE = 0x2cc;

/**
 * Field offsets of STACKFRAME / STACKFRAME64. They differ only in ADDRESS vs ADDRESS64:
 * 12 bytes (DWORD + WORD + enum) against 16 (DWORD64 + WORD + enum, 8-aligned). Everything
 * downstream shifts by that, which is why the two layouts are data rather than two walkers.
 */
interface StackFrameLayout {
    /** sizeof(ADDRESS.Offset) — also what separates Offset from Segment. */
    offsetSize: 4 | 8;
    addrPC: number;
    addrReturn: number;
    addrFrame: number;
    addrStack: number;
    funcTableEntry: number;
    far: number;
    virtual: number;
    /** Bytes this walker reads or writes — validated as ONE extent up front. */
    touched: number;
}

const STACKFRAME32_LAYOUT: StackFrameLayout = {
    offsetSize: 4,
    addrPC: 0, addrReturn: 12, addrFrame: 24, addrStack: 36,
    funcTableEntry: 48, far: 68, virtual: 72, touched: 76,
};

const STACKFRAME64_LAYOUT: StackFrameLayout = {
    offsetSize: 8,
    addrPC: 0, addrReturn: 16, addrFrame: 32, addrStack: 48,
    funcTableEntry: 80, far: 120, virtual: 124, touched: 128,
};

interface WalkFrame { pc: number; ret: number; frame: number; stack: number; }
interface WalkState { frames: WalkFrame[]; index: number; lastPc: number; }

/** Per-STACKFRAME-buffer walk position. Bounded: a handful of live walks is already odd. */
const walks = new Map<number, WalkState>();
const MAX_LIVE_WALKS = 32;

/**
 * The module base an address belongs to. ModuleRegistry covers PE images the guest
 * loaded; an HLE'd DLL has a synthetic image instead, whose slot base IS its HMODULE.
 */
export function moduleBaseForAddress(addr: number): number {
    const address = addr >>> 0;
    if (!address) return 0;

    const mod = System.getInstance().process?.moduleRegistry?.getModuleContainingAddress(address);
    if (mod) return mod.baseAddress >>> 0;

    if (address >= MEM_HLE_IMAGE_BASE && address < MEM_HLE_IMAGE_BASE + MEM_HLE_IMAGE_SIZE) {
        const slot = Math.floor((address - MEM_HLE_IMAGE_BASE) / HLE_IMAGE_SLOT_SIZE);
        const slotBase = (MEM_HLE_IMAGE_BASE + slot * HLE_IMAGE_SLOT_SIZE) >>> 0;
        if (hleModuleNameByBase(slotBase)) return slotBase;
    }
    return 0;
}

/** Write one ADDRESS/ADDRESS64: Offset, then Segment=0 and Mode=Flat. */
function writeAddress(framePtr: number, fieldOffset: number, layout: StackFrameLayout, value: number): void {
    const at = (framePtr + fieldOffset) >>> 0;
    Mem.writeUint32(at, value >>> 0);
    if (layout.offsetSize === 8) Mem.writeUint32(at + 4, 0);
    Mem.writeUint16(at + layout.offsetSize, 0);
    Mem.writeUint32(at + layout.offsetSize + 4, ADDR_MODE_FLAT);
}

/**
 * Turn the dispatcher's reconstruction into the frame sequence StackWalk hands out.
 * Frame 0 is the context's own PC; each later frame's PC is the previous frame's return
 * address, so AddrReturn always names the NEXT frame — the relationship callers print.
 */
function buildWalk(eip: number, esp: number, ebp: number): WalkFrame[] {
    const dispatcher = System.getInstance().process?.dispatcher;
    const scanned = dispatcher?.getGuestCallStack?.(esp, 0x800, 48)?.frames ?? [];

    const frames: WalkFrame[] = [];
    if (eip) {
        frames.push({ pc: eip >>> 0, ret: (scanned[0]?.retAddr ?? 0) >>> 0, frame: ebp >>> 0, stack: esp >>> 0 });
    }
    for (let i = 0; i < scanned.length; i++) {
        frames.push({
            pc: scanned[i].retAddr >>> 0,
            ret: (scanned[i + 1]?.retAddr ?? 0) >>> 0,
            // We recover frames by scanning for return addresses, not by following EBP, so
            // only the seed frame has a frame pointer we can honestly name.
            frame: 0,
            // The slot just past the return address is where that frame's stack resumes.
            stack: (esp + scanned[i].stackOffset + 4) >>> 0,
        });
    }
    return frames;
}

function makeStackWalk(layout: StackFrameLayout): ThunkImplementation {
    return (_ctx, mem, args) => {
        const machineType = args[0] >>> 0;
        const framePtr = args[3] >>> 0;
        const contextPtr = args[4] >>> 0;
        const scheduler = System.getInstance().scheduler;

        // We emulate one architecture; answering for another would be an invented unwind.
        if (machineType !== IMAGE_FILE_MACHINE_I386) {
            scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        if (!framePtr || !isValidAddress(mem, framePtr, layout.touched, "rw")) {
            scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        const currentPc = Mem.readUint32(framePtr + layout.addrPC) ?? 0;
        let state = walks.get(framePtr);
        if (!state || state.lastPc !== currentPc) {
            const hasContext = contextPtr !== 0 && isValidAddress(mem, contextPtr, CONTEXT_I386_SIZE, "r");
            const ctxEip = hasContext ? (Mem.readUint32(contextPtr + CTX_EIP) ?? 0) : 0;
            const ctxEbp = hasContext ? (Mem.readUint32(contextPtr + CTX_EBP) ?? 0) : 0;
            const ctxEsp = hasContext ? (Mem.readUint32(contextPtr + CTX_ESP) ?? 0) : 0;

            // The caller seeds the STACKFRAME from the CONTEXT; either source is legal, and
            // a caller that seeded neither has given us nothing to walk.
            const seedEip = currentPc || ctxEip;
            const seedEsp = (Mem.readUint32(framePtr + layout.addrStack) ?? 0) || ctxEsp;
            const seedEbp = (Mem.readUint32(framePtr + layout.addrFrame) ?? 0) || ctxEbp;
            if (!seedEsp) {
                scheduler.setLastError(ERROR_INVALID_PARAMETER);
                return 0;
            }

            if (walks.size >= MAX_LIVE_WALKS) walks.clear();
            state = { frames: buildWalk(seedEip, seedEsp, seedEbp), index: 0, lastPc: -1 };
            walks.set(framePtr, state);
        }

        if (state.index >= state.frames.length) {
            // Walk exhausted: FALSE with no error is how the loop is meant to end.
            walks.delete(framePtr);
            scheduler.setLastError(0);
            return 0;
        }

        const frame = state.frames[state.index++];
        writeAddress(framePtr, layout.addrPC, layout, frame.pc);
        writeAddress(framePtr, layout.addrReturn, layout, frame.ret);
        writeAddress(framePtr, layout.addrFrame, layout, frame.frame);
        writeAddress(framePtr, layout.addrStack, layout, frame.stack);
        // No FPO/pdata to point at, and this is not a WOW or synthesized frame.
        Mem.writeUint32(framePtr + layout.funcTableEntry, 0);
        Mem.writeUint32(framePtr + layout.far, 0);
        Mem.writeUint32(framePtr + layout.virtual, 0);

        state.lastPc = frame.pc;
        scheduler.setLastError(0);
        return 1;
    };
}

export const stackWalk32: ThunkImplementation = makeStackWalk(STACKFRAME32_LAYOUT);
export const stackWalk64: ThunkImplementation = makeStackWalk(STACKFRAME64_LAYOUT);

/**
 * DWORD64 SymGetModuleBase64(HANDLE, DWORD64 Address) — and its 32-bit twin, which takes
 * one dword less. Every base in a 32-bit address space fits in EAX, so the high half a
 * DWORD64 return would carry is always zero.
 */
export const symGetModuleBase32: ThunkImplementation = (_ctx, _mem, args) => moduleBaseForAddress(args[1] >>> 0);
export const symGetModuleBase64: ThunkImplementation = (_ctx, _mem, args) => moduleBaseForAddress(args[1] >>> 0);
