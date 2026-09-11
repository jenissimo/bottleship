import { expect, test } from 'bun:test';
import { runHostToolProcess } from '../dev-sidecar/host-tool-process';

test('native tool preserves streams and the real exit code', async () => {
    const result = await runHostToolProcess(process.execPath,
        ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode=7'],
        process.cwd(), new AbortController().signal, 3000);
    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 7 });
});

test('cancelling a running native tool reaps it instead of waiting for its timeout', async () => {
    const controller = new AbortController();
    const result = runHostToolProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
        process.cwd(), controller.signal, 60_000).catch(e => e);
    controller.abort(new Error('guest terminated'));
    expect(String(await result)).toContain('guest terminated');
}, 3000);

test('an already cancelled launch cannot create a native process', async () => {
    const controller = new AbortController();
    controller.abort(new Error('session gone'));
    expect(String(await runHostToolProcess('missing-executable', [], process.cwd(), controller.signal, 3000)
        .catch(e => e))).toContain('session gone');
});

test('HTTP disconnect propagates cancellation to the native tool', async () => {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let finished!: (error: unknown) => void;
    const stopped = new Promise<unknown>(resolve => { finished = resolve; });
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
        const child = runHostToolProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
            process.cwd(), req.signal, 60_000);
        ready();
        try { await child; finished('unexpected exit'); }
        catch (error) { finished(error); }
        return new Response('done');
    } });
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${server.port}/`, { signal: controller.signal }).catch(e => e);
    try {
        await started;
        controller.abort();
        await request;
        expect(String(await stopped)).toMatch(/abort/i);
    } finally { await server.stop(true); }
}, 3000);
