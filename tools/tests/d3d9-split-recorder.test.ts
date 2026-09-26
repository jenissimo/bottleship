/**
 * The split D3D9 recorder wraps the device's API surface and records only the OUTERMOST call.
 * An async method's code after an `await` runs at depth 0, so any recorded method it calls
 * there is recorded a second time: `present()` flushing through `this.submitFrame(true)` after
 * the pacer wait sent the render twin an empty present on top of every real one, and the
 * screen went black while every state audit read clean.
 *
 * This pins the static rule: no RECORDED name is called by D3D9Device after an await.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';

const DEVICE = fs.readFileSync('src/worker/backends/webgpu/d3d9/d3d9-device.ts', 'utf8');
const SPLIT = fs.readFileSync('src/worker/modules/d3d9/split.ts', 'utf8');

function recordedNames(): Set<string> {
    const start = SPLIT.indexOf('const RECORDED = [');
    const end = SPLIT.indexOf('] as const;', start);
    expect(start).toBeGreaterThan(0);
    return new Set([...SPLIT.slice(start, end).matchAll(/"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]!));
}

/** `method line N: this.x(` for every recorded name called after an await in an async method. */
function postAwaitRecordedCalls(recorded: Set<string>): string[] {
    const lines = DEVICE.split(/\r?\n/);
    const hits: string[] = [];
    let method: string | null = null;
    let depth = 0;
    let awaited = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const head = line.match(/^    (?:private |public )?async ([a-zA-Z0-9_]+)\(/);
        if (head && !method) { method = head[1]!; depth = 0; awaited = false; }
        if (!method) continue;
        if (/\bawait\b/.test(line)) awaited = true;
        if (awaited) {
            for (const call of line.matchAll(/this\.([a-zA-Z0-9_]+)\(/g)) {
                if (recorded.has(call[1]!)) hits.push(`${method} line ${i + 1}: this.${call[1]}(`);
            }
        }
        for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
        if (depth <= 0 && line.includes('}')) method = null;
    }
    return hits;
}

describe('split recorder: the recorded surface', () => {
    it('no recorded method is called by the device after an await', () => {
        expect(postAwaitRecordedCalls(recordedNames())).toEqual([]);
    });

    it('the scan finds the call that blackened the screen', () => {
        const withSubmit = new Set(recordedNames());
        withSubmit.add('submitFrame');
        expect(postAwaitRecordedCalls(withSubmit).some((h) => h.startsWith('present '))).toBe(true);
    });

    it('every recorded and delegated name is a D3D9Device method', () => {
        const missing = [...recordedNames()].filter((n) => !new RegExp(`^    (?:async )?${n}\\(`, 'm').test(DEVICE));
        expect(missing).toEqual([]);
    });
});
