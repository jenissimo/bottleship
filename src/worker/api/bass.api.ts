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

export const bassModule: ModuleDescriptor = {
    name: "bass",
    functions: [
        makeFunc("BASS_Init", 5),
        makeFunc("BASS_Free", 0),
        makeFunc("BASS_StreamCreateFile", 5),
        makeFunc("BASS_StreamPlay", 3),
        makeFunc("BASS_StreamFree", 1),
        makeFunc("BASS_StreamGetLength", 1),
        makeFunc("BASS_ChannelSetAttributes", 4),
        makeFunc("BASS_ChannelStop", 1),
        makeFunc("BASS_ChannelGetPosition", 1),
        makeFunc("BASS_ChannelGetData", 3),
        makeFunc("BASS_ChannelIsActive", 1),
        makeFunc("BASS_ChannelGetInfo", 2),
        makeFunc("BASS_ChannelBytes2Seconds", 3),
        makeFunc("BASS_Pause", 0),
        makeFunc("BASS_Start", 0),
        makeFunc("BASS_SampleLoad", 6),
        makeFunc("BASS_SamplePlay", 1),
        makeFunc("BASS_SamplePlayEx", 6),
        makeFunc("BASS_SampleGetInfo", 2),
        makeFunc("BASS_SampleSetInfo", 2),
    ]
};
