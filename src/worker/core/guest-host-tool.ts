import { startChildExecution, type ChildProcessRequest, type ChildProcessTask } from './child-process';
import { runHostTool, type HostToolFile } from './host-tool-bridge';
import { VirtualFileSystem } from '../runtime/filesystem/vfs';

function splitCommandLine(commandLine: string): string[] {
    const out: string[] = [];
    let cur = '', inQuote = false;
    for (const ch of commandLine) {
        if (ch === '"') { inQuote = !inQuote; continue; }
        if (!inQuote && /\s/.test(ch)) {
            if (cur) { out.push(cur); cur = ''; }
        } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}

/** Shares the child lifetime and durability contract with the in-guest backend. */
export function startGuestHostTool(vfs: VirtualFileSystem, request: ChildProcessRequest,
    run: typeof runHostTool = runHostTool,
): ChildProcessTask {
    return startChildExecution(vfs, request, async context => {
        const argv = splitCommandLine(request.rawCommandLine ?? `"${request.imagePath}" ${request.commandLine}`);
        const tool = (request.imagePath.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').toLowerCase();
        if (!tool) throw new Error('No host tool image');
        const paths = new VirtualFileSystem();
        paths.currentDir = request.currentDirectory.endsWith('\\') ? request.currentDirectory : `${request.currentDirectory}\\`;
        const inputs: HostToolFile[] = [];
        for (const arg of argv.slice(1)) {
            if (arg.startsWith('/') || arg.startsWith('-')) continue;
            const path = paths.resolvePath(arg);
            const size = vfs.getFileSize(path);
            if (size <= 0) continue;
            const handle = await vfs.open(path, 0x80000000, 3);
            context.checkActive();
            if (!handle) continue;
            const bytes = new Uint8Array(size);
            let offset = 0;
            while (offset < size) {
                const chunk = await vfs.read(handle, size - offset);
                context.checkActive();
                if (!chunk.length) throw new Error(`Short read of host tool input: ${path}`);
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
            inputs.push({ name: arg.split(/[\\/]/).pop() ?? arg, bytes });
        }
        context.checkActive();
        const result = await run(tool, argv.slice(1), inputs, context.signal);
        context.checkActive();
        if (!result) throw new Error(`Host tool "${tool}" refused or unavailable`);
        for (const out of result.outputs) {
            const path = paths.resolvePath(out.name);
            context.record.fileMutations = (context.record.fileMutations ?? 0) + 1;
            const changed = context.record.mutationPaths ??= [];
            if (changed.length < 16 && !changed.includes(path)) changed.push(path);
            const handle = await vfs.open(path, 0x40000000, 2);
            context.checkActive();
            if (!handle) throw new Error(`Cannot write host tool output: ${path}`);
            const written = await vfs.write(handle, out.bytes);
            context.checkActive();
            if (written !== out.bytes.length) throw new Error(`Short write of host tool output: ${path}`);
        }
        return result.exitCode;
    }, 'host');
}
