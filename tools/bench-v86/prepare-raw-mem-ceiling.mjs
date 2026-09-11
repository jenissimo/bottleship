// Isolated CEILING experiment: extend the existing unsafe raw-read path from 32-bit reads to
// 8- and 16-bit reads as well. Shipping source and Wasm stay untouched.
//
// WHY. `stack_raw_unsafe` mode 2 already bypasses the inline TLB guard for flat 32-bit reads,
// and that alone measured **+5.9% FPS** in a clean NFSU race (22.98 -> 24.35, interleaved arms,
// stable calibrator). It is reached from ONE emitter, gen_modrm_resolve_safe_read32; the game's
// hot code also does byte and word reads (the walker reads `short`/`ushort` selectors). This
// build adds the same path for those widths to measure how much more of the guard cost is
// recoverable.
//
// This is NOT shippable: skipping the guard means such a read can no longer fault, and a
// permission change stops being observed. It is a ceiling measurement, and the number it
// produces is what a SAFE mechanism (permission bitmap / proven-page reuse) would be aiming at.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-rawmem-'));
const hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { directory, shippingHash: hash('public/v86.wasm'), arms: {} };
console.log(directory);

for (const arm of ['baseline', 'candidate']) {
    const dst = path.join(directory, arm);
    fs.mkdirSync(path.join(dst, 'build'), { recursive: true });
    for (const name of ['src', 'crates', 'tools', '.cargo', 'Cargo.toml', 'Cargo.lock']) {
        fs.cpSync(path.join(vendor, name), path.join(dst, name), { recursive: true });
    }
    for (const name of ['libv86.mjs', 'zstddeclib.o']) {
        fs.copyFileSync(path.join(vendor, 'build', name), path.join(dst, 'build', name));
    }
    if (arm === 'candidate') {
        const f = path.join(dst, 'src/rust/codegen.rs');
        let source = fs.readFileSync(f, 'utf8');
        const replace = (a, b) => {
            if (source.split(a).length !== 2) throw Error('Ambiguous or missing anchor: ' + a.slice(0, 70));
            source = source.replace(a, b);
        };
        replace(
            'pub fn gen_modrm_resolve_safe_read8(ctx: &mut JitContext, modrm_byte: ModrmByte) {\n'
            + '    gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| gen_safe_read8(ctx, addr));\n}',
            'pub fn gen_modrm_resolve_safe_read8(ctx: &mut JitContext, modrm_byte: ModrmByte) {\n'
            + '    if let Some(base) = stack_raw_applies(ctx, &modrm_byte) {\n'
            + '        gen_modrm_resolve(ctx, modrm_byte);\n'
            + '        ctx.builder.load_u8(base);\n'
            + '        return;\n'
            + '    }\n'
            + '    gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| gen_safe_read8(ctx, addr));\n}',
        );
        replace(
            'pub fn gen_modrm_resolve_safe_read16(ctx: &mut JitContext, modrm_byte: ModrmByte) {\n'
            + '    gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| gen_safe_read16(ctx, addr));\n}',
            'pub fn gen_modrm_resolve_safe_read16(ctx: &mut JitContext, modrm_byte: ModrmByte) {\n'
            + '    if let Some(base) = stack_raw_applies(ctx, &modrm_byte) {\n'
            + '        gen_modrm_resolve(ctx, modrm_byte);\n'
            + '        ctx.builder.load_unaligned_u16(base);\n'
            + '        return;\n'
            + '    }\n'
            + '    gen_modrm_resolve_with_local(ctx, modrm_byte, &|ctx, addr| gen_safe_read16(ctx, addr));\n}',
        );
        // WRITES: the same elision, at the one place every guest write funnels through. There is
        // no modrm-level chokepoint for writes, so the flat-segment test cannot be applied here;
        // mode >= 2 is taken as "the guest is flat", which is true for these titles and is why
        // this is a CEILING build and not a candidate. It also drops the HAS_CODE bit, so guest
        // self-modifying code would stop invalidating compiled blocks.
        // Anchor on the write path's own comment: the block/get_local preamble below is shared
        // with gen_safe_read and is not unique.
        const writeAnchor = [
            '    //   fast: mem[(entry & ~0xFFF) ^ addr] <- value',
            '',
            '    let cont = ctx.builder.block_void();',
            '    ctx.builder.get_local(&address_local);',
            '',
            '    ctx.builder.const_i32(12);',
            '    ctx.builder.shr_u_i32();',
            '    ctx.builder.const_i32(2);',
            '    ctx.builder.shl_i32();',
            '',
            '    ctx.builder',
            '        .load_aligned_i32(unsafe { &tlb_data[0] as *const i32 as u32 });',
            '    let entry_local = ctx.builder.tee_new_local();',
        ].join(String.fromCharCode(10));
        const rawWrite = [
            '    if stack_raw_unsafe_mode() >= 2 {',
            '        if let Some(base) = raw_guest_base() {',
            '            if let GenSafeWriteValue::I32(local) = value_local {',
            '                ctx.builder.get_local(&address_local);',
            '                ctx.builder.get_local(local);',
            '                match bits {',
            '                    BitSize::BYTE => ctx.builder.store_u8(base),',
            '                    BitSize::WORD => ctx.builder.store_unaligned_u16(base),',
            '                    _ => ctx.builder.store_unaligned_i32(base),',
            '                }',
            '                return;',
            '            }',
            '        }',
            '    }',
        ].join(String.fromCharCode(10));
        replace(writeAnchor, rawWrite + String.fromCharCode(10) + writeAnchor);
        fs.writeFileSync(f, source);
    }
    const r = spawnSync('cargo', ['rustc', '--release', '--target', 'wasm32-unknown-unknown', '--',
        '-C', 'linker=tools/rust-lld-wrapper.cmd',
        '-C', 'link-args=--import-table --global-base=4096',
        '-C', 'link-args=build/zstddeclib.o',
        '-C', 'target-feature=+bulk-memory', '-C', 'target-feature=+multivalue',
        '-C', 'target-feature=+simd128'],
        { cwd: dst, encoding: 'utf8', maxBuffer: 16 << 20 });
    fs.writeFileSync(path.join(dst, 'build.log'), (r.stdout ?? '') + (r.stderr ?? ''));
    if (r.status !== 0) throw Error(r.error ?? r.stderr?.slice(-3000));
    const wasm = path.join(dst, 'build/wasm32-unknown-unknown/release/v86.wasm');
    manifest.arms[arm] = { wasm, hash: hash(wasm), bytes: fs.statSync(wasm).size };
    const engines = path.resolve('public/apps/source-pair-lab/engines');
    fs.mkdirSync(engines, { recursive: true });
    fs.copyFileSync(wasm, path.join(engines, `${manifest.arms[arm].hash}.wasm`));
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ arm, ...manifest.arms[arm] }));
}
console.log(JSON.stringify({
    manifest: path.join(directory, 'manifest.json'),
    baselineMatchesShipping: manifest.arms.baseline.hash === manifest.shippingHash,
}));
