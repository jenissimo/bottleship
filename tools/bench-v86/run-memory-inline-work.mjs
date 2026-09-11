import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { V86 } from '../../vendor/v86/build/libv86.mjs';
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const output = path.join(manifest.directory, 'eagl-memory-work.json');
if (fs.existsSync(output)) throw Error('Refusing to overwrite evidence');
const engines = {}, rows = [], calls = 10000, count = 32;
try {
    for (const arm of ['baseline', 'candidate']) {
        const a = manifest.arms[arm];
        if (createHash('sha256').update(fs.readFileSync(a.wasm)).digest('hex') !== a.hash) throw Error('Artifact drift');
        const em = new V86({ autostart: false, memory_size: 16 << 20, wasm_path: a.wasm, log_level: 0 });
        engines[arm] = { em };
        await new Promise(resolve => em.add_listener('emulator-loaded', resolve));
        const c = em.v86.cpu, w = c.wm.exports;
        c.reboot_internal(); c.reset_memory();
        const hp = w.get_hypercall_page_ptr() >>> 0;
        const host = new DataView(c.wasm_memory.buffer), guest = new DataView(c.mem8.buffer, c.mem8.byteOffset, c.mem8.byteLength);
        host.setUint32(hp + 8, 1, true);
        new Uint8Array(c.wasm_memory.buffer)[hp + 0x100 + 1] = 128;
        const stack = 0x10000, desc = 0x11000, src = 0x12000, dst = 0x14000;
        c.reg32[4] = stack; c.reg32[2] = 0xB077;
        for (const [off, value] of [[4, desc], [8, dst], [12, src], [16, count]]) guest.setUint32(stack + off, value, true);
        guest.setUint32(desc, 3, true); guest.setUint32(desc + 0x14, 4, true); guest.setUint32(desc + 0x18, 4, true);
        for (let i = 0; i < count * 16; i++) guest.setUint32(src + i * 4, (i * 2654435761) >>> 0, true);
        if (w.eagl_read_cursor_selftest() !== 0) throw Error('Cursor selftest');
        w.eagl_read_cursor_set_policy(1);
        const measure = () => {
            c.mem8.fill(0xA5, dst, dst + count * 64);
            const served = host.getUint32(hp + 0x2000 + 128 * 4, true);
            const fallbacks = host.getUint32(hp + 0x2400 + 128 * 4, true);
            const begin = performance.now();
            for (let i = 0; i < calls; i++) { c.reg32[0] = 1; w.instr32_EF(); }
            const ms = performance.now() - begin;
            if (c.reg32[0] !== 0 || host.getUint32(hp + 0x2000 + 128 * 4, true) - served !== calls ||
                host.getUint32(hp + 0x2400 + 128 * 4, true) !== fallbacks) throw Error('Kernel did not execute expected work');
            const actual = Buffer.from(c.mem8.subarray(dst, dst + count * 64));
            if (!actual.equals(Buffer.from(c.mem8.subarray(src, src + count * 64)))) throw Error('Output mismatch');
            return { arm, ms, calls, dwordsPerCall: count * 16, digest: createHash('sha256').update(actual).digest('hex') };
        };
        engines[arm] = { em, measure };
    }
    const warmup = [];
    for (let i = 0; i < 12; i++) warmup.push(engines[i % 2 ? 'candidate' : 'baseline'].measure());
    for (let round = 0; round < 9; round++) {
        for (const arm of ['baseline', 'candidate', 'candidate', 'baseline', 'baseline', 'baseline', 'candidate', 'candidate']) {
            rows.push({ round, ...engines[arm].measure() });
        }
    }
    const rounds = Array.from({ length: 9 }, (_, i) => {
        const r = rows.slice(i * 8, i * 8 + 8).map(r => r.ms);
        return { speedupPct: 100 * (Math.sqrt(r[0] * r[3] / (r[1] * r[2])) - 1),
            aaPct: 100 * (r[4] / r[5] - 1), ccPct: 100 * (r[6] / r[7] - 1) };
    });
    const summary = { medianSpeedupPct: rounds.map(r => r.speedupPct).sort((a, b) => a - b)[4],
        maxAbsControlPct: Math.max(...rounds.flatMap(r => [Math.abs(r.aaPct), Math.abs(r.ccPct)])),
        positiveRounds: rounds.filter(r => r.speedupPct > 0).length };
    fs.writeFileSync(output, JSON.stringify({ scope: 'Node, flat nonpaging EAGL copy kernel via real OUT handler; no FPS claim; no fault/permission coverage',
        manifest, warmup, rows, rounds, summary }, null, 2));
    console.log(JSON.stringify({ output, summary, rounds }, null, 2));
} finally { for (const e of Object.values(engines)) e.em.destroy(); }
