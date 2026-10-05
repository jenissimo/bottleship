#!/usr/bin/env bun
/** Reusable diagnostic capture: bun tools/jit-corpus.ts <directory> [seconds] [--content-only]. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, release } from 'node:os';
import { CdpSession, findTab, listTargets, pageEval, DEFAULT_CDP_PORT } from './cdp-core';
import { harness, closeHarnessConnection } from './harness';
import { joinJitProfile, sha256 } from './bench-v86/join-jit-profile.mjs';
import { analyze } from './bench-v86/analyze-jit-wasm.mjs';

async function deadline<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`CDP timeout: ${label}`)), 15000);
        })]);
    } finally { clearTimeout(timer); }
}

class WorkerChannel {
    private constructor(private parent: CdpSession, private sessionId: string) {}
    static async attach(page: { webSocketDebuggerUrl: string }, workerId: string) {
        const parent = await CdpSession.connect(page.webSocketDebuggerUrl);
        try {
            let sessionId: string | undefined;
            parent.on('Target.attachedToTarget', p => {
                if (p.targetInfo?.targetId === workerId) sessionId = p.sessionId;
            });
            await deadline(parent.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }), 'auto-attach worker');
            if (!sessionId) {
                const attached = await deadline(parent.send('Target.attachToTarget', { targetId: workerId, flatten: true }), 'attach worker');
                sessionId = attached.result?.sessionId;
            }
            if (!sessionId) throw new Error('Missing attached worker sessionId');
            const channel = new WorkerChannel(parent, sessionId);
            await channel.send('Runtime.enable');
            return channel;
        } catch (error) { parent.close(); throw error; }
    }
    send(method: string, params: any = {}) {
        return deadline(this.parent.send(method, params, this.sessionId), method);
    }
    on(method: string, cb: (p: any) => void) {
        this.parent.on(method, (p, sid) => { if (sid === this.sessionId) cb(p); });
    }
    close() { this.parent.close(); }
}

async function call(cmd: string, ...args: unknown[]): Promise<any> {
    const result = await harness().call(cmd, ...args).run();
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.steps?.filter(s => s.cmd === cmd).at(-1)?.result;
}

/** Read-only identity capability check on a paused guest; it does not collect timings. */
export async function inspectJitIdentity(directory: string) {
    mkdirSync(directory, { recursive: false });
    const page = await findTab();
    const targets = await listTargets();
    const sessions: WorkerChannel[] = [];
    let active: WorkerChannel | undefined;
    let resume = false, scratch = false, debugging = false;
    const result: any = { page, timingsCollected: false, inspectedAt: new Date().toISOString(), functions: [] };
    try {
        const ping = await call('ping');
        if (typeof ping?.paused !== 'boolean') throw new Error('Unknown initial pause state');
        if (!ping.paused) { await call('pause'); resume = true; }
        for (const target of targets.filter(t => t.type === 'worker' && (t as any).parentId === page.id)) {
            const session = await WorkerChannel.attach(page, target.id);
            sessions.push(session);
            const probe = await session.send('Runtime.evaluate', { expression: '!!globalThis.preemption', returnByValue: true });
            if (probe.result?.result?.value) {
                if (active) throw new Error('Multiple emulator workers');
                active = session;
                result.worker = target;
            }
        }
        if (!active) throw new Error('No emulator worker');
        const entries = await call('evalWorker', `
            if (globalThis.__jitIdentitySnapshot) throw Error('Identity inspection already active');
            const p=System.getInstance().process; const c=p?.v86?.cpu??p?.v86?.v86?.cpu;
            const table=c?.wm?.wasm_table; if(!table) throw Error('No Wasm table');
            const entries=[];
            for(let slot=1024; slot<table.length && entries.length<8; slot++) {
                const f=table.get(slot); if(f) entries.push({slot,f});
            }
            entries.push({slot:null,f:globalThis.preemption.getWasmExports().get_jit_config,kind:'runtime'});
            const bytes=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,5,1,1,102,0,0,10,6,1,4,0,65,1,11]);
            for(let i=0;i<3;i++) {
                if(i===2) bytes[bytes.length-2]=2;
                const instance=new WebAssembly.Instance(new WebAssembly.Module(bytes));
                entries.push({slot:null,f:instance.exports.f,synthetic:i,expectedBytes:Array.from(bytes)});
            }
            globalThis.__jitIdentitySnapshot=entries;
            return entries.map(({slot,f,synthetic,expectedBytes,kind})=>({slot,name:f.name,synthetic,expectedBytes,kind}));`);
        scratch = true;
        await active.send('Debugger.enable');
        debugging = true;
        for (let i = 0; i < entries.length; i++) {
            const remote = await active.send('Runtime.evaluate', {
                expression: `globalThis.__jitIdentitySnapshot[${i}].f`, objectGroup: 'jit-identity-inspect',
            });
            const objectId = remote.result?.result?.objectId;
            if (!objectId) throw new Error('Missing function objectId');
            const properties = await active.send('Runtime.getProperties', { objectId, ownProperties: true });
            const internal = properties.result?.internalProperties ?? [];
            const location = internal.find((p: any) => p.name === '[[FunctionLocation]]');
            const scriptId = location?.value?.value?.scriptId;
            let bytecode: any = null;
            if (scriptId) {
                const source = await active.send('Debugger.getScriptSource', { scriptId });
                if (source.result?.bytecode) {
                    const bytes = Buffer.from(source.result.bytecode, 'base64');
                    bytecode = { sha256: sha256(bytes), byteLength: bytes.length };
                    if (entries[i].kind === 'runtime') bytecode.matchesPinnedBaseline =
                        bytecode.sha256 === '3a50af7f4ade1197eb39f3bdff9764fb039a884989b2b5c7acf059977a03cb3a';
                    if (entries[i].expectedBytes) bytecode.matchesExpected =
                        Buffer.from(entries[i].expectedBytes).equals(bytes);
                }
            }
            result.functions.push({ ...entries[i], remote: remote.result, properties: properties.result,
                functionLocation: location ?? null, bytecode });
        }
        const synthetic = result.functions.filter((f: any) => f.synthetic !== undefined);
        result.capabilities = {
            exactBytecodeRoundTrip: synthetic.length === 3 && synthetic.every((f: any) => f.bytecode?.matchesExpected === true),
            identicalBytesShareScriptId: synthetic.length === 3 &&
                synthetic[0].functionLocation?.value?.value?.scriptId === synthetic[1].functionLocation?.value?.value?.scriptId,
            changedBytesChangeScriptId: synthetic.length === 3 &&
                synthetic[0].functionLocation?.value?.value?.scriptId !== synthetic[2].functionLocation?.value?.value?.scriptId,
            loadedRuntime: result.functions.find((f: any) => f.kind === 'runtime')?.bytecode ?? null,
        };
        return { functions: result.functions.length,
            withLocation: result.functions.filter((f: any) => f.functionLocation).length };
    } catch (error) {
        result.error = String(error);
        throw error;
    } finally {
        if (scratch) await call('evalWorker', 'delete globalThis.__jitIdentitySnapshot; return true;')
            .catch(e => { result.cleanupError = String(e); });
        if (debugging) await active?.send('Debugger.disable').catch(() => {});
        await active?.send('Runtime.releaseObjectGroup', { objectGroup: 'jit-identity-inspect' }).catch(() => {});
        for (const session of sessions) session.close();
        if (resume) await call('resume').catch(e => { result.resumeError = String(e); });
        writeFileSync(join(directory, 'identity.json'), JSON.stringify(result, null, 2));
        if (result.resumeError || result.cleanupError) throw new Error(`Identity inspection cleanup failed: ${result.resumeError ?? result.cleanupError}`);
    }
}

export async function captureJitCorpus(directory: string, seconds = 10, contentOnly = false, useArmed = false) {
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) throw new Error('Duration must be 1–60 seconds');
    mkdirSync(directory, { recursive: false });
    const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2));
    const page = await findTab();
    const targets = await listTargets();
    // parentId is supplied by /json/list on this Chrome. Never fall back to another page's worker.
    const workers = targets.filter(t => t.type === 'worker' && (t as any).parentId === page.id);
    const candidates: Array<{ session: WorkerChannel; target: typeof page }> = [];
    let active: WorkerChannel | undefined;
    let armed = false, profiling = false, debugging = false, profilerEnabled = false;
    const scripts = new Map<string, any>();
    let scriptDrops = 0;
    const manifest: any = { captureId: crypto.randomUUID(), startedAt: new Date().toISOString(), seconds,
        diagnosticOnly: true, contentOnly, page, targets, host: hostname(), os: release(),
        baselineDiskSha256: sha256(await Bun.file('public/v86.wasm').bytes()),
        loadedRuntimeIdentity: 'unknown', graphicsSettings: 'unknown', scenario: 'current scene; not certified',
        completeFromWorkerStart: false, cdpPort: DEFAULT_CDP_PORT };
    save('manifest.json', manifest);
    try {
        manifest.otherGuests = [];
        for (const other of targets.filter(t => t.type === 'page' && t.id !== page.id && t.url.includes('game='))) {
            const session = await CdpSession.connect(other.webSocketDebuggerUrl);
            try {
                const result = await pageEval(session, 'window.__BS__.harness.__runSteps([{cmd:"ping",args:[]}])');
                const ping = result?.steps?.[0]?.result;
                manifest.otherGuests.push({ targetId: other.id, ping });
                if (!result?.ok || !ping || (ping.hasProcess && ping.paused !== true)) {
                    throw new Error(`Other guest is active or pause state is unknown: ${other.url}`);
                }
            } finally { session.close(); }
        }
        for (const target of workers) {
            const session = await WorkerChannel.attach(page, target.id);
            candidates.push({ session, target });
            const r = await session.send('Runtime.evaluate', {
                expression: '!!globalThis.preemption', returnByValue: true,
            });
            if (r.result?.result?.value) {
                if (active) throw new Error('Multiple emulator workers for selected page');
                active = session;
                manifest.worker = target;
            }
        }
        if (!active) throw new Error('No uniquely identified emulator worker belonging to selected page');
        manifest.before = await call('evalWorker', `const w=globalThis.preemption.getWasmExports();
            return {config:Array.from({length:32},(_,i)=>w.get_jit_config(i)),timeOrigin:performance.timeOrigin};`);
        if (!contentOnly) {
            if (useArmed) {
                const status = await call('jitPublications');
                if (!status || status.sealed) throw new Error('No active pre-armed publication capture');
                manifest.preArmed = status;
            } else await call('jitPublications', 'arm');
            armed = true;
        }
        active.on('Debugger.scriptParsed', p => {
            if (p.scriptLanguage !== 'WebAssembly' && !p.url?.startsWith('wasm://')) return;
            if (scripts.size >= 30000) { scriptDrops++; return; }
            scripts.set(String(p.scriptId), { ...p });
        });
        await active.send('Debugger.enable', { maxScriptsCacheSize: 64 * 1024 * 1024 });
        debugging = true;
        await active.send('Profiler.enable');
        profilerEnabled = true;
        await active.send('Profiler.setSamplingInterval', { interval: 1000 });
        await active.send('Profiler.start');
        profiling = true;
        await Bun.sleep(seconds * 1000);
        const stopped = await active.send('Profiler.stop');
        profiling = false;
        const profile = stopped.result.profile;
        save('profile.json', profile);
        let journal: any = { events: [], dropped: 0, completeFromWorkerStart: false, unavailable: true };
        if (armed) {
            await call('jitPublications', 'seal');
            journal = await call('jitPublications', 'export');
        }
        mkdirSync(join(directory, 'modules'));
        for (const module of journal.modules ?? []) {
            const bytes = Buffer.from(module.base64, 'base64');
            if (sha256(bytes) !== module.sha256) throw new Error('Journal export hash mismatch');
            writeFileSync(join(directory, 'modules', `${module.sha256}.wasm`), bytes);
        }
        save('publications.json', { ...journal, modules: undefined, completeFromWorkerStart: false });
        const counts = new Map<number, number>();
        for (const id of profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
        const sampled = profile.nodes.filter((n: any) => counts.has(n.id))
            .sort((a: any, b: any) => counts.get(b.id)! - counts.get(a.id)!);
        let retrievedBytes = 0;
        const fetched = new Set<string>();
        const staticReports = new Map<string, any>();
        for (const node of sampled) {
            const id = String(node.callFrame.scriptId);
            if (fetched.has(id)) continue;
            fetched.add(id);
            const script = scripts.get(id);
            if (!script) continue;
            try {
                if (retrievedBytes >= 64 * 1024 * 1024) throw new Error('CDP byte retrieval limit');
                const result = await active.send('Debugger.getScriptSource', { scriptId: id });
                if (!result.result?.bytecode) throw new Error('CDP did not return Wasm bytecode');
                const bytes = Buffer.from(result.result.bytecode, 'base64');
                if (retrievedBytes + bytes.length > 64 * 1024 * 1024) throw new Error('CDP byte retrieval limit');
                retrievedBytes += bytes.length;
                script.sha256 = sha256(bytes);
                script.byteLength = bytes.length;
                if (script.sha256 === manifest.baselineDiskSha256) {
                    manifest.loadedRuntimeIdentity = { status: 'sampled-cdp-bytecode-matches-baseline', sha256: script.sha256, scriptId: id };
                }
                writeFileSync(join(directory, 'modules', `${script.sha256}.wasm`), bytes);
                if (!staticReports.has(script.sha256)) {
                    try { staticReports.set(script.sha256, analyze(bytes, script.sha256)); }
                    catch (error) { staticReports.set(script.sha256, { unsupported: String(error) }); }
                }
            } catch (error) { script.unresolved = String(error); }
        }
        save('scripts.json', { scriptDrops, retrievedBytes, scripts: [...scripts.values()] });
        save('static.json', [...staticReports].map(([sha256, report]) => ({ sha256, report })));
        const report = joinJitProfile(profile, [...scripts.values()], journal);
        save('hotness.json', report);
        manifest.completedAt = new Date().toISOString();
        manifest.coverage = { totalSamples: report.totalSamples, wasmSamples: report.wasmSamples,
            byteResolvedSamples: report.byteResolvedSamples, publicationResolvedSamples: report.publicationResolvedSamples };
        return manifest.coverage;
    } catch (error) {
        manifest.error = String(error);
        throw error;
    } finally {
        if (profiling) await active?.send('Profiler.stop').catch(() => {});
        if (profilerEnabled) await active?.send('Profiler.disable').catch(() => {});
        if (armed) await call('jitPublications', 'seal').catch(e => { manifest.cleanupError = String(e); });
        if (debugging) await active?.send('Debugger.disable').catch(() => {});
        for (const { session } of candidates) session.close();
        save('manifest.json', manifest);
    }
}

if (import.meta.main) {
    const directory = process.argv[2];
    if (!directory) throw new Error('Usage: bun tools/jit-corpus.ts <new directory> [seconds] [--content-only]');
    try {
        console.log(process.argv.includes('--inspect-identity') ? await inspectJitIdentity(directory) :
            await captureJitCorpus(directory, Number(process.argv[3] ?? 10), process.argv.includes('--content-only'), process.argv.includes('--use-armed')));
    } finally { closeHarnessConnection(); }
    process.exit(process.exitCode ?? 0);
}
