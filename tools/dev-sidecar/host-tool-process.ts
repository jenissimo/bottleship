/** Owns the native process until exit, including HTTP cancellation and timeout. */
export async function runHostToolProcess(exe: string, args: string[], cwd: string,
    signal: AbortSignal, timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    signal.throwIfAborted();
    const proc = Bun.spawn([exe, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    const stop = () => { if (proc.exitCode === null) proc.kill(); };
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
        ]);
        signal.throwIfAborted();
        return { stdout, stderr, exitCode };
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        stop();
        await proc.exited;
    }
}
