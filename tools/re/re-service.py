#!/usr/bin/env python3
"""
re-service.py — the warm reverse-engineering backend.

A persistent local HTTP service that opens/analyzes a Ghidra project ONCE and
keeps it warm, serving queries with a contract that mirrors harness_rpc:
POST / {cmd, args} -> {ok, result | error}. This fixes the two real pains the
~100 one-off GhidraScripts exposed — Java->Python ergonomics and
cold-headless->warm latency — while preserving the project's Ghidra capital.

Dual-mode for reliability: in-process pyGhidra (JPype) by
default; if unavailable it degrades gracefully (decompile/xref report a clear
error) and disasm falls back to capstone via tools/pe-disas.py. `re doctor`
(client side) checks the environment.

Reproducibility: project cache keyed by binary SHA-256 in
tmp/ghidra_project/<hash>/ so re-analysis is skipped.

Run:  GHIDRA_INSTALL_DIR=... python tools/re/re-service.py [--port 9334]
Commands (POST body {"cmd":..., "args":[...]}):
  open(path)            load+analyze a binary, set it current (cached by hash)
  info()                current program name/base/size/analysis state
  decompile(addr|name)  C decompilation of the function at addr/by name
  disasm(addr,len)      disassembly listing (pyGhidra; capstone fallback)
  callers(addr)         functions that call addr
  xrefs(addr)           references to addr
  symbols()             all functions {name, addr, size}
  resolve(addr)         {func, off, sym} for an address
  strings()             defined strings {addr, value}
  dataAt(addr)          defined data at addr
  exportSymbolMap()     {name -> RVA} for breakOnSymbol/loadSymbols
  doctor()              environment / backend availability
"""

import json
import os
import sys
import hashlib
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
# Ghidra refuses a project path with an element starting with '.', which every checkout
# under a `.wt\` worktree has; BS_RE_PROJECT_ROOT moves the cache somewhere dot-free.
PROJECT_ROOT = os.environ.get("BS_RE_PROJECT_ROOT") or os.path.join(REPO, "tmp", "ghidra_project")

# --- pyGhidra state (lazy, warm) ---
_pyghidra_started = False
_pyghidra_error = None
_current = None  # dict: {path, hash, flat, program}


def _try_start_pyghidra():
    global _pyghidra_started, _pyghidra_error
    if _pyghidra_started or _pyghidra_error:
        return _pyghidra_started
    try:
        # macOS: without headless AWT the JVM's LWCToolkit tries to init AppKit from a
        # non-main thread in a background process and deadlocks in +[AWTStarter start:].
        opts = os.environ.get("JAVA_TOOL_OPTIONS", "")
        if "java.awt.headless" not in opts:
            os.environ["JAVA_TOOL_OPTIONS"] = (opts + " -Djava.awt.headless=true").strip()
        import pyghidra  # noqa
        pyghidra.start()
        _pyghidra_started = True
    except Exception as e:  # ImportError / JVM / version mismatch
        _pyghidra_error = f"{type(e).__name__}: {e}"
    return _pyghidra_started


def _file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def _open(path):
    """Open a binary into a hash-keyed cached project, keep it warm as _current."""
    global _current
    if not os.path.isfile(path):
        raise RuntimeError(f"not a file: {path}")
    if not _try_start_pyghidra():
        raise RuntimeError(f"pyghidra unavailable ({_pyghidra_error}); set GHIDRA_INSTALL_DIR + pip install pyghidra")
    import pyghidra
    h = _file_hash(path)
    proj_dir = os.path.join(PROJECT_ROOT, h)
    os.makedirs(proj_dir, exist_ok=True)
    # open_program analyzes on first open; subsequent opens reuse the saved project.
    ctx = pyghidra.open_program(path, project_location=proj_dir, project_name=h, analyze=True)
    flat = ctx.__enter__()
    program = flat.getCurrentProgram()
    _current = {"path": path, "hash": h, "flat": flat, "program": program, "ctx": ctx}
    base = int(program.getImageBase().getOffset())
    return {"path": path, "hash": h, "base": base, "name": program.getName()}


def _require():
    if not _current:
        raise RuntimeError("no program open — call open(path) first")
    return _current


def _addr(arg):
    import re as _re
    cur = _require()
    if isinstance(arg, str):
        s = arg.lower().strip()
        # Hex if 0x-prefixed OR pure [0-9a-f] (a bare hex EIP like 'b077ba00' or
        # '4010a0'); otherwise treat as a function name. (Addresses are hex.)
        is_hex = s.startswith("0x") or bool(_re.fullmatch(r"[0-9a-f]+", s))
        if not is_hex:
            fn = _find_function_by_name(arg)
            if fn is None:
                raise RuntimeError(f"function not found: {arg}")
            return fn.getEntryPoint()
        val = int(s, 16)
    else:
        val = int(arg)
    return cur["program"].getAddressFactory().getDefaultAddressSpace().getAddress(val)


def _find_function_by_name(name):
    cur = _require()
    fm = cur["program"].getFunctionManager()
    for fn in fm.getFunctions(True):
        if str(fn.getName()) == name:
            return fn
    return None


def cmd_open(path):
    return _open(path)


def cmd_info():
    cur = _require()
    p = cur["program"]
    return {
        "path": cur["path"], "hash": cur["hash"], "name": p.getName(),
        "base": int(p.getImageBase().getOffset()),
        "functions": p.getFunctionManager().getFunctionCount(),
    }


def cmd_mkfunc(target):
    """Define a function at addr (vtable-only entries Ghidra's analyzer missed)."""
    cur = _require()
    from ghidra.app.cmd.function import CreateFunctionCmd
    program = cur["program"]
    addr = _addr(target)
    fm = program.getFunctionManager()
    fn = fm.getFunctionContaining(addr)
    if fn is not None:
        return {"name": str(fn.getName()), "entry": int(fn.getEntryPoint().getOffset()), "created": False}
    tx = program.startTransaction("mkfunc")
    ok = False
    try:
        ok = CreateFunctionCmd(addr).applyTo(program)
    finally:
        program.endTransaction(tx, True)
    fn = fm.getFunctionContaining(addr)
    if fn is None:
        raise RuntimeError(f"mkfunc failed at {target} (applyTo={ok})")
    return {"name": str(fn.getName()), "entry": int(fn.getEntryPoint().getOffset()), "created": True}


def cmd_decompile(target):
    cur = _require()
    from ghidra.app.decompiler import DecompInterface
    from ghidra.util.task import ConsoleTaskMonitor
    addr = _addr(target)
    fn = cur["program"].getFunctionManager().getFunctionContaining(addr)
    if fn is None:
        # Auto-define: vtable-only functions are never direct-call targets, so the
        # initial analysis misses them. Create, then decompile as usual.
        cmd_mkfunc(target)
        fn = cur["program"].getFunctionManager().getFunctionContaining(addr)
    if fn is None:
        raise RuntimeError(f"no function containing {addr}")
    di = DecompInterface()
    di.openProgram(cur["program"])
    res = di.decompileFunction(fn, 60, ConsoleTaskMonitor())
    if not res.decompileCompleted():
        raise RuntimeError(f"decompile failed: {res.getErrorMessage()}")
    return {"name": str(fn.getName()), "entry": int(fn.getEntryPoint().getOffset()), "c": res.getDecompiledFunction().getC()}


def cmd_disasm(addr, length=64):
    try:
        cur = _require()
        listing = cur["program"].getListing()
        a = _addr(addr)
        out = []
        end = int(a.getOffset()) + int(length)
        ins = listing.getInstructionAt(a)
        while ins is not None and int(ins.getAddress().getOffset()) < end:
            out.append({"addr": int(ins.getAddress().getOffset()), "text": str(ins)})
            ins = ins.getNext()
        if out:
            return {"backend": "ghidra", "instructions": out}
    except Exception:
        pass
    # Capstone fallback (no JVM) — tools/pe-disas.py.
    return _capstone_disasm(addr, length)


def _capstone_disasm(addr, length):
    if not _current:
        raise RuntimeError("capstone fallback needs an open binary path (open() first)")
    script = os.path.join(REPO, "tools", "pe-disas.py")
    if not os.path.isfile(script):
        raise RuntimeError("no ghidra and tools/pe-disas.py missing")
    a = addr if isinstance(addr, str) else hex(addr)
    # pe-disas.py CLI: range <exe> <va_hex> <nbytes_HEX> — the command word is
    # required and the length arg is parsed as hex (int(argv[4], 16)).
    r = subprocess.run([sys.executable, script, "range", _current["path"], a, hex(int(length))],
                       capture_output=True, text=True)
    return {"backend": "capstone", "stdout": r.stdout, "stderr": r.stderr[:500]}


def cmd_callers(addr):
    cur = _require()
    a = _addr(addr)
    rm = cur["program"].getReferenceManager()
    fm = cur["program"].getFunctionManager()
    out = []
    for ref in rm.getReferencesTo(a):
        frm = ref.getFromAddress()
        fn = fm.getFunctionContaining(frm)
        out.append({"from": int(frm.getOffset()), "func": str(fn.getName()) if fn else None, "type": str(ref.getReferenceType())})
    return out


def cmd_xrefs(addr):
    return cmd_callers(addr)


def cmd_symbols():
    cur = _require()
    out = []
    for fn in cur["program"].getFunctionManager().getFunctions(True):
        out.append({"name": str(fn.getName()), "addr": int(fn.getEntryPoint().getOffset()), "size": int(fn.getBody().getNumAddresses())})
    return out


def cmd_resolve(addr):
    cur = _require()
    a = _addr(addr)
    fn = cur["program"].getFunctionManager().getFunctionContaining(a)
    base = int(cur["program"].getImageBase().getOffset())
    if fn is None:
        return {"func": None, "off": int(a.getOffset()) - base, "sym": None}
    entry = int(fn.getEntryPoint().getOffset())
    return {"func": str(fn.getName()), "off": int(a.getOffset()) - entry, "rva": entry - base, "sym": f"{fn.getName()}+0x{int(a.getOffset())-entry:x}"}


def cmd_strings():
    cur = _require()
    out = []
    di = cur["program"].getListing().getDefinedData(True)
    for d in di:
        v = d.getValue()
        if v is not None and d.hasStringValue():
            out.append({"addr": int(d.getAddress().getOffset()), "value": str(v)[:200]})
    return out


def cmd_dataAt(addr):
    cur = _require()
    a = _addr(addr)
    d = cur["program"].getListing().getDefinedDataAt(a)
    if d is None:
        return None
    return {"addr": int(d.getAddress().getOffset()), "type": str(d.getDataType().getName()), "value": str(d.getValue())[:200]}


def cmd_exportSymbolMap():
    """{name -> RVA} (offset from image base) — the breakOnSymbol/loadSymbols bridge.
    Duplicate display names (demangled C++ overloads/templates, thunks) are
    disambiguated with a +0x<rva> suffix so a breakpoint can target a specific
    instance instead of silently last-wins; `collisions` reports how many."""
    cur = _require()
    base = int(cur["program"].getImageBase().getOffset())
    out = {}
    collisions = 0
    for fn in cur["program"].getFunctionManager().getFunctions(True):
        name = str(fn.getName())
        rva = int(fn.getEntryPoint().getOffset()) - base
        if name in out:
            collisions += 1
            out[f"{name}+0x{rva:x}"] = rva  # keep the colliding instance addressable
        else:
            out[name] = rva
    return {"module": cur["program"].getName(), "base": base, "symbols": out, "collisions": collisions}


def cmd_doctor():
    cap = False
    try:
        import capstone  # noqa
        cap = True
    except Exception:
        pass
    return {
        "pyghidra": _try_start_pyghidra(),
        "pyghidraError": _pyghidra_error,
        "ghidraInstallDir": os.environ.get("GHIDRA_INSTALL_DIR"),
        "capstone": cap,
        "peDisasFallback": os.path.isfile(os.path.join(REPO, "tools", "pe-disas.py")),
        "projectRoot": PROJECT_ROOT,
        "open": _current["path"] if _current else None,
    }


COMMANDS = {
    "open": cmd_open, "info": cmd_info, "decompile": cmd_decompile, "disasm": cmd_disasm, "mkfunc": cmd_mkfunc,
    "callers": cmd_callers, "xrefs": cmd_xrefs, "symbols": cmd_symbols, "resolve": cmd_resolve,
    "strings": cmd_strings, "dataAt": cmd_dataAt, "exportSymbolMap": cmd_exportSymbolMap, "doctor": cmd_doctor,
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self._send({"ok": True})
        else:
            self._send({"ok": True, "service": "re-service", "commands": sorted(COMMANDS)})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            msg = json.loads(self.rfile.read(n) or b"{}")
            cmd = msg.get("cmd")
            args = msg.get("args") or []
            fn = COMMANDS.get(cmd)
            if not fn:
                self._send({"ok": False, "error": f"unknown command: {cmd}", "code": "UNKNOWN_CMD"})
                return
            result = fn(*args)
            self._send({"ok": True, "result": result})
        except Exception as e:
            self._send({"ok": False, "error": f"{type(e).__name__}: {e}", "code": "INTERNAL"})


def main():
    port = 9334
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    os.makedirs(PROJECT_ROOT, exist_ok=True)
    print(f"[re-service] listening on http://localhost:{port}  (pyghidra warm-on-first-open)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
