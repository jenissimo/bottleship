import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Only script IDs from the same worker/CDP capture may be passed here. */
export function joinJitProfile(profile, scripts, journal) {
    if (!Array.isArray(profile.samples) || !Array.isArray(profile.timeDeltas) ||
        profile.samples.length !== profile.timeDeltas.length) throw new Error('Incomplete profile samples/timeDeltas');
    const nodeIds = new Set((profile.nodes ?? []).map(n => n.id));
    if (profile.samples.some(id => !nodeIds.has(id))) throw new Error('Profile contains unknown sample node');
    if (new Set(scripts.map(s => String(s.scriptId))).size !== scripts.length) throw new Error('Duplicate script ID');
    const byId = new Map(scripts.map(s => [String(s.scriptId), s]));
    const publications = new Map();
    for (const event of journal.events ?? []) {
        if (event.status !== 'published') continue;
        const list = publications.get(event.sha256) ?? [];
        list.push(event);
        publications.set(event.sha256, list);
    }
    const counts = new Map();
    const durations = new Map();
    for (let i = 0; i < (profile.samples ?? []).length; i++) {
        const id = profile.samples[i];
        counts.set(id, (counts.get(id) ?? 0) + 1);
        durations.set(id, (durations.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0));
    }
    let wasmSamples = 0, byteResolvedSamples = 0, publicationResolvedSamples = 0;
    const rows = (profile.nodes ?? []).map(node => {
        const samples = counts.get(node.id) ?? 0;
        const frame = node.callFrame;
        const script = byId.get(String(frame.scriptId));
        const isWasm = script?.scriptLanguage === 'WebAssembly' || frame.url?.startsWith('wasm://');
        const events = script?.sha256 ? publications.get(script.sha256) ?? [] : [];
        // Missing publications can be another instance of identical bytes. Loss invalidates
        // generation uniqueness even when exactly one retained publication matches.
        const unique = events.length === 1 && journal.dropped === 0 && journal.completeFromWorkerStart === true;
        if (isWasm) {
            wasmSamples += samples;
            if (script?.sha256) byteResolvedSamples += samples;
            if (unique) publicationResolvedSamples += samples;
        }
        return { nodeId: node.id, ...frame, samples, sampledTimeUs: durations.get(node.id) ?? 0,
            isWasm, sha256: script?.sha256 ?? null,
            byteIdentity: script?.sha256 ? 'exact-cdp-bytecode' : 'unresolved',
            generation: unique ? events[0].generation : null,
            publicationIdentity: unique ? 'resolved' : 'unresolved',
            matchingPublications: events.map(e => e.generation),
            reason: unique ? null : !events.length ? 'no-publication' : 'incomplete-or-ambiguous-publication-history' };
    }).filter(r => r.samples).sort((a, b) => b.sampledTimeUs - a.sampledTimeUs);
    return { totalSamples: (profile.samples ?? []).length, wasmSamples, byteResolvedSamples,
        publicationResolvedSamples, rows,
        limitations: ['Self samples identify module execution, not the cost of an instruction pattern.',
            'CDP offsets are Wasm locations; no exact guest instruction map is available.',
            'Capturing after worker startup cannot prove publication-generation uniqueness.'] };
}
