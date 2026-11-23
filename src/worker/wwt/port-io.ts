interface PortDevice {
    device?: unknown;
    read8?(): number;
    read16?(): number;
    read32?(): number;
    write8?(value: number): void;
    write16?(value: number): void;
    write32?(value: number): void;
}

interface PortCpu {
    mem8: Uint8Array;
    reg32: Int32Array;
    instruction_pointer: Int32Array;
    io: { ports: { [port: number]: PortDevice | undefined } };
    wwtHypercall?: { dispatch(functionId: number): boolean };
}

/** Complete a scalar i386 IN/OUT intercepted by WWT's privileged-instruction fault.
 * HLE may redirect the guest, so publish the resume address before invoking the device. */
export function emulateWwtPortIo(cpu: PortCpu, eip: number, beforeIo?: () => void, allowPortable = true): boolean {
    const mem = cpu.mem8;
    let cursor = eip >>> 0;
    let operand16 = false;
    // 32-bit flat code. Segment/address-size and REP prefixes don't change scalar port I/O.
    for (; cursor < mem.length && cursor - eip < 15; cursor++) {
        const byte = mem[cursor];
        if (byte === 0x66) operand16 = true;
        else if (![0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x67, 0xf2, 0xf3].includes(byte)) break;
    }
    const opcode = mem[cursor++];
    if (!(opcode >= 0xe4 && opcode <= 0xe7 || opcode >= 0xec && opcode <= 0xef)) return false;
    const immediate = opcode < 0xec;
    const port = immediate ? mem[cursor++] : cpu.reg32[2] & 0xffff;
    if (cursor > mem.length || cursor - eip > 15) return false;
    const device = cpu.io.ports[port];
    if (!device) return false;
    const width = (opcode & 1) === 0 ? 8 : operand16 ? 16 : 32;
    const mask = width === 32 ? -1 : (1 << width) - 1;
    if (opcode & 2) {
        const write = device[`write${width}`];
        if (!write) return false;
        cpu.instruction_pointer[0] = cursor;
        beforeIo?.();
        const value = cpu.reg32[0] & mask;
        if (allowPortable && port === 0xb077 && width === 32 && cpu.wwtHypercall?.dispatch(value >>> 0)) return true;
        write.call(device.device, value);
    } else {
        const read = device[`read${width}`];
        if (!read) return false;
        cpu.instruction_pointer[0] = cursor;
        beforeIo?.();
        cpu.reg32[0] = (cpu.reg32[0] & ~mask) | (read.call(device.device) & mask);
    }
    return true;
}
