#!/usr/bin/env python
"""
Read a C++ vtable out of a 32-bit PE the way the linker wrote it, so an HLE
interface can be TRANSCRIBED instead of guessed.

Guessing a vtable is a recurring, expensive failure in this codebase (ID3DXEffect,
galaxy::api::IGalaxy): slot N answered with a method of a different arg count, the
callee-cleanup `RET imm16` walks the caller's ESP off its own frame, and the fault
lands in unrelated code. Both the ORDER and the ARITY are observable in the binary
that defines them:

  - MSVC emits RTTI. The type descriptor for `Foo` holds the string `.?AVFoo@ns@@`
    eight bytes past its own start; a complete-object locator points at it, and the
    vftable is the dword right after the pointer to that locator. So a class name is
    enough to find every vtable the class has (one per base with its own layout).
  - `this` is in ECX (__thiscall), so a slot's `RET imm16 / 4` is exactly the number
    of PUSHED arguments — the count an HLE stub must clean. It is a measurement, not
    an inference: every return site in the body has to agree, and disagreement is
    reported rather than hidden.

Ghidra-free (PE + capstone only), so it answers for any DLL on disk without opening
a project. Driven as `bun tools/re/re.ts vtable <binary> <ClassName|0xVFTABLE>`.
"""

import json
import struct
import sys

from capstone import CS_ARCH_X86, CS_MODE_32, Cs

JCC = {
    "jmp", "je", "jne", "jz", "jnz", "jg", "jge", "jl", "jle", "ja", "jae",
    "jb", "jbe", "js", "jns", "jo", "jno", "jp", "jnp", "jcxz", "jecxz",
}


class Image:
    def __init__(self, path):
        self.data = open(path, "rb").read()
        d = self.data
        pe = struct.unpack_from("<I", d, 0x3C)[0]
        if d[pe:pe + 4] != b"PE\0\0":
            raise ValueError("not a PE image")
        if struct.unpack_from("<H", d, pe + 24)[0] != 0x10B:
            raise ValueError("only 32-bit (PE32) images carry the __thiscall layout this reads")
        nsec = struct.unpack_from("<H", d, pe + 6)[0]
        optsz = struct.unpack_from("<H", d, pe + 20)[0]
        self.base = struct.unpack_from("<I", d, pe + 24 + 28)[0]
        self.secs = []
        for i in range(nsec):
            o = pe + 24 + optsz + i * 40
            name = d[o:o + 8].rstrip(b"\0").decode("latin1")
            vsize, vaddr, rsize, rptr = struct.unpack_from("<IIII", d, o + 8)
            self.secs.append((name, vaddr, vsize, rptr, rsize))
        self.md = Cs(CS_ARCH_X86, CS_MODE_32)

    def off(self, va):
        """File offset for a VA, or None when it is outside the raw (on-disk) bytes."""
        rva = va - self.base
        for _, vaddr, vsize, rptr, rsize in self.secs:
            if vaddr <= rva < vaddr + max(vsize, rsize):
                delta = rva - vaddr
                return rptr + delta if delta < rsize else None
        return None

    def va(self, off):
        for _, vaddr, _vs, rptr, rsize in self.secs:
            if rptr <= off < rptr + rsize:
                return self.base + vaddr + (off - rptr)
        return None

    def section(self, va):
        rva = va - self.base
        for name, vaddr, vsize, _rptr, rsize in self.secs:
            if vaddr <= rva < vaddr + max(vsize, rsize):
                return name
        return None

    def u32(self, off):
        return struct.unpack_from("<I", self.data, off)[0]


def resolve_thunk(img, va, depth=0):
    """Incremental linking puts a table of `jmp real` in front of everything; follow it."""
    off = img.off(va)
    if off is None or depth > 3:
        return va
    ins = list(img.md.disasm(img.data[off:off + 16], va))
    if ins and ins[0].mnemonic == "jmp" and ins[0].op_str.startswith("0x"):
        return resolve_thunk(img, int(ins[0].op_str, 16), depth + 1)
    return va


def measure(img, va, window=0x800):
    """Every `RET imm16` in the body -> pushed-arg count. Disagreement is reported."""
    off = img.off(va)
    if off is None:
        return {"error": "target is not in the image's raw bytes"}
    rets, furthest, head = [], va, []
    for i in img.md.disasm(img.data[off:off + window], va):
        if len(head) < 8:
            head.append(f"{i.mnemonic} {i.op_str}".strip())
        if i.mnemonic in JCC and i.op_str.startswith("0x"):
            t = int(i.op_str, 16)
            if furthest < t < va + window:
                furthest = t
        if i.mnemonic == "ret":
            rets.append(int(i.op_str, 16) if i.op_str else 0)
            if i.address >= furthest:
                break
        elif i.mnemonic == "int3" and i.address >= furthest and rets:
            break
    out = {"head": head}
    if not rets:
        out["args"] = None
        out["note"] = "no RET reached — a tail-jump or a body longer than the window"
        return out
    out["args"] = rets[0] // 4
    out["retImm"] = rets[0]
    if len(set(rets)) > 1:
        out["conflictingRets"] = sorted(set(rets))
        out["args"] = None
        out["note"] = "return sites disagree — read the body before trusting an arity"
    return out


def read_vtable(img, vt, limit):
    slots = []
    off = img.off(vt)
    for i in range(limit):
        target = img.u32(off + i * 4)
        if img.section(target) != ".text":
            break
        real = resolve_thunk(img, target)
        slot = {"index": i, "entry": f"0x{target:08x}"}
        if real != target:
            slot["target"] = f"0x{real:08x}"
        slot.update(measure(img, real))
        slots.append(slot)
    return slots


def type_descriptor(img, cls):
    """`Foo@ns@@` (with or without the leading `.?AV`) -> the descriptor's VA."""
    # A template's own mangling starts with `?$`, so the prefix is prepended verbatim.
    name = cls if cls.startswith(".?A") else ".?AV" + cls
    idx = img.data.find(name.encode("latin1") + b"\0")
    if idx < 0:
        return None, name
    return img.va(idx - 8), name


def vftables_for(img, td_va):
    """Every complete-object locator naming this descriptor, and the vftable each fronts."""
    out = []
    needle = struct.pack("<I", td_va)
    pos = 0
    while True:
        pos = img.data.find(needle, pos)
        if pos < 0:
            break
        col_off, pos = pos - 12, pos + 1
        if col_off < 0 or img.u32(col_off) != 0:  # COL signature (32-bit RTTI) is 0
            continue
        col_va = img.va(col_off)
        if col_va is None:
            continue
        base_offset = img.u32(col_off + 4)
        ref = 0
        col_needle = struct.pack("<I", col_va)
        while True:
            ref = img.data.find(col_needle, ref)
            if ref < 0:
                break
            vt = img.va(ref + 4)
            ref += 1
            if vt is not None and img.section(vt) == ".rdata":
                out.append((col_va, base_offset, vt))
    return out


def main():
    argv = sys.argv[1:]
    limit = 200
    if "--slots" in argv:
        i = argv.index("--slots")
        limit = int(argv[i + 1])
        del argv[i:i + 2]
    if len(argv) < 2:
        print("usage: vtables.py <binary> <ClassName|0xVFTABLE> [--slots N]", file=sys.stderr)
        return 2
    img = Image(argv[0])
    target = argv[1]

    if target.lower().startswith("0x"):
        vt = int(target, 16)
        result = {"binary": argv[0], "imageBase": f"0x{img.base:08x}",
                  "vftables": [{"address": f"0x{vt:08x}", "slots": read_vtable(img, vt, limit)}]}
    else:
        td, mangled = type_descriptor(img, target)
        if td is None:
            print(json.dumps({"error": f"no RTTI type descriptor named {mangled}",
                              "hint": "MSVC only emits one when the class has a virtual "
                                      "function and /GR is on; try the vftable address"}), file=sys.stderr)
            return 1
        tables = []
        for col_va, base_offset, vt in vftables_for(img, td):
            tables.append({"completeObjectLocator": f"0x{col_va:08x}", "baseOffset": base_offset,
                           "address": f"0x{vt:08x}", "slots": read_vtable(img, vt, limit)})
        result = {"binary": argv[0], "imageBase": f"0x{img.base:08x}",
                  "class": mangled, "typeDescriptor": f"0x{td:08x}", "vftables": tables}
    print(json.dumps(result, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
