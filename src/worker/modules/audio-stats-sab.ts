/**
 * Worker-side singleton for the AudioWorklet signal-stats SABs.
 *
 * Any audio-producing module (dsound, winmm waveOut, mss32, openal) calls
 * ensureAudioStatsSab() once; the first call allocates BOTH stats SABs and posts
 * them to the main thread (App.tsx → AudioEngine → worklet "register_stats" /
 * "register_master_stats"), parking references on globalThis.__audioStatsSab
 * (ring stage, pre-mix) and globalThis.__audioMasterStatsSab (master stage,
 * post-mix — what the user actually hears) so dbg.audio() / harness audioSignal
 * can read the counters without an import cycle. One call provisions both: a
 * caller that only cares about the ring never has to remember the master SAB
 * exists, so the two counter sets can't silently drift out of being registered
 * together.
 */

import { createStatsSab, createMasterStatsSab } from "../../audio/audio-ring-buffer";

let statsSab: SharedArrayBuffer | null = null;
let masterStatsSab: SharedArrayBuffer | null = null;

export function ensureAudioStatsSab(): SharedArrayBuffer {
    if (!statsSab) {
        statsSab = createStatsSab();
        (globalThis as any).__audioStatsSab = statsSab;
        self.postMessage({ type: "audio_stats_sab", payload: { sab: statsSab } });
    }
    if (!masterStatsSab) {
        masterStatsSab = createMasterStatsSab();
        (globalThis as any).__audioMasterStatsSab = masterStatsSab;
        self.postMessage({ type: "audio_master_stats_sab", payload: { sab: masterStatsSab } });
    }
    return statsSab;
}
