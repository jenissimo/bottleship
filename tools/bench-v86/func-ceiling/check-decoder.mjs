// Decoder oracle: every instruction the discovery walk reaches must start at an instruction
// boundary of an INDEPENDENT disassembler (MSVC dumpbin /disasm) with the same length; plus the
// discovery statistics.
//   node check-decoder.mjs <flat.exe> [...]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadPE, discover } from "./discover.mjs";

function dumpbin() {
    const vs = process.env.VSINSTALLDIR || "C:/Program Files/Microsoft Visual Studio/2022/Community";
    const root = path.join(vs, "VC/Tools/MSVC");
    const v = fs.readdirSync(root).sort().at(-1);
    return path.join(root, v, "bin/Hostx64/x86/dumpbin.exe");
}

for (const exe of process.argv.slice(2)) {
    const pe = loadPE(fs.readFileSync(exe));
    const d = discover(pe);
    const txt = execFileSync(dumpbin(), ["/nologo", "/disasm", exe], { encoding: "utf8", maxBuffer: 1 << 30 });
    const len = new Map();
    let cur = null;
    for (const line of txt.split(/\r?\n/)) {
        let m = /^\s+([0-9A-F]{8}): ((?:[0-9A-F]{2} )+)/.exec(line);
        if (m) { cur = parseInt(m[1], 16); len.set(cur, m[2].trim().split(" ").length); continue; }
        m = /^\s+([0-9A-F]{2}(?: [0-9A-F]{2})*)\s*$/.exec(line);
        if (m && cur !== null) len.set(cur, len.get(cur) + m[1].trim().split(" ").length);
    }
    let checked = 0, bad = 0, missing = 0;
    const badList = [];
    for (const f of d.funcs.values()) for (const b of f.blocks.values()) for (const i of b.ins) {
        if (i.m === "int3") continue;
        checked++;
        const L = len.get(i.addr);
        if (L === undefined) { missing++; if (badList.length < 10) badList.push({ addr: i.addr.toString(16), ours: i.len, dumpbin: "no boundary", m: i.m }); }
        else if (L !== i.len) { bad++; if (badList.length < 10) badList.push({ addr: i.addr.toString(16), ours: i.len, dumpbin: L, m: i.m }); }
    }
    console.log(JSON.stringify({ exe, checked, lengthMismatch: bad, notABoundary: missing, examples: badList, stats: d.stats }));
}
