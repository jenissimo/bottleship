#!/usr/bin/env bun
/**
 * A DECLARED export with no handler must answer with something the caller reads as
 * FAILURE. `UnimplementedReturn` defaults to "zero", which fails under every
 * pointer/handle/BOOL/count convention — and is SUCCESS under the status-code
 * conventions (HRESULT S_OK, MMSYSERR_NOERROR, MCI 0, ERROR_SUCCESS). Those are the
 * names a descriptor has to declare, and this is what keeps them declared.
 *
 * Two checks, both of which caught a real defect the first time they ran:
 *
 *  1. ROT — every declared export whose curated win32 reference says it returns
 *     HRESULT/MMRESULT/MCIERROR/LSTATUS must carry a matching `onUnimplemented`.
 *     Ground truth is `tools/reference/win32/<mod>/*.sig.json`, the same files the
 *     arg-count reference is generated from, so this is not a hand-maintained list.
 *
 *  2. SILENT DROP — an api file's `makeFunc` factory builds its FunctionDescriptor
 *     field by field. One that takes `overrides` but does not spread it discards
 *     `onUnimplemented` without a word, and the export goes back to answering "success".
 *     Every such factory must spread its overrides.
 *
 * Usage: bun tools/validate-unimplemented-returns.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ApiCoverageIndex } from '../src/worker/tools/api-coverage';

const API_DIR = 'src/worker/api';
const REF_DIR = 'tools/reference/win32';

/** Reference C return type → the class a descriptor must declare. */
const REQUIRED_CLASS: Record<string, string> = {
    HRESULT: 'hresult',
    MMRESULT: 'mmresult',
    MCIERROR: 'mcierror',
    LSTATUS: 'win32Status',
};

function loadReferenceReturnTypes(): Map<string, string> {
    const out = new Map<string, string>();
    if (!fs.existsSync(REF_DIR)) return out;
    for (const dll of fs.readdirSync(REF_DIR)) {
        const dir = path.join(REF_DIR, dll);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.sig.json')) continue;
            const json = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
            for (const fn of json.functions ?? []) {
                if (!fn?.name || !fn?.returnType) continue;
                const name = String(fn.name).replace(/^_+/, '').replace(/@\d+$/, '').toLowerCase();
                out.set(`${dll.toLowerCase()}:${name}`, String(fn.returnType));
            }
        }
    }
    return out;
}

const declaredClass = (line: string): string | undefined => /onUnimplemented:\s*"(\w+)"/.exec(line)?.[1];

const coverage = ApiCoverageIndex.load(process.cwd());
const failures: string[] = [];
const ref = loadReferenceReturnTypes();
let checked = 0;
let annotated = 0;

for (const file of fs.readdirSync(API_DIR).filter(f => f.endsWith('.api.ts'))) {
    const module = file.replace(/\.api\.ts$/, '').toLowerCase();
    const src = fs.readFileSync(path.join(API_DIR, file), 'utf-8');

    // Check 2: a factory that takes overrides must forward them.
    for (const m of src.matchAll(/const (\w+) = \([^)]*overrides: Partial<FunctionDescriptor>[\s\S]{0,120}?=> \(\{([\s\S]{0,200}?)\n\}\)/g)) {
        if (!m[2].includes('...overrides')) {
            failures.push(`${file}: factory ${m[1]}() takes \`overrides\` but never spreads them — ` +
                `an onUnimplemented written at a call site is silently discarded.`);
        }
    }

    for (const line of src.split('\n')) {
        const call = /makeFunc\w*\(\s*"([A-Za-z_0-9@]+)"/.exec(line);
        if (!call) continue;
        const name = call[1].replace(/^_+/, '').replace(/@\d+$/, '').toLowerCase();
        // "unresolvable" says GetProcAddress must report the name ABSENT. The day someone
        // implements it, that annotation turns a working export into a missing one.
        if (declaredClass(line) === 'unresolvable' && coverage.lookup(module, name)?.status === 'implemented') {
            failures.push(`${module}:${call[1]} is declared "unresolvable" (GetProcAddress answers NULL) ` +
                `but a handler now exists — drop the annotation so the export resolves.`);
        }
        const returnType = ref.get(`${module}:${name}`);
        const required = returnType ? REQUIRED_CLASS[returnType] : undefined;
        if (line.includes('onUnimplemented')) annotated++;
        if (!required) continue;
        checked++;
        const declared = declaredClass(line);
        if (!declared) {
            failures.push(`${module}:${call[1]} returns ${returnType} — 0 is SUCCESS there, so it must declare ` +
                `{ onUnimplemented: "${required}" }.`);
        } else if (declared !== required) {
            failures.push(`${module}:${call[1]} returns ${returnType} but declares "${declared}" (expected "${required}").`);
        }
    }
}

console.log(`Checked ${checked} status-code-returning declarations against the win32 reference; ` +
    `${annotated} declarations carry an explicit failure class.`);

if (failures.length) {
    console.error(`\nFAIL — ${failures.length} problem(s):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
}
console.log('OK — no export whose failure value would read as success is left undeclared.');
