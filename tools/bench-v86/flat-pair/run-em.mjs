// Arm B runner: the Emscripten build of the same source, in the same Node/V8.
//   node run-em.mjs --mjs out/flat/flat.mjs --warm 3 --lo 2000 --hi 8000 --reps 3 [--seed 7]
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";

export async function runEm(opts) {
    const factory = (await import(url.pathToFileURL(path.resolve(opts.mjs)).href)).default;
    const input = [0xF1A7, opts.warm, opts.lo, opts.hi, opts.reps, opts.seed ?? 7];
    let inPos = 0;
    const marks = [], outs = [];
    const mod = await factory({
        bsIn: () => (input[inPos++] ?? 0) >>> 0,
        bsOut: (v) => outs.push(v >>> 0),
        bsMark: (id) => marks.push({ id, t: Number(process.hrtime.bigint()) }),
        print: () => {}, printErr: (s) => process.stderr.write(s + "\n"),
    });
    mod._bs_main();
    const wasm = path.resolve(opts.mjs).replace(/\.mjs$/, ".wasm");
    return {
        arm: opts.label || "emscripten", status: marks.length && marks[marks.length - 1].id === 99 ? "ok" : "HALT_EARLY",
        mjs: opts.mjs, wasmSha256: crypto.createHash("sha256").update(fs.readFileSync(wasm)).digest("hex"),
        input, marks, outs,
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
    const a = process.argv.slice(2);
    const o = { warm: 2, lo: 1000, hi: 4000, reps: 3, seed: 7 };
    for (let i = 0; i < a.length; i++) {
        if (a[i] === "--mjs") o.mjs = a[++i];
        else if (a[i] === "--out") o.out = a[++i];
        else if (a[i] === "--label") o.label = a[++i];
        else if (["--warm", "--lo", "--hi", "--reps", "--seed"].includes(a[i])) o[a[i].slice(2)] = Number(a[++i]);
        else { console.error(`unknown option ${a[i]}`); process.exit(2); }
    }
    const r = await runEm(o);
    const s = JSON.stringify(r);
    if (o.out) fs.writeFileSync(o.out, s);
    console.log(s);
}
