/** Build tools/tests/fixtures/live-child.c with tools/build-live-child-probe.ps1 first.
 * WGB selects waiting.wgb, exiting.wgb or chain.wgb under logs/child-promotion/. */
import { harness } from '../../harness';
if (!process.env.WGB) throw new Error('Set WGB to a live-child probe bundle');
const loaded = await harness().openWgb(process.env.WGB).run();
if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
let attached = false;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
    const state = await harness().state(['modules', 'windows']).run();
    const current = state.named.state as any;
    if (state.ok && current.modules?.[0]?.name === 'child.exe' && current.windows?.some((w: any) => w.title === 'Live child: press Space')) {
        attached = true; break;
    }
    await Bun.sleep(200);
}
if (!attached) throw new Error('The live child did not become the foreground session');
const before = await harness().fsRead('C:\\once.dat').run();
if (!before.ok || (before.named.fsRead as any).content !== 'QQ==') throw new Error(`Pre-window effect was replayed: ${JSON.stringify(before.named)}`);
const input = await harness().key('Space').run();
if (!input.ok) throw new Error(JSON.stringify(input.error));
let after: any;
for (let i = 0; i < 100; i++) {
    const result = await harness().fsRead('C:\\once.dat').run();
    after = result.named.fsRead;
    if (after?.content === 'QUI=') break;
    await Bun.sleep(50);
}
if (after?.content !== 'QUI=') throw new Error(`Expected AB from the original running child: ${JSON.stringify(after)}`);
console.log(JSON.stringify({ ok: true, before: 'A', after: 'AB', image: 'child.exe', replayed: false }));
