#!/usr/bin/env python3
"""
libid - whose code is this: the game's, or a library's.

Answers one question: does a hot address in a guest image belong to the game or to
a statically linked library (MSVC CRT, D3DX, zlib, Bink...)? Without that answer an
emulator profile cannot become a work plan: "31% of the time in the JIT" says nothing
until you know whose code that is and whether fixing it carries over to the other
titles of the era.

Identification sources, each with its own weight and its own trace in the answer:

  fid     Ghidra Function ID (the FLIRT analogue, shipped with Ghidra) -
          Single Match names the CRT/MFC function; Conflict gives only the family.
  sig     Our own body signatures taken from a donor DLL
          (`libid.py sigs d3dx9_25.dll --lib d3dx9`). Covers what the FID databases
          do not hold at all: D3DX, Bink, Miles. Two tiers - strict (body bytes with
          addresses masked out) and fuzzy (mnemonic stream); a strict hit is reported
          as strict rather than blurred into "looks like".
  str     Fingerprint strings and constants (`lib-fingerprints.json`) plus xrefs: a
          function reaching for "D3DX Effect Compiler" is part of the D3DX runtime.

On top of the point identifications sits a block map: the linker lays a library's
object files down back to back, so an unidentified function inside a dense library
block is library code too - reported honestly as confidence=low, source=region.

There are deliberately four verdicts, not two: library / import / game / unresolved.
"Unidentified" is not a synonym for "game code": merging them passes ignorance off as
a finding.

Usage:
  libid.py sigs  <donor.dll> --lib <name> [--out FILE]   take signatures off a library
  libid.py index <image.exe> [--sigs DIR] [--out FILE]   build the image map (needs Ghidra)
  libid.py ask   <image.exe|--index FILE> [0x... ...] [--addrs FILE] [--json]
  libid.py selftest <image.exe> [--expect FILE]          run against known anchors

`index` needs pyghidra (project cache shared with re-service, tmp/ghidra_project/<sha16>);
`ask` needs plain python and a built index - addresses can be answered with no Ghidra at all.
"""
from __future__ import annotations

import argparse
import bisect
import datetime
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
PROJECT_ROOT = os.path.join(REPO, "tmp", "ghidra_project")
INDEX_ROOT = os.path.join(REPO, "tmp", "libid")
SIG_ROOT = os.path.join(HERE, "libsigs")
FINGERPRINTS = os.path.join(HERE, "lib-fingerprints.json")
ANCHORS = os.path.join(HERE, "libid-anchors.json")

# A body of a couple hundred bytes is identifiable from its head; short functions are not
# signatured at all - too many of them are identical, and a "match" there means nothing.
SIG_BYTES = 192
SIG_MIN_BYTES = 24
SIG_MIN_INSNS = 8
FUZZY_INSNS = 40
# A library block: the linker lays object files down in a row, but unidentified
# neighbours turn up between them. A gap longer than this many functions ends the block.
BLOCK_GAP = 48           # this many unidentified neighbours in a row a block still survives
BLOCK_MIN_DENSITY = 0.2  # ...but only if every fifth function in it is confirmed
BLOCK_MIN_CONFIRMED = 3


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_fingerprints(path: str = FINGERPRINTS) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- the Ghidra half

def _start_pyghidra():
    opts = os.environ.get("JAVA_TOOL_OPTIONS", "")
    if "java.awt.headless" not in opts:
        os.environ["JAVA_TOOL_OPTIONS"] = (opts + " -Djava.awt.headless=true").strip()
    try:
        import pyghidra
    except Exception as e:
        raise SystemExit(f"libid: needs pyghidra ({type(e).__name__}: {e}). "
                         f"pip install pyghidra + GHIDRA_INSTALL_DIR, see tools/re/README.md")
    pyghidra.start()
    return pyghidra


def _open(path: str):
    """Open an image in the same project cache re-service uses: analysis once per sha."""
    pyghidra = _start_pyghidra()
    h = _sha256(path)[:16]
    proj = os.path.join(PROJECT_ROOT, h)
    os.makedirs(proj, exist_ok=True)
    ctx = pyghidra.open_program(path, project_location=proj, project_name=h, analyze=True)
    return ctx, h


def _mask_instruction(ins) -> bytes:
    """Instruction bytes with addresses zeroed, so a signature survives relocation.

    We mask the 4-byte windows that match a reference target, either as an absolute
    address or as a rel32 from the end of the instruction. Those are exactly what
    changes when the code moves; the rest of the body is the real fingerprint.
    """
    try:
        b = bytearray(int(x) & 0xFF for x in ins.getBytes())
    except Exception:
        return b""
    refs = list(ins.getReferencesFrom() or [])
    if refs and len(b) >= 5:
        addr = int(ins.getAddress().getOffset())
        targets = set()
        for r in refs:
            try:
                t = int(r.getToAddress().getOffset())
            except Exception:
                continue
            targets.add(t & 0xFFFFFFFF)
            targets.add((t - (addr + len(b))) & 0xFFFFFFFF)
        for i in range(len(b) - 3):
            word = int.from_bytes(bytes(b[i:i + 4]), "little")
            if word in targets:
                b[i:i + 4] = b"\x00\x00\x00\x00"
    return bytes(b)


def _norm_operand(text: str) -> str:
    """An operand without its concrete numbers: EBP+-0x4c and EBP+-0x8 are one shape."""
    return re.sub(r"0x[0-9a-fA-F]+|\b\d+\b", "#", str(text))


def _signatures(program, fn):
    """(strict, fuzzy) for one function; None when the body is too small to conclude."""
    listing = program.getListing()
    body = fn.getBody()
    raw = bytearray()
    stream = []
    n = 0
    it = listing.getInstructions(body, True)
    while it.hasNext():
        ins = it.next()
        n += 1
        if len(raw) < SIG_BYTES:
            raw += _mask_instruction(ins)
        if len(stream) < FUZZY_INSNS:
            ops = ",".join(_norm_operand(ins.getDefaultOperandRepresentation(i))
                           for i in range(ins.getNumOperands()))
            stream.append(f"{ins.getMnemonicString()} {ops}")
        if len(raw) >= SIG_BYTES and len(stream) >= FUZZY_INSNS:
            # the tail will not enter the signature anyway, but counting instructions is cheap
            pass
    if n < SIG_MIN_INSNS or len(raw) < SIG_MIN_BYTES:
        return None, None
    strict = hashlib.sha1(bytes(raw[:SIG_BYTES])).hexdigest()[:20]
    fuzzy = hashlib.sha1("\n".join(stream).encode("utf-8")).hexdigest()[:20]
    return strict, fuzzy


def cmd_sigs(args):
    """Take signatures off a donor library: one DLL, one signature file."""
    ctx, h = _open(args.binary)
    with ctx as flat:
        program = flat.getCurrentProgram()
        base = int(program.getImageBase().getOffset())
        strict, fuzzy, names = {}, {}, {}
        total = 0
        for fn in program.getFunctionManager().getFunctions(True):
            if fn.isThunk() or fn.isExternal():
                continue
            total += 1
            s, f = _signatures(program, fn)
            if not s:
                continue
            nm = str(fn.getName())
            if nm.startswith("FUN_"):
                nm = f"sub_{int(fn.getEntryPoint().getOffset()) - base:06x}"
            names[nm] = names.get(nm, 0) + 1
            strict.setdefault(s, [])
            if nm not in strict[s]:
                strict[s].append(nm)
            fuzzy.setdefault(f, [])
            if nm not in fuzzy[f]:
                fuzzy[f].append(nm)
        out = {
            "schema": "libid-sigs/1",
            "lib": args.lib,
            "kind": args.kind,
            "donor": os.path.basename(args.binary),
            "donorSha256": _sha256(args.binary),
            "version": args.version or os.path.splitext(os.path.basename(args.binary))[0],
            "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "functions": total,
            "strict": strict,
            "fuzzy": fuzzy,
        }
    dest = args.out or os.path.join(SIG_ROOT, f"{args.lib}-{out['version']}.sig.json")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"[libid] {out['lib']}/{out['version']}: {total} functions, "
          f"{len(strict)} strict, {len(fuzzy)} fuzzy -> {dest}")
    return 0


def _load_sigs(sig_dir: str) -> list[dict]:
    if not sig_dir or not os.path.isdir(sig_dir):
        return []
    out = []
    for name in sorted(os.listdir(sig_dir)):
        if not name.endswith(".sig.json"):
            continue
        with open(os.path.join(sig_dir, name), "r", encoding="utf-8") as f:
            d = json.load(f)
        if d.get("schema") == "libid-sigs/1":
            d.setdefault("kind", "library")
            out.append(d)
    return out


def _fid_lib(name: str, fp: dict) -> str:
    """Which Microsoft library the FID name actually belongs to.

    The FID database shipped with Ghidra is built from Visual Studio libraries, so the
    choice here is not "library or game" but "CRT, MFC or some other MS runtime".
    """
    lib = _name_lib(name, fp)
    if lib:
        return lib
    if name.startswith("?"):
        return "mfc" if re.search(r"@@|AFX|@C[A-Z]", name) and "AFX" in name else "msvc-lib"
    if re.fullmatch(r"_{1,3}[a-z][A-Za-z0-9_]*", name):
        return "msvc-crt"
    return "msvc-lib"


def _name_lib(name: str, fp: dict) -> str | None:
    for lib, spec in fp["libs"].items():
        for rule in spec.get("nameRules", []):
            if re.search(rule, name):
                return lib
    return None


def cmd_index(args):
    fp = load_fingerprints(args.fingerprints)
    sigs = _load_sigs(args.sigs or SIG_ROOT)
    ctx, h = _open(args.binary)
    with ctx as flat:
        program = flat.getCurrentProgram()
        base = int(program.getImageBase().getOffset())
        fm = program.getFunctionManager()

        funcs = []          # [{e, s, n, src, ext}]
        ev: dict[str, list] = {}

        def add(entry: int, item: dict):
            ev.setdefault(f"{entry:x}", []).append(item)

        # --- 1. functions, thunks and imports
        for fn in fm.getFunctions(True):
            entry = int(fn.getEntryPoint().getOffset())
            sym = fn.getSymbol()
            rec = {"e": entry, "s": int(fn.getBody().getNumAddresses()),
                   "n": str(fn.getName()),
                   "src": str(sym.getSource()) if sym is not None else "?"}
            ext = None
            if fn.isThunk():
                try:
                    t = fn.getThunkedFunction(True)
                    if t is not None and t.isExternal():
                        loc = t.getExternalLocation()
                        lib = str(loc.getLibraryName()) if loc is not None else "?"
                        ext = {"dll": lib, "fn": str(t.getName())}
                except Exception:
                    ext = None
            if ext:
                rec["ext"] = ext
                add(entry, {"src": "import", "lib": fp["importLibs"].get(ext["dll"].lower(), "import:" + ext["dll"]),
                            "fn": ext["fn"], "quality": "import", "detail": ext["dll"]})
            funcs.append(rec)
        # Who calls whom: without a call graph a function with no evidence of its own is
        # mute, even when the only code calling it is confirmed library code.
        monitor = flat.getMonitor()
        by_entry = {r["e"]: r for r in funcs}
        for fn in fm.getFunctions(True):
            r = by_entry.get(int(fn.getEntryPoint().getOffset()))
            if r is None:
                continue
            try:
                callers = sorted({int(c.getEntryPoint().getOffset())
                                  for c in fn.getCallingFunctions(monitor)})
            except Exception:
                callers = []
            if callers:
                r["cb"] = callers
        funcs.sort(key=lambda r: r["e"])
        starts = [r["e"] for r in funcs]

        def containing(addr: int):
            i = bisect.bisect_right(starts, addr) - 1
            if i < 0:
                return None
            r = funcs[i]
            return r if r["e"] <= addr < r["e"] + max(r["s"], 1) else None

        # --- 2. Ghidra Function ID: the FLIRT layer, already computed by the analysis
        bm = program.getBookmarkManager()
        it = bm.getBookmarksIterator()
        fid_single = fid_conflict = 0
        while it.hasNext():
            b = it.next()
            cat = str(b.getCategory())
            if not cat.startswith("Function ID"):
                continue
            addr = int(b.getAddress().getOffset())
            fn = containing(addr)
            if fn is None:
                continue
            comment = str(b.getComment())
            single = "Single Match" in comment
            # Take the name from the function itself: FID has already applied it, and that
            # is safer than carving the tail out of the bookmark's prose - for
            # "Multiple Matches, Same Function Name" the tail is not where it looks.
            name = fn["n"]
            if name.startswith("FUN_"):
                m = re.search(r"Match(?:es)?,?\s{2,}(\S.*)$", comment)
                name = m.group(1).strip() if m else name
            fid_single += 1 if single else 0
            fid_conflict += 0 if single else 1
            # The FID database shipped with Ghidra is the Visual Studio libraries
            # (vsOlder/vs20xx). So any hit already proves "not game code"; all that is
            # left is which MS library, not whether it is one.
            add(fn["e"], {"src": "fid", "lib": _fid_lib(name, fp),
                          "fn": name, "quality": "single" if single else "conflict",
                          "detail": comment[:120]})

        # --- 3. symbol names that came from the analysis/demangler rather than FID
        for r in funcs:
            nm = r["n"]
            if nm.startswith(("FUN_", "thunk_FUN_", "caseD_", "switchD_")):
                continue
            lib = _name_lib(nm, fp)
            if lib:
                add(r["e"], {"src": "name", "lib": lib, "fn": nm, "quality": "name"})

        # --- 4. fingerprint strings and the xrefs to them
        strings = []
        refman = program.getReferenceManager()
        di = program.getListing().getDefinedData(True)
        str_hits = 0
        while di.hasNext():
            d = di.next()
            if not d.hasStringValue():
                continue
            try:
                val = str(d.getValue())
            except Exception:
                continue
            for lib, spec in fp["libs"].items():
                for s in spec.get("strings", []):
                    if s["s"] in val:
                        saddr = int(d.getAddress().getOffset())
                        strings.append({"addr": saddr, "lib": lib, "w": s["w"], "value": val[:80]})
                        for ref in refman.getReferencesTo(d.getAddress()):
                            src_addr = ref.getFromAddress()
                            fn = containing(int(src_addr.getOffset()))
                            if fn is not None:
                                str_hits += 1
                                add(fn["e"], {"src": "str", "lib": lib, "fn": None,
                                              "quality": s["w"], "detail": val[:60]})
                                continue
                            # A string reached through a pointer in data: this is exactly
                            # how the effect's GetDesc hands out "D3DX Effect Compiler".
                            # Stopping at the first xref would lose the whole runtime cluster.
                            for ref2 in refman.getReferencesTo(src_addr):
                                fn2 = containing(int(ref2.getFromAddress().getOffset()))
                                if fn2 is not None:
                                    str_hits += 1
                                    add(fn2["e"], {"src": "str", "lib": lib, "fn": None,
                                                   "quality": "weak" if s["w"] == "strong" else s["w"],
                                                   "detail": val[:60] + " (via pointer)"})
                        break

        # --- 5. our own signatures from donor DLLs
        sig_strict = sig_fuzzy = sig_shared = 0
        if sigs:
            for r in funcs:
                if r.get("ext"):
                    continue
                fn = fm.getFunctionAt(
                    program.getAddressFactory().getDefaultAddressSpace().getAddress(r["e"]))
                if fn is None:
                    continue
                s, f = _signatures(program, fn)
                if not s:
                    continue
                r["sig"] = 1
                for pack in sigs:
                    corpus = pack.get("kind") == "corpus"
                    hit, kind = pack["strict"].get(s), "strict"
                    if not hit:
                        hit, kind = pack["fuzzy"].get(f), "fuzzy"
                    if not hit:
                        continue
                    if corpus:
                        # A match against another game does not name a library - it says
                        # only "this code is not unique to the image". Whose it is comes
                        # from accumulation: two independent foreign images mean shared code.
                        sig_shared += 1
                        add(r["e"], {"src": "shared", "lib": "shared-code", "fn": hit[0],
                                     "quality": kind, "detail": pack["version"]})
                        continue
                    sig_strict += 1 if kind == "strict" else 0
                    sig_fuzzy += 1 if kind == "fuzzy" else 0
                    add(r["e"], {"src": "sig", "lib": pack["lib"], "fn": hit[0],
                                 "quality": kind if len(hit) == 1 else kind + "-multi",
                                 "detail": pack["version"]})

        # --- 6. function-pointer tables: a C++ library hands objects over as vtables,
        # so a method with no evidence of its own is identified by its table neighbours.
        entry_set = {r["e"] for r in funcs}
        tables = []
        mem = program.getMemory()
        for blk in mem.getBlocks():
            if not blk.isInitialized() or blk.isExecute():
                continue
            size = int(blk.getSize())
            if size <= 0 or size > (32 << 20):
                continue
            try:
                data = bytes(memoryview(flat.getBytes(blk.getStart(), size)))
            except Exception as e:
                print(f"[libid] block {blk.getName()} unreadable ({type(e).__name__}: {e}) - "
                      f"no method tables will be found in it", file=sys.stderr)
                continue
            start = int(blk.getStart().getOffset())
            run, run_at = [], 0
            for off in range(0, len(data) - 3, 4):
                val = int.from_bytes(data[off:off + 4], "little")
                if val in entry_set:
                    if not run:
                        run_at = start + off
                    run.append(val)
                else:
                    if len(run) >= 4:
                        tables.append({"addr": run_at, "entries": run})
                    run = []
            if len(run) >= 4:
                tables.append({"addr": run_at, "entries": run})

        index = {
            "schema": "libid-index/1",
            "binary": os.path.abspath(args.binary),
            "name": str(program.getName()),
            "sha256": _sha256(args.binary),
            "hash16": h,
            "base": base,
            "builtAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "sigPacks": [{"lib": p["lib"], "version": p["version"], "donor": p["donor"],
                           "kind": p.get("kind", "library")} for p in sigs],
            "functions": funcs,
            "evidence": ev,
            "strings": strings[:4000],
            "tables": tables,
            "stats": {"functions": len(funcs), "fidSingle": fid_single, "fidConflict": fid_conflict,
                      "stringHits": str_hits, "sigStrict": sig_strict, "sigFuzzy": sig_fuzzy,
                      "sigShared": sig_shared, "tables": len(tables)},
        }
    index["blocks"] = build_blocks(index)
    dest = args.out or os.path.join(INDEX_ROOT, f"{h}.json")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(index, f)
    st = index["stats"]
    print(f"[libid] {index['name']}: {st['functions']} functions, FID {st['fidSingle']}+{st['fidConflict']}, "
          f"strings {st['stringHits']}, sig {st['sigStrict']}/{st['sigFuzzy']}, "
          f"shared {st['sigShared']}, tables {st['tables']}, "
          f"blocks {len(index['blocks'])} -> {dest}")
    return 0


# ---------------------------------------------------------------- answering without Ghidra

DIRECT = {"fid", "sig", "str", "name", "import"}
STRONG = {"single", "strict", "strong", "import"}


def _best(items: list[dict]) -> dict | None:
    order = {"single": 0, "strict": 0, "strong": 1, "name": 2, "fuzzy": 2, "import": 0,
             "strict-multi": 3, "fuzzy-multi": 4, "conflict": 4, "weak": 5}
    ranked = sorted(items, key=lambda e: order.get(e.get("quality"), 9))
    return ranked[0] if ranked else None


def build_blocks(index: dict) -> list[dict]:
    """The library block map: confirmed functions merged into ranges.

    The point is not decoration but a hole: of a static library maybe a dozen functions
    out of a hundred get identified and the rest look nameless. But they lie in a row,
    and a block neighbour is its code too, just without evidence of its own.
    """
    funcs = index["functions"]
    ev = index["evidence"]
    marks = []
    for i, r in enumerate(funcs):
        items = [e for e in ev.get(f"{r['e']:x}", []) if e["src"] in DIRECT and e["src"] != "import"]
        best = _best(items)
        if best and best.get("quality") in STRONG:
            marks.append((i, best["lib"]))
    blocks = []
    cur = None
    for i, lib in marks:
        dense = cur and (cur["confirmed"] + 1) / (i - cur["firstIdx"] + 1) >= BLOCK_MIN_DENSITY
        if cur and lib == cur["lib"] and i - cur["lastIdx"] <= BLOCK_GAP and dense:
            cur["lastIdx"] = i
            cur["confirmed"] += 1
        else:
            if cur and cur["confirmed"] >= BLOCK_MIN_CONFIRMED:
                blocks.append(cur)
            cur = {"lib": lib, "firstIdx": i, "lastIdx": i, "confirmed": 1}
    if cur and cur["confirmed"] >= BLOCK_MIN_CONFIRMED:
        blocks.append(cur)
    out = []
    for b in blocks:
        first, last = funcs[b["firstIdx"]], funcs[b["lastIdx"]]
        n = b["lastIdx"] - b["firstIdx"] + 1
        out.append({"lib": b["lib"], "start": first["e"], "end": last["e"] + max(last["s"], 1),
                    "funcs": n, "confirmed": b["confirmed"], "density": round(b["confirmed"] / n, 2)})
    return out


class Index:
    def __init__(self, data: dict):
        self.d = data
        self.funcs = data["functions"]
        self.starts = [r["e"] for r in self.funcs]
        # Always recomputed: the block-merge rule changes more often than the image, and
        # serving yesterday's map out of a fresh index would be lying quietly.
        self.blocks = build_blocks(data)
        self.block_starts = [b["start"] for b in self.blocks]
        self.confirmed_total = sum(b["confirmed"] for b in self.blocks)
        self._prop = None
        self._scc = None
        self._cb = {r["e"]: r.get("cb") for r in self.funcs if r.get("cb")}
        self.corpus = [p["version"] for p in data.get("sigPacks", []) if p.get("kind") == "corpus"]

    def function_at(self, addr: int):
        i = bisect.bisect_right(self.starts, addr) - 1
        if i < 0:
            return None
        r = self.funcs[i]
        return r if r["e"] <= addr < r["e"] + max(r["s"], 1) else None

    def block_at(self, addr: int):
        i = bisect.bisect_right(self.block_starts, addr) - 1
        if i < 0:
            return None
        b = self.blocks[i]
        return b if b["start"] <= addr < b["end"] else None

    def _sccs(self) -> list[frozenset]:
        """Strongly connected components of the call graph - iterative Tarjan.

        The recursive version blows the interpreter stack on fifteen thousand functions,
        and the graph has to be walked whole either way.
        """
        if self._scc is not None:
            return self._scc
        graph: dict[int, list[int]] = {}
        for r in self.funcs:
            for c in (r.get("cb") or ()):
                graph.setdefault(c, []).append(r["e"])
            graph.setdefault(r["e"], graph.get(r["e"], []))
        index: dict[int, int] = {}
        low: dict[int, int] = {}
        on_stack: set[int] = set()
        stack: list[int] = []
        out: list[frozenset] = []
        counter = 0
        for root in graph:
            if root in index:
                continue
            work = [(root, iter(graph[root]))]
            index[root] = low[root] = counter
            counter += 1
            stack.append(root)
            on_stack.add(root)
            while work:
                node, it = work[-1]
                advanced = False
                for nxt in it:
                    if nxt not in index:
                        index[nxt] = low[nxt] = counter
                        counter += 1
                        stack.append(nxt)
                        on_stack.add(nxt)
                        work.append((nxt, iter(graph.get(nxt, ()))))
                        advanced = True
                        break
                    if nxt in on_stack:
                        low[node] = min(low[node], index[nxt])
                if advanced:
                    continue
                work.pop()
                if work:
                    low[work[-1][0]] = min(low[work[-1][0]], low[node])
                if low[node] == index[node]:
                    comp = set()
                    while True:
                        w = stack.pop()
                        on_stack.discard(w)
                        comp.add(w)
                        if w == node:
                            break
                    out.append(frozenset(comp))
        self._scc = out
        return out

    def _direct_lib(self, entry: int) -> str | None:
        """Library by the function's own evidence - no graph, so this cannot recurse."""
        items = self.d["evidence"].get(f"{entry:x}", [])
        best = _best([e for e in items if e["src"] in DIRECT and e["src"] != "import"])
        if best:
            return best["lib"]
        shared = [e for e in items if e["src"] == "shared"]
        if shared and (any(e.get("quality") == "strict" for e in shared)
                       or len({e.get("detail") for e in shared}) >= 2):
            return "shared-code"
        block = self.block_at(entry)
        return block["lib"] if block else None

    def _propagated(self) -> dict[int, str]:
        """A function only the library calls is library code too.

        The quiet part of a static library: internal helpers with no strings, no name and
        no signature hit. Nothing outside the library ever calls them - that is the
        evidence. Computed to a fixed point, each step only over what is already labelled,
        so a cycle in the graph multiplies nothing.
        """
        if self._prop is not None:
            return self._prop
        label: dict[int, str] = {}
        how: dict[int, tuple] = {}
        for r in self.funcs:
            lib = self._direct_lib(r["e"])
            if lib:
                label[r["e"]] = lib
        seeded = set(label)
        tables = self.d.get("tables") or []
        for _ in range(8):
            grown = 0
            # A pointer table (vtable) belongs to one owner as a whole: if most of its
            # slots are confirmed library, the remaining slots of the same object cannot
            # be game code.
            for t in tables:
                entries = t["entries"]
                seen = [label.get(e) for e in entries]
                known = [x for x in seen if x]
                if len(known) < 3 or len(known) * 2 < len(entries):
                    continue
                top = max(set(known), key=known.count)
                if known.count(top) * 5 < len(known) * 4:   # needs a clear majority
                    continue
                for e in entries:
                    if e not in label:
                        label[e] = top
                        how[e] = ("vtable", t["addr"], len(entries), len(known))
                        grown += 1
            # By mutual-recursion groups rather than single functions: the D3DX state
            # dispatcher and its walk call each other, and "all callers identified" never
            # fires on such a pair - each one waits for the other.
            for group in self._sccs():
                if any(e in label for e in group):
                    continue
                outside = {c for e in group for c in (self._cb.get(e) or ())} - group
                if not outside:
                    continue
                libs = {label.get(c) for c in outside}
                if len(libs) == 1 and None not in libs:
                    lib = libs.pop()
                    for e in group:
                        label[e] = lib
                        how[e] = ("callgraph", len(outside), len(group), 0)
                    grown += len(group)
            if not grown:
                break
        self._prop = {k: (v, how.get(k)) for k, v in label.items() if k not in seeded}
        return self._prop

    def ask(self, addr: int) -> dict:
        fn = self.function_at(addr)
        if fn is None:
            return {"addr": addr, "verdict": "unresolved", "confidence": "none",
                    "reason": "Ghidra sees no function at this address - data, a tail, or code left undisassembled"}
        items = self.d["evidence"].get(f"{fn['e']:x}", [])
        ans = {"addr": addr, "func": fn["n"], "entry": fn["e"], "size": fn["s"],
               "off": addr - fn["e"], "evidence": items}
        imports = [e for e in items if e["src"] == "import"]
        if imports:
            e = imports[0]
            ans.update(verdict="import", lib=e["lib"], libFunc=e["fn"], confidence="high",
                       source="import", reason=f"thunk into import {e['detail']}")
            return ans
        direct = [e for e in items if e["src"] in DIRECT]
        best = _best(direct)
        if best and best.get("quality") in STRONG:
            ans.update(verdict="library", lib=best["lib"], libFunc=best.get("fn"),
                       confidence="high", source=best["src"],
                       reason=f"{best['src']}/{best.get('quality')}")
            return ans
        if best:
            ans.update(verdict="library", lib=best["lib"], libFunc=best.get("fn"),
                       confidence="medium", source=best["src"],
                       reason=f"{best['src']}/{best.get('quality')} - identification is ambiguous")
            return ans
        shared = [e for e in items if e["src"] == "shared"]
        if shared:
            donors = sorted({e.get("detail") for e in shared})
            strict = any(e.get("quality") == "strict" for e in shared)
            if strict or len(donors) >= 2:
                ans.update(verdict="library", lib="shared-code", libFunc=shared[0].get("fn"),
                           confidence="medium", source="shared",
                           reason=f"the same body is present in foreign images ({', '.join(donors)}) - "
                                  f"{'byte for byte' if strict else 'by instruction stream'}; "
                                  f"the code is shared, the specific library is not named")
                return ans
        block = self.block_at(addr)
        if block:
            ans.update(verdict="library", lib=block["lib"], libFunc=None, confidence="low",
                       source="region",
                       reason=f"inside the {block['lib']} block 0x{block['start']:x}-0x{block['end']:x} "
                              f"({block['confirmed']} confirmed of {block['funcs']}, "
                              f"density {block.get('density','?')}), no evidence of its own")
            return ans
        if self.confirmed_total < 20:
            ans.update(verdict="unresolved", confidence="none", source="none",
                       reason="too few confirmed library functions in this image to trust the "
                              "block map - staying silent instead of filing it under game code")
            return ans
        prop = self._propagated().get(fn["e"])
        if prop:
            lib, how = prop
            if how and how[0] == "vtable":
                why = (f"slot of method table 0x{how[1]:x}: {how[3]} of {how[2]} slots are "
                       f"identified and most are {lib}; an object belongs to one owner as a whole")
            elif how and how[0] == "callgraph":
                why = (f"no evidence of its own, but the only code entering this group of "
                       f"{how[2]} mutually recursive functions from outside is confirmed "
                       f"{lib} ({how[1]} callers)")
            else:
                why = f"identified as {lib} by its surroundings"
            ans.update(verdict="library", lib=lib, libFunc=None, confidence="low",
                       source=(how[0] if how else "propagated"), reason=why)
            return ans
        weak = [e for e in items if e["src"] == "shared"]
        why = "outside every library block of the image and with no library evidence of its own"
        if weak:
            why += f"; a loose match against {weak[0].get('detail')} - one is not enough to conclude"
        if self.corpus and fn.get("sig"):
            ans.update(verdict="game", confidence="medium", source="outside-blocks",
                       reason=why + f"; the body did not turn up in any foreign image "
                                    f"({', '.join(self.corpus)})")
            return ans
        ans.update(verdict="game", confidence="low", source="outside-blocks",
                   reason=why + ("; no foreign images to compare against - the verdict rests on the "
                                 "image layout, not on comparison" if not self.corpus
                                 else "; the body is too short for a signature"))
        return ans


def _index_path_for(binary: str) -> str:
    return os.path.join(INDEX_ROOT, f"{_sha256(binary)[:16]}.json")


def load_index(args) -> Index:
    path = args.index or (_index_path_for(args.binary) if args.binary else None)
    if not path or not os.path.isfile(path):
        raise SystemExit(f"libid: no index ({path}). Build one: libid.py index <image.exe>")
    with open(path, "r", encoding="utf-8") as f:
        return Index(json.load(f))


def _parse_addrs(args) -> list[int]:
    raw = list(args.addrs or [])
    if args.addrs_file:
        with open(args.addrs_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.split("#", 1)[0].strip()
                if line:
                    raw.append(line.split()[0])
    out = []
    for a in raw:
        a = a.strip().rstrip(",")
        # Generated Wasm function names from traces (`g0040d001@t12`) go in as they are:
        # transcribing the VA by hand is one more chance to fumble a digit.
        m = re.fullmatch(r"g([0-9a-fA-F]+)(@t\d+)?", a)
        if m:
            a = m.group(1)
        try:
            out.append(int(a, 16) if a.lower().startswith("0x") or re.fullmatch(r"[0-9a-fA-F]+", a) else int(a))
        except ValueError:
            print(f"libid: not an address, skipping: {a}", file=sys.stderr)
    return out


def cmd_ask(args):
    idx = load_index(args)
    addrs = _parse_addrs(args)
    if not addrs:
        raise SystemExit("libid: give me addresses - positionally or --addrs FILE")
    answers = [idx.ask(a) for a in addrs]
    if args.json:
        print(json.dumps({"binary": idx.d["binary"], "sha256": idx.d["sha256"],
                          "answers": answers}, ensure_ascii=False, indent=1))
        return 0
    width = max(len(a.get("func") or "") for a in answers)
    for a in answers:
        head = f"0x{a['addr']:08x}"
        if a["verdict"] == "unresolved" and "func" not in a:
            print(f"{head}  {'—':<{width}}  unresolved  {a['reason']}")
            continue
        lib = a.get("lib") or ""
        fn = a.get("libFunc") or ""
        label = f"{lib}:{fn}" if fn else lib
        print(f"{head}  {a['func']:<{width}}  {a['verdict']:<10} {a.get('confidence',''):<7} "
              f"{label:<28} {a['reason']}")
    return 0


def cmd_selftest(args):
    """Run against anchors whose owner is known in advance: the tool either agrees or not.

    The anchors are not the tool's opinion of itself: the addresses come from independent
    analysis (Ghidra FID in the catalog audit, the D3DX dispatcher RE on NFSU2). A red
    selftest means the tool broke, not the image.
    """
    idx = load_index(args)
    with open(args.expect or ANCHORS, "r", encoding="utf-8") as f:
        data = json.load(f)
    groups = data.get("images") or [data]
    name = str(idx.d.get("name") or "")
    group = next((g for g in groups if str(g.get("image", "")).lower() == name.lower()), None)
    if group is None:
        raise SystemExit(f"libid: no anchors for image {name} in {args.expect or ANCHORS} - "
                         f"have: {', '.join(g.get('image','?') for g in groups)}")
    print(f"[libid selftest] {name}: {group.get('note','')}")
    ok = bad = 0
    for item in group["anchors"]:
        addr = int(item["addr"], 16)
        got = idx.ask(addr)
        want_verdict = item.get("verdict", "library")
        want_lib = item.get("lib")
        good = got["verdict"] == want_verdict and (want_lib is None or got.get("lib") == want_lib)
        ok, bad = (ok + 1, bad) if good else (ok, bad + 1)
        mark = "ok  " if good else "FAIL"
        print(f"{mark} 0x{addr:08x} {item.get('note','')}: expected {want_verdict}/{want_lib or '*'}, "
              f"got {got['verdict']}/{got.get('lib','-')} [{got.get('confidence','-')}] "
              f"({got.get('reason','')})")
    print(f"[libid selftest] agreed {ok}, disagreed {bad}")
    return 0 if bad == 0 else 1


def cmd_summary(args):
    """Image functions grouped by owner - the input a time-weighted census builds on."""
    idx = load_index(args)
    tally: dict[str, dict] = {}
    for r in idx.funcs:
        a = idx.ask(r["e"])
        key = a["verdict"] if a["verdict"] in ("game", "unresolved") else f"{a['verdict']}:{a.get('lib')}"
        t = tally.setdefault(key, {"funcs": 0, "bytes": 0, "high": 0})
        t["funcs"] += 1
        t["bytes"] += r["s"]
        t["high"] += 1 if a.get("confidence") == "high" else 0
    rows = sorted(tally.items(), key=lambda kv: -kv[1]["bytes"])
    if args.json:
        print(json.dumps({"binary": idx.d["binary"], "blocks": idx.blocks,
                          "tally": dict(rows)}, ensure_ascii=False, indent=1))
        return 0
    total = sum(v["bytes"] for _, v in rows) or 1
    print(f"{'owner':<28} {'funcs':>8} {'bytes':>10} {'code share':>11} {'confident':>10}")
    for k, v in rows:
        print(f"{k:<28} {v['funcs']:>8} {v['bytes']:>10} {100*v['bytes']/total:>9.1f}% {v['high']:>9}")
    print("\nCode share is static size, NOT a share of time. Time comes from the profile.")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="libid", description="whose code is this: the game's or a library's")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("sigs", help="take signatures off a donor library")
    s.add_argument("binary")
    s.add_argument("--lib", required=True)
    s.add_argument("--kind", choices=("library", "corpus"), default="library",
                   help="library - the donor is the library itself; corpus - a foreign game, "
                        "a match against which proves only that the code is shared, not whose it is")
    s.add_argument("--version")
    s.add_argument("--out")
    s.set_defaults(fn=cmd_sigs)

    s = sub.add_parser("index", help="build the image map (needs Ghidra)")
    s.add_argument("binary")
    s.add_argument("--sigs")
    s.add_argument("--fingerprints", default=FINGERPRINTS)
    s.add_argument("--out")
    s.set_defaults(fn=cmd_index)

    for name, fn, helptext in (("ask", cmd_ask, "whose code is at these addresses"),
                               ("summary", cmd_summary, "distribution by owner"),
                               ("selftest", cmd_selftest, "run against known anchors")):
        s = sub.add_parser(name, help=helptext)
        s.add_argument("binary", nargs="?")
        s.add_argument("addrs", nargs="*")
        s.add_argument("--index")
        s.add_argument("--addrs", dest="addrs_file")
        s.add_argument("--json", action="store_true")
        s.add_argument("--expect")
        s.set_defaults(fn=fn)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
