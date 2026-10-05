#!/usr/bin/env bun
/**
 * win32-arity-oracle: derive stdcall argument counts from a REAL 32-bit Windows DLL.
 *
 * Why this exists: validate-signatures can only cross-check an arity when the name carries
 * stdcall decoration (_Foo@16) or the module has a tools/reference/win32 entry. For the modules
 * with neither, a wrong arity is unprovable in-repo — and a wrong arity misaligns the thunk's
 * RET N and corrupts the guest frame. But the answer ships with Windows: in a 32-bit stdcall
 * DLL the CALLEE cleans the stack, so the RET imm16 in the epilogue IS the argument count
 * (imm16 / 4), read out of the shipping binary rather than guessed.
 *
 * Only the SysWOW64 (32-bit) copies are usable. The System32 ones on a 64-bit Windows are x64,
 * where the caller-cleans ABI makes RET carry no arity at all — so this refuses them by machine
 * type instead of silently reporting every function as zero-argument.
 *
 * KNOWN LIMIT, and the reason for the two filters below: there is no instruction-length decoder
 * here, so a byte scan cannot by itself tell where one function ends and the next begins. Both
 * filters exist to turn a would-be confidently-wrong answer into an honest "unknown".
 *
 * Usage:
 *   bun tools/win32-arity-oracle.ts <dll-path|module-name> [more...] [--json]
 *   bun tools/win32-arity-oracle.ts hid --check src/worker/api/hid.api.ts
 * Exit code 1 if any --check mismatch was found.
 */
import { readFileSync, existsSync } from "fs";
import { readPeHeaders, rvaToFileOffset } from "../packages/formats/src/pe";

const SYSWOW64 = "C:/Windows/SysWOW64";
/** A real stdcall frame is 4-aligned and small; this rejects operand-byte coincidences. */
const MAX_STACK_BYTES = 256;

interface ArityRow {
    name: string;
    rva: number;
    /** imm16/4 when one RET imm16 was attributable; 0 for a bare RET; null when unknown. */
    args: number | null;
    /** Distinct terminal forms seen, for auditing. */
    forms: string[];
    note?: string;
}

function exportTable(image: Uint8Array) {
    const h = readPeHeaders(image);
    if (!h) throw new Error("not a PE image");
    if (h.machine !== 0x14c) {
        throw new Error(
            `machine 0x${h.machine.toString(16)} is not i386 — only a 32-bit DLL encodes arity in `
            + `RET (x64 is caller-cleans, so its RET is always bare). Use the SysWOW64 copy.`);
    }
    const dir = h.dataDirectories[0]; // IMAGE_DIRECTORY_ENTRY_EXPORT
    if (!dir || !dir.rva) throw new Error("no export directory");
    const base = rvaToFileOffset(h, dir.rva);
    if (base === null) throw new Error("export directory RVA is not mapped");
    const v = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const numFuncs = v.getUint32(base + 20, true);
    const numNames = v.getUint32(base + 24, true);
    const funcsOff = rvaToFileOffset(h, v.getUint32(base + 28, true));
    const namesOff = rvaToFileOffset(h, v.getUint32(base + 32, true));
    const nameOrdOff = rvaToFileOffset(h, v.getUint32(base + 36, true));
    if (funcsOff === null || namesOff === null || nameOrdOff === null) throw new Error("export tables not mapped");

    const cstr = (off: number) => {
        let e = off;
        while (e < image.length && image[e]) e++;
        return new TextDecoder().decode(image.subarray(off, e));
    };
    const rows: { name: string; rva: number; forwarded: boolean }[] = [];
    for (let i = 0; i < numNames; i++) {
        const nameOff = rvaToFileOffset(h, v.getUint32(namesOff + i * 4, true));
        const ord = v.getUint16(nameOrdOff + i * 2, true);
        if (nameOff === null || ord >= numFuncs) continue;
        const fnRva = v.getUint32(funcsOff + ord * 4, true);
        // An RVA inside the export directory is a forwarder string, not code.
        const forwarded = fnRva >= dir.rva && fnRva < dir.rva + dir.size;
        rows.push({ name: cstr(nameOff), rva: fnRva, forwarded });
    }
    return { headers: h, exports: rows.sort((a, b) => a.rva - b.rva) };
}

/**
 * True when the export is only a TAIL-JUMP STUB, i.e. its body lives in another image.
 *
 * Modern Windows system DLLs export a hotpatch prologue then jmp dword ptr [__imp_...] into an
 * ApiSet/IAT target: 8B FF (mov edi,edi), 55 8B EC (push ebp; mov ebp,esp), 5D (pop ebp),
 * FF 25 <abs32>. There is no epilogue here, so a scan runs off the end of the stub and reports a
 * RET belonging to whatever follows — which is how RegOpenKeyExW read as 3 args instead of its
 * documented 5, and CloseServiceHandle as 9 instead of 1.
 */
function isTailJumpStub(image: Uint8Array, off: number): boolean {
    const end = Math.min(image.length, off + 16);
    for (let p = off; p + 1 < end; p++) {
        if (image[p] === 0xff && image[p + 1] === 0x25) return true; // jmp dword ptr [abs32]
        if (image[p] === 0xc2 || image[p] === 0xc3) return false;    // a real epilogue came first
    }
    return false;
}

/**
 * True when `p` is a RET actually preceded by a function epilogue. Requiring the classic epilogue
 * context is an INDEPENDENT structural property, not a fit to any expected answer, and it is what
 * makes a hit attributable to the function we are standing in.
 */
function isEpilogueTerminator(image: Uint8Array, p: number): boolean {
    const b = image[p];
    if (b !== 0xc3 && b !== 0xc2) return false;
    if (b === 0xc2 && p + 2 >= image.length) return false;
    const prev = (n: number) => (p - n >= 0 ? image[p - n] : -1);
    if (prev(1) === 0x5d || prev(1) === 0xc9) return true;                     // pop ebp | leave
    if (prev(1) === 0x5b || prev(1) === 0x5e || prev(1) === 0x5f) return true;  // pop ebx/esi/edi
    if (prev(1) === 0x59) return true;                                          // pop ecx
    if (prev(2) === 0x8b && prev(1) === 0xe5) return true;                      // mov esp,ebp
    if (prev(3) === 0x83 && prev(2) === 0xc4) return true;                      // add esp,imm8
    if (prev(6) === 0x81 && prev(5) === 0xc4) return true;                      // add esp,imm32
    return false;
}

/** Distinct terminal RET forms inside [rva, limitRva), following a leading direct jump. */
function terminalForms(image: Uint8Array, h: NonNullable<ReturnType<typeof readPeHeaders>>, rva: number, limitRva: number): string[] {
    let off = rvaToFileOffset(h, rva);
    if (off === null) return [];
    const v = new DataView(image.buffer, image.byteOffset, image.byteLength);
    for (let hops = 0; hops < 4 && image[off] === 0xe9; hops++) {
        const target = rva + 5 + v.getInt32(off + 1, true);
        const next = rvaToFileOffset(h, target);
        if (next === null) break;
        off = next;
        rva = target;
    }
    if (isTailJumpStub(image, off)) return ["stub"];
    const span = Math.max(16, Math.min(limitRva - rva, 4096));
    const end = Math.min(image.length, off + span);
    const forms = new Set<string>();
    for (let p = off; p < end; p++) {
        if (!isEpilogueTerminator(image, p)) continue;
        if (image[p] === 0xc3) { forms.add("ret"); continue; }
        const imm = image[p + 1] | (image[p + 2] << 8);
        if (imm > 0 && imm % 4 === 0 && imm <= MAX_STACK_BYTES) forms.add(`ret ${imm}`);
    }
    return [...forms];
}

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const checkIdx = argv.indexOf("--check");
const checkFile = checkIdx >= 0 ? argv[checkIdx + 1] : null;
// `--check <file>`'s VALUE is the only positional that is not a target. With no --check
// there is no such index, and comparing against `-1 + 1` would silently eat the first target.
const checkValueIdx = checkIdx >= 0 ? checkIdx + 1 : -1;
const targets = argv.filter((a, i) => !a.startsWith("--") && i !== checkValueIdx);

if (targets.length === 0) {
    console.error("usage: bun tools/win32-arity-oracle.ts <dll-path|module-name> [--json] [--check <api.ts>]");
    process.exit(2);
}

let anyMismatch = false;
let verifiedNothing = false;
let missingTarget = false;
for (const t of targets) {
    const path = existsSync(t) ? t : `${SYSWOW64}/${t.replace(/\.dll$/i, "")}.dll`;
    // A target we could not open is a failed run, not a skipped one: the caller asked for it.
    if (!existsSync(path)) { console.error(`skip ${t}: no such file (${path})`); missingTarget = true; continue; }
    const image = new Uint8Array(readFileSync(path));
    let table: ReturnType<typeof exportTable>;
    try { table = exportTable(image); } catch (e) { console.error(`skip ${path}: ${(e as Error).message}`); continue; }

    const rows: ArityRow[] = [];
    for (let i = 0; i < table.exports.length; i++) {
        const e = table.exports[i];
        if (e.forwarded) { rows.push({ name: e.name, rva: e.rva, args: null, forms: [], note: "forwarded" }); continue; }
        const limit = table.exports[i + 1]?.rva ?? e.rva + 4096;
        const forms = terminalForms(image, table.headers, e.rva, limit);
        if (forms.includes("stub")) {
            rows.push({ name: e.name, rva: e.rva, args: null, forms, note: "IAT tail-jump stub — body is in another image" });
            continue;
        }
        const rets = forms.filter((f) => f.startsWith("ret "));
        let args: number | null = null;
        let note: string | undefined;
        if (rets.length === 1 && !forms.includes("ret")) {
            args = Number(rets[0].slice(4)) / 4;
        } else if (rets.length === 1 && forms.includes("ret")) {
            // Both a bare RET and a RET imm in the same range. The range runs to the NEXT
            // EXPORT, so it routinely covers non-exported code after the body — preferring the
            // imm attributes a neighbour's cleanup to a cdecl export and reports a confident
            // wrong arity (verified on msvcrt's _ultoa/realloc). Ambiguous is the honest answer.
            note = `ambiguous: bare ret and ${rets[0]} in the same range (scan may span a function boundary)`;
        } else if (rets.length === 0 && forms.includes("ret")) {
            args = 0;
            note = "bare ret (cdecl, or stdcall with zero args)";
        } else if (rets.length >= 1) {
            note = `ambiguous: ${forms.join(", ")}`;
        } else {
            note = "no attributable ret in range";
        }
        rows.push({ name: e.name, rva: e.rva, args, forms, note });
    }

    if (json) { console.log(JSON.stringify({ dll: path, exports: rows }, null, 1)); continue; }
    console.log(`\n=== ${path}  (${rows.length} named exports)`);
    for (const r of rows) {
        console.log(`  ${r.name.padEnd(34)} args=${(r.args === null ? "?" : String(r.args)).padStart(2)}  ${r.note ?? ""}`);
    }

    if (checkFile && existsSync(checkFile)) {
        const src = readFileSync(checkFile, "utf8");
        console.log(`\n--- cross-check vs ${checkFile}`);
        let ok = 0, bad = 0, skipped = 0;
        for (const r of rows) {
            const m = new RegExp(`makeFunc\\("${r.name}",\\s*(\\d+)`).exec(src);
            if (!m) { skipped++; continue; }
            const declared = Number(m[1]);
            if (r.args === null) { skipped++; continue; }
            if (declared === r.args) { ok++; continue; }
            // A bare ret in the DLL against a non-zero declared count is the cdecl/varargs case
            // (wsprintfA), not a stdcall disagreement — report it, but not as a mismatch.
            if (r.args === 0 && r.forms.includes("ret") && declared > 0) {
                console.log(`  ~ ${r.name}: declared ${declared}, DLL is cdecl/varargs (bare ret) — not comparable`);
                skipped++;
                continue;
            }
            console.log(`  MISMATCH ${r.name}: declared ${declared}, real DLL says ${r.args} (${r.forms.join(", ")})`);
            bad++;
        }
        console.log(`  ${ok} agree, ${bad} mismatch, ${skipped} unchecked`);
        if (bad > 0) anyMismatch = true;
        // A --check that compared NOTHING is not a pass. Every export being a tail-jump stub
        // (an ApiSet forwarder DLL) reads exactly like a clean run otherwise.
        if (ok + bad === 0) {
            console.error(`  VERIFIED NOTHING for ${t}: ${skipped} export(s), none comparable`);
            verifiedNothing = true;
        }
    }
}
if (checkFile && !existsSync(checkFile)) {
    console.error(`--check ${checkFile}: no such file — nothing was cross-checked`);
    process.exit(2);
}
if (missingTarget) process.exit(2);
process.exit(anyMismatch || verifiedNothing ? 1 : 0);
