/**
 * WHEN is the ADPCM decoder actually hot, and by how much? Count-weighted share of the
 * guest's own decoder loop at several points along one boot with the hook DISABLED (so
 * the guest's loop is the code under measurement), plus the decode rate the census itself
 * yields (`exec * 2` samples per window — each execution of the loop head is two samples).
 *
 * It exists to settle a 37%-of-guest-instructions attribution that would not reproduce.
 * Two things had to be right before the question could even be asked:
 *   - the census must watch the decoder's page BY NAME (`pages:[…]`). v86's watch table is
 *     64 entries and there were 256 tier-2 pages, and the enumeration is HashSet order, so
 *     the default selection is an arbitrary quarter that changes per boot — which is how
 *     one session read 15% and five read 0%.
 *   - the window must be long enough. The codec is intermittent; 8 s windows read 0% four
 *     times out of five purely by missing the burst. At 30 s it resolves.
 *
 * Result on Harry Potter: CoS, decoder page armed, 5 x 30 s across one boot: four windows
 * with the loop absent (no ADPCM audio playing), one with exec = 1,258,522 per loop block
 * = 83,887 samples/s — i.e. real-time 44.1 kHz stereo, nothing pathological — for 4.7% of
 * counted retired guest instructions. Not 37%.
 *
 * Usage: CENSUS_MS=30000 bun tools/harness.ts run tools/examples/psx-adpcm-share.harness.ts
 */

import { harness } from "../harness";

const WGB = process.env.WGB ?? "g:/WGB/running/harry-potter-cos.wgb";
const CENSUS_MS = Number(process.env.CENSUS_MS ?? 8000);

const pick = (r: any, cmd: string): any => (r?.steps ?? []).filter((s: any) => s.cmd === cmd).pop()?.result;

async function workerEval(expr: string): Promise<any> {
    const p = Bun.spawn(["bun", "tools/harness.ts", "worker-eval", expr], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    try { return JSON.parse(JSON.parse(out.trim())); } catch { return null; }
}

async function disableDescriptor(): Promise<void> {
    for (let i = 0; i < 30; i++) {
        const cfg = await workerEval("JSON.stringify((()=>{const E=globalThis.EmulatorConfig;if(!E)return null;"
            + "const c=E.getInstance().hleLibs;c['psx-adpcm']={enable:false};return c;})())");
        if (cfg?.["psx-adpcm"]?.enable === false) return;
        await Bun.sleep(500);
    }
    throw new Error("could not disable the descriptor — the guest loop must be the code under measurement");
}

const isAdpcm = (m: unknown) => /^core[^+]*\+0x7a[bc]/i.test(String(m));

/** The decoder's live address, so the census can be told to watch that page BY NAME
 *  instead of hoping it lands in the arbitrary quarter of tier-2 pages that fits in
 *  v86's 64-entry watch table (see guestBlocks' selectionWarning). */
async function decoderPage(): Promise<number | null> {
    const r = await workerEval(
        "JSON.stringify((function(){var S=globalThis.System;if(!S)return null;"
        + "var p=S.getInstance().process;if(!p||!p.moduleRegistry)return null;"
        + "var mods=p.moduleRegistry.getAllModules();"
        + "for(var i=0;i<mods.length;i++){if(/^core(\\.dll)?$/i.test(mods[i].name))return mods[i].baseAddress+0x7ab80;}"
        + "return null;})())");
    return typeof r === "number" ? r : null;
}

async function census(label: string, page: number | null) {
    const gb = pick(await harness().call("guestBlocks", {
        ms: CENSUS_MS, top: 15, ...(page ? { pages: [page] } : {}),
    }).run(), "guestBlocks");
    if (!gb?.counted?.available) return { label, refused: gb?.counted?.note ?? gb?.armRefused };
    const rows = gb.counted.rows ?? [];
    const mine = rows.filter((x: any) => isAdpcm(x.module));
    const w = gb.counted.window;
    // Each execution of the loop head decodes two samples, so the census itself yields a
    // decode rate — a second, independent read on "how much audio is this really".
    const head = mine.find((x: any) => /\+0x7abd8$/i.test(String(x.module)));
    return {
        label,
        decoderPage: page ? "0x" + page.toString(16) : null,
        armedRequestedPages: w.armedRequestedPages,
        tier2Total: w.tier2Total, tier2PagesUnwatched: w.tier2PagesUnwatched,
        censusMs: w.elapsedMs, presentsDuringCensus: w.presents, watchedPages: w.watchedPages, slotOverflow: w.slotOverflow,
        adpcmSharePct: Math.round(mine.reduce((s: number, x: any) => s + x.sharePct, 0) * 10) / 10,
        adpcmRows: mine.map((x: any) => ({ module: x.module, exec: x.exec, ins: x.ins, sharePct: x.sharePct })),
        derivedSamplesPerSec: head && w.elapsedMs ? Math.round((head.exec * 2) / (w.elapsedMs / 1000)) : null,
        top3: rows.slice(0, 3).map((x: any) => ({ module: x.module, sharePct: x.sharePct })),
        sampled: gb.sampled?.available ? (gb.sampled.topEips ?? []).slice(0, 3) : { note: gb.sampled?.note },
    };
}

await harness().reload().run();
await disableDescriptor();
await harness().streamLogs(["SYSTEM"]).openWgb(WGB, { reload: false }).tickFrames(200).run();

const page = await decoderPage();
if (page === null) throw new Error("could not resolve Core.dll's base — the census would fall back to an arbitrary page subset");
console.log("decoder page: 0x" + page.toString(16));

const out: any[] = [];
out.push(await census("after 200 presents (level load / first play)", page));
await harness().tickFrames(400).run();
out.push(await census("after 600 presents", page));
await harness().tickFrames(600).run();
out.push(await census("after 1200 presents", page));
await harness().tickFrames(600).run();
out.push(await census("after 1800 presents", page));
for (let i = 0; i < 8; i++) await harness().sleep(30_000).run();
out.push(await census("after a further 240 s of play (settled)", page));

await Bun.write(process.env.OUT ?? "psx-adpcm-share.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.map(o => ({
    label: o.label, adpcmSharePct: o.adpcmSharePct, derivedSamplesPerSec: o.derivedSamplesPerSec,
    armedRequestedPages: o.armedRequestedPages, tier2PagesUnwatched: o.tier2PagesUnwatched,
    presentsDuringCensus: o.presentsDuringCensus, censusMs: o.censusMs, adpcmRows: o.adpcmRows,
    top3: o.top3, refused: o.refused,
})), null, 2));
