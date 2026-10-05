// Build isolated baseline/candidate from the same working sources. Never publish either.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../../', import.meta.url));
const vendor = path.join(root, 'vendor/v86');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-x87-pair-'));
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest = { dir, arms: {}, created: new Date().toISOString() };
for (const arm of ['baseline', 'candidate']) {
    const dst = path.join(dir, arm);
    fs.mkdirSync(path.join(dst, 'build'), { recursive: true });
    for (const name of ['src', 'crates', 'tools', '.cargo', 'Cargo.toml', 'Cargo.lock'])
        fs.cpSync(path.join(vendor, name), path.join(dst, name), { recursive: true });
    for (const name of ['zstddeclib.o', 'libv86.mjs'])
        fs.copyFileSync(path.join(vendor, 'build', name), path.join(dst, 'build', name));
    const source = path.join(dst, 'src/rust/codegen.rs');
    if (arm === 'candidate') {
        let s = fs.readFileSync(source, 'utf8');
        s = s.replace('fn gen_fpu_relaxed_st_ok(ctx:', 'fn gen_fpu_relaxed_repr_ok(ctx:');
        const split = '    // …and the register must hold a value at all.';
        if (!s.includes(split)) throw new Error('baseline guard changed');
        s = s.replace(split, `}

fn gen_fpu_relaxed_st_ok(ctx: &mut JitContext, i: u32, addr: &WasmLocal) {
    gen_fpu_relaxed_repr_ok(ctx, i, addr);
${split}`);
        const helper = `
/// Both operands must have a relaxed representation AND be nonempty. Duplicate the
/// physical empty byte so rotating TOP also handles ST(i) wrapping from register 7 to 0.
/// This predicate reads state only; it must run before any stack mutation or helper.
fn gen_fpu_relaxed_pair_ok(ctx: &mut JitContext, i: u32, st0: &WasmLocal, sti: &WasmLocal) {
    gen_fpu_relaxed_repr_ok(ctx, 0, st0);
    gen_fpu_relaxed_repr_ok(ctx, i, sti);
    ctx.builder.and_i32();
    ctx.builder.load_fixed_u8(global_pointers::fpu_stack_empty as u32);
    ctx.builder.const_i32(0x101);
    ctx.builder.mul_i32();
    ctx.builder.load_fixed_u8(global_pointers::fpu_stack_ptr as u32);
    ctx.builder.shr_u_i32();
    ctx.builder.const_i32((1 | (1u32 << i)) as i32);
    ctx.builder.and_i32();
    ctx.builder.eqz_i32();
    ctx.builder.and_i32();
}

`;
        s = s.replace('fn gen_fpu_load_relaxed_st_bits(', helper + 'fn gen_fpu_load_relaxed_st_bits(');
        let count = 0;
        s = s.replace(/    gen_fpu_relaxed_st_ok\(ctx, 0, &st0_addr\);\r?\n    gen_fpu_relaxed_st_ok\(ctx, (sti|i|1), &(op_addr|sti_addr|st1_addr)\);\r?\n    ctx.builder.and_i32\(\);/g,
            (_, i, addr) => { count++; return `    gen_fpu_relaxed_pair_ok(ctx, ${i}, &st0_addr, &${addr});`; });
        if (count !== 5) throw new Error(`expected 5 pair consumers, got ${count}`);
        fs.writeFileSync(source, s);
    }
    console.log(`BUILD ${arm} ${dst}`);
    const build = spawnSync('cargo', ['rustc', '--release', '--target', 'wasm32-unknown-unknown', '--',
        '-C', 'linker=tools/rust-lld-wrapper.cmd', '-C', 'link-args=--import-table --global-base=4096',
        '-C', 'link-args=build/zstddeclib.o', '-C', 'target-feature=+bulk-memory',
        '-C', 'target-feature=+multivalue', '-C', 'target-feature=+simd128'], { cwd: dst, encoding: 'utf8', maxBuffer: 8 << 20 });
    fs.writeFileSync(path.join(dst, 'build.log'), build.stdout + build.stderr);
    if (build.status !== 0) throw new Error(build.stderr.slice(-6000));
    const wasm = path.join(dst, 'build/wasm32-unknown-unknown/release/v86.wasm');
    fs.copyFileSync(wasm, path.join(dst, 'build/v86.wasm'));
    manifest.arms[arm] = { wasm: path.join(dst, 'build/v86.wasm'), hash: sha(wasm), source: sha(source) };
}
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
