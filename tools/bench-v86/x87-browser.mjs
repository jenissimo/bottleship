import { V86 } from '../../vendor/v86/build/libv86.mjs';
import { SHIPPING_JIT } from '../jit-config/shipping.mjs';
import { createX87Workload } from './x87-workload.mjs';
const sha = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2,'0')).join('');
const median = xs => [...xs].sort((a,b)=>a-b)[xs.length >> 1];
try {
    const config = await (await fetch('/_x87/config')).json();
    const modules = {};
    for (const arm of ['baseline','candidate']) {
        const bytes = await (await fetch(`/_x87/${arm}.wasm`)).arrayBuffer();
        if (await sha(bytes) !== config.arms[arm].hash) throw Error('engine hash mismatch');
        modules[arm] = await WebAssembly.compile(bytes);
    }
    const result = { status: 'ok', userAgent: navigator.userAgent, config, rows: [] };
    for (const kind of ['pair', 'spread', 'memory']) {
      for (const [i, arm] of config.order.entries()) {
        const wasm = `/_x87/${arm}.wasm`;
        const { image, boot, state, checkResult, measure } = createX87Workload(V86, { wasm, shipping: SHIPPING_JIT, engineModule: modules[arm] });
        const row = result.rows[i] ||= { i, arm, kernels: [], medians: {} };
            const im = image(kind);
            const live = await boot(im, { stats: true });
            const liveness = state(live.c, live.w, kind); checkResult(liveness, 120000, kind);
            if (liveness.hits === 0 || liveness.fallbacks !== 0) throw Error('inline path not live');
            live.em.destroy();
            const b = await boot(im);
            for (let j=0;j<3;j++) measure(b, im, 2000000);
            const samples=[];
            for (let j=0;j<7;j++) samples.push(measure(b, im, 5000000));
            const generatedModules = await Promise.all(globalThis.__wasmDump.out.map(r => sha(r.bytes)));
            row.kernels.push({ kind, image: await sha(im.bytes), liveness, samples, modules: generatedModules });
            row.medians[kind] = median(samples.map(s=>s.ms));
            b.em.destroy();
        await fetch('/_x87/progress', {method:'POST',body:JSON.stringify({kind,i,arm,ms:row.medians[kind]})});
      }
    }
    await fetch('/_x87/finish', {method:'POST',body:JSON.stringify(result)});
} catch(e) {
    await fetch('/_x87/finish', {method:'POST',body:JSON.stringify({status:'error',error:String(e?.stack||e)})});
}
