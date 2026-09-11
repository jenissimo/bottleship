import { ModuleDescriptor, FunctionDescriptor } from "./types";
import { GALAXY_HLE_ALL_EXPORTS } from "../modules/galaxy/export-names";
import { GALAXY_STACK_CLEANUP } from "../modules/galaxy/stack-cleanup";
import { GOG_GALAXY_EXPORTS } from "../modules/galaxy/gog-sdk";

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

export const galaxyModule: ModuleDescriptor = {
    name: "galaxy",
    functions: [
        ...GALAXY_HLE_ALL_EXPORTS.map((name) => msvcFunc(name, STACK[name] ?? 0)),
        ...GOG_GALAXY_FACTORY.map((name) => msvcFunc(name, 0)),
    ],
};
