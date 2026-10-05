/**
 * lgvid.dll — the Dark Engine's video module (System Shock 2 NewDark, Thief 1/2/Gold).
 *
 * The shipped DLL is a thin front end over a bundled ffmpeg.dll; we replace it with
 * the native VideoEngine. Both exports are the SAME entry point in the real DLL —
 * `CreateLGVideoDecoder2` is an alias, not a second version — and both are __cdecl
 * taking (IMovieHost* host, const char* resolvedMoviePath).
 *
 * `IMoviePlayer1` is a C++ class, but every method is compiled __stdcall with `this`
 * as the first STACK argument (MOV EAX,[ESP+4] … RET N), not __thiscall. The host
 * interface the game passes in uses the same convention.
 */

import {
    ModuleDescriptor,
    InterfaceDescriptor,
    FunctionDescriptor,
    ParameterDescriptor,
} from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: i === 0 ? "this" : `arg${i}`, type: i === 0 ? "ptr" : "u32" });
    }
    return params;
};

const makeMethod = (name: string, argCount: number): FunctionDescriptor => ({
    name,
    params: buildParams(argCount),
    returnType: "u32",
    callingConvention: "stdcall",
});

/** Vtable order is the real DLL's (0x10005568); the destructor is LAST, not first. */
export const IMoviePlayer1: InterfaceDescriptor = {
    name: "IMoviePlayer1",
    methods: [
        makeMethod("Destroy", 1),
        makeMethod("Play", 1),
        makeMethod("IsDone", 1),
        makeMethod("BeginFrame", 1),
        makeMethod("EndFrame", 1),
        makeMethod("FillAudio", 2),
        makeMethod("GetTime", 1),
        makeMethod("DeleteDtor", 2),
    ],
};

export const lgvidModule: ModuleDescriptor = {
    name: "lgvid",
    functions: [
        {
            name: "CreateLGVideoDecoder",
            params: [
                { name: "host", type: "ptr" },
                { name: "path", type: "ptr" },
            ],
            returnType: "u32",
            callingConvention: "cdecl",
        },
        {
            name: "CreateLGVideoDecoder2",
            params: [
                { name: "host", type: "ptr" },
                { name: "path", type: "ptr" },
            ],
            returnType: "u32",
            callingConvention: "cdecl",
        },
    ],
    interfaces: [IMoviePlayer1],
};
