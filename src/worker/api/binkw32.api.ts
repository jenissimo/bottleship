/**
 * Bink Video Library API Descriptor
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

export const binkw32Module: ModuleDescriptor = {
    name: "binkw32",
    functions: [
        // Sound system
        makeFunc("_BinkSetSoundSystem@8", 2),     // callback, param

        // Video open/close
        makeFunc("_BinkOpen@8", 2),               // name, flags
        makeFunc("_BinkClose@4", 1),              // handle

        // Frame control
        makeFunc("_BinkDoFrame@4", 1),            // handle
        makeFunc("_BinkNextFrame@4", 1),          // handle
        makeFunc("_BinkWait@4", 1),               // handle
        makeFunc("_BinkGoto@12", 3),              // handle, frame, flags
        makeFunc("_BinkPause@8", 2),              // handle, pause
        makeFunc("_BinkGetRects@8", 2),           // handle, flags
        makeFunc("_BinkGetSummary@8", 2),         // handle, summary ptr

        // Buffer operations
        makeFunc("_BinkCopyToBuffer@28", 7),      // handle, buf, pitch, height, x, y, flags
        makeFunc("_BinkCopyToBufferRect@44", 11), // handle, buf, pitch, height, x, y, left, top, width, height2, flags
        makeFunc("_BinkBufferOpen@16", 4),        // hwnd, ...
        makeFunc("_BinkBufferClose@4", 1),        // handle
        makeFunc("_BinkBufferBlit@16", 4),        // buffer, bink, x, y
        makeFunc("_BinkBufferLock@4", 1),         // buffer
        makeFunc("_BinkBufferUnlock@4", 1),       // buffer
        makeFunc("_BinkDDSurfaceType@4", 1),      // lpDirectDrawSurface

        // Sound control
        makeFunc("_BinkOpenMiles@4", 1),          // HDIGDRIVER
        // Bink >= 1.9 gave BinkSetVolume a track parameter, and BOTH generations ship. The
        // decoration is the contract either way — a stdcall export pops exactly what its
        // `@N` says, and every real binkw32 we have (0.8i, 1.0v, 1.5v) exports `@8` and
        // RET 8s. Overriding `@8` to pop 12 drifts ESP by 4 in a caller that pushed 8, and
        // the caller's own RET then jumps into whatever dword the drift exposed: TLJ's
        // dx_module landed in its heap data and died with no trace back to here.
        makeFunc("_BinkSetVolume@12", 3),         // 1.9+: handle, trackid, volume
        makeFunc("_BinkSetVolume@8", 2),          // pre-1.9: handle, volume
        makeFunc("_BinkSetPan@12", 3),            // handle, trackid, pan
        makeFunc("_BinkSetSoundOnOff@8", 2),      // handle, onoff
        makeFunc("_BinkSetSoundTrack@8", 2),      // tracks, trackIds
        makeFunc("_BinkSetVideoOnOff@8", 2),      // handle, onoff

        // I/O
        makeFunc("_BinkSetIOSize@4", 1),          // iosize (global read-ahead buffer hint)

        // Misc
        makeFunc("_BinkGetError@0", 0),           // no args
        makeFunc("_BinkSetMemory@8", 2),          // alloc, free
        makeFunc("_BinkLogoAddress@0", 0),        // no args
    ]
};
