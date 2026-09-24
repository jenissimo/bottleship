/**
 * KERNELBASE.DLL API descriptor.
 *
 * kernelbase holds the implementation most of kernel32 (and parts of advapi32 and
 * shlwapi) forwards to, plus a few exports kernel32 never had. Every api-set contract
 * hosted by kernelbase resolves here (dll-aliases), so this table is exactly what
 * GetProcAddress on such a contract may find: the names real kernelbase exports
 * (kernelbase-exports.generated.ts) that one of those modules declares, with that
 * module's arity and failure class, plus kernelbase's own.
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";
import { kernel32Module } from "./kernel32.api";
import { kernel32VistaSupplement } from "./kernel32-vista-supplement";
import { advapi32Module } from "./advapi32.api";
import { shlwapiModule } from "./shlwapi.api";
import { KERNELBASE_EXPORT_NAMES } from "./kernelbase-exports.generated";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    ...overrides,
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

/** Exported by kernelbase and its api-set contracts only — never by kernel32. */
const kernelbaseOwn: FunctionDescriptor[] = [
    makeFunc("WaitOnAddress", 4),
    makeFunc("WakeByAddressSingle", 1),
    makeFunc("WakeByAddressAll", 1),
    makeFunc("AppPolicyGetProcessTerminationMethod", 2, { onUnimplemented: "win32Status" }),
    makeFunc("AppPolicyGetThreadInitializationType", 2, { onUnimplemented: "win32Status" }),
    makeFunc("AppPolicyGetShowDeveloperDiagnostic", 2, { onUnimplemented: "win32Status" }),
];

/** The modules whose implementations kernelbase shares, in precedence order. */
export const KERNELBASE_HOST_MODULES: readonly ModuleDescriptor[] = [
    kernel32Module, kernel32VistaSupplement, advapi32Module, shlwapiModule,
];

/** The host modules' declarations of the names kernelbase also exports. */
function sharedWithHosts(): FunctionDescriptor[] {
    const exported = new Set(KERNELBASE_EXPORT_NAMES.map(n => n.toLowerCase()));
    const seen = new Set(kernelbaseOwn.map(f => f.name.toLowerCase()));
    const out: FunctionDescriptor[] = [];
    for (const host of KERNELBASE_HOST_MODULES) {
        for (const f of host.functions) {
            const key = f.name.toLowerCase();
            if (!exported.has(key) || seen.has(key)) continue;
            seen.add(key);
            out.push({ ...f });
        }
    }
    return out;
}

export const kernelbaseModule: ModuleDescriptor = {
    name: "kernelbase",
    functions: [...kernelbaseOwn, ...sharedWithHosts()],
};
