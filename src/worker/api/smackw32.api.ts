/**
 * Smacker Video Library API Descriptor
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

export const smackw32Module: ModuleDescriptor = {
    name: "smackw32",
    functions: [
        // Sound system
        makeFunc("_SmackSoundUseMSS@4", 1),       // driver handle

        // CPU features
        makeFunc("_SmackUseMMX@4", 1),            // flag

        // Video open/close
        makeFunc("_SmackOpen@12", 3),             // name, flags, extraBuffers
        makeFunc("_SmackClose@4", 1),             // handle

        // Frame control
        makeFunc("_SmackDoFrame@4", 1),           // handle
        makeFunc("_SmackNextFrame@4", 1),         // handle
        makeFunc("_SmackWait@4", 1),              // handle
        makeFunc("_SmackGoto@8", 2),              // handle, frame

        // Buffer operations
        makeFunc("_SmackToBuffer@28", 7),         // handle, left, top, pitch, height, buf, flags
        makeFunc("_SmackToBufferRect@8", 2),      // handle, SmackSurface
        makeFunc("_SmackBufferOpen@24", 6),       // hwnd, blitType, width, height, scaledWidth, scaledHeight
        makeFunc("_SmackBufferClose@4", 1),       // handle
        makeFunc("_SmackBufferNewPalette@12", 3), // handle, palette, palType

        // Sound control
        makeFunc("_SmackSoundOnOff@8", 2),        // handle, onoff
        makeFunc("_SmackSoundUseDirectSound@4", 1), // directsound handle
        makeFunc("_SmackVolumePan@16", 4),        // handle, track, vol, pan
    ]
};
