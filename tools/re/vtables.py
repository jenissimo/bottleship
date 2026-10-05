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
    an inference: every REACHABLE return site has to agree, and disagreement is
    reported rather than hidden. Reachable, not "in the address range": see measure().

Ghidra-free (PE + capstone only), so it answers for any DLL on disk without opening
a project. Driven as `bun tools/re/re.ts vtable <binary> <ClassName|0xVFTABLE>`.
"""

import json
import re
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


CMP_IMM = re.compile(r"^e[a-z]{2}, (0x[0-9a-f]+|\d+)$")
JMP_TABLE = re.compile(r"^dword ptr \[(?:e[a-z]{2}\*4 \+ )?(0x[0-9a-f]+)(?:\s*\+\s*e[a-z]{2}\*4)?\]$")


def switch_targets(img, ins, bound):
    """`jmp dword ptr [tbl + reg*4]` -> the case arms, bounded by the preceding `cmp`."""
    if ins.mnemonic != "jmp" or bound is None or not 0 <= bound < 512:
        return []
    m = JMP_TABLE.match(ins.op_str)
    if not m:
        return []
    off = img.off(int(m.group(1), 16))
    if off is None:
        return []
    out = []
    for i in range(bound + 1):
        t = img.u32(off + i * 4)
        if img.section(t) != ".text":
            break
        out.append(t)
    return out


def measure(img, va, budget=6000):
    """
    Reachable `RET imm16` -> pushed-arg count.

    The walk FOLLOWS CONTROL FLOW rather than reading straight through, because a
    linear read of an MSVC /EHsc body is not a read of the function: the compiler
    lays the `__unwind$`/`__catch$` funclets inside the same address range, and a
    funclet is CALLED, so it ends in a bare `ret`. A linear reader collects those
    alongside the epilogue and then either reports a conflict or — when a funclet
    precedes the epilogue — answers `0` for a method that cleans up arguments. A
    wrong arity is the one failure this tool exists to prevent, and a plausible
    `0` is worse than a refusal. Funclets are unreachable from the entry, so
    following branches leaves them out by construction.
    """
    off = img.off(va)
    if off is None:
        return {"error": "target is not in the image's raw bytes"}
    head = [f"{i.mnemonic} {i.op_str}".strip()
            for i in list(img.md.disasm(img.data[off:off + 64], va))[:8]]
    rets, seen, work = [], set(), [va]
    truncated = False
    while work:
        pc = work.pop()
        bound = None  # the `cmp reg, N` that fronts a switch's `jmp [tbl + reg*4]`
        while True:
            if pc in seen:
                break
            if len(seen) >= budget:
                truncated = True
                break
            o = img.off(pc)
            if o is None:
                break
            ins = next(img.md.disasm(img.data[o:o + 16], pc), None)
            if ins is None:
                break
            seen.add(pc)
            if ins.mnemonic == "ret":
                rets.append(int(ins.op_str, 16) if ins.op_str else 0)
                break
            if ins.mnemonic == "int3":
                break
            if ins.mnemonic == "cmp":
                m = CMP_IMM.match(ins.op_str)
                bound = int(m.group(1), 0) if m else None
            if ins.mnemonic in JCC:
                if not ins.op_str.startswith("0x"):
                    # A switch compiles to `cmp reg, N / ja default / jmp [tbl + reg*4]`.
                    # Without the table every case arm is unreachable, and a body whose
                    # only returns live in the arms then reads as "no RET" — measurable
                    # code refused for want of one indirection. The `cmp` bounds the
                    # table; anything else indirect really is unreadable.
                    for t in switch_targets(img, ins, bound):
                        work.append(t)
                    break
                target = int(ins.op_str, 16)
                if img.section(target) != ".text":
                    break
                if ins.mnemonic == "jmp":
                    pc = target
                    continue
                work.append(target)
            pc = ins.address + ins.size
    out = {"head": head}
    if not rets:
        out["args"] = None
        out["note"] = ("no RET reached — an indirect tail-jump, a noreturn body, or a walk "
                       "that ran out of budget" if truncated else
                       "no RET reached — an indirect tail-jump or a noreturn body")
        return out
    imms = sorted(set(rets))
    out["retImm"] = imms[0]
    if len(imms) > 1:
        # Two different cleanups on reachable paths means the walk left the function
        # (a followed tail-jump, most likely) — not something to average.
        out["args"] = None
        out["conflictingRets"] = imms
        out["note"] = "return sites disagree — read the body before trusting an arity"
        return out
    out["args"] = imms[0] // 4
    if truncated:
        out["note"] = "walk hit the instruction budget — some return sites may be unread"
    return out


EAX8 = re.compile(r"^(al|ah)\b")
IMM_ONLY = re.compile(r"^(mov [0-9]|zero$)")
PASCAL = re.compile(r"^[A-Z][A-Za-z0-9]{3,}$")
_touches_eax = {}


def touches_eax(img, va):
    """Does this callee write EAX at all? The epilogue's `__security_check_cookie` does
    not, and treating it as a clobber loses every return value in a /GS binary."""
    if va in _touches_eax:
        return _touches_eax[va]
    _touches_eax[va] = True  # recursion guard: assume the worst
    off = img.off(va)
    if off is None:
        return True
    hit = False
    for i in img.md.disasm(img.data[off:off + 0x200], va):
        mn = i.mnemonic.replace("bnd ", "")
        dst = i.op_str.split(",")[0].strip()
        if mn == "call" or dst in ("eax", "ax", "al", "ah") or mn in ("cdq", "cwde"):
            hit = True
            break
        if mn in ("ret", "int3", "jmp"):
            break
    _touches_eax[va] = hit
    return hit


def returns(img, va, argc, budget=8000):
    """
    What the reachable return paths leave in EAX — the OTHER half of the contract.

    An HLE stub that answers 0 is only correct where the real method returns void, a bool
    or an integer; for a slot that returns a pointer, 0 is a NULL the guest dereferences.
    Arity alone cannot tell those apart, and a stub table built from arity alone will
    crash on the first `const char*` getter it meets.

    Kinds are only claimed where the evidence is unambiguous — every path an 8-bit write
    (bool), every path an immediate (an enum), or the single pushed argument handed back
    (MSVC's struct-by-value hidden buffer). Everything else reports `null` with the raw
    defining instructions, because a confident wrong kind here is worse than none.
    """
    off = img.off(va)
    if off is None:
        return {}
    defs, seen, work = [], set(), [(va, "none")]
    while work:
        pc, state = work.pop()
        bound = None
        while True:
            if (pc, state) in seen or len(seen) >= budget:
                break
            o = img.off(pc)
            if o is None:
                break
            ins = next(img.md.disasm(img.data[o:o + 16], pc), None)
            if ins is None:
                break
            seen.add((pc, state))
            m, ops = ins.mnemonic, ins.op_str
            if m == "ret":
                defs.append(state)
                break
            if m == "int3":
                break
            if m == "call":
                if not ops.startswith("0x"):
                    state = "call *"
                elif touches_eax(img, resolve_thunk(img, int(ops, 16))):
                    state = f"call {ops}"
            elif m == "xor" and ops == "eax, eax":
                state = "zero"
            elif m in ("mov", "movzx", "movsx", "lea") and ops.startswith("eax,"):
                state = f"{'lea' if m == 'lea' else 'mov'} {ops[5:]}"
            elif EAX8.match(ops.split(",")[0].strip() + " ") or (m.startswith("set") and EAX8.match(ops)):
                state = "byte"
            if m in JCC:
                if not ops.startswith("0x"):
                    for t in switch_targets(img, ins, bound):
                        work.append((t, state))
                    break
                t = int(ops, 16)
                if img.section(t) != ".text":
                    break
                if m == "jmp":
                    pc = t
                    continue
                work.append((t, state))
            if m == "cmp":
                mm = CMP_IMM.match(ops)
                bound = int(mm.group(1), 0) if mm else None
            pc = ins.address + ins.size
    defs = sorted(set(defs))
    out = {"eaxDefs": defs}
    if not defs:
        return out
    if all(d == "byte" for d in defs):
        out["returns"] = "bool"
    elif all(IMM_ONLY.match(d) for d in defs):
        out["returns"] = "int"
    elif argc == 1 and defs == ["mov esi"] and first_arg_into_esi(img, va):
        # `mov esi, [ebp+8]` … `mov eax, esi` with exactly one pushed argument: that
        # argument is the hidden return buffer, not a parameter.
        out["returns"] = "sret"
    else:
        out["returns"] = None
    return out


def first_arg_into_esi(img, va, window=0x80):
    off = img.off(va)
    for i in img.md.disasm(img.data[off:off + window], va):
        if i.mnemonic == "mov" and i.op_str == "esi, dword ptr [ebp + 8]":
            return True
    return False


def self_name(img, va):
    """
    The name the body logs for ITSELF. Many C++ facades push their own method name as a
    literal for an error/trace format string, which names a slot that has no RTTI of its
    own. Reported as `selfName` because it is a strong hint, not a symbol: it is simply
    the first PascalCase C string the body pushes, and a method that logs something else
    first will be misnamed. Verify before treating it as the method's identity.
    """
    end = body_end(img, va)
    off = img.off(va)
    for i in img.md.disasm(img.data[off:off + end], va):
        if i.mnemonic != "push":
            continue
        for tok in re.findall(r"0x[0-9a-f]{8}", i.op_str):
            s = cstr(img, int(tok, 16))
            if s and PASCAL.match(s):
                return s
    return None


def body_end(img, va, cap=0x3000):
    """First int3 padding run after the entry — the linker's function boundary."""
    off = img.off(va)
    run = 0
    for i in img.md.disasm(img.data[off:off + cap], va):
        if i.mnemonic == "int3":
            run += 1
            if run >= 4:
                return i.address - 3 - va
        else:
            run = 0
    return cap


def cstr(img, va, limit=200):
    o = img.off(va)
    if o is None:
        return None
    e = img.data.find(b"\0", o, o + limit)
    if e < 0:
        return None
    s = img.data[o:e]
    return s.decode("latin1") if s and all(0x20 <= c < 0x7f for c in s) else None


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
        slot.update(returns(img, real, slot.get("args")))
        name = self_name(img, real)
        if name:
            slot["selfName"] = name
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
