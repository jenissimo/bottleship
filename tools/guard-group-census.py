#!/usr/bin/env python3
"""Guard-group census: how many dynamic guest memory accesses could run WITHOUT a guard because an
earlier access in the same compiled module already validated the page they touch.

Input: a block dump from the guard-group census engine (tools/probes/guardgroup/: the Tier-2 trace
profiler extended to watch every page) - one record per JIT basic block with its CFG edges
(intra-module successors only), is_entry, exec count and the guest bytes. The x86 is decoded here
with capstone (full register def/use, implicit stack accesses), so a group ends exactly when its base
register is written, not at the first non-qualifying instruction.

Group = accesses through the same (segment, base, index, scale) key. The first access (anchor) checks
the whole static extent [min disp, max disp + width) of its members once; members emit no check. A
group ends at: a non-trackable write of base/index, any kill-all instruction (I/O - OUT is the thunk
and hypercall crossing, which can run JS that decommits pages -, INT/IRET/HLT/SYSENTER, CR/DR moves,
INVLPG, descriptor-table loads, far control transfer, segment-register writes), and the module
boundary: an entry block (reachable from the dispatcher) starts empty. Everything that can change a
translation (set_tlb_entry: TLB fill/flush, CR3, INVLPG, decommit) is outside module execution or
behind one of those instructions; a TLB capacity flush inside the group does not change the
identity translation it validated.

Models (all weighted by exec count):
  B0          the OLD census criterion (plan/perf-campaign; tools/bench-v86/prepare-guard-group-census.mjs):
              pure modrm reads 8/16/32, base w/o index, flat, forward disp <= 64 B, group closed by
              any instruction that performs no such read and at every basic block. Calibration only.
  S           basic block, strict: any write to base/index ends the group.
  SO          basic block, + constant-offset tracking (push/pop/add/sub/inc/dec/lea base,imm).
  MO          module-wide must-availability over intra-module edges, offset tracking; entry blocks
              start empty.                       <- the realisable design
  MO-sep      MO, but a read-validated page does not cover a later write (W covers R, not R->W).
  MO-noentry  MO ignoring the dispatcher edge into entry blocks (upper bound; needs path splitting).
  MOH         MO + loop-invariant bases hoisted to one check per loop entry (upper bound: loop
              entries estimated as count(header) - sum(count(latch)), which undercounts entries).

Page-cross fallback: the anchor's extent check fails when the extent straddles a page; the modelled
rate for extent L is (L - w_anchor)/4096 (uniform base alignment); `members_pc` applies it.

usage: python tools/guard-group-census.py <dump.json> [--out result.json] [--frames N]
       python tools/guard-group-census.py --selftest
"""
import json, sys, argparse
from collections import defaultdict

import capstone
from capstone import x86 as X

MD = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
MD.detail = True

GPR = {}
for i, names in enumerate([("eax", "ax", "al", "ah"), ("ecx", "cx", "cl", "ch"), ("edx", "dx", "dl", "dh"),
                           ("ebx", "bx", "bl", "bh"), ("esp", "sp", "spl"), ("ebp", "bp", "bpl"),
                           ("esi", "si", "sil"), ("edi", "di", "dil")]):
    for n in names:
        GPR[n] = i
ESP, EBP = 4, 5
SEGS = {"cs", "ds", "es", "ss", "fs", "gs"}

KILL_ALL_PREFIX = ("in", "out", "ins", "outs", "int", "into", "iret", "hlt", "sysenter", "sysexit",
                   "syscall", "sysret", "invlpg", "lgdt", "lidt", "lldt", "ltr", "lmsw", "clts", "wrmsr",
                   "ljmp", "lcall", "retf", "lret", "wbinvd", "invd", "rsm", "ud2", "ud0", "ud1")
NO_ACCESS = ("lea", "nop", "prefetch", "clflush", "fnop", "prefetchw", "prefetcht0", "prefetcht1",
             "prefetcht2", "prefetchnta")
REP_STRING = ("movs", "stos", "lods", "cmps", "scas", "ins", "outs")


def is_kill_all(ins):
    m = ins.mnemonic
    if m in ("in", "out", "int", "int1", "int3", "into", "hlt", "sysenter", "sysexit", "syscall",
             "invlpg", "lgdt", "lidt", "lldt", "ltr", "lmsw", "clts", "wrmsr", "ljmp", "lcall", "retf",
             "lret", "wbinvd", "invd", "rsm", "ud2", "ud0", "ud1", "iret", "iretd"):
        return True
    if m.startswith(("ins", "outs")) and m[:4] in ("insb", "insw", "insd", "outs"):
        return True
    if m.startswith("rep") and any(s in m for s in ("ins", "outs")):
        return True
    if m.startswith("mov") and ("cr" in ins.op_str or ins.op_str.startswith("dr") or ", dr" in ins.op_str):
        if any(t in ins.op_str.replace(",", " ").split() for t in
               ("cr0", "cr2", "cr3", "cr4", "dr0", "dr1", "dr2", "dr3", "dr6", "dr7")):
            return True
    if m in ("jmp", "call") and ins.op_str.startswith(("far", "0x") ) and ":" in ins.op_str:
        return True
    _, w = ins.regs_access()
    if any(MD.reg_name(r) in SEGS for r in w):
        return True
    return False


def seg_class(seg_reg):
    n = MD.reg_name(seg_reg) if seg_reg else None
    return n if n in ("fs", "gs") else "flat"


def decode_accesses(ins):
    """Ordered memory events of one instruction.
    Events: ('acc', kind, key, disp, width, cls) and ('reg', gpr, delta|None) and ('killall',).
    kind in R/W/RMW; key None = ungroupable (still counted)."""
    m = ins.mnemonic
    ev = []
    if is_kill_all(ins):
        ev.append(("killall",))
    rep = ins.prefix[0] in (0xF2, 0xF3) and any(m.startswith(s) or (" " + s) in (" " + m) for s in REP_STRING)
    explicit = []
    if not m.startswith(NO_ACCESS):
        for op in ins.operands:
            if op.type != X.X86_OP_MEM:
                continue
            acc = op.access
            kind = "RMW" if (acc & 1 and acc & 2) else ("W" if acc & 2 else "R")
            if acc == 0:
                kind = "R"
            mem = op.mem
            base = GPR.get(MD.reg_name(mem.base)) if mem.base else None
            index = GPR.get(MD.reg_name(mem.index)) if mem.index else None
            seg = seg_class(mem.segment)
            if rep:
                key, cls = None, "rep"
            elif base is None and index is None:
                key, cls = ("abs", seg, (mem.disp & 0xFFFFFFFF) >> 12), "abs"
            else:
                key = (seg, base, index, mem.scale if index is not None else 0)
                cls = "stack" if base in (ESP, EBP) else "reg"
            disp = (mem.disp & 0xFFF) if (key and key[0] == "abs") else mem.disp
            explicit.append(("acc", kind, key, disp, op.size or 4, cls, base is not None and index is None and seg == "flat" and not rep))
    # implicit stack traffic and the precise register effects
    osz = 2 if 0x66 in ins.prefix else 4
    stack = lambda kind, disp, width: ("acc", kind, ("flat", ESP, None, 0), disp, width, "stack", False)
    if m == "push" or m in ("pushfd", "pushf", "pushal", "pushaw", "pushad"):
        width = 32 if m.startswith("pusha") else osz
        ev += explicit
        ev.append(stack("W", -width, width))
        ev.append(("reg", ESP, -width))
    elif m == "pop" or m in ("popfd", "popf", "popal", "popaw", "popad"):
        width = 32 if m.startswith("popa") else osz
        ev.append(stack("R", 0, width))
        ev.append(("reg", ESP, width))
        ev += explicit  # pop [mem] addresses with the incremented esp
    elif m == "call":
        ev += explicit
        ev.append(stack("W", -4, 4))
        ev.append(("reg", ESP, -4))
    elif m in ("ret", "retn"):
        imm = ins.operands[0].imm if ins.operands else 0
        ev.append(stack("R", 0, 4))
        ev.append(("reg", ESP, 4 + imm))
    elif m == "leave":
        ev.append(("acc", "R", ("flat", EBP, None, 0), 0, 4, "stack", False))
        ev.append(("reg", ESP, None))
        ev.append(("reg", EBP, None))
    else:
        ev += explicit
    # remaining register writes (the ones not already modelled above)
    if m not in ("push", "pop", "call", "ret", "retn", "leave", "pushfd", "pushf", "popfd", "popf",
                 "pushal", "pushad", "popal", "popad", "pushaw", "popaw"):
        _, w = ins.regs_access()
        for r in sorted({GPR[MD.reg_name(x)] for x in w if MD.reg_name(x) in GPR}):
            ev.append(("reg", r, const_delta(ins, r)))
    elif m.startswith("popa"):
        for r in range(8):
            if r != ESP:
                ev.append(("reg", r, None))
    elif m == "pop":
        # pop reg: the destination register is written after esp moves
        ops = ins.operands
        if ops and ops[0].type == X.X86_OP_REG:
            n = MD.reg_name(ops[0].reg)
            if n in GPR:
                ev.append(("reg", GPR[n], None))
    return ev


def const_delta(ins, r):
    """reg += constant (full 32-bit register), else None."""
    m, ops = ins.mnemonic, ins.operands
    full = lambda op: op.type == X.X86_OP_REG and MD.reg_name(op.reg) in GPR and GPR[MD.reg_name(op.reg)] == r \
        and MD.reg_name(op.reg).startswith("e")
    if m in ("add", "sub") and len(ops) == 2 and full(ops[0]) and ops[1].type == X.X86_OP_IMM:
        v = ops[1].imm
        v = v - (1 << 32) if v >= (1 << 31) else v
        return v if m == "add" else -v
    if m in ("inc", "dec") and len(ops) == 1 and full(ops[0]):
        return 1 if m == "inc" else -1
    if m == "lea" and len(ops) == 2 and full(ops[0]):
        mem = ops[1].mem
        if mem.base and MD.reg_name(mem.base) in GPR and GPR[MD.reg_name(mem.base)] == r and not mem.index \
                and not mem.segment:
            return mem.disp
    return None


def decode_block(b):
    code = bytes.fromhex(b["hex"])
    insns = list(MD.disasm(code, b["addr"]))
    consumed = sum(i.size for i in insns)
    return insns, consumed == len(code) and len(insns) == b["n"]


# ---------------------------------------------------------------- analysis over one model

def analyse(blocks, model, killall_every=False, no_kill=False):
    """Returns per-access classification list [(block, kind, cls, is_member, anchors, offset, width)]
    plus anchor extents. model: S, SO, MO, MO-sep, MO-noentry."""
    by_addr = {b["addr"]: b for b in blocks}
    track = model != "S"
    module = model.startswith("MO")
    sep = model == "MO-sep"
    noentry = model == "MO-noentry"
    preds = defaultdict(list)
    for b in blocks:
        for s in (b["sf"], b["st"]):
            if s and s in by_addr and module:
                preds[s].append(b["addr"])

    def transfer(b, state, record):
        # state: key -> (delta, anchors frozenset, cap) ; cap 'W' covers R and W
        st = dict(state)
        for ii, ins in enumerate(b["insns"]):
            events = b["events"][ii]
            for e in events:
                if killall_every:
                    st = {}
                if e[0] == "killall":
                    if not no_kill:
                        st = {}
                elif e[0] == "reg":
                    _, r, d = e
                    if no_kill:
                        continue
                    for k in list(st):
                        if k[0] == "abs":
                            continue
                        if k[2] == r:
                            del st[k]
                        elif k[1] == r:
                            if track and d is not None:
                                dl, an, cap = st[k]
                                st[k] = (dl + d, an, cap)
                            else:
                                del st[k]
                else:
                    _, kind, key, disp, width, cls, _flat = e
                    need = "W" if (sep and kind != "R") else "R"
                    member = False
                    if key is not None and key in st and (st[key][2] == "W" or need == "R"):
                        dl, an, cap = st[key]
                        off = disp + dl if key[0] != "abs" else disp
                        if key[0] == "abs" and disp + width > 4096:
                            member = False
                        else:
                            member = True
                    if record is not None:
                        if member:
                            record.append((b["addr"], kind, cls, True, an, off, width, ii))
                        else:
                            aid = (b["addr"], ii, disp)
                            record.append((b["addr"], kind, cls, False, frozenset([aid]), disp, width, ii))
                    if not member and key is not None:
                        cap = "W" if (not sep or kind != "R") else "R"
                        if key[0] == "abs" and disp + width > 4096:
                            continue
                        st[key] = (0 if key[0] != "abs" else 0, frozenset([(b["addr"], ii, disp)]), cap)
                        if key[0] == "abs":
                            st[key] = (0, frozenset([(b["addr"], ii, disp)]), cap)
                    elif member and sep and kind != "R" and st[key][2] == "R":
                        pass
        return st

    def meet(states):
        states = [s for s in states if s is not None]
        if not states:
            return {}
        out = {}
        for k, (dl, an, cap) in states[0].items():
            ok = True
            anchors = set(an)
            c = cap
            for s in states[1:]:
                v = s.get(k)
                if v is None or v[0] != dl:
                    ok = False
                    break
                anchors |= v[1]
                if v[2] != "W":
                    c = "R"
            if ok:
                out[k] = (dl, frozenset(anchors), c)
        return out

    out_state = {}
    if module:
        order = sorted(by_addr)
        changed = True
        it = 0
        while changed and it < 50:
            changed = False
            it += 1
            for a in order:
                b = by_addr[a]
                ps = preds.get(a, [])
                if (b["entry"] and not noentry) or not ps:
                    ins = {}
                else:
                    ins = meet([out_state.get(p) for p in ps])
                o = transfer(b, ins, None)
                if out_state.get(a) != o:
                    out_state[a] = o
                    changed = True
        converged = not changed
    else:
        converged = True
    record = []
    for a in sorted(by_addr):
        b = by_addr[a]
        if module:
            ps = preds.get(a, [])
            ins = {} if ((b["entry"] and not noentry) or not ps) else meet([out_state.get(p) for p in ps])
        else:
            ins = {}
        transfer(b, ins, record)
    return record, converged


def old_criterion(blocks):
    """B0: the prepare-guard-group-census.mjs rule, per basic block."""
    rec = []
    for b in blocks:
        prev_base, prev_disp = -1, 0
        for ii, ins in enumerate(b["insns"]):
            touched = False
            for e in b["events"][ii]:
                if e[0] != "acc":
                    continue
                _, kind, key, disp, width, cls, flatmodrm = e
                if kind != "R" or not flatmodrm or width not in (1, 2, 4) or key is None:
                    continue
                if ins.mnemonic in ("pop", "ret", "retn", "leave", "popfd", "popad", "popal"):
                    continue
                base = key[1]
                covered = prev_base == base and disp >= prev_disp and disp - prev_disp + width <= 64
                rec.append((b["addr"], kind, cls, covered, None, disp, width, ii))
                touched = True
                if not covered:
                    prev_base, prev_disp = base, disp
            if not touched:
                prev_base = -1
    return rec


def summarise(blocks, record, pagecross=True):
    cnt = {b["addr"]: b["exec"] for b in blocks}
    # anchor extents
    ext = {}
    for (a, kind, cls, mem, anchors, off, w, ii) in record:
        if anchors is None:
            continue
        for an in anchors:
            lo, hi = ext.get(an, (off, off + w))
            ext[an] = (min(lo, off), max(hi, off + w))
    tot = defaultdict(float)
    mem_ = defaultdict(float)
    mem_pc = defaultdict(float)
    for (a, kind, cls, member, anchors, off, w, ii) in record:
        c = cnt[a]
        for k in ("all", kind, cls, kind + ":" + cls):
            tot[k] += c
        if member:
            p = 0.0
            if anchors is not None and pagecross and cls != "abs":  # an absolute page is known statically
                for an in anchors:
                    lo, hi = ext[an]
                    p = max(p, max(0, (hi - lo) - 4) / 4096.0)
            for k in ("all", kind, cls, kind + ":" + cls):
                mem_[k] += c
                mem_pc[k] += c * (1 - min(1.0, p))
    return {k: {"accesses": tot[k], "members": mem_[k], "members_pc": mem_pc[k],
                "share": mem_[k] / tot[k] if tot[k] else 0, "share_pc": mem_pc[k] / tot[k] if tot[k] else 0}
            for k in sorted(tot)}


def loops_hoist(blocks, record_mo):
    """MOH upper bound: accesses in a natural loop whose key is loop-invariant become members,
    paying one anchor per loop entry (entries estimated low => bound is optimistic)."""
    by_addr = {b["addr"]: b for b in blocks}
    succ = {b["addr"]: [s for s in (b["sf"], b["st"]) if s and s in by_addr] for b in blocks}
    preds = defaultdict(list)
    for a, ss in succ.items():
        for s in ss:
            preds[s].append(a)
    # dominators within module components (iterative, entry blocks as roots)
    nodes = sorted(by_addr)
    roots = [a for a in nodes if by_addr[a]["entry"] or not preds[a]]
    dom = {a: set(nodes) for a in nodes}
    for r in roots:
        dom[r] = {r}
    changed = True
    while changed:
        changed = False
        for a in nodes:
            if a in roots:
                continue
            ps = [dom[p] for p in preds[a]]
            nd = set.intersection(*ps) | {a} if ps else {a}
            if nd != dom[a]:
                dom[a] = nd
                changed = True
    loops = defaultdict(set)  # header -> body
    latches = defaultdict(set)
    for a in nodes:
        for s in succ[a]:
            if s in dom[a]:  # back edge a->s
                latches[s].add(a)
                body = {s, a}
                stack = [a]
                while stack:
                    x = stack.pop()
                    for p in preds[x]:
                        if p not in body:
                            body.add(p)
                            stack.append(p)
                loops[s] |= body
    extra = 0.0  # members gained
    cost = 0.0   # anchors paid (loop entries)
    for h, body in loops.items():
        entries = max(0.0, by_addr[h]["exec"] - sum(by_addr[l]["exec"] for l in latches[h]))
        written, killall = set(), False
        for a in body:
            for evs in by_addr[a]["events"]:
                for e in evs:
                    if e[0] == "killall":
                        killall = True
                    elif e[0] == "reg":
                        written.add(e[1])
        if killall:
            continue
        keys = set()
        for (a, kind, cls, member, anchors, off, w, ii) in record_mo:
            if a in body and not member:
                ev = [e for e in by_addr[a]["events"][ii] if e[0] == "acc"]
                for e in ev:
                    k = e[2]
                    if k is None:
                        continue
                    if k[0] == "abs" or (k[1] not in written and (k[2] is None or k[2] not in written)):
                        keys.add(k)
                        extra += by_addr[a]["exec"] / max(1, len(ev))
        cost += entries * len(keys)
    return {"loops": len(loops), "extraMembers": extra, "entryAnchors": cost}


def prepare(blocks):
    bad = 0
    for b in blocks:
        insns, ok = decode_block(b)
        if not ok:
            bad += 1
        b["insns"] = insns
        b["events"] = [decode_accesses(i) for i in insns]
    return bad


def run(dump, frames=None):
    blocks = [b for b in dump["blocks"] if b.get("hex")]
    bad = prepare(blocks)
    res = {"blocks": len(blocks), "decodeMismatch": bad,
           "execBlocks": sum(1 for b in blocks if b["exec"] > 0),
           "dynInsns": sum(b["exec"] * len(b["insns"]) for b in blocks),
           "dynInsnsEngine": sum(b["exec"] * b["n"] for b in blocks)}
    res["B0"] = summarise(blocks, old_criterion(blocks), pagecross=False)
    for model in ("S", "SO", "MO", "MO-sep", "MO-noentry"):
        rec, conv = analyse(blocks, model)
        res[model] = summarise(blocks, rec)
        res[model]["_converged"] = conv
        if model == "MO":
            res["MOH"] = loops_hoist(blocks, rec)
    # instrument must be able to fail: a kill before every event leaves exactly no members,
    # and removing all kills can only raise coverage.
    rec, _ = analyse(blocks, "MO", killall_every=True)
    res["ctl_killEvery"] = summarise(blocks, rec)["all"]
    rec, _ = analyse(blocks, "MO", no_kill=True)
    res["ctl_noKill"] = summarise(blocks, rec)["all"]
    if frames:
        res["frames"] = frames
    return res


# ---------------------------------------------------------------- self test (negative control)

def selftest():
    def blk(addr, hexs, sf=0, st=0, entry=False, exec_=1):
        code = bytes.fromhex(hexs.replace(" ", ""))
        n = len(list(MD.disasm(code, addr)))
        return {"addr": addr, "end": addr + len(code), "hex": code.hex(), "n": n, "sf": sf, "st": st,
                "entry": entry, "exec": exec_}
    cases = []
    # T1: three reads through esi: 1 anchor + 2 members in every model
    cases.append(("T1 same base", [blk(0x1000, "8B06 8B5E04 8B4E08 C3", entry=True)],
                  {"S": 2, "SO": 2, "MO": 2, "B0": 2}))
    # T2: esi reloaded from itself: [esi+4] is still a member, [esi+8] after the write is an anchor
    cases.append(("T2 base write kills", [blk(0x1000, "8B06 8B7604 8B4E08 C3", entry=True)],
                  {"S": 1, "SO": 1, "MO": 1, "B0": 2}))  # B0 cannot see the write (its known blind spot)
    # T3: cross-block: B1 [edi] -> B2 (not entry) [edi+8]
    cases.append(("T3 cross block", [blk(0x1000, "8B07 7402", sf=0x1004, st=0x1006, entry=True),
                                     blk(0x1004, "EB00", sf=0x1006),
                                     blk(0x1006, "8B5F08 C3")],
                  {"S": 0, "SO": 0, "MO": 1, "MO-noentry": 1, "B0": 0}))
    # T4: same but B2 is an entry block -> MO anchor, noentry member
    cases.append(("T4 entry resets", [blk(0x1000, "8B07 EB00", sf=0x1004, entry=True),
                                      blk(0x1004, "8B5F08 C3", entry=True)],
                  {"MO": 0, "MO-noentry": 1}))
    # T5: OUT between reads kills
    cases.append(("T5 OUT kills", [blk(0x1000, "8B06 EF 8B5E04 C3", entry=True)], {"S": 0, "MO": 0}))
    # T6: push between stack reads: strict kills, offset tracking keeps; ret read [esp] after push:
    #   SO/MO: [esp+4] anchor, push write [esp-4] member, [esp+8] member, ret [esp] member => 3
    cases.append(("T6 offset tracking", [blk(0x1000, "8B442404 53 8B4C2408 C3", entry=True)],
                  {"S": 2, "SO": 3, "MO": 3}))
    # T7: join with different esp deltas kills the esp group
    #   push in B2 is a member (delta 0); at B3 the deltas differ (0 vs -4): [esp+8] must be an
    #   anchor (a join that ignored deltas would make it a member: 3), the ret after it a member.
    cases.append(("T7 delta mismatch at join", [blk(0x1000, "8B0424 7403", sf=0x1005, st=0x1008, entry=True),
                                                blk(0x1005, "53 EB00", sf=0x1008),
                                                blk(0x1008, "8B442408 C3")],
                  {"MO": 2}))
    # T8: RMW/x87/moffs: [esi+10] W anchor... then RMW, fld m64, two moffs on one page
    cases.append(("T8 kinds", [blk(0x1000, "894610 014614 DD4618 A100106000 8B1D04106000 C3", entry=True)],
                  {"S": 3, "MO": 3}))
    # T9: sep: read anchor does not cover a later write
    cases.append(("T9 R does not cover W", [blk(0x1000, "8B06 894604 C3", entry=True)], {"MO": 1, "MO-sep": 0}))
    fails = []
    for name, blocks, want in cases:
        prepare(blocks)
        for model, exp in want.items():
            if model == "B0":
                rec = old_criterion(blocks)
                got = sum(1 for r in rec if r[3])
            else:
                rec, _ = analyse(blocks, model)
                got = sum(1 for r in rec if r[3])
            status = "ok" if got == exp else "FAIL"
            if got != exp:
                fails.append((name, model, exp, got))
            print(f"{status:4} {name:28} {model:11} want {exp} got {got}")
    # mutation: the checks above must be able to fail
    blocks = [blk(0x1000, "8B06 8B7604 8B4E08 C3", entry=True)]
    prepare(blocks)
    rec, _ = analyse(blocks, "MO", no_kill=True)
    mutated = sum(1 for r in rec if r[3])
    print(f"mutation no_kill on T2: {mutated} members (the correct analysis says 1) ->",
          "detected" if mutated != 1 else "NOT DETECTED")
    if mutated == 1:
        fails.append(("mutation", "no_kill", "!=1", mutated))
    print("SELFTEST", "FAILED" if fails else "PASSED", fails)
    return not fails


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("dump", nargs="?")
    ap.add_argument("--out")
    ap.add_argument("--frames", type=float)
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(0 if selftest() else 1)
    dump = json.load(open(a.dump))
    res = run(dump, a.frames or dump.get("frames"))
    s = json.dumps(res, indent=1, default=str)
    if a.out:
        open(a.out, "w").write(s)
    print(s[:6000])
