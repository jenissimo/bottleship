import { cpuViews } from '../../core/cpu/cpu-views';
import type { CpuOverride, FieldPolicy } from '../participant';
import type { SaveValue } from '../value-codec';

type Reg = Int32Array | Uint32Array | Uint16Array | Uint8Array;

export interface V86RegisterFile {
    memory_size: Uint32Array;
    segment_is_null: Uint8Array;
    segment_access_bytes: Uint8Array;
    segment_offsets: Int32Array;
    segment_limits: Uint32Array;
    protected_mode: Int32Array;
    idtr_offset: Int32Array;
    idtr_size: Int32Array;
    gdtr_offset: Int32Array;
    gdtr_size: Int32Array;
    cr: Int32Array;
    cpl: Uint8Array;
    is_32: Int32Array;
    stack_size_32: Int32Array;
    in_hlt: Uint8Array;
    last_virt_eip: Int32Array;
    eip_phys: Int32Array;
    sysenter_cs: Int32Array;
    sysenter_eip: Int32Array;
    sysenter_esp: Int32Array;
    prefixes: Uint8Array;
    flags: Int32Array;
    flags_changed: Int32Array;
    last_op1: Int32Array;
    last_op_size: Int32Array;
    instruction_pointer: Int32Array;
    previous_ip: Int32Array;
    reg32: Int32Array;
    sreg: Uint16Array;
    dreg: Int32Array;
    reg_pdpte: Int32Array;
    tss_size_32: Uint8Array;
    reg_xmm32s: Int32Array;
    fpu_st: Int32Array;
    fpu_stack_empty: Int32Array;
    fpu_stack_ptr: Int32Array;
    fpu_control_word: Int32Array;
    fpu_ip: Int32Array;
    fpu_ip_selector: Int32Array;
    fpu_dp: Int32Array;
    fpu_dp_selector: Int32Array;
    fpu_opcode: Int32Array;
    last_result: Int32Array;
    fpu_status_word: Uint16Array;
    mxcsr: Int32Array;
    current_tsc: Uint32Array;
}

export const CPU_FIELDS = {
    memory_size: 'derive',
    segment_is_null: 'save',
    segment_access_bytes: 'save',
    segment_offsets: 'save',
    segment_limits: 'save',
    protected_mode: 'save',
    idtr_offset: 'save',
    idtr_size: 'save',
    gdtr_offset: 'save',
    gdtr_size: 'save',
    cr: 'save',
    cpl: 'save',
    is_32: 'save',
    stack_size_32: 'save',
    in_hlt: 'save',
    last_virt_eip: 'save',
    eip_phys: 'save',
    sysenter_cs: 'save',
    sysenter_eip: 'save',
    sysenter_esp: 'save',
    prefixes: 'save',
    flags: 'save',
    flags_changed: 'save',
    last_op1: 'save',
    last_op_size: 'save',
    instruction_pointer: 'save',
    previous_ip: 'save',
    reg32: 'save',
    sreg: 'save',
    dreg: 'save',
    reg_pdpte: 'save',
    tss_size_32: 'save',
    reg_xmm32s: 'save',
    fpu_st: 'save',
    fpu_stack_empty: 'save',
    fpu_stack_ptr: 'save',
    fpu_control_word: 'save',
    fpu_ip: 'save',
    fpu_ip_selector: 'save',
    fpu_dp: 'save',
    fpu_dp_selector: 'save',
    fpu_opcode: 'save',
    last_result: 'save',
    fpu_status_word: 'save',
    mxcsr: 'save',
    current_tsc: 'save',
} as const satisfies Record<keyof V86RegisterFile, FieldPolicy>;

export interface V86Cpu extends V86RegisterFile {
    store_current_tsc(): void;
    set_tsc(lo: number, hi: number): void;
    update_state_flags(): void;
    full_clear_tlb(): void;
    jit_clear_cache(): void;
    fw_value: unknown;
}

type SavedName = { [K in keyof typeof CPU_FIELDS]: (typeof CPU_FIELDS)[K] extends 'save' ? K : never }[keyof typeof CPU_FIELDS];

const SAVED = (Object.keys(CPU_FIELDS) as (keyof V86RegisterFile)[])
    .filter((k): k is SavedName => CPU_FIELDS[k] === 'save');

export function captureCpu(cpu: V86Cpu, override: CpuOverride | null = null): SaveValue {
    cpu.store_current_tsc();
    const regs: Record<string, SaveValue> = {};
    for (const name of SAVED) regs[name] = (cpu[name] as Reg).slice();
    if (override) {
        const gpr = regs.reg32 as Reg;
        [gpr[0], gpr[1], gpr[2], gpr[3], gpr[4], gpr[5], gpr[6], gpr[7]] = [
            override.eax, override.ecx, override.edx, override.ebx, override.esp, override.ebp, override.esi, override.edi,
        ].map(v => v | 0);
        (regs.flags as Reg)[0] = override.eflags | 0;
        (regs.flags_changed as Reg)[0] = 0;
        (regs.instruction_pointer as Reg)[0] = override.eip | 0;
        (regs.previous_ip as Reg)[0] = override.eip | 0;
        (regs.last_virt_eip as Reg)[0] = -1;
    }
    return { memorySize: cpuViews(cpu).memorySize[0]!, regs };
}

export function restoreCpu(cpu: V86Cpu, state: SaveValue): void {
    const s = state as { memorySize: number; regs: Record<SavedName, Reg> };
    const memorySize = cpuViews(cpu).memorySize[0];
    if (s.memorySize !== memorySize) {
        throw new Error(`cpu: snapshot has ${s.memorySize} bytes of RAM, this CPU has ${memorySize}`);
    }
    for (const name of SAVED) {
        const saved = s.regs[name];
        const live = cpu[name] as Reg;
        if (!saved || saved.length !== live.length) throw new Error(`cpu: register ${name} has the wrong shape`);
        if (name === 'current_tsc') continue;
        live.set(saved);
    }
    cpu.set_tsc(s.regs.current_tsc[0], s.regs.current_tsc[1]);
    cpu.update_state_flags();
    cpu.full_clear_tlb();
    cpu.jit_clear_cache();
}
