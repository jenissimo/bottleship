/**
 * OpenAL (wrap_oal.dll) + ALUT (alut.dll) API Descriptors.
 *
 * All OpenAL functions use cdecl calling convention.
 * wrap_oal.dll is the OpenAL Soft wrapper shipped with many casual games.
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
    callingConvention: overrides.callingConvention ?? "cdecl",
});

export const openalModule: ModuleDescriptor = {
    name: "wrap_oal",
    functions: [
        // ── ALC (context) ────────────────────────────────────────────────
        makeFunc("alcOpenDevice", 1),          // const ALCchar *devicename → ALCdevice*
        makeFunc("alcCloseDevice", 1),         // ALCdevice* → ALCboolean
        makeFunc("alcCreateContext", 2),        // ALCdevice*, ALCint* attrlist → ALCcontext*
        makeFunc("alcDestroyContext", 1),       // ALCcontext*
        makeFunc("alcMakeContextCurrent", 1),   // ALCcontext* → ALCboolean
        makeFunc("alcGetCurrentContext", 0),    // → ALCcontext*
        makeFunc("alcGetContextsDevice", 1),    // ALCcontext* → ALCdevice*
        makeFunc("alcProcessContext", 1),       // ALCcontext*
        makeFunc("alcSuspendContext", 1),       // ALCcontext*
        makeFunc("alcGetError", 1),             // ALCdevice* → ALCenum
        makeFunc("alcGetString", 2),            // ALCdevice*, ALCenum → const ALCchar*
        makeFunc("alcGetIntegerv", 4),          // ALCdevice*, ALCenum, ALCsizei, ALCint*
        makeFunc("alcIsExtensionPresent", 2),   // ALCdevice*, const ALCchar* → ALCboolean
        makeFunc("alcGetProcAddress", 2),       // ALCdevice*, const ALCchar* → void*
        makeFunc("alcGetEnumValue", 2),         // ALCdevice*, const ALCchar* → ALCenum
        makeFunc("alcCaptureOpenDevice", 4),    // name, freq, format, bufsize → ALCdevice*
        makeFunc("alcCaptureCloseDevice", 1),
        makeFunc("alcCaptureStart", 1),
        makeFunc("alcCaptureStop", 1),
        makeFunc("alcCaptureSamples", 3),

        // ── AL (core) ────────────────────────────────────────────────────
        makeFunc("alGetError", 0),              // → ALenum
        makeFunc("alEnable", 1),
        makeFunc("alDisable", 1),
        makeFunc("alIsEnabled", 1),             // → ALboolean
        makeFunc("alGetString", 1),             // ALenum → const ALchar*
        makeFunc("alGetBoolean", 1),
        makeFunc("alGetBooleanv", 2),
        makeFunc("alGetInteger", 1),
        makeFunc("alGetIntegerv", 2),
        makeFunc("alGetFloat", 1),
        makeFunc("alGetFloatv", 2),
        makeFunc("alGetDouble", 1),
        makeFunc("alGetDoublev", 2),
        makeFunc("alGetEnumValue", 1),          // const ALchar* → ALenum
        makeFunc("alGetProcAddress", 1),        // const ALchar* → void*
        makeFunc("alIsExtensionPresent", 1),    // const ALchar* → ALboolean
        makeFunc("alDistanceModel", 1),
        makeFunc("alDopplerFactor", 1),
        makeFunc("alDopplerVelocity", 1),
        makeFunc("alSpeedOfSound", 1),

        // ── Listener ─────────────────────────────────────────────────────
        makeFunc("alListenerf", 2),
        makeFunc("alListener3f", 4),            // param, v1, v2, v3
        makeFunc("alListenerfv", 2),
        makeFunc("alListeneri", 2),
        makeFunc("alListener3i", 4),
        makeFunc("alListeneriv", 2),
        makeFunc("alGetListenerf", 2),
        makeFunc("alGetListener3f", 4),
        makeFunc("alGetListenerfv", 2),
        makeFunc("alGetListeneri", 2),
        makeFunc("alGetListeneriv", 2),
        makeFunc("alGetListener3i", 4),

        // ── Source ───────────────────────────────────────────────────────
        makeFunc("alGenSources", 2),            // ALsizei n, ALuint* sources
        makeFunc("alDeleteSources", 2),
        makeFunc("alIsSource", 1),              // → ALboolean
        makeFunc("alSourcef", 3),               // source, param, value
        makeFunc("alSource3f", 5),              // source, param, v1, v2, v3
        makeFunc("alSourcefv", 3),
        makeFunc("alSourcei", 3),
        makeFunc("alSource3i", 5),
        makeFunc("alSourceiv", 3),
        makeFunc("alGetSourcef", 3),
        makeFunc("alGetSource3f", 5),
        makeFunc("alGetSourcefv", 3),
        makeFunc("alGetSourcei", 3),
        makeFunc("alGetSource3i", 5),
        makeFunc("alGetSourceiv", 3),
        makeFunc("alSourcePlay", 1),
        makeFunc("alSourceStop", 1),
        makeFunc("alSourcePause", 1),
        makeFunc("alSourceRewind", 1),
        makeFunc("alSourcePlayv", 2),           // ALsizei n, ALuint* sources
        makeFunc("alSourceStopv", 2),
        makeFunc("alSourcePausev", 2),
        makeFunc("alSourceRewindv", 2),
        makeFunc("alSourceQueueBuffers", 3),    // source, nb, ALuint* buffers
        makeFunc("alSourceUnqueueBuffers", 3),  // source, nb, ALuint* buffers

        // ── Buffer ───────────────────────────────────────────────────────
        makeFunc("alGenBuffers", 2),            // ALsizei n, ALuint* buffers
        makeFunc("alDeleteBuffers", 2),
        makeFunc("alIsBuffer", 1),              // → ALboolean
        makeFunc("alBufferData", 5),            // buffer, format, data, size, freq
        makeFunc("alBufferf", 3),
        makeFunc("alBuffer3f", 5),
        makeFunc("alBufferfv", 3),
        makeFunc("alBufferi", 3),
        makeFunc("alBuffer3i", 5),
        makeFunc("alBufferiv", 3),
        makeFunc("alGetBufferf", 3),
        makeFunc("alGetBuffer3f", 5),
        makeFunc("alGetBufferfv", 3),
        makeFunc("alGetBufferi", 3),
        makeFunc("alGetBuffer3i", 5),
        makeFunc("alGetBufferiv", 3),

        // ── EAX ──────────────────────────────────────────────────────────
        makeFunc("EAXGet", 5),
        makeFunc("EAXSet", 5),
    ],
};

export const alutModule: ModuleDescriptor = {
    name: "alut",
    functions: [
        makeFunc("alutInit", 2),                    // int *argcp, char **argv → ALenum
        makeFunc("alutInitWithoutContext", 2),
        makeFunc("alutExit", 0),                    // → ALenum
        makeFunc("alutGetError", 0),                // → ALenum
        makeFunc("alutGetErrorString", 1),          // ALenum → const char*
        makeFunc("alutCreateBufferFromFile", 1),    // const char* fileName → ALuint
        makeFunc("alutCreateBufferFromFileImage", 2), // const ALvoid* data, ALsizei len → ALuint
        makeFunc("alutCreateBufferHelloWorld", 0),  // → ALuint
        makeFunc("alutCreateBufferWaveform", 4),    // ALenum, ALfloat, ALfloat, ALfloat → ALuint
        makeFunc("alutGetMajorVersion", 0),
        makeFunc("alutGetMinorVersion", 0),
        makeFunc("alutGetMIMETypes", 1),            // ALenum → const char*
        makeFunc("alutLoadWAVFile", 5),             // legacy: fname, format*, data*, size*, freq*
        makeFunc("alutLoadWAVMemory", 6),           // legacy: buffer, format*, data*, size*, freq*, loop*
        makeFunc("alutUnloadWAV", 4),               // legacy: format, data, size, freq
        makeFunc("alutLoadMemoryFromFile", 4),      // fname, format*, size*, freq* → ALvoid*
        makeFunc("alutLoadMemoryFromFileImage", 5), // data, len, format*, size*, freq* → ALvoid*
        makeFunc("alutLoadMemoryHelloWorld", 3),    // format*, size*, freq* → ALvoid*
        makeFunc("alutLoadMemoryWaveform", 6),      // waveshape, freq, phase, dur, format*, size* → ALvoid*
        makeFunc("alutSleep", 1),                   // ALfloat duration
    ],
};
