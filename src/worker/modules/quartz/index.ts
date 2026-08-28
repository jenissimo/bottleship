/**
 * Quartz (DirectShow) Module — minimal FilterGraph for AVI cutscene playback.
 *
 * Implements IGraphBuilder, IMediaControl, IMediaEvent, IVideoWindow, IBasicAudio
 * as a single FilterGraphObject with sub-object QI pattern.
 */

import { IModule } from "../../core/module";
import { Process } from "../../core/process";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { Mem } from "../../core/memory/mem-accessor";
import { createVTablesFromDescriptor, VTableInfo } from "../../api/adapters/module-adapter";
import { quartzModule } from "../../api/quartz.api";
import { InterfaceRegistry } from "../../core/com/interface-registry";
import { ComObjectFactory } from "../../core/com/base-com-object";
import { SystemResourceProvider } from "../../core/resources/system-resource-provider";
import { System } from "../../core/system";
import { EmulatorConfig } from "../../core/emulator-config-manager";
import { videoEngine } from "../../../video/video-engine";
import { BufferSource } from "@bottleship/formats/unpack/source";
import { probeAudio, type AudioContainer } from "@bottleship/formats/audio";
import { FilterGraphObject } from "./com-objects";
import {
    IID_IGraphBuilder,
    IID_IMediaControl,
    IID_IMediaPosition,
    IID_IMediaEvent,
    IID_IMediaEventEx,
    IID_IMediaSeeking,
    IID_IVideoWindow,
    IID_IBasicAudio,
    TIME_FORMAT_FRAME,
    TIME_FORMAT_MEDIA_TIME,
    AM_SEEKING_CanSeekAbsolute,
    AM_SEEKING_CanSeekForwards,
    AM_SEEKING_CanSeekBackwards,
    AM_SEEKING_CanGetCurrentPos,
    AM_SEEKING_CanGetStopPos,
    AM_SEEKING_CanGetDuration,
    AM_SEEKING_AbsolutePositioning,
    AM_SEEKING_PositioningBitsMask,
    REFTIME_UNITS_PER_SECOND,
    S_OK,
    S_FALSE,
    E_POINTER,
    E_NOINTERFACE,
    E_NOTIMPL,
    E_FAIL,
    E_ABORT,
    EC_COMPLETE,
    FilterState,
} from "./constants";

type DetectedAudio = {
    mimeType: string;
    sampleRate: number;
    duration: number;
};

export class Quartz implements IModule {
    name = "quartz";
    exports: Record<string, ThunkImplementation> = {};
    vtables: Record<string, VTableInfo> = {};
    private process!: Process;

    initialize(process: Process): void {
        this.process = process;

        // Register interfaces in the registry
        const interfaceRegistry = InterfaceRegistry.getInstance();
        interfaceRegistry.registerFromModuleDescriptor(quartzModule);

        // Create VTables for all interfaces
        this.vtables = createVTablesFromDescriptor(this.process, quartzModule);
        for (const [name, info] of Object.entries(this.vtables)) {
            Logger.verbose(LogCategory.COM, `[Quartz] Created vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
        }

        // Register FilterGraphObject in ComObjectFactory for IGraphBuilder
        ComObjectFactory.register(IID_IGraphBuilder, FilterGraphObject);

        // Register thunk exports
        this.registerGraphBuilderExports();
        this.registerMediaControlExports();
        this.registerMediaPositionExports();
        this.registerMediaEventExports();
        this.registerMediaEventExExports();
        this.registerMediaSeekingExports();
        this.registerVideoWindowExports();
        this.registerBasicAudioExports();
        this.registerBasicVideoExports();
    }

    reset(): void {
        // vtables will be recreated by recreateVTables()
    }

    recreateVTables(): void {
        if (this.process) {
            this.vtables = createVTablesFromDescriptor(this.process, quartzModule);
            for (const [name, info] of Object.entries(this.vtables)) {
                Logger.verbose(LogCategory.COM, `[Quartz] Recreated vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
            }
        }
    }

    private getFilterGraph(mem: Uint8Array, thisPtr: number): FilterGraphObject | null {
        const obj = SystemResourceProvider.getInstance().getComObjectByAddress(thisPtr);
        if (!obj || !(obj instanceof FilterGraphObject)) {
            Logger.warn(LogCategory.COM, `[Quartz] Invalid FilterGraph object at 0x${thisPtr.toString(16)}`);
            return null;
        }
        return obj;
    }

    private readWideString(mem: Uint8Array, addr: number): string {
        if (addr === 0) return "";
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        let out = "";
        let p = addr;
        while (p + 1 < mem.length) {
            const ch = view.getUint16(p, true);
            if (ch === 0) break;
            out += String.fromCharCode(ch);
            p += 2;
        }
        return out;
    }

    /** Read a complete file from VFS into a Uint8Array. */
    private async readVfsFile(path: string): Promise<Uint8Array | null> {
        try {
            const vfs = System.getInstance().fileSystem;
            const size = vfs.getFileSize(path);
            if (size <= 0) {
                Logger.warn(LogCategory.COM, `[Quartz] readVfsFile("${path}"): size=${size}`);
                return null;
            }
            const LIMIT_BYTES = 256 * 1024 * 1024;
            if (size > LIMIT_BYTES) {
                Logger.warn(LogCategory.COM, `[Quartz] readVfsFile("${path}"): size ${size} exceeds limit`);
                return null;
            }
            const GENERIC_READ = 0x80000000;
            const OPEN_EXISTING = 3;
            const handle = await vfs.open(path, GENERIC_READ, OPEN_EXISTING);
            if (!handle) {
                Logger.warn(LogCategory.COM, `[Quartz] readVfsFile("${path}"): open failed`);
                return null;
            }
            const data = await vfs.read(handle, size);
            return data;
        } catch (e) {
            Logger.error(LogCategory.COM, `[Quartz] readVfsFile("${path}") error: ${e}`);
            return null;
        }
    }

    private static readonly MIME_BY_CONTAINER: Record<AudioContainer, string> = {
        wav: "audio/wav",
        mp3: "audio/mpeg",
        ogg: "audio/ogg",
        flac: "audio/flac",
    };

    private isAudioPath(path: string): boolean {
        const ext = path.split("?")[0].split(".").pop()?.toLowerCase();
        return ext === "mp3" || ext === "ogg" || ext === "wav";
    }

    private detectAudio(fileBytes: Uint8Array, path: string): DetectedAudio | null {
        const probe = probeAudio(new BufferSource(fileBytes));
        if (probe) {
            return {
                mimeType: Quartz.MIME_BY_CONTAINER[probe.format],
                sampleRate: probe.sampleRate || 44100,
                duration: probe.durationMs / 1000,
            };
        }

        // Header unreadable: the extension still names the decoder to hand it to, and
        // DirectShow answers "duration unknown" (0) rather than refusing to build a graph.
        const ext = path.split("?")[0].split(".").pop()?.toLowerCase();
        if (ext === "mp3") return { mimeType: "audio/mpeg", sampleRate: 44100, duration: 0 };
        if (ext === "ogg") return { mimeType: "audio/ogg", sampleRate: 44100, duration: 0 };
        if (ext === "wav") return { mimeType: "audio/wav", sampleRate: 44100, duration: 0 };
        return null;
    }

    // ── IGraphBuilder methods ────────────────────────────────────────────────

    private registerGraphBuilderExports(): void {
        // IUnknown methods are handled by ole32 universal stubs via VTable

        // IFilterGraph methods — mostly stubs
        this.exports["IGraphBuilder_AddFilter"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IGraphBuilder_RemoveFilter"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IGraphBuilder_EnumFilters"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IGraphBuilder_FindFilterByName"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IGraphBuilder_ConnectDirect"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IGraphBuilder_Reconnect"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IGraphBuilder_Disconnect"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IGraphBuilder_SetDefaultSyncSource"] = (_ctx, _mem, _args) => S_OK;

        // IGraphBuilder methods
        this.exports["IGraphBuilder_Connect"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IGraphBuilder_Render"] = (_ctx, _mem, _args) => S_OK;

        // RenderFile — async: load video file and prepare for playback
        this.exports["IGraphBuilder_RenderFile"] = async (_ctx, mem, args) => {
            const thisPtr = args[0];
            const lpwstrFile = args[1];
            // args[2] = lpwstrPlayList (unused)

            const fg = this.getFilterGraph(mem, thisPtr);
            if (!fg) return E_FAIL;

            const filePath = this.readWideString(mem, lpwstrFile);
            Logger.log(LogCategory.COM, `[Quartz] IGraphBuilder::RenderFile("${filePath}")`);
            fg.resetForRender();

            if (filePath && EmulatorConfig.getInstance().skipVideo && !this.isAudioPath(filePath)) {
                Logger.log(LogCategory.COM, `[Quartz] RenderFile: skipVideo=true, completing "${filePath}"`);
                fg.engineHandle = 0;
                fg.markCompleted();
                return S_OK;
            }

            if (!filePath) {
                fg.markCompleted();
                return S_OK;
            }

            // Normalize path: Windows path → VFS path
            let vfsPath = filePath.replace(/\\/g, "/");
            // Strip drive letter if present (e.g., "C:/game/video.avi" → "/game/video.avi")
            if (/^[A-Za-z]:/.test(vfsPath)) {
                vfsPath = vfsPath.substring(2);
            }

            // Read file from VFS
            const fileBytes = await this.readVfsFile(vfsPath);
            if (!fileBytes) {
                Logger.warn(LogCategory.COM, `[Quartz] RenderFile: could not read "${vfsPath}" — skipping video`);
                fg.markCompleted();
                return S_OK;
            }

            const audio = this.detectAudio(fileBytes, vfsPath);
            if (audio) {
                fg.prepareAudio(fileBytes, audio.mimeType, audio.sampleRate, audio.duration);
                Logger.log(LogCategory.COM,
                    `[Quartz] RenderFile: prepared audio "${vfsPath}" mime=${audio.mimeType} ` +
                    `rate=${audio.sampleRate}Hz duration=${audio.duration.toFixed(2)}s`);
                return S_OK;
            }

            // Try to open with video engine
            try {
                await videoEngine.ensureLoaded();
                const handle = await videoEngine.open(fileBytes);
                const info = videoEngine.getInfo(handle);
                if (!info) {
                    videoEngine.close(handle);
                    throw new Error("getInfo returned null");
                }

                fg.prepareVideoSession(handle, info.width, info.height, info.fps, info.frameCount);

                Logger.log(LogCategory.COM,
                    `[Quartz] RenderFile: opened ${info.width}x${info.height} ` +
                    `fps=${info.fps.toFixed(1)} frames=${info.frameCount}`);
            } catch (e) {
                // Video format not supported (e.g., AVI) — gracefully skip
                Logger.warn(LogCategory.COM, `[Quartz] RenderFile: video engine failed for "${vfsPath}": ${e} — skipping`);
                fg.markCompleted();
            }

            return S_OK;
        };

        this.exports["IGraphBuilder_AddSourceFilter"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IGraphBuilder_SetLogFile"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IGraphBuilder_Abort"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IGraphBuilder_ShouldOperationContinue"] = (_ctx, _mem, _args) => S_OK;

        // IUnknown stubs (handled by VTable → ole32 universal handlers, but need export entries)
        this.exports["IGraphBuilder_QueryInterface"] = (_ctx, mem, args) => {
            const thisPtr = args[0];
            const fg = this.getFilterGraph(mem, thisPtr);
            if (!fg) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                if (args[2]) view.setUint32(args[2], 0, true);
                return 0x80004002;
            }
            const iidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) iidBytes[i] = mem[args[1] + i];
            const iidStr = this.bytesToGuid(iidBytes);
            return fg.queryInterface(iidStr, args[2], mem);
        };
        this.exports["IGraphBuilder_AddRef"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.addRef() : 0;
        };
        this.exports["IGraphBuilder_Release"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.release() : 0;
        };
    }

    // ── IMediaControl methods ────────────────────────────────────────────────

    private registerMediaControlExports(): void {
        // IUnknown (QI forwards to FilterGraphObject)
        this.exports["IMediaControl_QueryInterface"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                if (args[2]) view.setUint32(args[2], 0, true);
                return 0x80004002;
            }
            const iidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) iidBytes[i] = mem[args[1] + i];
            return fg.queryInterface(this.bytesToGuid(iidBytes), args[2], mem);
        };
        this.exports["IMediaControl_AddRef"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.addRef() : 0;
        };
        this.exports["IMediaControl_Release"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.release() : 0;
        };

        // IDispatch stubs
        this.exports["IMediaControl_GetTypeInfoCount"] = (_ctx, mem, args) => {
            if (args[1]) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(args[1], 0, true);
            }
            return S_OK;
        };
        this.exports["IMediaControl_GetTypeInfo"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IMediaControl_GetIDsOfNames"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IMediaControl_Invoke"] = (_ctx, _mem, _args) => E_NOTIMPL;

        // Run
        this.exports["IMediaControl_Run"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            Logger.log(LogCategory.COM, `[Quartz] IMediaControl::Run()`);
            fg.startPlayback();
            return S_OK;
        };

        // Pause
        this.exports["IMediaControl_Pause"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            Logger.log(LogCategory.COM, `[Quartz] IMediaControl::Pause()`);
            fg.pausePlayback();
            return S_OK;
        };

        // Stop
        this.exports["IMediaControl_Stop"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            Logger.log(LogCategory.COM, `[Quartz] IMediaControl::Stop()`);
            fg.stopPlayback();
            return S_OK;
        };

        // GetState
        this.exports["IMediaControl_GetState"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            // args[1] = msTimeout, args[2] = pfs (FILTER_STATE*)
            if (args[2]) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                // Map our internal state to OAFilterState enum: State_Stopped=0, State_Paused=1, State_Running=2
                let oaState = 0;
                if (fg.state === FilterState.RUNNING) oaState = 2;
                else if (fg.state === FilterState.PAUSED) oaState = 1;
                else if (fg.state === FilterState.COMPLETED) oaState = 0; // Stopped
                view.setUint32(args[2], oaState, true);
            }
            return S_OK;
        };

        // RenderFile (IMediaControl version — delegates)
        this.exports["IMediaControl_RenderFile"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IMediaControl_AddSourceFilter"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IMediaControl_get_FilterCollection"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IMediaControl_get_RegFilterCollection"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IMediaControl_StopWhenReady"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (fg) fg.stopPlayback();
            return S_OK;
        };
    }

    // ── IMediaEvent methods ──────────────────────────────────────────────────

    private registerMediaPositionExports(): void {
        this.exports["IMediaPosition_QueryInterface"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) {
                if (args[2]) Mem.writeUint32(args[2], 0);
                return E_NOINTERFACE;
            }
            const iidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) iidBytes[i] = mem[args[1] + i];
            return fg.queryInterface(this.bytesToGuid(iidBytes), args[2], mem);
        };
        this.exports["IMediaPosition_AddRef"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.addRef() : 0;
        };
        this.exports["IMediaPosition_Release"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.release() : 0;
        };

        this.exports["IMediaPosition_GetTypeInfoCount"] = (_ctx, _mem, args) => {
            if (args[1] && !Mem.writeUint32(args[1], 0)) return E_POINTER;
            return S_OK;
        };
        this.exports["IMediaPosition_GetTypeInfo"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IMediaPosition_GetIDsOfNames"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IMediaPosition_Invoke"] = (_ctx, _mem, _args) => E_NOTIMPL;

        this.exports["IMediaPosition_get_Duration"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            const duration = fg.audioBytes
                ? fg.audioDuration
                : (fg.videoFps > 0 ? fg.videoFrameCount / fg.videoFps : 0);
            return Mem.writeFloat64(args[1], duration) ? S_OK : E_POINTER;
        };
        this.exports["IMediaPosition_put_CurrentPosition"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            fg.seekAudio(this.readRefTimeArg(args, 1));
            return S_OK;
        };
        this.exports["IMediaPosition_get_CurrentPosition"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            const position = fg.getMediaPositionSeconds();
            return Mem.writeFloat64(args[1], position) ? S_OK : E_POINTER;
        };
        this.exports["IMediaPosition_get_StopTime"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeFloat64(args[1], fg.audioStopTime) ? S_OK : E_POINTER;
        };
        this.exports["IMediaPosition_put_StopTime"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            fg.audioStopTime = Math.max(0, this.readRefTimeArg(args, 1));
            return S_OK;
        };
        this.exports["IMediaPosition_get_PrerollTime"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeFloat64(args[1], fg.audioPrerollTime) ? S_OK : E_POINTER;
        };
        this.exports["IMediaPosition_put_PrerollTime"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            fg.audioPrerollTime = Math.max(0, this.readRefTimeArg(args, 1));
            return S_OK;
        };
        this.exports["IMediaPosition_put_Rate"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            fg.setAudioRate(this.readRefTimeArg(args, 1));
            return S_OK;
        };
        this.exports["IMediaPosition_get_Rate"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeFloat64(args[1], fg.audioRate) ? S_OK : E_POINTER;
        };
        this.exports["IMediaPosition_CanSeekForward"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeUint32(args[1], 0xFFFFFFFF) ? S_OK : E_POINTER;
        };
        this.exports["IMediaPosition_CanSeekBackward"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeUint32(args[1], 0xFFFFFFFF) ? S_OK : E_POINTER;
        };
    }

    private registerMediaEventExports(): void {
        // IUnknown
        this.exports["IMediaEvent_QueryInterface"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                if (args[2]) view.setUint32(args[2], 0, true);
                return 0x80004002;
            }
            const iidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) iidBytes[i] = mem[args[1] + i];
            return fg.queryInterface(this.bytesToGuid(iidBytes), args[2], mem);
        };
        this.exports["IMediaEvent_AddRef"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.addRef() : 0;
        };
        this.exports["IMediaEvent_Release"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.release() : 0;
        };

        // IDispatch stubs
        this.exports["IMediaEvent_GetTypeInfoCount"] = (_ctx, mem, args) => {
            if (args[1]) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(args[1], 0, true);
            }
            return S_OK;
        };
        this.exports["IMediaEvent_GetTypeInfo"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IMediaEvent_GetIDsOfNames"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IMediaEvent_Invoke"] = (_ctx, _mem, _args) => E_NOTIMPL;

        // GetEventHandle
        this.exports["IMediaEvent_GetEventHandle"] = (_ctx, _mem, _args) => E_NOTIMPL;

        // GetEvent — pops one queued event. An empty queue is E_ABORT (the documented
        // "timeout expired, no event"), NOT a failure to be retried: drain loops spin on
        // success and only break when the queue runs dry.
        this.exports["IMediaEvent_GetEvent"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            // args[1] = lEventCode, args[2] = lParam1, args[3] = lParam2, args[4] = msTimeout
            const ev = fg.dequeueEvent();
            if (!ev) return E_ABORT;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            if (args[1]) view.setInt32(args[1], ev.code, true);
            if (args[2]) view.setInt32(args[2], ev.param1, true);
            if (args[3]) view.setInt32(args[3], ev.param2, true);
            return S_OK;
        };

        // WaitForCompletion — async thunk
        this.exports["IMediaEvent_WaitForCompletion"] = async (_ctx, mem, args) => {
            const thisPtr = args[0];
            const msTimeout = args[1]; // LONG msTimeout
            const pEvCode = args[2];   // long* pEvCode

            const fg = this.getFilterGraph(mem, thisPtr);
            if (!fg) return E_FAIL;

            Logger.log(LogCategory.COM, `[Quartz] IMediaEvent::WaitForCompletion(timeout=${msTimeout})`);

            if (fg.state !== FilterState.COMPLETED) {
                // Wait for completion or timeout
                const timeout = (msTimeout === -1 || msTimeout === 0xFFFFFFFF) ? 0 : msTimeout;
                await fg.waitForCompletion(timeout);
            }

            // WaitForCompletion consumes the completion event — a later GetEvent drain
            // must not see it a second time.
            while (fg.dequeueEvent()) { /* drain */ }

            // Write event code
            if (pEvCode) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setInt32(pEvCode, EC_COMPLETE, true);
            }

            Logger.log(LogCategory.COM, `[Quartz] WaitForCompletion returned (state=${FilterState[fg.state]})`);
            return S_OK;
        };

        // CancelDefaultHandling / RestoreDefaultHandling / FreeEventParams
        this.exports["IMediaEvent_CancelDefaultHandling"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IMediaEvent_RestoreDefaultHandling"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IMediaEvent_FreeEventParams"] = (_ctx, _mem, _args) => S_OK;
    }

    // ── IMediaEventEx methods ────────────────────────────────────────────────

    private registerMediaEventExExports(): void {
        // IMediaEventEx inherits all of IMediaEvent, plus:
        this.exports["IMediaEventEx_QueryInterface"] = this.exports["IMediaEvent_QueryInterface"];
        this.exports["IMediaEventEx_AddRef"] = this.exports["IMediaEvent_AddRef"];
        this.exports["IMediaEventEx_Release"] = this.exports["IMediaEvent_Release"];
        this.exports["IMediaEventEx_GetTypeInfoCount"] = this.exports["IMediaEvent_GetTypeInfoCount"];
        this.exports["IMediaEventEx_GetTypeInfo"] = this.exports["IMediaEvent_GetTypeInfo"];
        this.exports["IMediaEventEx_GetIDsOfNames"] = this.exports["IMediaEvent_GetIDsOfNames"];
        this.exports["IMediaEventEx_Invoke"] = this.exports["IMediaEvent_Invoke"];
        this.exports["IMediaEventEx_GetEventHandle"] = this.exports["IMediaEvent_GetEventHandle"];
        this.exports["IMediaEventEx_GetEvent"] = this.exports["IMediaEvent_GetEvent"];
        this.exports["IMediaEventEx_WaitForCompletion"] = this.exports["IMediaEvent_WaitForCompletion"];
        this.exports["IMediaEventEx_CancelDefaultHandling"] = this.exports["IMediaEvent_CancelDefaultHandling"];
        this.exports["IMediaEventEx_RestoreDefaultHandling"] = this.exports["IMediaEvent_RestoreDefaultHandling"];
        this.exports["IMediaEventEx_FreeEventParams"] = this.exports["IMediaEvent_FreeEventParams"];

        // SetNotifyWindow(OAHWND hwnd, long lMsg, LONG_PTR lInstanceData) — register the
        // window that receives event notifications. If the graph is already completed
        // (skipVideo path), surface EC_COMPLETE right away, matching DirectShow's
        // "notify immediately when events are pending" behavior.
        this.exports["IMediaEventEx_SetNotifyWindow"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            fg.setNotifyWindow(args[1] >>> 0, args[2] >>> 0, args[3] | 0);
            return S_OK;
        };
        this.exports["IMediaEventEx_SetNotifyFlags"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IMediaEventEx_GetNotifyFlags"] = (_ctx, _mem, _args) => E_NOTIMPL;
    }

    // ── IMediaSeeking methods ────────────────────────────────────────────────
    //
    // Positions are LONGLONG in the *current* time format. The default (and what every
    // observed title uses for cutscene playback) is TIME_FORMAT_MEDIA_TIME = 100ns
    // REFERENCE_TIME units. We also accept TIME_FORMAT_FRAME for video (units = frame).
    // Everything is computed in seconds internally and converted at the boundary.

    private seekUnitsPerSecond(fg: FilterGraphObject): number {
        if (fg.seekTimeFormat === TIME_FORMAT_FRAME && fg.videoFps > 0) {
            return fg.videoFps;
        }
        return REFTIME_UNITS_PER_SECOND;
    }

    private registerMediaSeekingExports(): void {
        // IUnknown (QI forwards to FilterGraphObject)
        this.exports["IMediaSeeking_QueryInterface"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) {
                if (args[2]) Mem.writeUint32(args[2], 0);
                return E_NOINTERFACE;
            }
            const iidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) iidBytes[i] = mem[args[1] + i];
            return fg.queryInterface(this.bytesToGuid(iidBytes), args[2], mem);
        };
        this.exports["IMediaSeeking_AddRef"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.addRef() : 0;
        };
        this.exports["IMediaSeeking_Release"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.release() : 0;
        };

        // GetCapabilities / CheckCapabilities — advertise what we can actually do.
        const CAPS =
            AM_SEEKING_CanSeekAbsolute |
            AM_SEEKING_CanSeekForwards |
            AM_SEEKING_CanSeekBackwards |
            AM_SEEKING_CanGetCurrentPos |
            AM_SEEKING_CanGetStopPos |
            AM_SEEKING_CanGetDuration;

        this.exports["IMediaSeeking_GetCapabilities"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeUint32(args[1], CAPS >>> 0) ? S_OK : E_POINTER;
        };
        // CheckCapabilities: AND the requested mask with ours; S_OK if all present,
        // S_FALSE if a subset present, E_FAIL if none. Mutates *pCapabilities to the
        // intersection (per MSDN).
        this.exports["IMediaSeeking_CheckCapabilities"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            const requested = Mem.readUint32(args[1]) ?? 0;
            if (requested === 0) return E_FAIL;
            const granted = (requested & CAPS) >>> 0;
            Mem.writeUint32(args[1], granted);
            if (granted === requested) return S_OK;
            if (granted === 0) return E_FAIL;
            return S_FALSE;
        };

        // IsFormatSupported / QueryPreferredFormat / GetTimeFormat / IsUsingTimeFormat /
        // SetTimeFormat — we support MEDIA_TIME (preferred) and FRAME.
        this.exports["IMediaSeeking_IsFormatSupported"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            const fmt = this.readGuidAt(mem, args[1]);
            return (fmt === TIME_FORMAT_MEDIA_TIME || fmt === TIME_FORMAT_FRAME) ? S_OK : S_FALSE;
        };
        this.exports["IMediaSeeking_QueryPreferredFormat"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return this.writeGuidAt(mem, args[1], TIME_FORMAT_MEDIA_TIME) ? S_OK : E_POINTER;
        };
        this.exports["IMediaSeeking_GetTimeFormat"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return this.writeGuidAt(mem, args[1], fg.seekTimeFormat) ? S_OK : E_POINTER;
        };
        this.exports["IMediaSeeking_IsUsingTimeFormat"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return this.readGuidAt(mem, args[1]) === fg.seekTimeFormat ? S_OK : S_FALSE;
        };
        this.exports["IMediaSeeking_SetTimeFormat"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            const fmt = this.readGuidAt(mem, args[1]);
            if (fmt === TIME_FORMAT_MEDIA_TIME || (fmt === TIME_FORMAT_FRAME && fg.videoFps > 0)) {
                fg.seekTimeFormat = fmt;
                Logger.log(LogCategory.COM, `[Quartz] IMediaSeeking::SetTimeFormat(${fmt})`);
                return S_OK;
            }
            return E_NOTIMPL;
        };

        // GetDuration / GetStopPosition / GetCurrentPosition — LONGLONG out, in units.
        this.exports["IMediaSeeking_GetDuration"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            const units = fg.getMediaDurationSeconds() * this.seekUnitsPerSecond(fg);
            return this.writeInt64(args[1], units) ? S_OK : E_POINTER;
        };
        this.exports["IMediaSeeking_GetStopPosition"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            // Stop time defaults to duration; audio sessions track an explicit stop.
            const stopSec = fg.audioBytes && fg.audioStopTime > 0
                ? fg.audioStopTime
                : fg.getMediaDurationSeconds();
            return this.writeInt64(args[1], stopSec * this.seekUnitsPerSecond(fg)) ? S_OK : E_POINTER;
        };
        this.exports["IMediaSeeking_GetCurrentPosition"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            const units = fg.getMediaPositionSeconds() * this.seekUnitsPerSecond(fg);
            return this.writeInt64(args[1], units) ? S_OK : E_POINTER;
        };

        // ConvertTimeFormat — between MEDIA_TIME and FRAME (via fps). args:
        // [0]=this [1]=pTarget(LONGLONG*) [2]=pTargetFormat(GUID*|null) [3..4]=Source(LONGLONG)
        // [5]=pSourceFormat(GUID*|null). NULL format => the current time format.
        this.exports["IMediaSeeking_ConvertTimeFormat"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            const targetFmt = args[2] ? this.readGuidAt(mem, args[2]) : fg.seekTimeFormat;
            const sourceFmt = args[5] ? this.readGuidAt(mem, args[5]) : fg.seekTimeFormat;
            const source = this.readInt64Arg(args, 3);
            const fps = fg.videoFps > 0 ? fg.videoFps : 0;
            const toSeconds = (val: number, fmt: string): number | null => {
                if (fmt === TIME_FORMAT_MEDIA_TIME) return val / REFTIME_UNITS_PER_SECOND;
                if (fmt === TIME_FORMAT_FRAME) return fps > 0 ? val / fps : null;
                return null;
            };
            const fromSeconds = (sec: number, fmt: string): number | null => {
                if (fmt === TIME_FORMAT_MEDIA_TIME) return sec * REFTIME_UNITS_PER_SECOND;
                if (fmt === TIME_FORMAT_FRAME) return fps > 0 ? sec * fps : null;
                return null;
            };
            const seconds = toSeconds(source, sourceFmt);
            if (seconds === null) return E_NOTIMPL;
            const target = fromSeconds(seconds, targetFmt);
            if (target === null) return E_NOTIMPL;
            return this.writeInt64(args[1], target) ? S_OK : E_POINTER;
        };

        // SetPositions — seek. args: [0]=this [1]=pCurrent(LONGLONG*) [2]=dwCurrentFlags
        // [3]=pStop(LONGLONG*) [4]=dwStopFlags. We honour absolute current-position seeks.
        this.exports["IMediaSeeking_SetPositions"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            const pCurrent = args[1];
            const currentFlags = (args[2] >>> 0) & AM_SEEKING_PositioningBitsMask;
            const pStop = args[3];
            const stopFlags = (args[4] >>> 0) & AM_SEEKING_PositioningBitsMask;
            const perSec = this.seekUnitsPerSecond(fg);

            if (pCurrent && currentFlags === AM_SEEKING_AbsolutePositioning) {
                const seconds = this.readInt64(pCurrent) / perSec;
                fg.seekMediaSeconds(seconds);
                Logger.log(LogCategory.COM,
                    `[Quartz] IMediaSeeking::SetPositions current=${seconds.toFixed(3)}s`);
            }
            if (pStop && stopFlags === AM_SEEKING_AbsolutePositioning && fg.audioBytes) {
                fg.audioStopTime = Math.max(0, this.readInt64(pStop) / perSec);
            }
            return S_OK;
        };

        // GetPositions — current + stop in one call.
        this.exports["IMediaSeeking_GetPositions"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            const perSec = this.seekUnitsPerSecond(fg);
            if (args[1] && !this.writeInt64(args[1], fg.getMediaPositionSeconds() * perSec)) return E_POINTER;
            if (args[2]) {
                const stopSec = fg.audioBytes && fg.audioStopTime > 0
                    ? fg.audioStopTime
                    : fg.getMediaDurationSeconds();
                if (!this.writeInt64(args[2], stopSec * perSec)) return E_POINTER;
            }
            return S_OK;
        };

        // GetAvailable — the seekable range. We can seek the whole stream: [0, duration].
        this.exports["IMediaSeeking_GetAvailable"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            const perSec = this.seekUnitsPerSecond(fg);
            if (args[1] && !this.writeInt64(args[1], 0)) return E_POINTER;
            if (args[2] && !this.writeInt64(args[2], fg.getMediaDurationSeconds() * perSec)) return E_POINTER;
            return S_OK;
        };

        // SetRate / GetRate — playback rate (double by value / out).
        this.exports["IMediaSeeking_SetRate"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            fg.setAudioRate(this.readRefTimeArg(args, 1));
            return S_OK;
        };
        this.exports["IMediaSeeking_GetRate"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeFloat64(args[1], fg.audioRate) ? S_OK : E_POINTER;
        };

        // GetPreroll — REFERENCE_TIME preroll. We don't preroll → 0.
        this.exports["IMediaSeeking_GetPreroll"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return this.writeInt64(args[1], 0) ? S_OK : E_POINTER;
        };
    }

    // ── IVideoWindow methods ─────────────────────────────────────────────────

    private registerVideoWindowExports(): void {
        // IUnknown
        this.exports["IVideoWindow_QueryInterface"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                if (args[2]) view.setUint32(args[2], 0, true);
                return 0x80004002;
            }
            const iidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) iidBytes[i] = mem[args[1] + i];
            return fg.queryInterface(this.bytesToGuid(iidBytes), args[2], mem);
        };
        this.exports["IVideoWindow_AddRef"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.addRef() : 0;
        };
        this.exports["IVideoWindow_Release"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.release() : 0;
        };

        // IDispatch stubs
        this.exports["IVideoWindow_GetTypeInfoCount"] = (_ctx, mem, args) => {
            if (args[1]) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(args[1], 0, true);
            }
            return S_OK;
        };
        this.exports["IVideoWindow_GetTypeInfo"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IVideoWindow_GetIDsOfNames"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IVideoWindow_Invoke"] = (_ctx, _mem, _args) => E_NOTIMPL;

        this.exports["IVideoWindow_put_Owner"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            fg.videoOwnerHwnd = args[1] >>> 0;
            Logger.log(LogCategory.COM,
                `[Quartz] IVideoWindow::put_Owner(0x${fg.videoOwnerHwnd.toString(16)})`);
            return S_OK;
        };
        this.exports["IVideoWindow_get_Owner"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeUint32(args[1], fg.videoOwnerHwnd >>> 0) ? S_OK : E_POINTER;
        };

        // Remaining IVideoWindow property methods — stub to S_OK
        const vwStubs = [
            "put_Caption", "get_Caption", "put_WindowStyle", "get_WindowStyle",
            "put_WindowStyleEx", "get_WindowStyleEx", "put_AutoShow", "get_AutoShow",
            "put_WindowState", "get_WindowState", "put_BackgroundPalette", "get_BackgroundPalette",
            "put_Visible", "get_Visible", "put_Left", "get_Left",
            "put_Width", "get_Width", "put_Top", "get_Top",
            "put_Height", "get_Height",
            "put_MessageDrain", "get_MessageDrain", "get_BorderColor", "put_BorderColor",
            "get_FullScreenMode", "put_FullScreenMode", "SetWindowForeground",
            "NotifyOwnerMessage", "SetWindowPosition", "GetWindowPosition",
            "GetMinIdealImageSize", "GetMaxIdealImageSize", "GetRestorePosition",
            "HideCursor", "IsCursorHidden",
        ];
        for (const name of vwStubs) {
            this.exports[`IVideoWindow_${name}`] = (_ctx: any, _mem: any, _args: any) => S_OK;
        }
    }

    // ── IBasicAudio methods ──────────────────────────────────────────────────

    private registerBasicAudioExports(): void {
        // IUnknown
        this.exports["IBasicAudio_QueryInterface"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                if (args[2]) view.setUint32(args[2], 0, true);
                return 0x80004002;
            }
            const iidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) iidBytes[i] = mem[args[1] + i];
            return fg.queryInterface(this.bytesToGuid(iidBytes), args[2], mem);
        };
        this.exports["IBasicAudio_AddRef"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.addRef() : 0;
        };
        this.exports["IBasicAudio_Release"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.release() : 0;
        };

        // IDispatch stubs
        this.exports["IBasicAudio_GetTypeInfoCount"] = (_ctx, mem, args) => {
            if (args[1]) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(args[1], 0, true);
            }
            return S_OK;
        };
        this.exports["IBasicAudio_GetTypeInfo"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IBasicAudio_GetIDsOfNames"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IBasicAudio_Invoke"] = (_ctx, _mem, _args) => E_NOTIMPL;

        // Volume/Balance
        this.exports["IBasicAudio_put_Volume"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            fg.setAudioVolume(args[1] | 0);
            return S_OK;
        };
        this.exports["IBasicAudio_get_Volume"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeUint32(args[1], fg.audioVolume >>> 0) ? S_OK : E_POINTER;
        };
        this.exports["IBasicAudio_put_Balance"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            fg.setAudioBalance(args[1] | 0);
            return S_OK;
        };
        this.exports["IBasicAudio_get_Balance"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeUint32(args[1], fg.audioBalance >>> 0) ? S_OK : E_POINTER;
        };
    }

    // ── IBasicVideo methods ──────────────────────────────────────────────────
    // Ground-truthed against control.odl (see quartz.api.ts's IBasicVideo comment).
    // We only have one native video size (no independent source/destination cropping
    // rects in our renderer), so Source*/Destination* getters all report the full
    // native frame and the setters are faithful no-ops — matches "IsUsingDefaultSource/
    // Destination" always being true, since we never support anything else.

    private registerBasicVideoExports(): void {
        // IUnknown
        this.exports["IBasicVideo_QueryInterface"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                if (args[2]) view.setUint32(args[2], 0, true);
                return E_NOINTERFACE;
            }
            const iidBytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) iidBytes[i] = mem[args[1] + i];
            return fg.queryInterface(this.bytesToGuid(iidBytes), args[2], mem);
        };
        this.exports["IBasicVideo_AddRef"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.addRef() : 0;
        };
        this.exports["IBasicVideo_Release"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            return fg ? fg.release() : 0;
        };

        // IDispatch stubs
        this.exports["IBasicVideo_GetTypeInfoCount"] = (_ctx, mem, args) => {
            if (args[1]) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(args[1], 0, true);
            }
            return S_OK;
        };
        this.exports["IBasicVideo_GetTypeInfo"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IBasicVideo_GetIDsOfNames"] = (_ctx, _mem, _args) => E_NOTIMPL;
        this.exports["IBasicVideo_Invoke"] = (_ctx, _mem, _args) => E_NOTIMPL;

        // Rates
        this.exports["IBasicVideo_get_AvgTimePerFrame"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            const perFrameSeconds = fg.videoFps > 0 ? 1 / fg.videoFps : 0;
            return Mem.writeFloat64(args[1], perFrameSeconds) ? S_OK : E_POINTER;
        };
        this.exports["IBasicVideo_get_BitRate"] = (_ctx, mem, args) => {
            if (!args[1]) return E_POINTER;
            return Mem.writeUint32(args[1], 0) ? S_OK : E_POINTER;
        };
        this.exports["IBasicVideo_get_BitErrorRate"] = (_ctx, mem, args) => {
            if (!args[1]) return E_POINTER;
            return Mem.writeUint32(args[1], 0) ? S_OK : E_POINTER;
        };

        // Native video size
        this.exports["IBasicVideo_get_VideoWidth"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeUint32(args[1], fg.videoWidth >>> 0) ? S_OK : E_POINTER;
        };
        this.exports["IBasicVideo_get_VideoHeight"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeUint32(args[1], fg.videoHeight >>> 0) ? S_OK : E_POINTER;
        };
        this.exports["IBasicVideo_GetVideoSize"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1] || !args[2]) return E_POINTER;
            if (!Mem.writeUint32(args[1], fg.videoWidth >>> 0)) return E_POINTER;
            if (!Mem.writeUint32(args[2], fg.videoHeight >>> 0)) return E_POINTER;
            Logger.log(LogCategory.COM,
                `[Quartz] IBasicVideo::GetVideoSize -> ${fg.videoWidth}x${fg.videoHeight}`);
            return S_OK;
        };

        // Source/Destination rects — no independent cropping support; always report
        // (0, 0, videoWidth, videoHeight) and accept (but ignore) puts/sets.
        const zeroGetter = (_ctx: any, mem: Uint8Array, args: number[]) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeUint32(args[1], 0) ? S_OK : E_POINTER;
        };
        const widthGetter = (_ctx: any, mem: Uint8Array, args: number[]) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeUint32(args[1], fg.videoWidth >>> 0) ? S_OK : E_POINTER;
        };
        const heightGetter = (_ctx: any, mem: Uint8Array, args: number[]) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1]) return E_POINTER;
            return Mem.writeUint32(args[1], fg.videoHeight >>> 0) ? S_OK : E_POINTER;
        };
        const putNoop = (_ctx: any, _mem: any, _args: any) => S_OK;

        this.exports["IBasicVideo_get_SourceLeft"] = zeroGetter;
        this.exports["IBasicVideo_put_SourceLeft"] = putNoop;
        this.exports["IBasicVideo_get_SourceTop"] = zeroGetter;
        this.exports["IBasicVideo_put_SourceTop"] = putNoop;
        this.exports["IBasicVideo_get_SourceWidth"] = widthGetter;
        this.exports["IBasicVideo_put_SourceWidth"] = putNoop;
        this.exports["IBasicVideo_get_SourceHeight"] = heightGetter;
        this.exports["IBasicVideo_put_SourceHeight"] = putNoop;
        this.exports["IBasicVideo_get_DestinationLeft"] = zeroGetter;
        this.exports["IBasicVideo_put_DestinationLeft"] = putNoop;
        this.exports["IBasicVideo_get_DestinationTop"] = zeroGetter;
        this.exports["IBasicVideo_put_DestinationTop"] = putNoop;
        this.exports["IBasicVideo_get_DestinationWidth"] = widthGetter;
        this.exports["IBasicVideo_put_DestinationWidth"] = putNoop;
        this.exports["IBasicVideo_get_DestinationHeight"] = heightGetter;
        this.exports["IBasicVideo_put_DestinationHeight"] = putNoop;

        this.exports["IBasicVideo_SetSourcePosition"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IBasicVideo_GetSourcePosition"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1] || !args[2] || !args[3] || !args[4]) return E_POINTER;
            Mem.writeUint32(args[1], 0);
            Mem.writeUint32(args[2], 0);
            Mem.writeUint32(args[3], fg.videoWidth >>> 0);
            Mem.writeUint32(args[4], fg.videoHeight >>> 0);
            return S_OK;
        };
        this.exports["IBasicVideo_SetDefaultSourcePosition"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IBasicVideo_SetDestinationPosition"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IBasicVideo_GetDestinationPosition"] = (_ctx, mem, args) => {
            const fg = this.getFilterGraph(mem, args[0]);
            if (!fg) return E_FAIL;
            if (!args[1] || !args[2] || !args[3] || !args[4]) return E_POINTER;
            Mem.writeUint32(args[1], 0);
            Mem.writeUint32(args[2], 0);
            Mem.writeUint32(args[3], fg.videoWidth >>> 0);
            Mem.writeUint32(args[4], fg.videoHeight >>> 0);
            return S_OK;
        };
        this.exports["IBasicVideo_SetDefaultDestinationPosition"] = (_ctx, _mem, _args) => S_OK;

        // No palettized formats or snapshot support.
        this.exports["IBasicVideo_GetVideoPaletteEntries"] = (_ctx, mem, args) => {
            if (args[3]) Mem.writeUint32(args[3], 0);
            return E_NOTIMPL;
        };
        this.exports["IBasicVideo_GetCurrentImage"] = (_ctx, _mem, _args) => E_NOTIMPL;

        // We never support anything but the default (native) source/destination rects.
        this.exports["IBasicVideo_IsUsingDefaultSource"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IBasicVideo_IsUsingDefaultDestination"] = (_ctx, _mem, _args) => S_OK;
    }

    // ── Utility ──────────────────────────────────────────────────────────────

    handleAudioStarted(id: number): void {
        this.forEachFilterGraph(fg => fg.handleAudioStarted(id));
    }

    handleAudioEnded(id: number): void {
        this.forEachFilterGraph(fg => fg.handleAudioEnded(id));
    }

    handleAudioError(id: number, error: string): void {
        this.forEachFilterGraph(fg => fg.handleAudioError(id, error));
    }

    handleAudioPosition(id: number, positionFrames: number): void {
        this.forEachFilterGraph(fg => fg.handleAudioPosition(id, positionFrames));
    }

    private forEachFilterGraph(callback: (fg: FilterGraphObject) => void): void {
        for (const obj of SystemResourceProvider.getInstance().getAllComObjects()) {
            if (obj instanceof FilterGraphObject) {
                callback(obj);
            }
        }
    }

    private readRefTimeArg(args: number[], index: number): number {
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer);
        view.setUint32(0, args[index] >>> 0, true);
        view.setUint32(4, args[index + 1] >>> 0, true);
        return view.getFloat64(0, true);
    }

    /** Read a LONGLONG passed by value across two stack dwords (low, high). */
    private readInt64Arg(args: number[], index: number): number {
        const low = args[index] >>> 0;
        const high = args[index + 1] | 0; // signed high dword
        return high * 0x100000000 + low;
    }

    /** Read a 64-bit little-endian integer from guest memory as a JS number. */
    private readInt64(addr: number): number {
        const low = Mem.readUint32(addr) ?? 0;
        const high = Mem.readInt32(addr + 4) ?? 0; // signed high dword
        return high * 0x100000000 + low;
    }

    /** Write a JS number as a 64-bit little-endian integer (LONGLONG / REFERENCE_TIME). */
    private writeInt64(addr: number, value: number): boolean {
        const v = Math.round(value);
        const low = (v >>> 0);
        const high = Math.floor(v / 0x100000000) >>> 0;
        return Mem.writeUint32(addr, low) && Mem.writeUint32(addr + 4, high);
    }

    /** Read a 16-byte GUID from guest memory, normalized (lowercase, no braces). */
    private readGuidAt(mem: Uint8Array, addr: number): string {
        const bytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) bytes[i] = mem[addr + i];
        return this.bytesToGuid(bytes).replace(/[{}]/g, "");
    }

    /** Write a normalized GUID string (no braces) as 16 bytes into guest memory. */
    private writeGuidAt(mem: Uint8Array, addr: number, guid: string): boolean {
        const hex = guid.replace(/[{}-]/g, "");
        if (hex.length !== 32) return false;
        const b = new Uint8Array(16);
        for (let i = 0; i < 16; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
        // Data1 (LE u32), Data2 (LE u16), Data3 (LE u16), Data4 (8 bytes as-is).
        const out = new Uint8Array(16);
        out[0] = b[3]; out[1] = b[2]; out[2] = b[1]; out[3] = b[0];
        out[4] = b[5]; out[5] = b[4];
        out[6] = b[7]; out[7] = b[6];
        for (let i = 8; i < 16; i++) out[i] = b[i];
        return Mem.writeBytes(addr, out) === 16;
    }

    private bytesToGuid(bytes: Uint8Array): string {
        const data1 = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
        const data2 = (bytes[4] | (bytes[5] << 8)) >>> 0;
        const data3 = (bytes[6] | (bytes[7] << 8)) >>> 0;
        const data4 = Array.from(bytes.slice(8, 16))
            .map(b => b.toString(16).padStart(2, "0"))
            .join("");
        return `{${data1.toString(16).padStart(8, "0")}-${data2.toString(16).padStart(4, "0")}-${data3.toString(16).padStart(4, "0")}-${data4.slice(0, 4)}-${data4.slice(4)}}`;
    }
}
