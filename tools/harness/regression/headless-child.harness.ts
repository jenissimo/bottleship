/** WGB, CHILD_IMAGE, CHILD_ARGS and CHILD_OUTPUT select a deterministic file-producing helper. */
import { harness } from '../../harness';

const { WGB, CHILD_IMAGE, CHILD_ARGS, CHILD_OUTPUT } = process.env;
if (!WGB || !CHILD_IMAGE || !CHILD_OUTPUT) throw new Error('Set WGB, CHILD_IMAGE, CHILD_ARGS and CHILD_OUTPUT');
const loaded = await harness().openWgb(WGB).run();
if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
let first: { size: number; crc32: string } | undefined;
for (let i = 0; i < 2; i++) {
    const run = await harness().runChildProcess(CHILD_IMAGE, CHILD_ARGS ?? '').fsHash(CHILD_OUTPUT)
        .childProcesses().run();
    if (!run.ok) throw new Error(JSON.stringify(run.error));
    const exit = run.named.runChildProcess as { exitCode: number };
    const hash = run.named.fsHash as { size: number; crc32: string; complete: boolean };
    if (exit.exitCode !== 0 || !hash.complete || !hash.size) throw new Error(JSON.stringify({ exit, hash }));
    if (first && (first.size !== hash.size || first.crc32 !== hash.crc32)) {
        throw new Error(`Repeated helper output differs: ${JSON.stringify({ first, hash })}`);
    }
    first = hash;
    console.log(JSON.stringify({ run: i + 1, exit, hash }));
}
console.log('OK — repeated headless child execution produced identical, fully readable output');
