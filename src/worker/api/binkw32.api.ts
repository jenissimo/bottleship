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
        makeFunc("_BinkSetVolume@12", 3),         // 1.9+: handle, trackid, volume
        // Bink >= 1.9 gave BinkSetVolume a track parameter (handle, trackid, volume) but
        // import tables built against older headers still carry the `@8` decoration, so the
        // name and the real ABI disagree — the case stackCleanupBytes exists for. Gothic's
        // SystemPack/Union detours the call site (0x43A942) to push the extra dword and jump
        // back, so the caller pushes 12 and a RET 8 leaves 4 bytes behind: every local in the
        // caller's frame then shifts and the fault lands in unrelated code.
        makeFunc("_BinkSetVolume@8", 3, { stackCleanupBytes: 12 }),
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
