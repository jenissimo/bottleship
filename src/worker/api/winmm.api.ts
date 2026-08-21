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

export const winmmModule: ModuleDescriptor = {
    name: "winmm",
    functions: [
        makeFunc("timeGetTime", 0),
        makeFunc("DefDriverProc", 5),
        makeFunc("DrvDefDriverProc", 5),
        makeFunc("timeGetDevCaps", 2),
        makeFunc("timeBeginPeriod", 1, { onUnimplemented: "mmresult" }),
        makeFunc("timeEndPeriod", 1, { onUnimplemented: "mmresult" }),
        makeFunc("timeSetEvent", 5, { onUnimplemented: "mmresult" }),
        makeFunc("timeKillEvent", 1, { onUnimplemented: "mmresult" }),
        makeFunc("mciSendStringA", 4),
        makeFunc("mciSendStringW", 4),
        // Wave output functions
        makeFunc("waveOutOpen", 6, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutClose", 1, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutPrepareHeader", 3, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutUnprepareHeader", 3, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutWrite", 3, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutReset", 1, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutGetID", 2, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutSetVolume", 2, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutGetVolume", 2, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutGetNumDevs", 0),
        makeFunc("waveOutGetDevCapsA", 3, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutGetErrorTextA", 3),
        makeFunc("waveOutGetErrorTextW", 3),
        makeFunc("waveOutGetPosition", 3, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutPause", 1, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutRestart", 1, { onUnimplemented: "mmresult" }),
        // Wave input functions
        makeFunc("waveInOpen", 6, { onUnimplemented: "mmresult" }),
        makeFunc("waveInClose", 1, { onUnimplemented: "mmresult" }),
        makeFunc("waveInPrepareHeader", 3, { onUnimplemented: "mmresult" }),
        makeFunc("waveInUnprepareHeader", 3, { onUnimplemented: "mmresult" }),
        makeFunc("waveInAddBuffer", 3, { onUnimplemented: "mmresult" }),
        makeFunc("waveInStart", 1, { onUnimplemented: "mmresult" }),
        makeFunc("waveInStop", 1, { onUnimplemented: "mmresult" }),
        makeFunc("waveInReset", 1, { onUnimplemented: "mmresult" }),
        makeFunc("waveInGetNumDevs", 0),
        makeFunc("waveInGetDevCapsA", 3, { onUnimplemented: "mmresult" }),
        makeFunc("waveInGetDevCapsW", 3, { onUnimplemented: "mmresult" }),
        // Auxiliary audio device functions
        makeFunc("auxGetNumDevs", 0),
        makeFunc("auxGetDevCapsA", 3, { onUnimplemented: "mmresult" }),
        makeFunc("auxGetDevCapsW", 3, { onUnimplemented: "mmresult" }),
        makeFunc("auxGetVolume", 2, { onUnimplemented: "mmresult" }),
        makeFunc("auxSetVolume", 2, { onUnimplemented: "mmresult" }),
        // Joystick functions
        makeFunc("joyGetNumDevs", 0),
        makeFunc("joyGetDevCapsA", 3, { onUnimplemented: "mmresult" }),
        makeFunc("joyGetDevCapsW", 3, { onUnimplemented: "mmresult" }),
        makeFunc("joyGetPos", 2, { onUnimplemented: "mmresult" }),
        makeFunc("joyGetPosEx", 2, { onUnimplemented: "mmresult" }),
        makeFunc("joyGetThreshold", 2, { onUnimplemented: "mmresult" }),
        makeFunc("joySetThreshold", 2, { onUnimplemented: "mmresult" }),
        makeFunc("joySetCapture", 4, { onUnimplemented: "mmresult" }),
        makeFunc("joyReleaseCapture", 1, { onUnimplemented: "mmresult" }),
        // MCI (Media Control Interface) functions
        makeFunc("mciGetDeviceIDA", 1),
        makeFunc("mciSendCommandA", 4, { onUnimplemented: "mcierror" }),
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
        makeFunc("mixerGetDevCapsA", 3, { onUnimplemented: "mmresult" }),
        makeFunc("mixerOpen", 5, { onUnimplemented: "mmresult" }),
        makeFunc("mixerClose", 1, { onUnimplemented: "mmresult" }),
        makeFunc("mixerGetLineInfoA", 3, { onUnimplemented: "mmresult" }),
        makeFunc("mixerGetControlDetailsA", 3, { onUnimplemented: "mmresult" }),
        makeFunc("mixerSetControlDetails", 3, { onUnimplemented: "mmresult" }),
        makeFunc("mixerGetID", 3, { onUnimplemented: "mmresult" }),
        makeFunc("mixerGetLineControlsA", 3, { onUnimplemented: "mmresult" }),

        // Auto-generated from reference signatures
        makeFunc("mciGetCreatorTask", 1),
        makeFunc("mciGetDeviceIDFromElementIDA", 2),
        makeFunc("mciGetDeviceIDFromElementIDW", 2),
        makeFunc("mciGetDeviceIDW", 1),
        makeFunc("mciGetYieldProc", 2),
        makeFunc("mciSendCommandW", 4, { onUnimplemented: "mcierror" }),
        makeFunc("mciSetYieldProc", 3),
        makeFunc("midiConnect", 3, { onUnimplemented: "mmresult" }),
        makeFunc("midiDisconnect", 3, { onUnimplemented: "mmresult" }),
        makeFunc("midiInClose", 1, { onUnimplemented: "mmresult" }),
        makeFunc("midiInGetID", 2, { onUnimplemented: "mmresult" }),
        makeFunc("midiInGetNumDevs", 0),
        makeFunc("midiInGetDevCapsA", 3, { onUnimplemented: "mmresult" }),
        makeFunc("midiOutGetDevCapsA", 3, { onUnimplemented: "mmresult" }),   // uDeviceID, lpCaps, cbCaps
        // MIDI stream API — the Miles RSX/synth drivers (Mssrsx.m3d) link these.
        makeFunc("midiStreamOpen", 6, { onUnimplemented: "mmresult" }),       // lphms, puDeviceID, cMidi, dwCallback, dwInstance, fdwOpen
        makeFunc("midiStreamOut", 3, { onUnimplemented: "mmresult" }),        // hms, pmh, cbmh
        makeFunc("midiStreamPosition", 3, { onUnimplemented: "mmresult" }),   // hms, lpmmt, cbmmt
        makeFunc("midiStreamProperty", 3, { onUnimplemented: "mmresult" }),   // hms, lppropdata, dwProperty
        makeFunc("midiInAddBuffer", 3, { onUnimplemented: "mmresult" }),      // hmi, pmh, cbmh
        makeFunc("midiInPrepareHeader", 3, { onUnimplemented: "mmresult" }),  // hmi, pmh, cbmh
        makeFunc("midiInUnprepareHeader", 3, { onUnimplemented: "mmresult" }),// hmi, pmh, cbmh
        makeFunc("midiInMessage", 4, { onUnimplemented: "mmresult" }),
        makeFunc("midiInOpen", 5, { onUnimplemented: "mmresult" }),
        makeFunc("midiInReset", 1, { onUnimplemented: "mmresult" }),
        makeFunc("midiInStart", 1, { onUnimplemented: "mmresult" }),
        makeFunc("midiInStop", 1, { onUnimplemented: "mmresult" }),
        makeFunc("midiOutClose", 1, { onUnimplemented: "mmresult" }),
        makeFunc("midiOutGetID", 2, { onUnimplemented: "mmresult" }),
        makeFunc("midiOutGetNumDevs", 0),
        makeFunc("midiOutGetVolume", 2, { onUnimplemented: "mmresult" }),
        makeFunc("midiOutMessage", 4, { onUnimplemented: "mmresult" }),
        makeFunc("midiOutOpen", 5, { onUnimplemented: "mmresult" }),
        makeFunc("midiOutReset", 1, { onUnimplemented: "mmresult" }),
        makeFunc("midiOutSetVolume", 2, { onUnimplemented: "mmresult" }),
        makeFunc("midiOutShortMsg", 2, { onUnimplemented: "mmresult" }),
        makeFunc("midiOutLongMsg", 3, { onUnimplemented: "mmresult" }),
        makeFunc("midiOutPrepareHeader", 3, { onUnimplemented: "mmresult" }),
        makeFunc("midiOutUnprepareHeader", 3, { onUnimplemented: "mmresult" }),
        makeFunc("midiStreamClose", 1, { onUnimplemented: "mmresult" }),
        makeFunc("midiStreamPause", 1, { onUnimplemented: "mmresult" }),
        makeFunc("midiStreamRestart", 1, { onUnimplemented: "mmresult" }),
        makeFunc("midiStreamStop", 1, { onUnimplemented: "mmresult" }),
        makeFunc("waveInGetID", 2, { onUnimplemented: "mmresult" }),
        makeFunc("waveInMessage", 4, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutBreakLoop", 1, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutGetDevCapsW", 3, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutGetPitch", 2, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutGetPlaybackRate", 2, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutMessage", 4, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutSetPitch", 2, { onUnimplemented: "mmresult" }),
        makeFunc("waveOutSetPlaybackRate", 2, { onUnimplemented: "mmresult" }),
    ]
};
