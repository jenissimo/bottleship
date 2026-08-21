/**
 * AVI File Library (avifil32.dll) API Descriptor
 *
 * Provides AVIFile/AVIStream functions used by games to play AVI cutscenes.
 * All functions use stdcall calling convention.
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

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

export const avifil32Module: ModuleDescriptor = {
    name: "avifil32",
    functions: [
        // Initialization / cleanup
        makeFunc("AVIFileInit", 0),
        makeFunc("AVIFileExit", 0),

        // File open/close
        makeFunc("AVIFileOpenA", 4),              // ppfile, szFile, uMode, lpHandler
        makeFunc("AVIFileRelease", 1),            // pfile → ref count
        makeFunc("AVIFileInfoA", 3),              // pfile, pfi (LPAVIFILEINFOA), lSize
        makeFunc("AVIFileGetStream", 4),          // pfile, ppavi, fccType, lParam

        // Stream open/close
        makeFunc("AVIStreamOpenFromFileA", 6),   // ppavi, szFile, fccType, lParam, mode, pclsidHandler
        makeFunc("AVIStreamRelease", 1),          // pavi

        // Stream info
        makeFunc("AVIStreamInfoA", 3),            // pavi, psi, lSize
        makeFunc("AVIStreamLength", 1),           // pavi → frame count
        makeFunc("AVIStreamStart", 1),            // pavi → start sample
        makeFunc("AVIStreamStartTime", 1),        // pavi → start time (ms)
        makeFunc("AVIStreamSampleToTime", 2),     // pavi, lSample → ms
        makeFunc("AVIStreamTimeToSample", 2),     // pavi, lTime (ms) → frame index

        // Stream reading
        makeFunc("AVIStreamRead", 7),             // pavi, lStart, lSamples, lpBuffer, cbBuffer, plBytes, plSamples
        makeFunc("AVIStreamReadFormat", 4),       // pavi, lPos, lpFormat, lpcbFormat
        makeFunc("AVIStreamReadData", 4),         // pavi, fcc, lp, lpcb
        makeFunc("AVIStreamWriteData", 4),        // pavi, fcc, lp, cb
        makeFunc("AVIStreamFindSample", 3),       // pavi, lPos, lFlags

        // Frame extraction
        makeFunc("AVIStreamGetFrameOpen", 2),     // pavi, lpbiWanted
        makeFunc("AVIStreamGetFrame", 2),         // pgf, lPos → ptr to DIB
        makeFunc("AVIStreamGetFrameClose", 1),    // pgf
    ]
};
