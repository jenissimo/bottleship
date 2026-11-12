/**
 * One C runtime per process: the HLE msvcrt or the bundle's own msvcrt.dll, never both.
 *
 * Windows maps ONE msvcrt.dll per process, and every module that imports it shares its heap,
 * its FILE table, errno and the locale. The per-module coverage rule in resolveImportBinding
 * cannot promise that on its own: a module whose CRT imports our HLE covers binds to HLE, a
 * module that imports a single uncovered function binds to the shipped DLL, and the process
 * then runs two CRTs. A pointer malloc'd by one and free'd by the other, a FILE* opened by
 * one and read by the other, breaks quietly (Empires: Dawn of the Modern World, issue #117).
 * And any HLE coverage PR can move one module across the line without anyone noticing.
 *
 * So the decision is taken once, for the process, before the first import is bound: walk
 * every statically known image (the EXE, the real DLLs it pulls in, transitively, including
 * delay-load descriptors) and look at its CRT imports.
 *  - every importer fully covered → HLE for all of them;
 *  - any importer needs the shipped DLL → the shipped DLL for all of them;
 *  - the bundle does not ship one → HLE (nothing else exists), with a warning naming the
 *    functions HLE does not cover.
 * A module loaded later (LoadLibrary, delay-load) follows the choice already made.
 *
 * The C++ runtimes (msvcp60, and the msvcp7x-12x names aliased to msvcp90) sit on top of the
 * C one: our HLE msvcp60 allocates through HLE msvcrt. Once the C runtime goes native, a
 * shipped C++ runtime goes native with it. mfc42 has no HLE module — it is always the real
 * DLL, and its own msvcrt imports are just one more importer in the walk.
 *
 * manifest.emulator.crt overrides the rule: "hle" keeps HLE for every importer, "native"
 * binds every CRT the bundle ships natively. Default "auto". manifest.appDirDlls still
 * outranks both for the names it lists.
 */

import { normalizeDllBaseName, resolveThunkedDllAlias } from './dll-aliases';
import type { ImportBinding, ImportFn } from './pe-import-binding';

export type CrtBindingMode = 'auto' | 'hle' | 'native';
export type CrtChoice = 'hle' | 'native';

const CRT_C_MODULE = 'msvcrt';
// @transient(constant name table)
const CRT_CPP_MODULES: ReadonlySet<string> = new Set(['msvcp60', 'msvcp90']);

/** 'c' for a C runtime import name (msvcrt, msvcr71, ucrt...), 'cpp' for a C++ one, else null. */
export function crtRuntimeKind(dllName: string): 'c' | 'cpp' | null {
    const target = resolveThunkedDllAlias(normalizeDllBaseName(dllName));
    if (target === CRT_C_MODULE) return 'c';
    if (CRT_CPP_MODULES.has(target)) return 'cpp';
    return null;
}

export function parseCrtBindingMode(value: unknown): CrtBindingMode | null {
    return value === 'auto' || value === 'hle' || value === 'native' ? value : null;
}

export interface CrtScanImport {
    dll: string;
    functions: ImportFn[];
}

export interface CrtPlanDeps {
    /**
     * The import descriptors (normal + delay-load) of the real DLL a module would load under
     * this name, or null when there is no such file or it is not a readable PE.
     */
    readImports(dllNameRaw: string): Promise<CrtScanImport[] | null>;
    /** The per-module binding resolveImportBinding chooses with no process decision. */
    bindAlone(dllNameRaw: string, functions: ImportFn[]): ImportBinding;
    /** Imports the HLE module cannot answer, whether or not a real file exists. */
    uncovered(dllNameRaw: string, functions: ImportFn[]): ImportFn[];
    /** Does the bundle ship a real file under this name? */
    shipped(dllNameRaw: string): boolean;
    log(message: string): void;
    warn(message: string): void;
}

interface CrtImporter {
    image: string;
    dll: string;
    functions: ImportFn[];
    needsNative: boolean;
}

export interface CrtPlanSummary {
    mode: CrtBindingMode;
    /** Import name (normalized base) → the binding the whole process uses. */
    choices: Record<string, CrtChoice>;
    /** Images whose CRT imports took part in the decision. */
    importers: string[];
    /** "image: dll -> choice" for every import the per-module rule alone would have bound the
     *  other way — exactly the bindings this decision changed. */
    overridden: string[];
}

function key(dllName: string): string {
    return normalizeDllBaseName(dllName);
}

function fnName(f: ImportFn): string {
    return f.name ?? `ord_${f.ordinal}`;
}

/**
 * Walk the statically known images from the EXE and decide, per CRT import name, whether the
 * whole process binds it to HLE or to the shipped file. Pure apart from deps.
 */
export async function planProcessCrt(
    rootImage: string,
    rootImports: readonly CrtScanImport[],
    mode: CrtBindingMode,
    deps: CrtPlanDeps,
): Promise<{ choices: Map<string, CrtChoice>; importers: string[] }> {
    const importers: CrtImporter[] = [];
    const visited = new Set<string>([key(rootImage)]);
    const queue: Array<{ image: string; imports: readonly CrtScanImport[] }> = [{ image: rootImage, imports: rootImports }];
    const choices = new Map<string, CrtChoice>();

    const scan = async (): Promise<void> => {
        while (queue.length > 0) {
            const { image, imports } = queue.shift()!;
            for (const imp of imports) {
                const name = key(imp.dll);
                if (crtRuntimeKind(imp.dll) !== null) {
                    importers.push({
                        image, dll: imp.dll, functions: imp.functions,
                        needsNative: !deps.bindAlone(imp.dll, imp.functions).isThunked,
                    });
                    continue;
                }
                if (visited.has(name)) continue;
                // Only a module that would load as a REAL image brings imports of its own.
                if (deps.bindAlone(imp.dll, imp.functions).isThunked) continue;
                visited.add(name);
                const nested = await deps.readImports(imp.dll);
                if (nested) queue.push({ image: name, imports: nested });
            }
        }
    };

    const decide = (): void => {
        const names = new Map<string, CrtImporter[]>();
        for (const imp of importers) {
            const list = names.get(key(imp.dll)) ?? [];
            list.push(imp);
            names.set(key(imp.dll), list);
        }
        let anyCNative = false;
        for (const [name, list] of names) {
            if (crtRuntimeKind(name) !== 'c') continue;
            const native = choose(name, list);
            choices.set(name, native ? 'native' : 'hle');
            anyCNative ||= native;
        }
        for (const [name, list] of names) {
            if (crtRuntimeKind(name) !== 'cpp') continue;
            // The C++ runtime sits on the C one: HLE msvcp60 allocates through HLE msvcrt.
            const native = choose(name, list) || (anyCNative && mode !== 'hle' && deps.shipped(name));
            choices.set(name, native ? 'native' : 'hle');
        }
    };

    const choose = (name: string, list: readonly CrtImporter[]): boolean => {
        if (mode === 'hle') return false;
        if (mode === 'native') return deps.shipped(name);
        return list.some(i => i.needsNative);
    };

    // A C++ runtime that goes native imports the C runtime itself, so its imports join the
    // walk — and may flip the C runtime too. Choices only ever move HLE → native, so this
    // settles in at most a few rounds.
    for (let round = 0; round < 8; round++) {
        await scan();
        decide();
        let grew = false;
        for (const [name, choice] of choices) {
            if (choice !== 'native' || visited.has(name)) continue;
            visited.add(name);
            const nested = await deps.readImports(name);
            if (nested) { queue.push({ image: name, imports: nested }); grew = true; }
        }
        if (!grew) break;
    }

    for (const [name, choice] of choices) {
        const list = importers.filter(i => key(i.dll) === name);
        const images = [...new Set(list.map(i => i.image))];
        const why = mode !== 'auto' ? `manifest crt "${mode}"`
            : choice === 'native' ? `needed by ${[...new Set(list.filter(i => i.needsNative).map(i => i.image))].join(', ') || 'the C runtime'}`
            : 'every importer covered';
        deps.log(`[PE] Process CRT binding: ${name} -> ${choice === 'native' ? 'shipped DLL' : 'HLE'} ` +
            `for ${images.join(', ')} (${why})`);
        if (choice !== 'hle') continue;
        const missing = new Set<string>();
        for (const imp of list) for (const f of deps.uncovered(imp.dll, imp.functions)) missing.add(fnName(f));
        if (missing.size === 0) continue;
        const shown = [...missing].slice(0, 8).join(', ');
        deps.warn(`[PE] Process CRT binding: ${name} stays on HLE ` +
            `(${deps.shipped(name) ? `manifest crt "${mode}"` : 'the bundle ships no copy'}) but HLE does not cover ` +
            `${missing.size} of its imports: ${shown}${missing.size > 8 ? ', …' : ''}`);
    }
    return { choices, importers: [...new Set(importers.map(i => i.image))] };
}

/** The decision for the running process. One EXE per worker, so one instance. */
class ProcessCrtBinding {
    private choices = new Map<string, CrtChoice>();
    private importerImages: string[] = [];
    private overrides: string[] = [];
    private disabled = false;
    mode: CrtBindingMode = 'auto';

    /** No process decision at all: every module binds by its own coverage (A/B only). */
    disable(): void {
        this.disabled = true;
    }

    /** An import the process decision bound differently from the module's own coverage. */
    noteOverride(image: string, dllName: string, choice: CrtChoice): void {
        if (this.overrides.length < 64) this.overrides.push(`${image}: ${key(dllName)} -> ${choice}`);
    }

    adoptPlan(mode: CrtBindingMode, choices: ReadonlyMap<string, CrtChoice>, importers: readonly string[] = []): void {
        this.mode = mode;
        this.choices = new Map(choices);
        this.importerImages = [...importers];
    }

    /** The process choice for this CRT import name, or undefined when none was made yet. */
    choiceFor(dllName: string): CrtChoice | undefined {
        if (this.disabled || crtRuntimeKind(dllName) === null) return undefined;
        return this.choices.get(key(dllName));
    }

    /**
     * A CRT name no static image imported, first bound by a late module: its own binding
     * becomes the process choice, so the modules after it agree with it.
     */
    noteLateBinding(dllName: string, thunked: boolean): void {
        if (this.disabled || crtRuntimeKind(dllName) === null || this.choices.has(key(dllName))) return;
        this.choices.set(key(dllName), thunked ? 'hle' : 'native');
    }

    summary(): CrtPlanSummary {
        return { mode: this.mode, choices: Object.fromEntries(this.choices), importers: [...this.importerImages], overridden: [...this.overrides] };
    }

    reset(): void {
        this.choices.clear();
        this.importerImages = [];
        this.overrides = [];
        this.disabled = false;
        this.mode = 'auto';
    }
}

// @transient(link-time decision: System.reset clears it and loadExecutable recomputes it; a savestate loads into a fresh worker that relinks the EXE)
export const processCrtBinding = new ProcessCrtBinding();
