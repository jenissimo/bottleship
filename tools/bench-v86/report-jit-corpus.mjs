import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function rankCorpus(hotness, statics) {
    const classify = r => /^g[0-9a-f]+@t\d+$/i.test(r.functionName) ? 'generated JIT' :
        !r.isWasm ? (r.functionName.startsWith('(') ? 'V8 idle / program / other' : 'JavaScript') :
        /hypercall_eagl/.test(r.functionName) ? 'Wasm EAGL HLE' :
        /cycle_internal|^main_loop$|^jit_tier2_drain_pending$/.test(r.functionName) ? 'CPU dispatch / loop / tier drain' :
        /safe_(read|write)|^read\d|^write\d|memory\d+(read|write)|translate_address/.test(r.functionName) ? 'Wasm guest memory helpers' :
        /fpu|^instr_/.test(r.functionName) ? 'Wasm x87 / instruction fallback' : 'other Wasm runtime';
    const families = new Map(), functions = new Map(), modules = new Map();
    for (const r of hotness.rows) {
        const family = classify(r);
        families.set(family, (families.get(family) ?? 0) + r.samples);
        const key = `${r.isWasm ? 'wasm' : 'js'}:${r.functionName}`;
        const f = functions.get(key) ?? { name: r.functionName, family, samples: 0 };
        f.samples += r.samples; functions.set(key, f);
        if (family === 'generated JIT') {
            const m = modules.get(r.sha256) ?? { sha256: r.sha256, names: new Set(), samples: 0, publications: new Set() };
            m.samples += r.samples; m.names.add(r.functionName);
            for (const p of r.matchingPublications) m.publications.add(p);
            modules.set(r.sha256, m);
        }
    }
    const share = samples => 100 * samples / hotness.totalSamples;
    const bySamples = (a, b) => b.samples - a.samples;
    const staticMap = new Map(statics.map(s => [s.sha256, s.report]));
    return {
        denominator: hotness.totalSamples,
        coverage: { wasmSamples: hotness.wasmSamples, exactByteSamples: hotness.byteResolvedSamples,
            jitSamples: [...modules.values()].reduce((n, m) => n + m.samples, 0),
            jitSamplesWithPublicationBytes: hotness.rows.filter(r => classify(r) === 'generated JIT' && r.matchingPublications.length)
                .reduce((n, r) => n + r.samples, 0) },
        families: [...families].map(([family, samples]) => ({ family, samples, sampleSharePct: share(samples) })).sort(bySamples),
        functions: [...functions.values()].sort(bySamples).slice(0, 40).map(f => ({ ...f, sampleSharePct: share(f.samples) })),
        modules: [...modules.values()].sort(bySamples).map(m => {
            const s = staticMap.get(m.sha256);
            return { ...m, names: [...m.names], publications: [...m.publications], sampleSharePct: share(m.samples),
                staticShapes: s ? { unsupported: s.unsupported ?? s.error ?? null,
                    cr0Guards: s.cr0?.recognized, readTranslations: s.memory?.recognizedReadTranslations,
                    memoryFallbackSites: s.memory?.slowFallbackSites, directReadPairs: s.memory?.directReadPairs?.length } : null };
        }),
        limitations: ['Family labels are name-based classifications for manual review.',
            'A module sample share is not a cost estimate for its static instruction patterns.',
            'Profiler self samples do not prove critical-path time or achievable FPS uplift.',
            'Identical module bytes may correspond to several publication generations.'],
    };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const directory = process.argv[2];
    if (!directory) throw Error('Usage: node report-jit-corpus.mjs <corpus directory>');
    const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    const result = rankCorpus(read('hotness.json'), read('static.json'));
    fs.writeFileSync(path.join(directory, 'ranking.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ coverage: result.coverage, families: result.families, functions: result.functions.slice(0, 12), modules: result.modules.slice(0, 5) }, null, 2));
}
