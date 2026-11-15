import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** Run the real CLI after a synthetic streaming decoder writes real files. A child-local
 * fs guard refuses to reload any extracted payload, without allocating a multi-GB fixture.
 * Parsing/decoding is mocked here; their actual formats are covered by installer-streaming. */
function extractOnly(extra: string[] = []) {
    const work = mkdtempSync(join(tmpdir(), 'gog-extract-only-'));
    try {
        const installer = join(work, 'setup.exe');
        writeFileSync(installer, 'fixture');
        const cli = resolve('tools/gog-to-wgb.ts');
        const extractDir = join(work, 'out');
        const runner = `
            import { mock } from 'bun:test';
            import * as fs from 'node:fs';
            import * as inno from '@bottleship/formats/inno';
            import * as unpack from '@bottleship/formats/unpack';
            import { resolve, join, sep, basename } from 'node:path';
            const originalFs = { ...fs }, originalInno = { ...inno }, originalUnpack = { ...unpack };
            const payloadRoot = resolve(${JSON.stringify(extractDir)}, 'app') + sep;
            mock.module('fs', () => ({ ...originalFs, readFileSync(file, ...args) {
                const absolute = resolve(String(file));
                if (absolute.startsWith(payloadRoot) && !/^goggame-.*\\.(info|script)$/i.test(basename(absolute))) {
                    throw new Error('EXTRACTED_PAYLOAD_RELOADED: ' + basename(absolute));
                }
                return originalFs.readFileSync(file, ...args);
            } }));
            mock.module('@bottleship/formats/inno', () => ({ ...originalInno,
                parseInnoHeader: async () => ({ offsets: { dataOffset: 1 }, header: {}, files: [] }),
                extractInno: async (_source, options, sink) => {
                    const files = [
                        ['game.exe', 'game'], ['other.exe', 'other'], ['data/large.bin', 'payload'],
                        ['__redist/runtime.exe', 'support'], ['gog.ico', 'icon'],
                        ['goggame-123.info', JSON.stringify({ name: 'Fixture Game', gameId: '123' })],
                    ];
                    for (const [name, body] of files) {
                        if (options.wantFile && !options.wantFile(name)) continue;
                        const file = sink(name); file.begin(); file.data(new TextEncoder().encode(body)); file.end(true);
                    }
                },
            }));
            mock.module('@bottleship/formats/unpack', () => ({ ...originalUnpack,
                UnpackDecoder: class { async init() {} },
            }));
            process.argv = ['bun', ${JSON.stringify(cli)}, ${JSON.stringify(installer)}, ${JSON.stringify(join(work, 'unused.wgb'))},
                '--extract-only', '--extract-dir', ${JSON.stringify(extractDir)}, ...${JSON.stringify(extra)}];
            await import(${JSON.stringify(cli)});
        `;
        const child = Bun.spawnSync([process.execPath, '--eval', runner], { stdout: 'pipe', stderr: 'pipe', timeout: 15_000 });
        return { exitCode: child.exitCode, output: new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr) };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

test('extract-only lists filtered payload paths and detects the exe without reading payload bytes again', () => {
    const result = extractOnly();
    expect(result.output).not.toContain('EXTRACTED_PAYLOAD_RELOADED');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('exe:       game.exe');
    expect(result.output).toContain('  data/large.bin');
    expect(result.output).toContain('  game.exe');
    expect(result.output).not.toContain('  __redist/runtime.exe');
    expect(result.output).not.toContain('  gog.ico');
    expect(result.output).toContain('Extracted to:');
});

test('extract-only keeps GOG files and metadata and honours an explicit exe without payload reloads', () => {
    const result = extractOnly(['--keep-gog', '--exe', 'other.exe']);
    expect(result.output).not.toContain('EXTRACTED_PAYLOAD_RELOADED');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('game name: Fixture Game');
    expect(result.output).toContain('exe:       other.exe');
    expect(result.output).toContain('  __redist/runtime.exe');
    expect(result.output).toContain('  gog.ico');
    expect(result.output).toContain('  goggame-123.info');
    expect(result.output).toContain('Extracted to:');
});
