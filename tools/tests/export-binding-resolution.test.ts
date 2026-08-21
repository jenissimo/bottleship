/**
 * The export-binding resolver, pinned against a synthetic module tree.
 *
 * Written because the real defect it fixes was invisible: `imagehlp.ts` binds 22 exports
 * with `Object.assign(this.exports, createDbgHelpExports())`, the scanner could not follow
 * that, and validate-signatures reported "3 implemented" — a wrong number, in green ink,
 * with nothing to indicate the shortfall was a scanner limit rather than a fact.
 *
 * A fixture rather than the repo's own modules: the point is that the resolver can be shown
 * to answer correctly AND to admit ignorance, and both must stay provable without depending
 * on what any real module happens to look like this week.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiCoverageIndex } from '../../src/worker/tools/api-coverage';

let root = '';

const api = (name: string, funcs: string) => `
import { ModuleDescriptor } from "./types";
export const ${name}Module: ModuleDescriptor = {
    name: "${name}",
    functions: [${funcs}],
};
`;

const func = (name: string, argCount: number) =>
    `{ name: "${name}", params: [${Array.from({ length: argCount }, (_, i) => `{ name: "a${i}", type: "u32" }`).join(',')}], returnType: "u32", callingConvention: "stdcall" }`;

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-binding-'));
    const apiDir = path.join(root, 'src/worker/api');
    const modDir = path.join(root, 'src/worker/modules');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(modDir, { recursive: true });

    // provider: implements the shared table. consumer: declares the same surface and
    // reaches it only through a merge. opaque: merges from something unfollowable.
    fs.writeFileSync(path.join(apiDir, 'provider.api.ts'),
        api('provider', [func('SharedOne', 2), func('SharedTwo', 3)].join(',')));
    fs.writeFileSync(path.join(apiDir, 'consumer.api.ts'),
        api('consumer', [func('OwnCall', 1), func('SharedOne', 2), func('SharedTwo', 3), func('NeverImplemented', 4)].join(',')));
    fs.writeFileSync(path.join(apiDir, 'opaque.api.ts'),
        api('opaque', [func('Mystery', 1)].join(',')));

    fs.writeFileSync(path.join(modDir, 'provider.ts'), `
export function createProviderExports(): Record<string, any> {
    return {
        SharedOne: (ctx: any, mem: any, args: number[]) => ({ value: args[0], stackCleanup: 8 }),
        SharedTwo: (ctx: any, mem: any, args: number[]) => ({ value: args[1], stackCleanup: 12 }),
    };
}
export class Provider {
    exports: Record<string, any> = createProviderExports();
}
`);
    fs.writeFileSync(path.join(modDir, 'consumer.ts'), `
import { createProviderExports } from "./provider";
export class Consumer {
    exports: Record<string, any> = {};
    initialize(): void {
        Object.assign(this.exports, createProviderExports());
        this.exports["OwnCall"] = (ctx: any, mem: any, args: number[]) => ({ value: 0, stackCleanup: 4 });
    }
}
`);
    fs.writeFileSync(path.join(modDir, 'opaque.ts'), `
export class Opaque {
    exports: Record<string, any> = {};
    initialize(): void {
        Object.assign(this.exports, (globalThis as any).__lateTable);
    }
}
`);
});

afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('export-binding resolution', () => {
    test('a merge from another module binds that module\'s handlers', () => {
        const idx = ApiCoverageIndex.load(root);
        const shared = idx.lookup('consumer', 'SharedOne');
        expect(shared?.status).toBe('implemented');
        // The handler is provider's, and that is what makes the two descriptors comparable.
        expect(shared?.origin).toBe('provider');
        expect(shared?.stackCleanups).toEqual([8]);
        expect(idx.lookup('consumer', 'SharedTwo')?.status).toBe('implemented');
        expect(idx.lookup('consumer', 'OwnCall')?.origin).toBeUndefined();
    });

    test('a declaration with no handler anywhere stays declared-only', () => {
        const idx = ApiCoverageIndex.load(root);
        // Legitimate and common (638 exports in the repo): the dispatcher answers
        // ERROR_NOT_SUPPORTED. It must be counted, not confused with a merged binding.
        expect(idx.lookup('consumer', 'NeverImplemented')?.status).toBe('declared-stub');
    });

    test('an unfollowable merge is confessed, not silently counted as unimplemented', () => {
        const idx = ApiCoverageIndex.load(root);
        const opaque = idx.getModule('opaque')!;
        expect(opaque.mergeSites).toBeGreaterThan(0);
        expect(opaque.unresolvedMerges).toHaveLength(1);
        expect(opaque.unresolvedMerges[0].reason).toContain('runtime property access');
        // The module a resolver CAN follow must not be dragged into the unknown bucket.
        expect(idx.getModule('consumer')!.unresolvedMerges).toHaveLength(0);
        expect(idx.getModule('consumer')!.mergeSites).toBe(1);
    });
});
