#!/usr/bin/env python3
"""STATIC cross-check for perf-campaign measurement 2 (the stack-access census).

    python tools/aot/stack-class-census.py --self-test
    python tools/aot/stack-class-census.py --exe tmp/nfsu/Speed.exe --pages 5d3,5d4,672,40c,5cb \
        --weights 5d3:767.3e6,5d4:390.6e6,672:149.1e6,40c:195.6e6,5cb:204.1e6

Classifies every memory operand of every decoded instruction into the classes the stack-fastmem
mode-1 guard cares about (`plan/perf-campaign/v86-emitter-target-architecture.md` §3 lever 2):

    esp    base is ESP, no index, 32-bit addressing   -> a window around ESP covers it
    ebp    base is EBP, no index, 32-bit addressing   -> covered ONLY if EBP is proven in-window
    other  any other base, or an index register, or an absolute address
    seg    carries a non-default segment prefix (FS/GS) -- not flat, never eligible

WHAT THIS IS AND IS NOT. It is STATIC and therefore NOT the measurement: the guard cost is paid
per EXECUTED read, and a static sweep weights a once-executed instruction the same as a hot loop
body. `--weights` recovers PAGE-level execution weighting and no more -- it still assumes the mix
is uniform inside a page. It is here as an INDEPENDENT prior for the runtime census
(tools/bench-v86/prepare-stack-class-census.mjs): the two instruments share no code, so an
ESP/EBP mix that disagrees between them is one of them being wrong, loudly.

Its own known contamination, inherited from tools/aot/capstone-lengths.py and stated there too:
instruction boundaries come from a LINEAR sweep with one byte of resync, so jump tables, padding
and constant pools decode as instructions. Ranking is robust to that; absolute percentages are not.
"""
import argparse
import json
from collections import Counter

from capstone import Cs, CS_ARCH_X86, CS_MODE_32
from capstone.x86 import X86_OP_MEM, X86_REG_ESP, X86_REG_EBP, X86_REG_INVALID

ap = argparse.ArgumentParser()
ap.add_argument("--exe", default="tmp/nfsu/Speed.exe")
ap.add_argument("--pages", default="5d3,5d4,672,40c,5cb",
                help="comma-separated hex page numbers, or 'text' for every page of the PE's "
                     "first executable section (unweighted: a whole-section sweep answers 'is "
                     "this title's ESP/EBP idiom like NFSU's', not 'what does the guard cost')")
ap.add_argument("--image-base", default="0x400000")
ap.add_argument("--weights", default="",
                help="page:instructions-executed pairs, e.g. 5d3:767.3e6,5d4:390.6e6")
ap.add_argument("--self-test", action="store_true",
                help="classify hand-encoded instructions whose class is known by construction, "
                     "including the two bypasses this census must not miss: an index register on "
                     "an ESP/EBP base, and a segment override")
a = ap.parse_args()

md = Cs(CS_ARCH_X86, CS_MODE_32)
md.detail = True

# An explicit segment override. modrm::stack_const_is_flat rejects anything whose segment is not
# DS/SS/CS under flat segmentation; capstone reports an override in op.mem.segment and INVALID
# when there is none, which is the same population for 32-bit game code.
FLAT_OK = {X86_REG_INVALID}


def classify(op):
    m = op.mem
    if m.segment not in FLAT_OK:
        return "seg"
    if m.index != X86_REG_INVALID:
        return "other"
    if m.base == X86_REG_ESP:
        return "esp"
    if m.base == X86_REG_EBP:
        return "ebp"
    return "other"


def sweep(buf, va):
    """Linear sweep with 1-byte resync. Returns (reads, writes, insn_count, undecoded)."""
    reads, writes = Counter(), Counter()
    n = 0
    bad = 0
    i = 0
    while i < len(buf):
        got = None
        for ins in md.disasm(bytes(buf[i:i + 16]), va + i, count=1):
            got = ins
        if got is None:
            bad += 1
            i += 1
            continue
        n += 1
        for op in got.operands:
            if op.type != X86_OP_MEM:
                continue
            cls = classify(op)
            # capstone per-operand access flags: CS_AC_READ = 1, CS_AC_WRITE = 2
            if op.access & 1:
                reads[cls] += 1
            if op.access & 2:
                writes[cls] += 1
        i += got.size
    return reads, writes, n, bad


# (encoding, disassembly, expected read class, expected write class)
SELF_TEST = [
    ("8b4508", "mov eax, [ebp+8]", "ebp", None),
    ("8b442404", "mov eax, [esp+4]", "esp", None),
    ("8b06", "mov eax, [esi]", "other", None),
    ("8b440604", "mov eax, [esi+eax+4]", "other", None),
    ("8b442c04", "mov eax, [esp+ebp+4]", "other", None),
    ("64a100000000", "mov eax, fs:[0]", "seg", None),
    ("894508", "mov [ebp+8], eax", None, "ebp"),
    ("89442404", "mov [esp+4], eax", None, "esp"),
    ("014508", "add [ebp+8], eax", "ebp", "ebp"),
    ("a100104000", "mov eax, [0x401000]", "other", None),
]

if a.self_test:
    fails = []
    for enc, text, want_r, want_w in SELF_TEST:
        raw = bytes.fromhex(enc)
        r, w, n, bad = sweep(raw, 0x401000)
        # One class, one hit -> that class; nothing -> None; anything else is reported verbatim
        # so an over-count shows up as a dict instead of silently reading like a clean answer.
        def only(c):
            return None if not c else (next(iter(c)) if sum(c.values()) == 1 else dict(c))
        got_r, got_w = only(r), only(w)
        if bad or n != 1 or got_r != want_r or got_w != want_w:
            fails.append({"bytes": enc, "asm": text, "insns": n, "undecoded": bad,
                          "read": got_r, "wantRead": want_r,
                          "write": got_w, "wantWrite": want_w})
    print(json.dumps({"cases": len(SELF_TEST), "failures": fails}, indent=2))
    raise SystemExit(1 if fails else 0)

data = open(a.exe, "rb").read()


def pe_text_section(buf):
    """(imageBase, sectionVA, rawOffset, rawSize) of the first executable section."""
    pe = int.from_bytes(buf[0x3c:0x40], "little")
    if buf[pe:pe + 4] != b"PE\0\0":
        raise SystemExit("not a PE image: " + a.exe)
    nsec = int.from_bytes(buf[pe + 6:pe + 8], "little")
    opt = int.from_bytes(buf[pe + 20:pe + 22], "little")
    image_base = int.from_bytes(buf[pe + 24 + 28:pe + 24 + 32], "little")
    sec = pe + 24 + opt
    for i in range(nsec):
        s = sec + 40 * i
        chars = int.from_bytes(buf[s + 36:s + 40], "little")
        if chars & 0x20000000:  # IMAGE_SCN_MEM_EXECUTE
            va = int.from_bytes(buf[s + 12:s + 16], "little")
            raw_size = int.from_bytes(buf[s + 16:s + 20], "little")
            raw_off = int.from_bytes(buf[s + 20:s + 24], "little")
            return image_base, image_base + va, raw_off, raw_size
    raise SystemExit("no executable section in " + a.exe)


if a.pages == "text":
    base, text_va, raw_off, raw_size = pe_text_section(data)
    # The sweep indexes by VA - imageBase, which holds only when the section's raw offset and its
    # RVA agree. Rebase the lookup on the section instead of assuming they do.
    base = text_va - raw_off
    page_list = list(range(text_va >> 12, (text_va + raw_size) >> 12))
else:
    base = int(a.image_base, 16)
    page_list = [int(x, 16) for x in a.pages.split(",")]

out = {"exe": a.exe, "imageBase": base, "pages": [],
       "note": "STATIC, linear sweep. Prior for the runtime census, not the measurement."}
tot_r, tot_w = Counter(), Counter()
tot_n = tot_bad = 0
for p in page_list:
    va = p << 12
    off = va - base
    buf = data[off:off + 4096]
    if len(buf) < 4096:
        continue
    r, w, n, bad = sweep(buf, va)
    tot_r += r
    tot_w += w
    tot_n += n
    tot_bad += bad
    rt = sum(r.values())
    out["pages"].append({
        "page": hex(p), "insns": n, "undecoded": bad,
        "reads": dict(r), "writes": dict(w),
        "readEspShare": round(r["esp"] / rt, 4) if rt else None,
        "readEbpShare": round(r["ebp"] / rt, 4) if rt else None,
    })

weights = {}
for pair in filter(None, a.weights.split(",")):
    k, v = pair.split(":")
    weights[int(k, 16)] = float(v)
if weights:
    missing = [hex(p) for p in page_list if p not in weights]
    if missing:
        raise SystemExit("--weights is missing pages: " + ",".join(missing))
    num = Counter()
    den = 0.0
    for p, row in zip(page_list, out["pages"]):
        w = weights[p]
        t = sum(row["reads"].values())
        if not t:
            continue
        den += w
        for cls, n in row["reads"].items():
            num[cls] += w * n / t
    out["weighted"] = {
        "note": "page-level execution weighting; shares of reads",
        "weightTotal": den,
        **{cls: round(num[cls] / den, 4) for cls in ("esp", "ebp", "other", "seg")},
        "espPlusEbp": round((num["esp"] + num["ebp"]) / den, 4),
    }

rt = sum(tot_r.values())
wt = sum(tot_w.values())
out["total"] = {
    "insns": tot_n, "undecoded": tot_bad,
    "reads": dict(tot_r), "writes": dict(tot_w),
    "readTotal": rt, "writeTotal": wt,
    "readEspShare": round(tot_r["esp"] / rt, 4) if rt else None,
    "readEbpShare": round(tot_r["ebp"] / rt, 4) if rt else None,
    "readEspPlusEbpShare": round((tot_r["esp"] + tot_r["ebp"]) / rt, 4) if rt else None,
}
print(json.dumps(out, indent=2))
