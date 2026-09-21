import { ModuleDescriptor, FunctionDescriptor } from "./types";
import { GALAXY_HLE_ALL_EXPORTS } from "../modules/galaxy/export-names";
import { GALAXY_STACK_CLEANUP } from "../modules/galaxy/stack-cleanup";
import { GOG_GALAXY_EXPORTS, GOG_GALAXY_API_EXPORTS } from "../modules/galaxy/gog-sdk";

function msvcFunc(name: string, stackCleanupBytes: number): FunctionDescriptor {
    return {
        name,
        params: [],
        returnType: "u32",
        callingConvention: "stdcall",
        stackCleanupBytes,
    };
}

const STACK = GALAXY_STACK_CLEANUP;

/**
 * GOG's Galaxy.dll ships in a GOG build's app directory under the SAME basename as
 * Unreal's Galaxy audio DLL, so one module name has to size both import tables. These
 * are the SDK's static factory entry points: `SA…XZ` — __cdecl, no arguments, so the
 * caller cleans nothing. The interfaces they hand back live in modules/galaxy/gog-sdk.ts,
 * whose vtable layouts are transcribed from the shipped Galaxy.dll.
 */
const GOG_GALAXY_FACTORY: readonly string[] = Object.values(GOG_GALAXY_EXPORTS);

/**
 * The later SDK's free-function facade: `YA…` — __cdecl, so the stub pops nothing no
 * matter how many arguments it takes. Declaring the convention (rather than a stdcall
 * with a cleanup of 0) is what keeps the two apart, because argument COUNT and cleanup
 * are one number in the registry: `Init` needs one marshalled argument AND a `ret` that
 * pops none, and only a cdecl descriptor can say both.
 */
function cdeclFunc(name: string, argCount: number): FunctionDescriptor {
    return {
        name,
        params: Array.from({ length: argCount }, (_, i) => ({ name: `arg${i}`, type: "u32" as const })),
        returnType: "u32",
        callingConvention: "cdecl",
    };
}

const GOG_GALAXY_API: readonly FunctionDescriptor[] = Object.values(GOG_GALAXY_API_EXPORTS).map(
    (name) => cdeclFunc(name, name === GOG_GALAXY_API_EXPORTS.init ? 1 : 0));

export const galaxyModule: ModuleDescriptor = {
    name: "galaxy",
    functions: [
        ...GALAXY_HLE_ALL_EXPORTS.map((name) => msvcFunc(name, STACK[name] ?? 0)),
        ...GOG_GALAXY_FACTORY.map((name) => msvcFunc(name, 0)),
        ...GOG_GALAXY_API,
    ],
};
