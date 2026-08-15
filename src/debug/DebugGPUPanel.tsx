import React, { useEffect, useRef, useState } from "react";

type FrameDebugSnapshot = {
    frameId: number;
    drawCalls: number;
    presents: number;
    lfbLocks?: number;
    lfbUnlocks?: number;
    lfbReads?: number;
    lfbWrites?: number;
    texDownloads?: number;
    lastPresent?: {
        surfaceAddr: number;
        width: number;
        height: number;
        format: string;
        timestamp: number;
    };
    lastDraw?: {
        api: "ddraw" | "d3d8" | "d3d9";
        textureHandle?: number;
        surfaceAddr?: number;
        numVerts?: number;
        numIndices?: number;
        fvf?: number;
        stride?: number;
        topology?: string;
        primitiveType?: number;
        alphaBlend?: boolean;
        alphaTest?: boolean;
        zEnable?: boolean;
        zWrite?: boolean;
        timestamp: number;
    };
    frameCounters?: {
        textureBinds: number;
        uploads: number;
        clears: number;
        cacheHits: number;
        cacheMisses: number;
        waitTimeMs: number;
        vertexBytes: number;
        textureBytes: number;
    };
};

type DDrawSurfaceDebugInfo = {
    address: number;
    handle: number;
    width: number;
    height: number;
    pitch: number;
    format: {
        flags: number;
        bpp: number;
        rMask: number;
        gMask: number;
        bMask: number;
        aMask: number;
    };
    caps: number;
    caps2?: number;
    surfacePtr: number;
    attachedSurfaceAddr: number;
    authority: "cpu" | "gpu" | "none";
    version: number;
    cpuVersion: number;
    gpuVersion: number;
    cpuValid: boolean;
    gpuValid: boolean;
    hasGpuTexture: boolean;
    activeLeaseId?: number;
    vidMemSize?: number;
    srcColorKey?: { low: number; high: number };
    destColorKey?: { low: number; high: number };
    refCount: number;
    role?: "primary" | "backbuffer" | "z" | "texture" | "offscreen";
    lastUsedFrame?: number;
    lastUploadFrame?: number;
    attachedTo?: number[];
    isPrimaryChain?: boolean;
};

type DebugGPUPanelProps = {
    isOpen: boolean;
    onClose: () => void;
    worker: Worker | null;
};

type TabType = "ddraw" | "d3d8" | "d3d9" | "glide" | "webgpu";

// D3D8 and D3D9 devices expose the same debug shape (getDebugResourcesInfo/getFrameSnapshot).
type DxResourcesData = {
    resources: {
        textures: Array<{
            handle: number;
            width: number;
            height: number;
            levels: number;
            format: number;
            isDirty: boolean;
            isLocked: boolean;
            hasGpuTexture: boolean;
        }>;
        vertexBuffers: Array<{
            handle: number;
            size: number;
            fvf: number;
            isDirty: boolean;
            isLocked: boolean;
            hasGpuBuffer: boolean;
        }>;
        indexBuffers: Array<{
            handle: number;
            size: number;
            format: number;
            isDirty: boolean;
            isLocked: boolean;
            hasGpuBuffer: boolean;
        }>;
        pipelineCacheSize: number;
    };
    frameSnapshot: FrameDebugSnapshot;
};

/** Worker presenter kind → panel tab (gdi/opengl have no tab yet). */
const backendToTab: Record<string, TabType | undefined> = {
    ddraw: "ddraw",
    d3d8: "d3d8",
    d3d9: "d3d9",
    glide: "glide",
};

/** Frame-snapshot block shared by the DirectX8 and DirectX9 tabs. */
function DxFrameSnapshot({ snap }: { snap: FrameDebugSnapshot }) {
    return (
        <>
            <div>Frame ID: {snap.frameId}</div>
            <div>Draw Calls: {snap.drawCalls}</div>
            <div>Presents: {snap.presents}</div>
            {snap.frameCounters && (
                <div style={{ marginTop: 4, padding: "4px 8px", backgroundColor: "#252540", borderRadius: 4 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
                        <span>Binds: {snap.frameCounters.textureBinds}</span>
                        <span>Uploads: {snap.frameCounters.uploads}</span>
                        <span>Clears: {snap.frameCounters.clears}</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginTop: 4 }}>
                        <span>Wait: {snap.frameCounters.waitTimeMs.toFixed(1)}ms</span>
                        <span>VB: {(snap.frameCounters.vertexBytes / 1024).toFixed(1)}KB</span>
                        <span>Tex: {(snap.frameCounters.textureBytes / 1024 / 1024).toFixed(2)}MB</span>
                    </div>
                </div>
            )}
            {snap.lastPresent && (
                <div style={{ marginTop: 4, paddingLeft: 10, borderLeft: "2px solid #4CAF50" }}>
                    <div style={{ fontWeight: "bold" }}>Last Present:</div>
                    {snap.lastPresent.width > 0 && (
                        <div>Size: {snap.lastPresent.width}x{snap.lastPresent.height} ({snap.lastPresent.format})</div>
                    )}
                    <div>Time: {new Date(snap.lastPresent.timestamp).toLocaleTimeString()}</div>
                </div>
            )}
            {snap.lastDraw && (
                <div style={{ marginTop: 4, paddingLeft: 10, borderLeft: "2px solid #2196F3" }}>
                    <div style={{ fontWeight: "bold" }}>Last Draw:</div>
                    <div>API: {snap.lastDraw.api}</div>
                    <div>Primitive Type: {snap.lastDraw.primitiveType ?? "N/A"}</div>
                    <div>Verts: {snap.lastDraw.numVerts ?? "N/A"}</div>
                    {snap.lastDraw.numIndices && (
                        <div>Indices: {snap.lastDraw.numIndices}</div>
                    )}
                </div>
            )}
        </>
    );
}

/** Textures / VB / IB / pipeline-cache tables shared by the DirectX8 and DirectX9 tabs. */
function DxResourceTables({ data, apiLabel }: { data: DxResourcesData | null; apiLabel: string }) {
    if (!data) {
        return (
            <div style={{ padding: 20, textAlign: "center", color: "#888" }}>
                No {apiLabel} data available
            </div>
        );
    }
    return (
        <>
            <div style={{ marginBottom: 10, fontWeight: "bold", color: "#888" }}>
                Textures ({data.resources.textures.length})
            </div>
            {data.resources.textures.length > 0 ? (
                <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 20 }}>
                    <thead>
                        <tr style={{ textAlign: "left", color: "#888", borderBottom: "1px solid #333" }}>
                            <th style={{ padding: "4px 8px" }}>Handle</th>
                            <th style={{ padding: "4px 8px" }}>Size</th>
                            <th style={{ padding: "4px 8px" }}>Format</th>
                            <th style={{ padding: "4px 8px" }}>Levels</th>
                            <th style={{ padding: "4px 8px" }}>Dirty</th>
                            <th style={{ padding: "4px 8px" }}>Locked</th>
                            <th style={{ padding: "4px 8px" }}>GPU</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.resources.textures.map((tex) => (
                            <tr key={tex.handle} style={{ borderBottom: "1px solid #222" }}>
                                <td style={{ padding: "6px 8px", color: "#8888ff" }}>
                                    0x{tex.handle.toString(16)}
                                </td>
                                <td style={{ padding: "6px 8px" }}>
                                    {tex.width}x{tex.height}
                                </td>
                                <td style={{ padding: "6px 8px" }}>
                                    0x{tex.format.toString(16)}
                                </td>
                                <td style={{ padding: "6px 8px" }}>
                                    {tex.levels}
                                </td>
                                <td style={{ padding: "6px 8px", color: tex.isDirty ? "#FF9800" : "#888" }}>
                                    {tex.isDirty ? "✓" : "—"}
                                </td>
                                <td style={{ padding: "6px 8px", color: tex.isLocked ? "#FF9800" : "#888" }}>
                                    {tex.isLocked ? "✓" : "—"}
                                </td>
                                <td style={{ padding: "6px 8px", color: tex.hasGpuTexture ? "#4CAF50" : "#f44336" }}>
                                    {tex.hasGpuTexture ? "✓" : "✗"}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : (
                <div style={{ padding: 20, textAlign: "center", color: "#888" }}>No textures</div>
            )}

            <div style={{ marginBottom: 10, fontWeight: "bold", color: "#888" }}>
                Vertex Buffers ({data.resources.vertexBuffers.length})
            </div>
            {data.resources.vertexBuffers.length > 0 ? (
                <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 20 }}>
                    <thead>
                        <tr style={{ textAlign: "left", color: "#888", borderBottom: "1px solid #333" }}>
                            <th style={{ padding: "4px 8px" }}>Handle</th>
                            <th style={{ padding: "4px 8px" }}>Size</th>
                            <th style={{ padding: "4px 8px" }}>FVF</th>
                            <th style={{ padding: "4px 8px" }}>Dirty</th>
                            <th style={{ padding: "4px 8px" }}>Locked</th>
                            <th style={{ padding: "4px 8px" }}>GPU</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.resources.vertexBuffers.map((vb) => (
                            <tr key={vb.handle} style={{ borderBottom: "1px solid #222" }}>
                                <td style={{ padding: "6px 8px", color: "#8888ff" }}>
                                    0x{vb.handle.toString(16)}
                                </td>
                                <td style={{ padding: "6px 8px" }}>
                                    {(vb.size / 1024).toFixed(2)} KB
                                </td>
                                <td style={{ padding: "6px 8px" }}>
                                    0x{vb.fvf.toString(16)}
                                </td>
                                <td style={{ padding: "6px 8px", color: vb.isDirty ? "#FF9800" : "#888" }}>
                                    {vb.isDirty ? "✓" : "—"}
                                </td>
                                <td style={{ padding: "6px 8px", color: vb.isLocked ? "#FF9800" : "#888" }}>
                                    {vb.isLocked ? "✓" : "—"}
                                </td>
                                <td style={{ padding: "6px 8px", color: vb.hasGpuBuffer ? "#4CAF50" : "#f44336" }}>
                                    {vb.hasGpuBuffer ? "✓" : "✗"}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : (
                <div style={{ padding: 20, textAlign: "center", color: "#888" }}>No vertex buffers</div>
            )}

            <div style={{ marginBottom: 10, fontWeight: "bold", color: "#888" }}>
                Index Buffers ({data.resources.indexBuffers.length})
            </div>
            {data.resources.indexBuffers.length > 0 ? (
                <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 20 }}>
                    <thead>
                        <tr style={{ textAlign: "left", color: "#888", borderBottom: "1px solid #333" }}>
                            <th style={{ padding: "4px 8px" }}>Handle</th>
                            <th style={{ padding: "4px 8px" }}>Size</th>
                            <th style={{ padding: "4px 8px" }}>Format</th>
                            <th style={{ padding: "4px 8px" }}>Dirty</th>
                            <th style={{ padding: "4px 8px" }}>Locked</th>
                            <th style={{ padding: "4px 8px" }}>GPU</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.resources.indexBuffers.map((ib) => (
                            <tr key={ib.handle} style={{ borderBottom: "1px solid #222" }}>
                                <td style={{ padding: "6px 8px", color: "#8888ff" }}>
                                    0x{ib.handle.toString(16)}
                                </td>
                                <td style={{ padding: "6px 8px" }}>
                                    {(ib.size / 1024).toFixed(2)} KB
                                </td>
                                <td style={{ padding: "6px 8px" }}>
                                    {ib.format === 101 ? "16-bit" : "32-bit"}
                                </td>
                                <td style={{ padding: "6px 8px", color: ib.isDirty ? "#FF9800" : "#888" }}>
                                    {ib.isDirty ? "✓" : "—"}
                                </td>
                                <td style={{ padding: "6px 8px", color: ib.isLocked ? "#FF9800" : "#888" }}>
                                    {ib.isLocked ? "✓" : "—"}
                                </td>
                                <td style={{ padding: "6px 8px", color: ib.hasGpuBuffer ? "#4CAF50" : "#f44336" }}>
                                    {ib.hasGpuBuffer ? "✓" : "✗"}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : (
                <div style={{ padding: 20, textAlign: "center", color: "#888" }}>No index buffers</div>
            )}

            <div style={{ marginTop: 20, padding: 10, backgroundColor: "#1a2a3a", borderRadius: 4 }}>
                <div style={{ fontWeight: "bold", marginBottom: 8, color: "#4CAF50" }}>Pipeline Cache</div>
                <div style={{ fontSize: 11 }}>
                    Size: {data.resources.pipelineCacheSize} pipelines
                </div>
            </div>
        </>
    );
}

export default function DebugGPUPanel({ isOpen, onClose, worker }: DebugGPUPanelProps) {
    const [activeTab, setActiveTab] = useState<TabType>("ddraw");
    const [autoRefresh, setAutoRefresh] = useState(false);
    const [ddrawData, setDdrawData] = useState<{
        surfaces: DDrawSurfaceDebugInfo[];
        frameSnapshot: FrameDebugSnapshot;
    } | null>(null);
    const [d3d8Data, setD3d8Data] = useState<DxResourcesData | null>(null);
    const [d3d9Data, setD3d9Data] = useState<DxResourcesData | null>(null);
    const [activeBackend, setActiveBackend] = useState<string | null>(null);
    // Once the user picks a tab by hand, stop following the active backend.
    const userPinnedTab = useRef(false);
    const [webgpuData, setWebgpuData] = useState<{
        overlayTexture?: {
            width: number;
            height: number;
            format: string;
        };
        deviceInfo: {
            format: string;
            hasDevice: boolean;
            hasQueue: boolean;
            hasContext: boolean;
        };
    } | null>(null);
    const [glideData, setGlideData] = useState<{
        resources: {
            state: {
                initialized: boolean;
                winOpen: boolean;
                width: number;
                height: number;
                renderBuffer: number;
                selectedSst: number;
                colorFormat: number;
                origin: number;
            };
            textures: Array<{
                handle: number;
                tmu: number;
                width: number;
                height: number;
                format: number;
                startAddress: number;
                bytes: number;
            }>;
            lfbSurfaces: Array<{
                buffer: number;
                address: number;
                width: number;
                height: number;
                pitch: number;
                bytesPerPixel: number;
                writeMode: number;
                dirty: boolean;
                activeLeaseId: number;
            }>;
            ringEvents: Array<{
                id: number;
                type: string;
                timestamp: number;
                detail?: string;
            }>;
            pipelineCache?: {
                hits: number;
                misses: number;
                size: number;
            };
            executorMetrics?: Record<string, number>;
        };
        frameSnapshot: FrameDebugSnapshot;
    } | null>(null);
    const [selectedSurface, setSelectedSurface] = useState<number | null>(null);
    const [surfacePreview, setSurfacePreview] = useState<{ data: string; width: number; height: number } | null>(null);
    const [lastUpdate, setLastUpdate] = useState(0);

    useEffect(() => {
        if (!worker || !isOpen) return;

        const handler = (event: MessageEvent) => {
            const { type, ok, data } = event.data;

            if (type === "gpu_debug_query" && ok) {
                if (data.ddraw) {
                    setDdrawData(data.ddraw);
                }
                if (data.d3d8) {
                    setD3d8Data(data.d3d8);
                }
                if (data.d3d9) {
                    setD3d9Data(data.d3d9);
                }
                if (data.glide) {
                    setGlideData(data.glide);
                }
                if (data.webgpu) {
                    setWebgpuData(data.webgpu);
                }
                if (data.activeBackend !== undefined) {
                    setActiveBackend(data.activeBackend);
                    const tab = data.activeBackend ? backendToTab[data.activeBackend] : undefined;
                    if (tab && !userPinnedTab.current) {
                        setActiveTab(tab);
                    }
                }
                setLastUpdate(Date.now());
            } else if (type === "gpu_debug_surface_preview" && ok) {
                setSurfacePreview(data);
            }
        };

        worker.addEventListener("message", handler);

        // Initial query for all APIs
        worker.postMessage({
            type: "gpu_debug_query",
            api: "all",
            scope: "summary",
            onlyActive: false,
        });

        // Auto-refresh interval (250-500ms)
        let intervalId: number | null = null;
        if (autoRefresh) {
            intervalId = window.setInterval(() => {
                worker.postMessage({
                    type: "gpu_debug_query",
                    api: "all",
                    scope: "summary",
                    onlyActive: false,
                });
            }, 400); // 400ms = middle of 250-500ms range
        }

        return () => {
            worker.removeEventListener("message", handler);
            if (intervalId !== null) {
                clearInterval(intervalId);
            }
        };
    }, [worker, isOpen, autoRefresh, activeTab]);

    const handleRefresh = () => {
        if (!worker) return;
        worker.postMessage({
            type: "gpu_debug_query",
            api: "all",
            scope: "summary",
            onlyActive: false,
        });
    };

    const handleExportBundle = () => {
        if (!worker) return;
        worker.postMessage({
            type: "gpu_debug_query",
            api: "all",
            scope: "full",
            onlyActive: false,
        });
    };

    const handleSurfaceClick = (address: number) => {
        setSelectedSurface(selectedSurface === address ? null : address);
        if (selectedSurface !== address && worker) {
            // Request preview
            worker.postMessage({
                type: "gpu_debug_surface_preview",
                surfaceAddr: address,
                maxSize: 512,
            });
        }
    };

    const formatCaps = (caps: number): string => {
        const flags: string[] = [];
        if (caps & 0x200) flags.push("PRIMARY");
        if (caps & 0x4) flags.push("BACKBUFFER");
        if (caps & 0x1000) flags.push("TEXTURE");
        if (caps & 0x800) flags.push("SYSMEM");
        if (caps & 0x4000) flags.push("VIDMEM");
        if (caps & 0x20000) flags.push("ZBUFFER");
        return flags.length > 0 ? flags.join("|") : `0x${caps.toString(16)}`;
    };

    if (!isOpen) return null;

    return (
        <div style={{
            position: "fixed",
            top: 10,
            right: 10,
            width: 800,
            maxHeight: "90vh",
            backgroundColor: "#1a1a2e",
            border: "1px solid #4a4a6a",
            borderRadius: 8,
            boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
            zIndex: 10002,
            fontFamily: "monospace",
            fontSize: 12,
            color: "#e0e0e0",
            display: "flex",
            flexDirection: "column",
        }}>
            {/* Header */}
            <div style={{
                padding: "10px 15px",
                borderBottom: "1px solid #4a4a6a",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                backgroundColor: "#252540",
            }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontWeight: "bold", fontSize: 14 }}>Debug GPU Panel</span>
                    <span style={{
                        padding: "2px 8px",
                        borderRadius: 10,
                        fontSize: 11,
                        backgroundColor: activeBackend ? "#1b3a26" : "#333",
                        border: `1px solid ${activeBackend ? "#4CAF50" : "#555"}`,
                        color: activeBackend ? "#4CAF50" : "#888",
                    }}>
                        {activeBackend ? `Active: ${activeBackend}` : "Active: —"}
                    </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                    <button
                        onClick={() => setAutoRefresh(!autoRefresh)}
                        style={{
                            padding: "4px 8px",
                            backgroundColor: autoRefresh ? "#4CAF50" : "#555",
                            border: "none",
                            borderRadius: 4,
                            color: "white",
                            cursor: "pointer",
                        }}
                    >
                        {autoRefresh ? "Auto ON" : "Auto OFF"}
                    </button>
                    <button
                        onClick={handleRefresh}
                        style={{
                            padding: "4px 8px",
                            backgroundColor: "#2196F3",
                            border: "none",
                            borderRadius: 4,
                            color: "white",
                            cursor: "pointer",
                        }}
                    >
                        Refresh
                    </button>
                    <button
                        onClick={handleExportBundle}
                        style={{
                            padding: "4px 8px",
                            backgroundColor: "#FF9800",
                            border: "none",
                            borderRadius: 4,
                            color: "white",
                            cursor: "pointer",
                        }}
                    >
                        Export Bundle
                    </button>
                    <button
                        onClick={onClose}
                        style={{
                            padding: "4px 8px",
                            backgroundColor: "#333",
                            border: "none",
                            borderRadius: 4,
                            color: "white",
                            cursor: "pointer",
                        }}
                    >
                        Close
                    </button>
                </div>
            </div>

            {/* Tabs */}
            <div style={{
                display: "flex",
                borderBottom: "1px solid #4a4a6a",
                backgroundColor: "#252540",
            }}>
                {(["ddraw", "d3d8", "d3d9", "glide", "webgpu"] as TabType[]).map((tab) => (
                    <button
                        key={tab}
                        onClick={() => {
                            userPinnedTab.current = true;
                            setActiveTab(tab);
                        }}
                        style={{
                            padding: "8px 16px",
                            backgroundColor: activeTab === tab ? "#1a1a2e" : "transparent",
                            border: "none",
                            borderBottom: activeTab === tab ? "2px solid #4CAF50" : "2px solid transparent",
                            color: activeTab === tab ? "#4CAF50" : "#888",
                            cursor: "pointer",
                            fontWeight: activeTab === tab ? "bold" : "normal",
                        }}
                    >
                        {tab === "ddraw" ? "DirectDraw" : tab === "d3d8" ? "DirectX8" : tab === "d3d9" ? "DirectX9" : tab === "glide" ? "Glide2x" : "WebGPU"}
                        {activeBackend !== null && backendToTab[activeBackend] === tab ? " ●" : ""}
                    </button>
                ))}
            </div>

            {/* Frame Snapshot Section (always visible) */}
            {((activeTab === "ddraw" && ddrawData?.frameSnapshot) ||
              (activeTab === "d3d8" && d3d8Data?.frameSnapshot) ||
              (activeTab === "d3d9" && d3d9Data?.frameSnapshot) ||
              (activeTab === "glide" && glideData?.frameSnapshot)) && (
                <div style={{
                    padding: 10,
                    borderBottom: "1px solid #4a4a6a",
                    backgroundColor: "#1a2a2e",
                }}>
                    <div style={{ fontWeight: "bold", marginBottom: 8, color: "#4CAF50" }}>Frame Snapshot</div>
                    <div style={{ fontSize: 11, lineHeight: 1.6 }}>
                        {activeTab === "ddraw" && ddrawData?.frameSnapshot && (
                            <>
                                <div>Frame ID: {ddrawData.frameSnapshot.frameId}</div>
                                <div>Draw Calls: {ddrawData.frameSnapshot.drawCalls}</div>
                                <div>Presents: {ddrawData.frameSnapshot.presents}</div>
                                {ddrawData.frameSnapshot.frameCounters && (
                                    <div style={{ marginTop: 4, padding: "4px 8px", backgroundColor: "#252540", borderRadius: 4 }}>
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
                                            <span>Binds: {ddrawData.frameSnapshot.frameCounters.textureBinds}</span>
                                            <span>Uploads: {ddrawData.frameSnapshot.frameCounters.uploads}</span>
                                            <span>Clears: {ddrawData.frameSnapshot.frameCounters.clears}</span>
                                            <span style={{ color: "#4CAF50" }}>Hits: {ddrawData.frameSnapshot.frameCounters.cacheHits}</span>
                                            <span style={{ color: "#f44336" }}>Miss: {ddrawData.frameSnapshot.frameCounters.cacheMisses}</span>
                                        </div>
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginTop: 4 }}>
                                            <span>Wait: {ddrawData.frameSnapshot.frameCounters.waitTimeMs.toFixed(1)}ms</span>
                                            <span>VB: {(ddrawData.frameSnapshot.frameCounters.vertexBytes / 1024).toFixed(1)}KB</span>
                                            <span>Tex: {(ddrawData.frameSnapshot.frameCounters.textureBytes / 1024 / 1024).toFixed(2)}MB</span>
                                        </div>
                                    </div>
                                )}
                                {ddrawData.frameSnapshot.lastPresent && (
                                    <div style={{ marginTop: 4, paddingLeft: 10, borderLeft: "2px solid #4CAF50" }}>
                                        <div style={{ fontWeight: "bold" }}>Last Present:</div>
                                        <div>Surface: 0x{ddrawData.frameSnapshot.lastPresent.surfaceAddr.toString(16)}</div>
                                        <div>Size: {ddrawData.frameSnapshot.lastPresent.width}x{ddrawData.frameSnapshot.lastPresent.height}</div>
                                        <div>Format: {ddrawData.frameSnapshot.lastPresent.format}</div>
                                    </div>
                                )}
                                {ddrawData.frameSnapshot.lastDraw && (
                                    <div style={{ marginTop: 4, paddingLeft: 10, borderLeft: "2px solid #2196F3" }}>
                                        <div style={{ fontWeight: "bold" }}>Last Draw:</div>
                                        <div>API: {ddrawData.frameSnapshot.lastDraw.api}</div>
                                        {ddrawData.frameSnapshot.lastDraw.textureHandle && (
                                            <div>Texture: 0x{ddrawData.frameSnapshot.lastDraw.textureHandle.toString(16)}</div>
                                        )}
                                        {ddrawData.frameSnapshot.lastDraw.surfaceAddr && (
                                            <div>RT: 0x{ddrawData.frameSnapshot.lastDraw.surfaceAddr.toString(16)}</div>
                                        )}
                                        <div>Verts: {ddrawData.frameSnapshot.lastDraw.numVerts ?? "N/A"}</div>
                                        <div>Topology: {ddrawData.frameSnapshot.lastDraw.topology ?? "N/A"}</div>
                                        <div>Alpha Blend: {ddrawData.frameSnapshot.lastDraw.alphaBlend ? "ON" : "OFF"}</div>
                                        <div>Z Enable: {ddrawData.frameSnapshot.lastDraw.zEnable ? "ON" : "OFF"}</div>
                                        <div>Z Write: {ddrawData.frameSnapshot.lastDraw.zWrite ? "ON" : "OFF"}</div>
                                        <div>Alpha Test: {ddrawData.frameSnapshot.lastDraw.alphaTest ? "ON" : "OFF"}</div>
                                    </div>
                                )}
                            </>
                        )}
                        {activeTab === "glide" && glideData?.frameSnapshot && (
                            <>
                                <div>Frame ID: {glideData.frameSnapshot.frameId}</div>
                                <div>Draw Calls: {glideData.frameSnapshot.drawCalls}</div>
                                <div>Presents: {glideData.frameSnapshot.presents}</div>
                                {glideData.frameSnapshot.frameCounters && (
                                    <div style={{ marginTop: 4, padding: "4px 8px", backgroundColor: "#252540", borderRadius: 4 }}>
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
                                            <span>Binds: {glideData.frameSnapshot.frameCounters.textureBinds}</span>
                                            <span>Uploads: {glideData.frameSnapshot.frameCounters.uploads}</span>
                                            <span>Clears: {glideData.frameSnapshot.frameCounters.clears}</span>
                                            <span style={{ color: "#4CAF50" }}>Hits: {glideData.frameSnapshot.frameCounters.cacheHits}</span>
                                            <span style={{ color: "#f44336" }}>Miss: {glideData.frameSnapshot.frameCounters.cacheMisses}</span>
                                        </div>
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginTop: 4 }}>
                                            <span>Tex: {(glideData.frameSnapshot.frameCounters.textureBytes / 1024 / 1024).toFixed(2)}MB</span>
                                            <span>VB: {(glideData.frameSnapshot.frameCounters.vertexBytes / 1024).toFixed(1)}KB</span>
                                        </div>
                                    </div>
                                )}
                                <div style={{ marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap" }}>
                                    <span>LFB Locks: {glideData.frameSnapshot.lfbLocks ?? 0}</span>
                                    <span>Unlocks: {glideData.frameSnapshot.lfbUnlocks ?? 0}</span>
                                    <span>Reads: {glideData.frameSnapshot.lfbReads ?? 0}</span>
                                    <span>Writes: {glideData.frameSnapshot.lfbWrites ?? 0}</span>
                                    <span>Tex DL: {glideData.frameSnapshot.texDownloads ?? 0}</span>
                                </div>
                            </>
                        )}
                        {activeTab === "d3d8" && d3d8Data?.frameSnapshot && (
                            <DxFrameSnapshot snap={d3d8Data.frameSnapshot} />
                        )}
                        {activeTab === "d3d9" && d3d9Data?.frameSnapshot && (
                            <DxFrameSnapshot snap={d3d9Data.frameSnapshot} />
                        )}
                    </div>
                </div>
            )}

            {/* Debug Toggles Section */}
            <div style={{
                padding: 10,
                borderBottom: "1px solid #4a4a6a",
                backgroundColor: "#1a2a2e",
            }}>
                <div style={{ fontWeight: "bold", marginBottom: 8, color: "#FF9800" }}>Debug Toggles</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 11 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                            type="checkbox"
                            onChange={(e) => {
                                if (worker) {
                                    worker.postMessage({
                                        type: "gpu_debug_toggle",
                                        toggle: "forceMissingTextureMagenta",
                                        enabled: e.target.checked,
                                    });
                                }
                            }}
                        />
                        <span>Magenta Missing Texture</span>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                            type="checkbox"
                            onChange={(e) => {
                                if (worker) {
                                    worker.postMessage({
                                        type: "gpu_debug_toggle",
                                        toggle: "forceDisableAlphaBlend",
                                        enabled: e.target.checked,
                                    });
                                }
                            }}
                        />
                        <span>Disable Alpha Blend</span>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                            type="checkbox"
                            onChange={(e) => {
                                if (worker) {
                                    worker.postMessage({
                                        type: "gpu_debug_toggle",
                                        toggle: "forceDisableAlphaTest",
                                        enabled: e.target.checked,
                                    });
                                }
                            }}
                        />
                        <span>Disable Alpha Test</span>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                            type="checkbox"
                            onChange={(e) => {
                                if (worker) {
                                    worker.postMessage({
                                        type: "gpu_debug_toggle",
                                        toggle: "forceTextureResync",
                                        enabled: e.target.checked,
                                    });
                                }
                            }}
                        />
                        <span>Force Texture Resync</span>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                            type="checkbox"
                            onChange={(e) => {
                                if (worker) {
                                    worker.postMessage({
                                        type: "gpu_debug_toggle",
                                        toggle: "forcePointFilter",
                                        enabled: e.target.checked,
                                    });
                                }
                            }}
                        />
                        <span>Force POINT Filter</span>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                            type="checkbox"
                            onChange={(e) => {
                                if (worker) {
                                    worker.postMessage({
                                        type: "gpu_debug_toggle",
                                        toggle: "forceDisableZTest",
                                        enabled: e.target.checked,
                                    });
                                }
                            }}
                        />
                        <span>Disable Z-Test</span>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                            type="checkbox"
                            onChange={(e) => {
                                if (worker) {
                                    worker.postMessage({
                                        type: "gpu_debug_toggle",
                                        toggle: "forceZMidpoint",
                                        enabled: e.target.checked,
                                    });
                                }
                            }}
                        />
                        <span>Force Z Midpoint (0.5*w)</span>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                            type="checkbox"
                            onChange={(e) => {
                                if (worker) {
                                    worker.postMessage({
                                        type: "gpu_debug_toggle",
                                        toggle: "forceCullNone",
                                        enabled: e.target.checked,
                                    });
                                }
                            }}
                        />
                        <span>Force Cull None</span>
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span>Texture Converter Debug:</span>
                        <select
                            onChange={(e) => {
                                if (worker) {
                                    const mode = parseInt(e.target.value);
                                    worker.postMessage({
                                        type: "gpu_debug_toggle",
                                        toggle: "textureConverterDebugMode",
                                        enabled: mode > 0,
                                        value: mode,
                                    });
                                }
                            }}
                            style={{
                                padding: "2px 4px",
                                backgroundColor: "#333",
                                color: "white",
                                border: "1px solid #555",
                                borderRadius: 4,
                                fontSize: 11,
                            }}
                        >
        <option value="0">Normal</option>
        <option value="1">Show Format (R=32, G=16, B=8)</option>
        <option value="2">Show Raw Data (Grayscale/Raw)</option>
        <option value="3">Show UV Grid (Debug Pattern)</option>
    </select>
                    </div>
                </div>
            </div>

            {/* Content Area */}
            <div style={{ padding: 10, overflowY: "auto", flex: 1 }}>
                {activeTab === "ddraw" && (
                    <div>
                        <div style={{ marginBottom: 10, fontWeight: "bold", color: "#888" }}>
                            Surfaces ({ddrawData?.surfaces.length ?? 0})
                        </div>
                        {ddrawData?.surfaces && ddrawData.surfaces.length > 0 ? (
                            <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                <thead>
                                    <tr style={{ textAlign: "left", color: "#888", borderBottom: "1px solid #333" }}>
                                        <th style={{ padding: "4px 8px" }}>Address</th>
                                        <th style={{ padding: "4px 8px" }}>Role</th>
                                        <th style={{ padding: "4px 8px" }}>Size</th>
                                        <th style={{ padding: "4px 8px" }}>Format</th>
                                        <th style={{ padding: "4px 8px" }}>Caps</th>
                                        <th style={{ padding: "4px 8px" }}>Authority</th>
                                        <th style={{ padding: "4px 8px" }}>Version</th>
                                        <th style={{ padding: "4px 8px" }}>GPU</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {ddrawData.surfaces.map((surface) => (
                                        <React.Fragment key={surface.address}>
                                            <tr
                                                style={{
                                                    borderBottom: "1px solid #222",
                                                    cursor: "pointer",
                                                    backgroundColor: selectedSurface === surface.address ? "#2a3a4e" : "transparent",
                                                }}
                                                onClick={() => handleSurfaceClick(surface.address)}
                                            >
                                                <td style={{ padding: "6px 8px", color: "#8888ff" }}>
                                                    0x{surface.address.toString(16)}
                                                </td>
                                                <td style={{ padding: "6px 8px", color: surface.role === "primary" ? "#4CAF50" : surface.role === "backbuffer" ? "#2196F3" : "#888" }}>
                                                    {surface.role?.toUpperCase() ?? "N/A"}
                                                </td>
                                                <td style={{ padding: "6px 8px" }}>
                                                    {surface.width}x{surface.height}
                                                </td>
                                                <td style={{ padding: "6px 8px" }}>
                                                    {surface.format.bpp}bpp
                                                </td>
                                                <td style={{ padding: "6px 8px", fontSize: 10 }}>
                                                    {formatCaps(surface.caps)}
                                                </td>
                                                <td style={{ padding: "6px 8px", color: surface.authority === "gpu" ? "#4CAF50" : surface.authority === "cpu" ? "#2196F3" : "#888" }}>
                                                    {surface.authority}
                                                </td>
                                                <td style={{ padding: "6px 8px", fontSize: 10 }}>
                                                    v{surface.version} c{surface.cpuVersion} g{surface.gpuVersion}
                                                </td>
                                                <td style={{ padding: "6px 8px", color: surface.hasGpuTexture ? "#4CAF50" : "#f44336" }}>
                                                    {surface.hasGpuTexture ? "✓" : "✗"}
                                                </td>
                                            </tr>
                                            {selectedSurface === surface.address && (
                                                <tr>
                                                    <td colSpan={8} style={{ padding: "10px", backgroundColor: "#1a2a3a", fontSize: 11 }}>
                                                        <div style={{ marginBottom: 8 }}>
                                                            <strong>Surface Details:</strong>
                                                        </div>
                                                        <div style={{ lineHeight: 1.8 }}>
                                                            <div>Handle: 0x{surface.handle.toString(16)}</div>
                                                            <div>SurfacePtr: 0x{surface.surfacePtr.toString(16)}</div>
                                                            <div>Pitch: {surface.pitch}</div>
                                                            <div>Authority: {surface.authority} | Version: {surface.version} (cpuV={surface.cpuVersion} gpuV={surface.gpuVersion})</div>
                                                            <div>cpuValid: {String(surface.cpuValid)} gpuValid: {String(surface.gpuValid)}</div>
                                                            <div>RefCount: {surface.refCount}</div>
                                                            {surface.vidMemSize && (
                                                                <div>VRAM: {(surface.vidMemSize / 1024 / 1024).toFixed(2)} MB</div>
                                                            )}
                                                            {surface.activeLeaseId !== undefined && (
                                                                <div>Active Lease: {surface.activeLeaseId}</div>
                                                            )}
                                                            {surface.attachedSurfaceAddr && (
                                                                <div>Attached: 0x{surface.attachedSurfaceAddr.toString(16)}</div>
                                                            )}
                                                            {surface.isPrimaryChain && (
                                                                <div style={{ color: "#4CAF50" }}>✓ Part of Primary Chain</div>
                                                            )}
                                                        </div>
                                                        {surfacePreview && (
                                                            <div style={{ marginTop: 10 }}>
                                                                <div style={{ marginBottom: 4, fontWeight: "bold" }}>Preview:</div>
                                                                <img
                                                                    src={surfacePreview.data}
                                                                    alt="Surface preview"
                                                                    style={{
                                                                        maxWidth: "100%",
                                                                        border: "1px solid #4a4a6a",
                                                                        borderRadius: 4,
                                                                    }}
                                                                />
                                                            </div>
                                                        )}
                                                    </td>
                                                </tr>
                                            )}
                                        </React.Fragment>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <div style={{ padding: 20, textAlign: "center", color: "#888" }}>
                                No surfaces found
                            </div>
                        )}

                        {/* Flipping Chain Visualization */}
                        {ddrawData?.surfaces && ddrawData.surfaces.some(s => s.isPrimaryChain) && (
                            <div style={{ marginTop: 20, padding: 10, backgroundColor: "#1a2a3a", borderRadius: 4 }}>
                                <div style={{ fontWeight: "bold", marginBottom: 8, color: "#4CAF50" }}>Flipping Chain</div>
                                <div style={{ fontSize: 11 }}>
                                    {ddrawData.surfaces
                                        .filter(s => s.isPrimaryChain)
                                        .map(s => (
                                            <div key={s.address} style={{ marginBottom: 4 }}>
                                                <span style={{ color: s.role === "primary" ? "#4CAF50" : "#2196F3" }}>
                                                    {s.role?.toUpperCase()}
                                                </span>
                                                {" "}0x{s.address.toString(16)}
                                                {s.attachedSurfaceAddr && (
                                                    <>
                                                        {" "}→{" "}
                                                        <span style={{ color: "#8888ff" }}>
                                                            0x{s.attachedSurfaceAddr.toString(16)}
                                                        </span>
                                                    </>
                                                )}
                                            </div>
                                        ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === "d3d8" && (
                    <div>
                        <DxResourceTables data={d3d8Data} apiLabel="D3D8" />
                    </div>
                )}

                {activeTab === "d3d9" && (
                    <div>
                        <DxResourceTables data={d3d9Data} apiLabel="D3D9" />
                    </div>
                )}

                {activeTab === "glide" && (
                    <div>
                        {glideData ? (
                            <>
                                <div style={{ marginBottom: 10, fontWeight: "bold", color: "#888" }}>
                                    Glide State
                                </div>
                                <div style={{ padding: 10, backgroundColor: "#1a2a3a", borderRadius: 4, marginBottom: 16 }}>
                                    <div style={{ fontSize: 11, lineHeight: 1.7 }}>
                                        <div>Initialized: {glideData.resources.state.initialized ? "yes" : "no"}</div>
                                        <div>Window Open: {glideData.resources.state.winOpen ? "yes" : "no"}</div>
                                        <div>Resolution: {glideData.resources.state.width}x{glideData.resources.state.height}</div>
                                        <div>RenderBuffer: {glideData.resources.state.renderBuffer}</div>
                                        <div>SST: {glideData.resources.state.selectedSst}</div>
                                        <div>Origin: {glideData.resources.state.origin}</div>
                                    </div>
                                </div>

                                <div style={{ marginBottom: 10, fontWeight: "bold", color: "#888" }}>
                                    Textures ({glideData.resources.textures.length})
                                </div>
                                {glideData.resources.textures.length > 0 ? (
                                    <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
                                        <thead>
                                            <tr style={{ textAlign: "left", color: "#888", borderBottom: "1px solid #333" }}>
                                                <th style={{ padding: "4px 8px" }}>Handle</th>
                                                <th style={{ padding: "4px 8px" }}>TMU</th>
                                                <th style={{ padding: "4px 8px" }}>Size</th>
                                                <th style={{ padding: "4px 8px" }}>Format</th>
                                                <th style={{ padding: "4px 8px" }}>Address</th>
                                                <th style={{ padding: "4px 8px" }}>Bytes</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {glideData.resources.textures.map((tex) => (
                                                <tr key={`${tex.tmu}:${tex.handle}:${tex.startAddress}`} style={{ borderBottom: "1px solid #222" }}>
                                                    <td style={{ padding: "6px 8px", color: "#8888ff" }}>0x{tex.handle.toString(16)}</td>
                                                    <td style={{ padding: "6px 8px" }}>{tex.tmu}</td>
                                                    <td style={{ padding: "6px 8px" }}>{tex.width}x{tex.height}</td>
                                                    <td style={{ padding: "6px 8px" }}>0x{tex.format.toString(16)}</td>
                                                    <td style={{ padding: "6px 8px" }}>0x{tex.startAddress.toString(16)}</td>
                                                    <td style={{ padding: "6px 8px" }}>{(tex.bytes / 1024).toFixed(1)} KB</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                ) : (
                                    <div style={{ padding: 20, textAlign: "center", color: "#888", marginBottom: 12 }}>
                                        No Glide textures
                                    </div>
                                )}

                                <div style={{ marginBottom: 10, fontWeight: "bold", color: "#888" }}>
                                    LFB Surfaces ({glideData.resources.lfbSurfaces.length})
                                </div>
                                {glideData.resources.lfbSurfaces.length > 0 ? (
                                    <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
                                        <thead>
                                            <tr style={{ textAlign: "left", color: "#888", borderBottom: "1px solid #333" }}>
                                                <th style={{ padding: "4px 8px" }}>Buffer</th>
                                                <th style={{ padding: "4px 8px" }}>Address</th>
                                                <th style={{ padding: "4px 8px" }}>Size</th>
                                                <th style={{ padding: "4px 8px" }}>Pitch</th>
                                                <th style={{ padding: "4px 8px" }}>Mode</th>
                                                <th style={{ padding: "4px 8px" }}>Dirty</th>
                                                <th style={{ padding: "4px 8px" }}>Lease</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {glideData.resources.lfbSurfaces.map((surf) => (
                                                <tr key={`${surf.buffer}:${surf.address}`} style={{ borderBottom: "1px solid #222" }}>
                                                    <td style={{ padding: "6px 8px" }}>{surf.buffer}</td>
                                                    <td style={{ padding: "6px 8px", color: "#8888ff" }}>0x{surf.address.toString(16)}</td>
                                                    <td style={{ padding: "6px 8px" }}>{surf.width}x{surf.height} ({surf.bytesPerPixel} bpp)</td>
                                                    <td style={{ padding: "6px 8px" }}>{surf.pitch}</td>
                                                    <td style={{ padding: "6px 8px" }}>{surf.writeMode}</td>
                                                    <td style={{ padding: "6px 8px", color: surf.dirty ? "#FF9800" : "#888" }}>{surf.dirty ? "yes" : "no"}</td>
                                                    <td style={{ padding: "6px 8px", color: surf.activeLeaseId ? "#4CAF50" : "#888" }}>
                                                        {surf.activeLeaseId ? surf.activeLeaseId : "—"}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                ) : (
                                    <div style={{ padding: 20, textAlign: "center", color: "#888", marginBottom: 12 }}>
                                        No LFB surfaces
                                    </div>
                                )}

                                <div style={{ marginBottom: 10, fontWeight: "bold", color: "#888" }}>
                                    Glide Events ({glideData.resources.ringEvents.length})
                                </div>
                                {glideData.resources.ringEvents.length > 0 ? (
                                    <div style={{ maxHeight: 180, overflowY: "auto", backgroundColor: "#1a2a3a", borderRadius: 4, padding: 8 }}>
                                        {glideData.resources.ringEvents.map((evt) => (
                                            <div key={evt.id} style={{ fontSize: 11, lineHeight: 1.6, borderBottom: "1px solid #223", padding: "2px 0" }}>
                                                <span style={{ color: "#4CAF50" }}>#{evt.id}</span>{" "}
                                                <span style={{ color: "#8ab4f8" }}>{evt.type}</span>{" "}
                                                <span style={{ color: "#888" }}>{evt.detail ?? ""}</span>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div style={{ padding: 20, textAlign: "center", color: "#888" }}>
                                        No Glide events
                                    </div>
                                )}
                            </>
                        ) : (
                            <div style={{ padding: 20, textAlign: "center", color: "#888" }}>
                                No Glide data available
                            </div>
                        )}
                    </div>
                )}

                {activeTab === "webgpu" && (
                    <div>
                        {webgpuData ? (
                            <>
                                <div style={{ marginBottom: 10, fontWeight: "bold", color: "#888" }}>
                                    Device Info
                                </div>
                                <div style={{ padding: 10, backgroundColor: "#1a2a3a", borderRadius: 4, marginBottom: 20 }}>
                                    <div style={{ fontSize: 11, lineHeight: 1.8 }}>
                                        <div>Format: {webgpuData.deviceInfo.format}</div>
                                        <div>Has Device: {webgpuData.deviceInfo.hasDevice ? "✓" : "✗"}</div>
                                        <div>Has Queue: {webgpuData.deviceInfo.hasQueue ? "✓" : "✗"}</div>
                                        <div>Has Context: {webgpuData.deviceInfo.hasContext ? "✓" : "✗"}</div>
                                    </div>
                                </div>

                                {webgpuData.overlayTexture && (
                                    <>
                                        <div style={{ marginBottom: 10, fontWeight: "bold", color: "#888" }}>
                                            Tracked Resources
                                        </div>
                                        <div style={{ padding: 10, backgroundColor: "#1a2a3a", borderRadius: 4 }}>
                                            <div style={{ fontWeight: "bold", marginBottom: 8, color: "#4CAF50" }}>Overlay Texture (GDI)</div>
                                            <div style={{ fontSize: 11, lineHeight: 1.8 }}>
                                                <div>Size: {webgpuData.overlayTexture.width}x{webgpuData.overlayTexture.height}</div>
                                                <div>Format: {webgpuData.overlayTexture.format}</div>
                                            </div>
                                        </div>
                                    </>
                                )}
                            </>
                        ) : (
                            <div style={{ padding: 20, textAlign: "center", color: "#888" }}>
                                No WebGPU data available
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Footer */}
            <div style={{
                padding: "8px 15px",
                borderTop: "1px solid #4a4a6a",
                backgroundColor: "#252540",
                fontSize: 11,
                color: "#888",
                display: "flex",
                justifyContent: "space-between"
            }}>
                <span>Last update: {new Date(lastUpdate).toLocaleTimeString()}</span>
                <span>Scope: summary</span>
            </div>
        </div>
    );
}
