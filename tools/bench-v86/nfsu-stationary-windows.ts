#!/usr/bin/env bun
/** Pilot windows on an observed stationary NFSU scene; repeated windows are NOT independent boots. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { harness, closeHarnessConnection } from '../harness';
import { listSessionTabs } from '../cdp-core';

async function call(cmd: string, ...args: unknown[]): Promise<any> {
    const r = await harness().call(cmd, ...args).run();
    if (!r.ok) throw Error(`${cmd}: ${JSON.stringify(r.error)}`);
    return r.steps?.filter(s => s.cmd === cmd).at(-1)?.result;
}
const stateCode = `const s=System.getInstance();const r=s.services.render;
    const m=s.process.getCurrentMemory();const v=new DataView(m.buffer,m.byteOffset,m.byteLength);
    const p=v.getUint32(0x73619c,true);const w=globalThis.preemption.getWasmExports();
    const state={raceState:p?v.getUint32(p,true):null,moverCounter:v.getUint32(0x78eb4c,true),
    serial:r.getPresentSerial(),guestSerial:r.getGuestPresentSerial(),paused:s.isPaused,
    config:Array.from({length:32},(_,i)=>w.get_jit_config(i)),time:performance.now(),
    source:r.getLastPresenterKind(),captureArmed:!!globalThis.__jitPublicationCapture,dumpArmed:!!globalThis.__wasmDump};`;

export async function runStationaryWindows(directory: string, phase?: { target: number; timeOrigin: number; observedStart: number }) {
    if (!directory) throw Error('Usage: bun tools/bench-v86/nfsu-stationary-windows.ts <new directory>');
    if ((await listSessionTabs()).length !== 1) throw Error('Pilot requires one guest tab');
    mkdirSync(directory, { recursive: false });
    const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2));
    const protocol = { kind: phase ? 'fresh boot phase-gated stationary window' : 'stationary same-boot pilot', windows: phase ? 1 : 4, windowMs: 20000, warmupMs: phase ? 0 : 15000,
        phase: phase ?? null, phaseTolerance: 300,
        gapMs: 3000, independentBoots: 1, inference: 'descriptive only; no independent-pair confidence interval',
        requireRawCount: 'raw.length === presentSerialDelta - 1; rejects ring overflow and omitted >=2s gaps',
        reject: ['race state differs from 4', 'physics does not advance', 'source changes', 'capture active',
            'idx21 enabled', 'guest/all present serials disagree', 'config changes'],
        acceptedUpliftCriterion: 'Future independent paired A/C: lower 95% FPS-ratio bound >= 1.20; movement and another session required',
        writtenAt: new Date().toISOString() };
    save('protocol.json', protocol);
    const journal = await call('jitPublications');
    if (journal && !journal.sealed) throw Error('Active capture must finish first');
    if (journal) await call('jitPublications', 'clear');
    const fixture = await Bun.file('fixtures/nfsu-max/manifest.json').json();
    const fixtureReadback = [];
    for (const path of fixture.files) {
        const read = await call('containerRead', fixture.container, path);
        const actual = Buffer.from(read.content, 'base64');
        const expected = Buffer.from(await Bun.file(`fixtures/nfsu-max${path}`).arrayBuffer());
        fixtureReadback.push({ path, equal: actual.equals(expected),
            actual: createHash('sha256').update(actual).digest('hex'),
            expected: createHash('sha256').update(expected).digest('hex') });
    }
    save('fixture.json', fixtureReadback);
    // This pilot compares windows within one loaded game. Preserve the exact profile-index
    // difference for later between-boot validation; settings and saves must still match.
    if (!fixtureReadback.filter(r => !r.path.endsWith('/Profiles.usr')).every(r => r.equal)) {
        throw Error('Settings or save differ from nfsu-max');
    }
    save('profile-index-limitation.json', { changed: fixtureReadback.filter(r => !r.equal),
        note: 'Any changed Profiles.usr bytes remain unexplained; this run cannot certify full fixture identity across boots.' });
    const screenshot = async (label: string) => {
        const shot = await call('shot');
        if (!shot.base64) throw Error('Missing screenshot');
        writeFileSync(join(directory, label + '.png'), Buffer.from(shot.base64, 'base64'));
    };
    await screenshot('before');
    if (phase) {
        const deadline = Date.now() + 90000;
        for (;;) {
            const state = await call('evalWorker', stateCode + `return {...state,timeOrigin:performance.timeOrigin};`);
            if (state.timeOrigin !== phase.timeOrigin || state.raceState !== 4) throw Error('Phase gate lost worker/race identity');
            if (state.moverCounter >= phase.target) break;
            if (Date.now() > deadline) throw Error('Phase gate timeout');
            await call('sleep', 100);
        }
    } else await call('sleep', protocol.warmupMs);
    const rows = [];
    for (let i = 0; i < protocol.windows; i++) {
        const before = await call('evalWorker', stateCode + `r.resetFlipCadence();return state;`);
        if (phase && (before.moverCounter < phase.target || before.moverCounter > phase.target + protocol.phaseTolerance)) {
            save('missed-phase', before); throw Error('Missed phase gate');
        }
        if (before.raceState !== 4 || before.paused || before.config[21] !== 0 || before.captureArmed || before.dumpArmed) {
            save(`${i}-before-invalid.json`, before); throw Error('Window preflight failed');
        }
        await call('sleep', protocol.windowMs);
        const after = await call('evalWorker', stateCode + `return {...state,raw:Array.from(r.flipIntervals)};`);
        const { raw, ...endState } = after;
        const delta = after.serial - before.serial;
        const valid = after.raceState === 4 && after.moverCounter > before.moverCounter &&
            !after.paused && !after.captureArmed && !after.dumpArmed && after.source === before.source &&
            JSON.stringify(after.config) === JSON.stringify(before.config) &&
            raw.length === delta - 1 && raw.length > 100 && after.guestSerial - before.guestSerial === delta;
        const sorted = [...raw].sort((a: number, b: number) => a - b);
        const sum = raw.reduce((a: number, b: number) => a + b, 0);
        const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1];
        const row = { i, valid, before, after: endState, raw, count: raw.length, sumMs: sum,
            fps: raw.length * 1000 / sum, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) };
        rows.push(row); save(`${i}.json`, row);
        console.log(JSON.stringify({ i, valid, frames: row.count, fps: row.fps, p95: row.p95 }));
        if (!valid) throw Error('Window integrity check failed');
        if (i + 1 < protocol.windows) await call('sleep', protocol.gapMs);
    }
    await screenshot('after');
    save('summary.json', { ...protocol, fps: rows.map(r => r.fps),
        p50: rows.map(r => r.p50), p95: rows.map(r => r.p95), p99: rows.map(r => r.p99) });
}

if (import.meta.main) {
    try { await runStationaryWindows(process.argv[2]); } finally { closeHarnessConnection(); }
    process.exit(process.exitCode ?? 0);
}
