#!/usr/bin/env python3
"""Ground truth for tools/aot/decoder-oracle.mjs: instruction lengths from an independent
disassembler over the same linear byte sweep.

    python tools/aot/capstone-lengths.py [--exe path] [--pages 5d3,5d4,...] > lengths.json

Linear sweep, one byte of resync on a decode failure — identical policy to the JS side, so a
disagreement is always about the length of a shared instruction, never about where one starts.
"""
import argparse
import json
import sys

from capstone import Cs, CS_ARCH_X86, CS_MODE_32

ap = argparse.ArgumentParser()
ap.add_argument("--exe", default="tmp/nfsu/Speed.exe")
ap.add_argument("--pages", default="5d3,5d4,672,40c,5cb")
ap.add_argument("--image-base", default="0x400000")
a = ap.parse_args()

base = int(a.image_base, 16)
data = open(a.exe, "rb").read()
md = Cs(CS_ARCH_X86, CS_MODE_32)

out = {"exe": a.exe, "imageBase": base, "pages": []}
for p in [int(x, 16) for x in a.pages.split(",")]:
    va = p << 12
    off = va - base
    buf = data[off:off + 4096]
    ins = []
    i = 0
    while i < 4096:
        got = list(md.disasm(buf[i:i + 16], va + i, count=1))
        if not got:
            i += 1
            continue
        x = got[0]
        ins.append([i, x.size, f"{x.mnemonic} {x.op_str}".strip()])
        i += x.size
    out["pages"].append({"page": p, "va": va, "fileOff": off, "instructions": ins})

json.dump(out, sys.stdout)
