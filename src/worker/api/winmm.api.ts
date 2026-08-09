import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const winmmModule: ModuleDescriptor = {
    name: "winmm",
    functions: [
        makeFunc("timeGetTime", 0),
        makeFunc("DefDriverProc", 5),
        makeFunc("DrvDefDriverProc", 5),
        makeFunc("timeGetDevCaps", 2),
        makeFunc("timeBeginPeriod", 1),
        makeFunc("timeEndPeriod", 1),
        makeFunc("timeSetEvent", 5),
        makeFunc("timeKillEvent", 1),
        makeFunc("mciSendStringA", 4),
        makeFunc("mciSendStringW", 4),
        // Wave output functions
        makeFunc("waveOutOpen", 6),
        makeFunc("waveOutClose", 1),
        makeFunc("waveOutPrepareHeader", 3),
        makeFunc("waveOutUnprepareHeader", 3),
        makeFunc("waveOutWrite", 3),
        makeFunc("waveOutReset", 1),
        makeFunc("waveOutGetID", 2),
        makeFunc("waveOutSetVolume", 2),
        makeFunc("waveOutGetVolume", 2),
        makeFunc("waveOutGetNumDevs", 0),
        makeFunc("waveOutGetDevCapsA", 3),
        makeFunc("waveOutGetErrorTextA", 3),
        makeFunc("waveOutGetErrorTextW", 3),
        makeFunc("waveOutGetPosition", 3),
        makeFunc("waveOutPause", 1),
        makeFunc("waveOutRestart", 1),
        // Wave input functions
        makeFunc("waveInOpen", 6),
        makeFunc("waveInClose", 1),
        makeFunc("waveInPrepareHeader", 3),
        makeFunc("waveInUnprepareHeader", 3),
        makeFunc("waveInAddBuffer", 3),
        makeFunc("waveInStart", 1),
        makeFunc("waveInStop", 1),
        makeFunc("waveInReset", 1),
        makeFunc("waveInGetNumDevs", 0),
        makeFunc("waveInGetDevCapsA", 3),
        makeFunc("waveInGetDevCapsW", 3),
        // Auxiliary audio device functions
        makeFunc("auxGetNumDevs", 0),
        makeFunc("auxGetDevCapsA", 3),
        makeFunc("auxGetDevCapsW", 3),
        makeFunc("auxGetVolume", 2),
        makeFunc("auxSetVolume", 2),
        // Joystick functions
        makeFunc("joyGetNumDevs", 0),
        makeFunc("joyGetDevCapsA", 3),
        makeFunc("joyGetDevCapsW", 3),
        makeFunc("joyGetPos", 2),
        makeFunc("joyGetPosEx", 2),
        makeFunc("joyGetThreshold", 2),
        makeFunc("joySetThreshold", 2),
        makeFunc("joySetCapture", 4),
        makeFunc("joyReleaseCapture", 1),
        // MCI (Media Control Interface) functions
        makeFunc("mciGetDeviceIDA", 1),
        makeFunc("mciSendCommandA", 4),
        makeFunc("mciGetErrorStringA", 3),
        // Sound functions
        makeFunc("sndPlaySoundA", 2),
        makeFunc("PlaySoundA", 3),
        makeFunc("PlaySoundW", 3),
        // MMIO (Multimedia I/O) functions
        makeFunc("mmioOpenA", 3),
        makeFunc("mmioClose", 2),
        makeFunc("mmioRead", 3),
        makeFunc("mmioSeek", 3),
        makeFunc("mmioGetInfo", 3),
        makeFunc("mmioSetInfo", 3),
        makeFunc("mmioDescend", 4),
        makeFunc("mmioAscend", 3),
        makeFunc("mmioAdvance", 3),
        makeFunc("mmioStringToFOURCCA", 2),
        // Mixer functions
        makeFunc("mixerGetNumDevs", 0),
        makeFunc("mixerGetDevCapsA", 3),
        makeFunc("mixerOpen", 5),
        makeFunc("mixerClose", 1),
        makeFunc("mixerGetLineInfoA", 3),
        makeFunc("mixerGetControlDetailsA", 3),
        makeFunc("mixerSetControlDetails", 3),
        makeFunc("mixerGetID", 3),
        makeFunc("mixerGetLineControlsA", 3),

        // Auto-generated from reference signatures
        makeFunc("mciGetCreatorTask", 1),
        makeFunc("mciGetDeviceIDFromElementIDA", 2),
        makeFunc("mciGetDeviceIDFromElementIDW", 2),
        makeFunc("mciGetDeviceIDW", 1),
        makeFunc("mciGetYieldProc", 2),
        makeFunc("mciSendCommandW", 4),
        makeFunc("mciSetYieldProc", 3),
        makeFunc("midiConnect", 3),
        makeFunc("midiDisconnect", 3),
        makeFunc("midiInClose", 1),
        makeFunc("midiInGetID", 2),
        makeFunc("midiInGetNumDevs", 0),
        makeFunc("midiInGetDevCapsA", 3),
        makeFunc("midiOutGetDevCapsA", 3),   // uDeviceID, lpCaps, cbCaps
        // MIDI stream API — the Miles RSX/synth drivers (Mssrsx.m3d) link these.
        makeFunc("midiStreamOpen", 6),       // lphms, puDeviceID, cMidi, dwCallback, dwInstance, fdwOpen
        makeFunc("midiStreamOut", 3),        // hms, pmh, cbmh
        makeFunc("midiStreamPosition", 3),   // hms, lpmmt, cbmmt
        makeFunc("midiStreamProperty", 3),   // hms, lppropdata, dwProperty
        makeFunc("midiInMessage", 4),
        makeFunc("midiInOpen", 5),
        makeFunc("midiInReset", 1),
        makeFunc("midiInStart", 1),
        makeFunc("midiInStop", 1),
        makeFunc("midiOutClose", 1),
        makeFunc("midiOutGetID", 2),
        makeFunc("midiOutGetNumDevs", 0),
        makeFunc("midiOutGetVolume", 2),
        makeFunc("midiOutMessage", 4),
        makeFunc("midiOutOpen", 5),
        makeFunc("midiOutReset", 1),
        makeFunc("midiOutSetVolume", 2),
        makeFunc("midiOutShortMsg", 2),
        makeFunc("midiOutLongMsg", 3),
        makeFunc("midiOutPrepareHeader", 3),
        makeFunc("midiOutUnprepareHeader", 3),
        makeFunc("midiStreamClose", 1),
        makeFunc("midiStreamPause", 1),
        makeFunc("midiStreamRestart", 1),
        makeFunc("midiStreamStop", 1),
        makeFunc("waveInGetID", 2),
        makeFunc("waveInMessage", 4),
        makeFunc("waveOutBreakLoop", 1),
        makeFunc("waveOutGetDevCapsW", 3),
        makeFunc("waveOutGetPitch", 2),
        makeFunc("waveOutGetPlaybackRate", 2),
        makeFunc("waveOutMessage", 4),
        makeFunc("waveOutSetPitch", 2),
        makeFunc("waveOutSetPlaybackRate", 2),
    ]
};
