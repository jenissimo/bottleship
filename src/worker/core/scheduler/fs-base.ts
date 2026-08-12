import { GDT_FS_DESCRIPTOR_ADDRESS } from "../bootloader";
import { Mem } from "../memory/mem-accessor";
import type { V86Cpu } from "./types";

/**
 * Program the guest FS base for a thread's TEB — the ONE writer of that state.
 *
 * Two places hold it and both must agree:
 *  - `cpu.segment_offsets[4]`, the base v86 cached when FS was last loaded. This is what
 *    every `fs:[…]` uses right now, so it must be written or the change is invisible to
 *    already-loaded FS.
 *  - GDT entry 3 (selector 0x18), the descriptor v86 re-reads from guest memory on the
 *    next FS selector load. Leave it at base 0 and an ordinary `push fs … pop fs` epilogue
 *    (Borland/Delphi RTL emits it) re-derives a base of 0, after which TEB reads hit
 *    linear 0. On Windows the FS descriptor is genuinely per-thread and the kernel
 *    rewrites it on every context switch — this mirrors that.
 *
 * Only the base fields are patched, so the limit/type bits stay owned by createGDTBytes().
 */
export function setFsBase(cpu: V86Cpu, tebAddress: number): void {
    const base = tebAddress >>> 0;

    if (cpu.segment_offsets) cpu.segment_offsets[4] = base | 0;

    // Descriptor base is split 15:0 / 23:16 / 31:24 across bytes +2..+3, +4 and +7.
    // No writeGuestCode/invalidateGuestCode here: these are DATA bytes. v86 re-reads the
    // descriptor through the segment-load helper at run time and never bakes it into a
    // compiled block, so the §3.1 coherence rule (JS writes of bytes the guest EXECUTES)
    // does not apply — even though the GDT shares page 0x7000 with the boot code.
    Mem.writeUint16(GDT_FS_DESCRIPTOR_ADDRESS + 2, base & 0xffff);
    Mem.writeUint8(GDT_FS_DESCRIPTOR_ADDRESS + 4, (base >>> 16) & 0xff);
    Mem.writeUint8(GDT_FS_DESCRIPTOR_ADDRESS + 7, (base >>> 24) & 0xff);
}

/** Read back the base the FS descriptor currently encodes (diagnostics + tests). */
export function readFsDescriptorBase(): number {
    const lo = Mem.readUint16(GDT_FS_DESCRIPTOR_ADDRESS + 2) ?? 0;
    const mid = Mem.readUint8(GDT_FS_DESCRIPTOR_ADDRESS + 4) ?? 0;
    const hi = Mem.readUint8(GDT_FS_DESCRIPTOR_ADDRESS + 7) ?? 0;
    return ((hi << 24) | (mid << 16) | lo) >>> 0;
}
