/**
 * Aureal A3D 4.0 API Descriptor — stub for galaxy.dll (Unreal Engine audio).
 *
 * Interface: IA3d4 (inherits IA3d3 → IA3d2 → IA3d → IUnknown)
 * All methods are no-op stubs returning S_OK.
 */

import {
    ModuleDescriptor,
    InterfaceDescriptor,
    FunctionDescriptor,
    ParameterDescriptor,
    IUnknown,
} from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: i === 0 ? "this" : `arg${i}`, type: i === 0 ? "ptr" : "u32" });
    }
    return params;
};

const makeMethod = (
    name: string,
    argCount: number,
    overrides: Partial<FunctionDescriptor> = {}
): FunctionDescriptor => ({
    ...overrides,
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
    async: overrides.async,
    category: overrides.category,
    description: overrides.description,
});

// IA3d5 vtable layout (51 methods total):
// 0-2:   IUnknown (QueryInterface, AddRef, Release)
// 3-8:   IA3d (SetOutputMode, GetOutputMode, SetResourceManagerMode, GetResourceManagerMode, SetHFAbsorbFactor, GetHFAbsorbFactor)
// 9-11:  IA3d2 (RegisterVersion, GetSoftwareCaps, GetHardwareCaps)
// 12-26: IA3d3 (Clear, Flush, Compat, Init, IsFeatureAvailable, NewSource, DuplicateSource, SetCooperativeLevel, GetCooperativeLevel, SetMaxReflectionDelayTime, GetMaxReflectionDelayTime, SetCoordinateSystem, GetCoordinateSystem, SetOutputGain, GetOutputGain)
// 27-41: IA3d4 (SetNumFallbackSources, GetNumFallbackSources, SetRMPriorityBias, GetRMPriorityBias, DisableViewer, SetUnitsPerMeter, GetUnitsPerMeter, SetDopplerScale, GetDopplerScale, SetDistanceModelScale, GetDistanceModelScale, SetEq, GetEq, Shutdown, RegisterApp)
// 42-50: IA3d5 (InitEx, NewReverb, BindReverb, GetStreamingProperties, SetStreamingProperties, A3dEnumerate, UnlockFallbackAC3Decoder, SetMaxHardwareSources, GetMaxHardwareSources)

export const IA3d5: InterfaceDescriptor = {
    name: "IA3d5",
    inherits: "IUnknown",
    iid: "9ae07221-8ac4-11d3-b6aa-00600879f3ee",
    methods: [
        ...IUnknown.methods.map(m => ({ ...m, name: m.name })),
        // IA3d methods (slots 3-8)
        makeMethod("SetOutputMode", 4),
        makeMethod("GetOutputMode", 4),
        makeMethod("SetResourceManagerMode", 2),
        makeMethod("GetResourceManagerMode", 2),
        makeMethod("SetHFAbsorbFactor", 2),
        makeMethod("GetHFAbsorbFactor", 2),
        // IA3d2 methods (slots 9-11)
        makeMethod("RegisterVersion", 2),
        makeMethod("GetSoftwareCaps", 2),
        makeMethod("GetHardwareCaps", 2),
        // IA3d3 methods (slots 12-26)
        makeMethod("Clear", 1),
        makeMethod("Flush", 1),
        makeMethod("Compat", 3),
        makeMethod("Init", 4),
        makeMethod("IsFeatureAvailable", 2),
        makeMethod("NewSource", 3),
        makeMethod("DuplicateSource", 3),
        makeMethod("SetCooperativeLevel", 3),
        makeMethod("GetCooperativeLevel", 2),
        makeMethod("SetMaxReflectionDelayTime", 2),
        makeMethod("GetMaxReflectionDelayTime", 2),
        makeMethod("SetCoordinateSystem", 2),
        makeMethod("GetCoordinateSystem", 2),
        makeMethod("SetOutputGain", 2),
        makeMethod("GetOutputGain", 2),
        // IA3d4 methods (slots 27-41)
        makeMethod("SetNumFallbackSources", 2),
        makeMethod("GetNumFallbackSources", 2),
        makeMethod("SetRMPriorityBias", 2),
        makeMethod("GetRMPriorityBias", 2),
        makeMethod("DisableViewer", 1),
        makeMethod("SetUnitsPerMeter", 2),
        makeMethod("GetUnitsPerMeter", 2),
        makeMethod("SetDopplerScale", 2),
        makeMethod("GetDopplerScale", 2),
        makeMethod("SetDistanceModelScale", 2),
        makeMethod("GetDistanceModelScale", 2),
        makeMethod("SetEq", 2),
        makeMethod("GetEq", 2),
        makeMethod("Shutdown", 1),
        makeMethod("RegisterApp", 2),
        // IA3d5 methods (slots 42-50)
        makeMethod("InitEx", 6),
        makeMethod("NewReverb", 2),
        makeMethod("BindReverb", 2),
        makeMethod("GetStreamingProperties", 3),
        makeMethod("SetStreamingProperties", 3),
        makeMethod("A3dEnumerate", 3),
        makeMethod("UnlockFallbackAC3Decoder", 3),
        makeMethod("SetMaxHardwareSources", 2),
        makeMethod("GetMaxHardwareSources", 2),
    ],
};

// Keep IA3d4 as alias for backward compatibility
export const IA3d4 = IA3d5;

export const a3dModule: ModuleDescriptor = {
    name: "a3d",
    version: "5.0",
    description: "Aureal A3D audio stubs",
    functions: [],
    interfaces: [IA3d5],
};
