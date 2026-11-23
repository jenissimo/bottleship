import type { WwtAbi } from "./cpu-provider";

interface ProtectedCpu {
    mem8: Uint8Array;
    reg32: Int32Array;
    cr: Int32Array;
    sreg: Uint16Array;
    segment_offsets: Int32Array;
    segment_limits: Uint32Array;
    segment_is_null: Uint8Array;
    instruction_pointer: Int32Array;
    flags: Int32Array;
    cpl: Uint8Array;
    gdtr_offset: Int32Array;
    gdtr_size: Int32Array;
    idtr_offset: Int32Array;
    idtr_size: Int32Array;
    in_hlt: Uint8Array;
    invalidatePaging?(): void;
}

interface Descriptor {
    base: number;
    limit: number;
    access: number;
}

function readDescriptor(cpu: ProtectedCpu, view: DataView, selector: number): Descriptor | null {
    const offset = selector & ~7;
    const at = (cpu.gdtr_offset[0] >>> 0) + offset;
    if ((selector & 4) || offset === 0 || offset + 7 > cpu.gdtr_size[0] || at + 8 > cpu.mem8.length) return null;
    const low = view.getUint32(at, true);
    const high = view.getUint32(at + 4, true);
    const access = (high >>> 8) & 0xff;
    if (!(access & 0x80)) return null;
    const base = ((low >>> 16) | ((high & 0xff) << 16) | (high & 0xff000000)) >>> 0;
    const rawLimit = (low & 0xffff) | (high & 0x000f0000);
    return { base, limit: (high & 0x00800000) ? ((rawLimit << 12) | 0xfff) >>> 0 : rawLimit, access };
}

export function updateSegment(cpu: ProtectedCpu, view: DataView, index: number, selector: number): boolean {
    if ((selector & ~3) === 0 && index !== 1 && index !== 2) {
        cpu.sreg[index] = selector;
        cpu.segment_offsets[index] = 0;
        cpu.segment_limits[index] = 0;
        cpu.segment_is_null[index] = 1;
        return true;
    }
    const descriptor = readDescriptor(cpu, view, selector);
    if (!descriptor) return false;
    cpu.sreg[index] = selector;
    cpu.segment_offsets[index] = descriptor.base;
    cpu.segment_limits[index] = descriptor.limit;
    cpu.segment_is_null[index] = 0;
    return true;
}

function emulatePagingControl(cpu: ProtectedCpu, eip: number): boolean {
    if (cpu.cpl[0] !== 0) return false;
    let at = eip;
    let address16 = false;
    for (; at - eip < 12; at++) {
        const prefix = cpu.mem8[at];
        if (prefix === 0x67) address16 = true;
        else if (prefix !== 0x26 && prefix !== 0x2e && prefix !== 0x36 && prefix !== 0x3e && prefix !== 0x64 && prefix !== 0x65) break;
    }
    if (cpu.mem8[at] !== 0x0f || at + 3 > cpu.mem8.length) return false;
    const op = cpu.mem8[at + 1];
    const modrm = cpu.mem8[at + 2];
    const mode = modrm >>> 6;
    const reg = (modrm >>> 3) & 7;
    const rm = modrm & 7;
    let next = at + 3;

    if ((op === 0x20 || op === 0x22) && mode === 3 && at === eip && [0, 2, 3, 4].includes(reg)) {
        if (op === 0x20) cpu.reg32[rm] = cpu.cr[reg];
        else {
            const value = cpu.reg32[rm];
            // This backend runs 32-bit protected mode without PSE or PAE.
            if ((reg === 0 && !(value & 1)) || (reg === 4 && (value & 0x30))) return false;
            cpu.cr[reg] = value;
            if (reg !== 2) cpu.invalidatePaging?.();
        }
    } else if (op === 0x01 && reg === 7 && mode !== 3) {
        // A full flush is valid for INVLPG. Decode the address operand's
        // length so execution can continue at the next instruction.
        let base = rm;
        if (!address16 && rm === 4) base = cpu.mem8[next++] & 7;
        if (mode === 0 && base === (address16 ? 6 : 5)) next += address16 ? 2 : 4;
        if (mode === 1) next += 1;
        if (mode === 2) next += address16 ? 2 : 4;
        if (next > cpu.mem8.length || next - eip > 15) return false;
        cpu.invalidatePaging?.();
    } else return false;

    cpu.instruction_pointer[0] = next;
    return true;
}

/** The shared BottleShip boot image uses 32-bit ring-0 interrupt gates and flat segments. */
export function emulateProtectedInstruction(cpu: ProtectedCpu, view: DataView, eip: number): boolean {
    const opcode = cpu.mem8[eip];
    if (emulatePagingControl(cpu, eip)) return true;
    const esp = cpu.reg32[4] >>> 0;
    if (opcode === 0xcf) {
        if (esp + 12 > cpu.mem8.length || esp < 0x1000) return false;
        const next = view.getUint32(esp, true);
        const selector = view.getUint16(esp + 4, true);
        const descriptor = readDescriptor(cpu, view, selector);
        if (!descriptor || (descriptor.access & 0x18) !== 0x18 || (selector & 3) !== cpu.cpl[0] ||
            descriptor.base !== 0 || next > descriptor.limit) return false;
        updateSegment(cpu, view, 1, selector);
        cpu.flags[0] = view.getUint32(esp + 8, true) | 2;
        cpu.reg32[4] = esp + 12;
        cpu.instruction_pointer[0] = next;
        return true;
    }

    if (cpu.cpl[0] === 0 && (opcode === 0xfa || opcode === 0xfb || opcode === 0xf4)) {
        if (opcode === 0xf4) cpu.in_hlt[0] = 1;
        else if (opcode === 0xfa) cpu.flags[0] &= ~0x200;
        else cpu.flags[0] |= 0x200;
        cpu.instruction_pointer[0] = eip + 1;
        return true;
    }

    let segment: number;
    let length = 1;
    switch (opcode) {
        case 0x07: segment = 0; break; // pop es
        case 0x17: segment = 2; break; // pop ss
        case 0x1f: segment = 3; break; // pop ds
        case 0x0f: {
            const second = cpu.mem8[eip + 1];
            if (second !== 0xa1 && second !== 0xa9) return false;
            segment = second === 0xa1 ? 4 : 5;
            length = 2;
            break;
        }
        default: return false;
    }
    if (esp + 4 > cpu.mem8.length || esp < 0x1000) return false;
    if (!updateSegment(cpu, view, segment, view.getUint16(esp, true))) return false;
    cpu.reg32[4] = esp + 4;
    cpu.instruction_pointer[0] = eip + length;
    return true;
}

interface Interrupt {
    vector: number;
    resume: number;
    error?: number;
}

function decodeFault(cpu: ProtectedCpu, faults: WwtAbi["fault"], code: number, eip: number, info: number, present: boolean): Interrupt | undefined {
    switch (code) {
        case faults.INTEGER_DIVIDE_BY_ZERO: return { vector: 0, resume: eip };
        case faults.SINGLE_STEP: return { vector: 1, resume: eip };
        case faults.BREAKPOINT: return { vector: 3, resume: eip + (cpu.mem8[eip] === 0xcd ? 2 : 1) };
        case faults.INTEGER_OVERFLOW: return { vector: 4, resume: eip + 1 };
        case faults.ILLEGAL_INSTRUCTION: return { vector: 6, resume: eip };
        case faults.GENERAL_PROTECTION:
        case faults.PRIVILEGED_INSTRUCTION:
            return { vector: 13, resume: eip, error: info & 0xffff };
        case faults.SOFTWARE_INTERRUPT:
            if (cpu.mem8[eip] !== 0xcd || eip + 2 > cpu.mem8.length) return undefined;
            return { vector: cpu.mem8[eip + 1], resume: eip + 2 };
        case faults.ACCESS_VIOLATION:
        case faults.ACCESS_VIOLATION_WRITE:
        case faults.ACCESS_VIOLATION_EXECUTE:
            cpu.cr[2] = info;
            return { vector: 14, resume: eip, error:
                (present ? 1 : 0) |
                (code === faults.ACCESS_VIOLATION_WRITE ? 2 : 0) |
                (cpu.cpl[0] === 3 ? 4 : 0) |
                (code === faults.ACCESS_VIOLATION_EXECUTE ? 16 : 0) };
        default: return undefined;
    }
}

export function deliverProtectedFault(cpu: ProtectedCpu, view: DataView, faults: WwtAbi["fault"], code: number, eip: number, info: number, present: boolean): boolean {
    const interrupt = decodeFault(cpu, faults, code, eip, info, present);
    if (!interrupt) return false;
    const offset = interrupt.vector * 8;
    const gate = (cpu.idtr_offset[0] >>> 0) + offset;
    if (!cpu.idtr_offset[0] || offset + 7 > cpu.idtr_size[0] || gate + 8 > cpu.mem8.length) return false;
    const access = view.getUint8(gate + 5);
    if ((access & 0x8f) !== 0x8e && (access & 0x8f) !== 0x8f) return false;
    const selector = view.getUint16(gate + 2, true);
    if ((selector & 3) !== cpu.cpl[0]) return false;
    const target = (view.getUint16(gate, true) | (view.getUint16(gate + 6, true) << 16)) >>> 0;
    const stack = cpu.reg32[4] >>> 0;
    const nextStack = stack - (interrupt.error === undefined ? 12 : 16);
    if (target === 0 || target >= cpu.mem8.length || nextStack < 0x1000 || stack > cpu.mem8.length) return false;
    const oldSelector = cpu.sreg[1];
    if (!updateSegment(cpu, view, 1, selector)) return false;
    view.setUint32(stack - 4, cpu.flags[0], true);
    view.setUint32(stack - 8, oldSelector, true);
    view.setUint32(stack - 12, interrupt.resume, true);
    if (interrupt.error !== undefined) view.setUint32(stack - 16, interrupt.error, true);
    cpu.flags[0] &= ~0x10100; // Clear Resume and Trap.
    if ((access & 0xf) === 0xe) cpu.flags[0] &= ~0x200;
    cpu.reg32[4] = nextStack;
    cpu.instruction_pointer[0] = target;
    return true;
}
