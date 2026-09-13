# RE layer — warm pyGhidra service

The static (reverse-engineering) half of the bring-up loop, packaged as a warm
local service with a contract that mirrors `harness_rpc` (`{cmd,args} -> {ok,result|error}`,
clean POJO). Consolidates the ~100 one-off Java GhidraScripts + `ghidra_*.py` glue
into ~10 commands; fixes the two real pains (Java→Python ergonomics, cold-headless→warm
latency) while preserving the project's Ghidra capital. Capstone (`tools/pe-disas.py`)
is the zero-dep fallback.

## Setup
```
pip install pyghidra capstone
export GHIDRA_INSTALL_DIR=/path/to/ghidra   # required for the Ghidra backend
bun tools/re/re.ts doctor                    # verify backend availability
```
`re doctor` reports pyghidra/JVM/capstone/GHIDRA_INSTALL_DIR. Without Ghidra the
service still answers `disasm` via capstone; decompile/xrefs report a clear error.

## Use
```
bun tools/re/re.ts start tmp/hl_real.exe     # launch warm service + open binary
bun tools/re/re.ts decompile 0x401000
bun tools/re/re.ts symbols
bun tools/re/re.ts callers 0x401000
```
Project cache is keyed by binary SHA-256 in `tmp/ghidra_project/<hash>/` → analysis
is done once and reused (warm).

### `re vtable` — transcribe a C++ vtable instead of guessing it

```
bun tools/re/re.ts vtable <binary> <ClassName@ns@@ | 0xVFTABLE> [--slots N]
```
Answers with every vftable MSVC emitted for that class (one per base layout, each with
its `baseOffset`) and, per slot, the target function and its **pushed-argument count**,
measured from the `RET imm16` — the count an HLE stub must clean, since `this` rides in
ECX under `__thiscall`. Return sites that disagree are reported as `conflictingRets`
with `args: null` rather than averaged into a plausible number, and a class with no RTTI
descriptor is an error, not an empty result.

Reach for it before writing ANY interface descriptor whose layout you are recalling
rather than reading: an invented slot order answers slot N with a method of a different
arity, and the RET mismatch walks the caller's ESP off its own frame — the fault then
lands in code with no connection to the interface (this cost days on `ID3DXEffect` and
again on `galaxy::api::IGalaxy`). Needs only PE + capstone, no Ghidra and no open
project, so it answers for any DLL on disk while the service holds a different binary.

## Static ↔ dynamic bridge (the point)
1. **Wild EIP → which function.** The harness emits `fault`/`breakHit` with a live
   EIP; relocate it against the live module base from `harness.state(['modules'])`:
   ```
   bun tools/re/re.ts resolve 0xb077ba00 --base 0x10000000
   ```
2. **C++-symbol breakpoints.** Export a sidecar map the harness loads:
   ```
   bun tools/re/re.ts exportSymbolMap --out core.symbols.json --module core
   # then in a harness script:  .call('loadSymbols','core', <symbols>)  .breakOnSymbol('core!UInput::ReadInput')
   ```
   Store `<game>.symbols.json` as a per-game sidecar (rides on container-vfs metadata).

## Boundary
RE stays a **separate, adjacent process** — heavy, offline — NOT embedded in the
live browser harness. The symmetric CLI gives one mental model: static and dynamic
are driven the same way.

## `libid` — whose hot code is this: the game's, or a library's

`re resolve` answers **what** the function at an address is called. `libid` answers
**whose** code it is. For an emulator profile those are different questions:
`FUN_00672fc8` is an honest name and a useless answer at the same time, if what lives
there is CRT `__ftol`, the same one in every game of the era. Until the owner of the
code is known, "31% of the time in the JIT" turns into neither a work plan nor an
estimate of how far a fix carries.

```
bun tools/re/libid.ts index tmp/nfsu/Speed.exe            # image map, once per sha256
bun tools/re/libid.ts ask   tmp/nfsu/Speed.exe 0x672fc8 g0040d001@t12
bun tools/re/libid.ts ask   tmp/nfsu/Speed.exe --addrs hot.txt --json
bun tools/re/libid.ts summary  tmp/nfsu/Speed.exe          # distribution by owner
bun tools/re/libid.ts selftest tmp/nfsu/Speed.exe          # check against known anchors
```

`index` and `sigs` open the image in Ghidra (project cache shared with `re-service`,
analysis once per sha256). `ask`/`summary`/`selftest` read the built index and never
touch Ghidra — a list of hot addresses is answered instantly, which is the path a
census walks over hundreds of trace addresses. Addresses are also accepted as trace
names (`g0040d001@t12`), so nobody transcribes a VA by hand.

### Where an identification comes from

| source | what it proves | weight |
|---|---|---|
| `fid` | Ghidra Function ID — the FLIRT analogue; the shipped database is built from Visual Studio libraries, so a hit already means "not game code" | Single Match — high, Conflict — medium |
| `sig` | our own signatures off a donor DLL (`libid.py sigs d3dx9_24.dll --lib d3dx9`): strict — body bytes with addresses masked, fuzzy — the mnemonic stream | strict — high, fuzzy — medium |
| `str` | fingerprint strings and constants from `lib-fingerprints.json` and the xrefs to them, including one hop through a pointer in data | strong — high |
| `import` | a thunk into an import: the code is not in the image at all | high |
| `shared` | the same body is present in another game's image (`sigs --kind corpus`): the code is shared, but which library is not said | medium |
| `region` | a function with no evidence of its own inside a dense library block — the linker lays object files down in a row | low |
| `vtable` | a slot of a method table whose other slots are confirmed library code | low |
| `callgraph` | the only code entering a group of mutually recursive functions from outside is confirmed library code | low |

### Four verdicts, not two

`library` / `import` / `game` / `unresolved`. "Unidentified" is not a synonym for
"game code": merging them would hand the census a share of "engine's own code" that
nobody measured. So every answer carries a `confidence` and a `reason` naming its
source, and `unresolved` is returned honestly — including when the image holds too
few confirmed library functions for the block map to be worth trusting.

Separately: `summary` prints shares of **static code size**, not of time. The share of
time comes only from a profile laid over these answers.

### Signatures

`libid.py sigs <donor> --lib <name>` takes signatures off a library (an era-appropriate
DLL — `d3dx9_24.dll`, `binkw32.dll`) into `tools/re/libsigs/*.sig.json`. `--kind corpus`
marks the donor as a foreign game: a match against it does not name a library, it only
proves the code is not unique to the image — and conversely, the absence of matches
across a corpus of foreign games becomes positive evidence for "this is game code",
rather than an absence of evidence.
