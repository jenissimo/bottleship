// Isolated experiment: make the flag-locals reload LAZY. Shipping source and Wasm untouched.
//
// WHY. With jit config 21 on, every non-whitelisted helper call emits
//   spill (dirty words only)  →  call  →  reload (ALL FIVE words, unconditionally).
// The spill is dirty-aware; the reload is not. On an ALU loop with no calls that costs nothing
// (measured: idx21 is -12.5% on the demo's k3), on call-dense code it is a storm (measured:
// idx21 is +4.7% SLOWER in an NFSU race, and only -2.6% on the pointer-chasing k1).
//
// The fix needs no per-helper classification. After the spill, MEMORY is authoritative for all
// five words, so the locals can simply be marked stale and each word reloaded at its first use;
// slots never used before the next call are never reloaded. Staleness is materialised at every
// control-flow boundary, so a join can never observe a half-reloaded set.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const vendor = path.resolve('vendor/v86');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-flaglazy-'));
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
        const f = path.join(dst, 'src/rust/wasmgen/wasm_builder.rs');
        let source = fs.readFileSync(f, 'utf8');
        const replace = (a, b) => {
            if (source.split(a).length !== 2) throw Error('Ambiguous or missing anchor: ' + a.slice(0, 70));
            source = source.replace(a, b);
        };

        // 1. The staleness bitmask lives next to the dirty one.
        replace('    pub flag_locals: Option<[(u8, u32); 5]>,',
            '    pub flag_locals: Option<[(u8, u32); 5]>,\n'
            + '    /// Slots whose LOCAL is stale because a helper call made memory authoritative.\n'
            + '    /// Never set together with the same slot\'s dirty bit: a write clears it.\n'
            + '    flag_stale: u8,');
        replace('            flag_locals: None,', '            flag_locals: None,\n            flag_stale: 0,');
        replace('        self.flag_locals = None;', '        self.flag_locals = None;\n        self.flag_stale = 0;');

        // 2. A call marks stale instead of reloading five words.
        replace(
            '        if spill {\n            self.emit_flag_reload();\n        }\n    }',
            '        if spill {\n'
            + '            // Memory is authoritative here (the dirty words were just spilled), so the\n'
            + '            // locals are simply stale; each is reloaded at its first use, and any still\n'
            + '            // stale at a control-flow boundary is materialised there.\n'
            + '            self.flag_stale = 0x1f;\n'
            + '            self.flag_dirty = 0;\n'
            + '        }\n    }',
        );

        // 3. Materialise before a join, and before assuming everything is dirty.
        replace(
            '    fn flag_boundary(&mut self) {\n        if self.flag_locals.is_some() {\n            self.flag_dirty = 0x1f;',
            '    fn flag_boundary(&mut self) {\n        if self.flag_locals.is_some() {\n'
            + '            self.materialize_stale_flags();\n'
            + '            self.flag_dirty = 0x1f;',
        );

        // 4. The accessors: ensure a slot before reading it.
        replace(
            '    pub fn flag_local_get(&mut self, slot: usize) -> bool {\n        match self.flag_locals {\n            Some(locals) => {\n                self.get_local_raw(locals[slot].0);',
            '    pub fn flag_local_get(&mut self, slot: usize) -> bool {\n        self.ensure_flag_local(slot);\n        match self.flag_locals {\n            Some(locals) => {\n                self.get_local_raw(locals[slot].0);',
        );
        for (const [sig, body] of [
            ['pub fn flag_load_u8(&mut self, slot: usize, fallback_addr: u32) {', null],
            ['pub fn flag_load_u16(&mut self, slot: usize, fallback_addr: u32) {', null],
            ['pub fn flag_load_i32(&mut self, slot: usize, fallback_addr: u32) {', null],
        ]) { void body; replace('    ' + sig, '    ' + sig + '\n        self.ensure_flag_local(slot);'); }

        // 5. A write makes the local authoritative again.
        replace(
            '                self.set_local_raw(locals[slot].0);\n                self.flag_dirty |= 1 << slot;\n                true',
            '                self.set_local_raw(locals[slot].0);\n                self.flag_dirty |= 1 << slot;\n                self.flag_stale &= !(1u8 << slot);\n                true',
        );
        replace(
            '                self.set_local_raw(locals[slot].0);\n                self.drop_();\n                self.flag_dirty |= 1 << slot;',
            '                self.set_local_raw(locals[slot].0);\n                self.drop_();\n                self.flag_dirty |= 1 << slot;\n                self.flag_stale &= !(1u8 << slot);',
        );

        // 6. The two helpers.
        replace(
            '    /// Memory globals → locals (after helpers that write flags, e.g. update_eflags).',
            `    /// Load one stale slot back from its memory global, at its first use.
    fn ensure_flag_local(&mut self, slot: usize) {
        if let Some(locals) = self.flag_locals {
            if self.flag_stale & (1u8 << slot) != 0 {
                self.load_fixed_i32(locals[slot].1);
                self.instruction_body.push(op::OP_SETLOCAL);
                self.instruction_body.push(locals[slot].0);
                self.flag_stale &= !(1u8 << slot);
            }
        }
    }

    /// Materialise every still-stale slot. Called where a later path may observe the locals
    /// without having gone through this one.
    fn materialize_stale_flags(&mut self) {
        if let Some(locals) = self.flag_locals {
            if self.flag_stale == 0 { return; }
            for (slot, (idx, addr)) in locals.into_iter().enumerate() {
                if self.flag_stale & (1u8 << slot) == 0 { continue; }
                self.load_fixed_i32(addr);
                self.instruction_body.push(op::OP_SETLOCAL);
                self.instruction_body.push(idx);
            }
            self.flag_stale = 0;
        }
    }

    /// Memory globals → locals (after helpers that write flags, e.g. update_eflags).`,
        );

        // 7. The final spill must not write a stale (garbage) local.
        replace(
            '    pub fn emit_flag_spill(&mut self) {\n        if let Some(locals) = self.flag_locals {',
            '    pub fn emit_flag_spill(&mut self) {\n        if let Some(locals) = self.flag_locals {\n'
            + '            debug_assert!(self.flag_dirty & self.flag_stale == 0);',
        );
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
