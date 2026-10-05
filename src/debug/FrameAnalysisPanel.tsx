import React, { useEffect, useState, useCallback, useMemo } from "react";

type CapturedDrawCall = {
    index: number;
    primitiveType: number;
    primitiveTypeName: string;
    vertexType: number;
    vertexCount: number;
    indexCount: number;
    isRHW: boolean;
    firstVertices: Array<{x: number; y: number; z: number; w?: number}>;
    rtSurfacePtr: number;
    rtWidth: number;
    rtHeight: number;
    tex0: {
        surfacePtr: number; width: number; height: number; pitch: number;
        bpp: number; aMask: number; rMask: number;
        gpuTextureFormat: string | null;
        srcColorKey: {low: number; high: number} | null;
        hasGpuView: boolean;
    } | null;
    tex1: { surfacePtr: number; width: number; height: number; bpp: number; aMask: number } | null;
    alphaBlendEnabled: number;
    srcBlend: number;
    dstBlend: number;
    alphaTestEnabled: number;
    alphaFunc: number;
    alphaRef: number;
    colorKeyRenderState: number;
    zEnable: number;
    zWrite: number;
    cullMode: number;
    lightingEnabled: number;
    fogEnabled: number;
    colorOp: number;
    alphaOp: number;
    colorArg1: number;
    colorArg2: number;
    alphaArg1: number;
    alphaArg2: number;
    legacySamplerState: {
        textureAddress: number; textureAddressU: number; textureAddressV: number;
        textureMag: number; textureMin: number; anisotropy: number;
    };
    stage0SamplerState: {
        minFilter: number; magFilter: number; mipFilter: number;
        addressU: number; addressV: number; maxAnisotropy: number;
    };
    effectiveSamplerState: {
        minFilter: number; magFilter: number; mipFilter: number;
        addressU: number; addressV: number; maxAnisotropy: number;
    } | null;
    forcePointFilter: boolean;
    derivedColorKeyEnabled: boolean;
    derivedUseTexture: boolean;
    derivedPremultiply: boolean;
    derivedShouldBlend: boolean;
    warnings: string[];
};

type CapturedFrame = {
    frameId: number;
    timestamp: number;
    drawCalls: CapturedDrawCall[];
    clears: Array<{color?: number; depth?: number; stencil?: number}>;
};

type Props = {
    isOpen: boolean;
    onClose: () => void;
    worker: Worker | null;
};

const BLEND_NAMES: Record<number, string> = {
    0: "?", 1: "ZERO", 2: "ONE", 3: "SRCCOLOR", 4: "INVSRCCOLOR",
    5: "SRCALPHA", 6: "INVSRCALPHA", 7: "DESTALPHA", 8: "INVDESTALPHA",
    9: "DESTCOLOR", 10: "INVDESTCOLOR", 11: "SRCALPHASAT",
};
const CMPFUNC_NAMES: Record<number, string> = {
    0: "?", 1: "NEVER", 2: "LESS", 3: "EQUAL", 4: "LESSEQUAL",
    5: "GREATER", 6: "NOTEQUAL", 7: "GREATEREQUAL", 8: "ALWAYS",
};
const TEXOP_NAMES: Record<number, string> = {
    0: "?", 1: "DISABLE", 2: "SELECTARG1", 3: "SELECTARG2", 4: "MODULATE",
    5: "MODULATE2X", 6: "MODULATE4X", 7: "ADD", 8: "ADDSIGNED",
};
const CULL_NAMES: Record<number, string> = { 0: "?", 1: "NONE", 2: "CW", 3: "CCW" };
const FILTER_NAMES: Record<number, string> = { 0: "?", 1: "POINT", 2: "LINEAR", 3: "ANISO" };
const MIPFILTER_NAMES: Record<number, string> = { 0: "?", 1: "NONE", 2: "POINT", 3: "LINEAR" };
const ADDRESS_NAMES: Record<number, string> = { 0: "?", 1: "WRAP", 2: "MIRROR", 3: "CLAMP", 4: "BORDER" };

function hex(n: number): string { return "0x" + n.toString(16).toUpperCase(); }
function yn(n: number): string { return n ? "YES" : "no"; }

export default function FrameAnalysisPanel({ isOpen, onClose, worker }: Props) {
    const [frame, setFrame] = useState<CapturedFrame | null>(null);
    const [capturing, setCapturing] = useState(false);
    const [expandedRow, setExpandedRow] = useState<number | null>(null);
    const [texPreviews, setTexPreviews] = useState<Map<number, string>>(new Map());
    const [filterText, setFilterText] = useState("");
    const [warningsOnly, setWarningsOnly] = useState(false);
    const [argb1555Only, setArgb1555Only] = useState(false);
    const [alphaBlendOnly, setAlphaBlendOnly] = useState(false);
    const [bit15Data, setBit15Data] = useState<Map<number, any>>(new Map());

    // Message handler
    useEffect(() => {
        if (!worker || !isOpen) return;
        const handler = (e: MessageEvent) => {
            if (e.data.type === "frame_capture_data") {
                if (e.data.ok) setFrame(e.data.data);
                setCapturing(false);
            }
            if (e.data.type === "frame_capture_texture" && e.data.ok && e.data.data) {
                setTexPreviews(prev => {
                    const next = new Map(prev);
                    next.set(e.data.surfacePtr, e.data.data.data);
                    return next;
                });
            }
            if (e.data.type === "frame_capture_bit15_check" && e.data.ok) {
                setBit15Data(prev => {
                    const next = new Map(prev);
                    next.set(e.data.surfacePtr, e.data.data);
                    return next;
                });
            }
        };
        worker.addEventListener("message", handler);
        return () => worker.removeEventListener("message", handler);
    }, [worker, isOpen]);

    const doCapture = useCallback(() => {
        if (!worker || capturing) return;
        setCapturing(true);
        setFrame(null);
        setExpandedRow(null);
        setTexPreviews(new Map());
        worker.postMessage({ type: "frame_capture_start" });
    }, [worker, capturing]);

    // Request texture preview on expand
    useEffect(() => {
        if (expandedRow === null || !frame || !worker) return;
        const dc = frame.drawCalls[expandedRow];
        if (!dc?.tex0) return;
        const ptr = dc.tex0.surfacePtr;
        if (texPreviews.has(ptr)) return;
        worker.postMessage({ type: "frame_capture_texture", surfacePtr: ptr, maxSize: 128 });
    }, [expandedRow, frame, worker, texPreviews]);

    // Filter
    const filtered = useMemo(() => {
        if (!frame) return [];
        let list = frame.drawCalls;
        if (warningsOnly) list = list.filter(d => d.warnings.length > 0);
        if (argb1555Only) list = list.filter(d => d.tex0 && d.tex0.aMask === 0x8000);
        if (alphaBlendOnly) list = list.filter(d => d.alphaBlendEnabled !== 0);
        if (filterText) {
            const lc = filterText.toLowerCase();
            list = list.filter(d =>
                d.primitiveTypeName.toLowerCase().includes(lc) ||
                hex(d.vertexType).toLowerCase().includes(lc) ||
                d.warnings.some(w => w.toLowerCase().includes(lc)) ||
                (d.tex0 && hex(d.tex0.surfacePtr).toLowerCase().includes(lc))
            );
        }
        return list;
    }, [frame, warningsOnly, argb1555Only, alphaBlendOnly, filterText]);

    // Stats
    const warnCount = frame ? frame.drawCalls.filter(d => d.warnings.length > 0).length : 0;
    const uniqueTex = frame ? new Set(frame.drawCalls.filter(d => d.tex0).map(d => d.tex0!.surfacePtr)).size : 0;

    if (!isOpen) return null;

    const S: Record<string, React.CSSProperties> = {
        overlay: {
            position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 10000, display: "flex", justifyContent: "center", alignItems: "flex-start",
            paddingTop: 24, backgroundColor: "rgba(0,0,0,0.6)",
        },
        panel: {
            width: "95vw", maxWidth: 1400, maxHeight: "90vh",
            backgroundColor: "#1a1a2e", color: "#e0e0e0", borderRadius: 8,
            fontFamily: "monospace", fontSize: 12, display: "flex", flexDirection: "column",
            border: "1px solid #333",
        },
        header: {
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "10px 16px", borderBottom: "1px solid #333",
        },
        body: { overflow: "auto", flex: 1, padding: "8px 12px" },
        btn: {
            padding: "4px 12px", border: "1px solid #555", borderRadius: 4,
            backgroundColor: "#252540", color: "#e0e0e0", cursor: "pointer", fontSize: 12,
        },
        btnPrimary: {
            padding: "4px 12px", border: "1px solid #4CAF50", borderRadius: 4,
            backgroundColor: "#2e7d32", color: "#fff", cursor: "pointer", fontSize: 12,
        },
        filterBar: {
            display: "flex", gap: 8, alignItems: "center", padding: "6px 0",
            borderBottom: "1px solid #333", marginBottom: 6, flexWrap: "wrap",
        },
        input: {
            padding: "3px 8px", border: "1px solid #555", borderRadius: 4,
            backgroundColor: "#252540", color: "#e0e0e0", fontSize: 12, width: 180,
        },
        th: {
            padding: "4px 6px", textAlign: "left", borderBottom: "1px solid #444",
            color: "#aaa", fontSize: 11, whiteSpace: "nowrap",
        },
        td: { padding: "3px 6px", borderBottom: "1px solid #222", whiteSpace: "nowrap" },
        expandedRow: {
            padding: "8px 12px", backgroundColor: "#252540", borderBottom: "1px solid #333",
            fontSize: 11, lineHeight: 1.6,
        },
        label: { display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11 },
    };

    return (
        <div style={S.overlay} onClick={onClose}>
            <div style={S.panel} onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div style={S.header}>
                    <span style={{ fontWeight: "bold", fontSize: 14 }}>Frame Analysis</span>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button
                            style={capturing ? S.btn : S.btnPrimary}
                            onClick={doCapture}
                            disabled={capturing}
                        >
                            {capturing ? "Waiting..." : "Capture Frame"}
                        </button>
                        <button style={S.btn} onClick={onClose}>Close</button>
                    </div>
                </div>

                <div style={S.body}>
                    {!frame ? (
                        <div style={{ padding: 24, textAlign: "center", color: "#888" }}>
                            {capturing ? "Waiting for next frame..." : "Click \"Capture Frame\" to record one frame of draw calls."}
                        </div>
                    ) : (
                        <>
                            {/* Summary */}
                            <div style={{ display: "flex", gap: 16, padding: "4px 0 8px", fontSize: 11, color: "#aaa" }}>
                                <span>Frame #{frame.frameId}</span>
                                <span>Draws: <b style={{ color: "#e0e0e0" }}>{frame.drawCalls.length}</b></span>
                                <span>Unique Textures: <b style={{ color: "#e0e0e0" }}>{uniqueTex}</b></span>
                                <span style={{ color: warnCount > 0 ? "#ff9800" : "#888" }}>
                                    Warnings: <b>{warnCount}</b>
                                </span>
                            </div>

                            {/* Filter bar */}
                            <div style={S.filterBar}>
                                <input
                                    style={S.input}
                                    placeholder="Filter (type, FVF, ptr...)"
                                    value={filterText}
                                    onChange={e => setFilterText(e.target.value)}
                                />
                                <label style={S.label}>
                                    <input type="checkbox" checked={warningsOnly} onChange={e => setWarningsOnly(e.target.checked)} />
                                    Warnings
                                </label>
                                <label style={S.label}>
                                    <input type="checkbox" checked={argb1555Only} onChange={e => setArgb1555Only(e.target.checked)} />
                                    ARGB1555
                                </label>
                                <label style={S.label}>
                                    <input type="checkbox" checked={alphaBlendOnly} onChange={e => setAlphaBlendOnly(e.target.checked)} />
                                    Alpha Blend
                                </label>
                                <span style={{ fontSize: 11, color: "#888" }}>
                                    Showing {filtered.length}/{frame.drawCalls.length}
                                </span>
                            </div>

                            {/* Table */}
                            <table style={{ width: "100%", borderCollapse: "collapse" }}>
                                <thead>
                                    <tr>
                                        <th style={S.th}>#</th>
                                        <th style={S.th}>Type</th>
                                        <th style={S.th}>Verts</th>
                                        <th style={S.th}>FVF</th>
                                        <th style={S.th}>Texture</th>
                                        <th style={S.th}>Size</th>
                                        <th style={S.th}>Blend</th>
                                        <th style={S.th}>ATest</th>
                                        <th style={S.th}>CKey</th>
                                        <th style={S.th}>Z</th>
                                        <th style={S.th}>Warn</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map(dc => {
                                        const hasWarn = dc.warnings.length > 0;
                                        const isArgb1555Warn = hasWarn && dc.tex0?.aMask === 0x8000 && dc.alphaTestEnabled !== 0;
                                        const rowColor = isArgb1555Warn ? "#f4433622" : hasWarn ? "#ff980015" : "transparent";
                                        const borderLeft = isArgb1555Warn ? "3px solid #f44336" : hasWarn ? "3px solid #ff9800" : "3px solid #4CAF5044";
                                        const isExpanded = expandedRow === dc.index;

                                        return (
                                            <React.Fragment key={dc.index}>
                                                <tr
                                                    style={{ backgroundColor: rowColor, borderLeft, cursor: "pointer" }}
                                                    onClick={() => setExpandedRow(isExpanded ? null : dc.index)}
                                                >
                                                    <td style={S.td}>{dc.index}</td>
                                                    <td style={S.td}>{dc.primitiveTypeName}</td>
                                                    <td style={S.td}>{dc.vertexCount}{dc.indexCount > 0 ? `/${dc.indexCount}i` : ""}</td>
                                                    <td style={S.td}>{hex(dc.vertexType)}{dc.isRHW ? " RHW" : ""}</td>
                                                    <td style={S.td}>
                                                        {dc.tex0 ? (
                                                            <span style={{ color: dc.tex0.hasGpuView ? "#4CAF50" : "#f44336" }}>
                                                                {hex(dc.tex0.surfacePtr)}
                                                            </span>
                                                        ) : <span style={{ color: "#666" }}>none</span>}
                                                    </td>
                                                    <td style={S.td}>
                                                        {dc.tex0 ? `${dc.tex0.width}x${dc.tex0.height}` : ""}
                                                    </td>
                                                    <td style={S.td}>
                                                        <span style={{ color: dc.alphaBlendEnabled ? "#2196F3" : "#666" }}>
                                                            {dc.alphaBlendEnabled ? `${BLEND_NAMES[dc.srcBlend] ?? dc.srcBlend}/${BLEND_NAMES[dc.dstBlend] ?? dc.dstBlend}` : "off"}
                                                        </span>
                                                    </td>
                                                    <td style={S.td}>
                                                        <span style={{ color: dc.alphaTestEnabled ? "#ff9800" : "#666" }}>
                                                            {dc.alphaTestEnabled ? `${CMPFUNC_NAMES[dc.alphaFunc] ?? dc.alphaFunc} ref=${dc.alphaRef}` : "off"}
                                                        </span>
                                                    </td>
                                                    <td style={S.td}>
                                                        <span style={{ color: dc.colorKeyRenderState ? "#9C27B0" : (dc.derivedColorKeyEnabled ? "#CE93D8" : "#666") }}>
                                                            {dc.colorKeyRenderState ? "RS" : ""}{dc.derivedColorKeyEnabled ? "CK" : dc.colorKeyRenderState ? "" : "off"}
                                                        </span>
                                                    </td>
                                                    <td style={S.td}>
                                                        {yn(dc.zEnable)}/{yn(dc.zWrite)}
                                                    </td>
                                                    <td style={S.td}>
                                                        {hasWarn ? (
                                                            <span style={{ color: "#ff9800" }}>{dc.warnings.length}</span>
                                                        ) : <span style={{ color: "#4CAF50" }}>ok</span>}
                                                    </td>
                                                </tr>
                                                {isExpanded && (
                                                    <tr>
                                                        <td colSpan={11} style={S.expandedRow}>
                                                            <ExpandedDrawCall
                                                                dc={dc}
                                                                texPreview={dc.tex0 ? texPreviews.get(dc.tex0.surfacePtr) : undefined}
                                                                bit15Stats={dc.tex0 ? bit15Data.get(dc.tex0.surfacePtr) : undefined}
                                                                onCheckBit15={() => {
                                                                    if (dc.tex0 && worker) {
                                                                        worker.postMessage({
                                                                            type: "frame_capture_bit15_check",
                                                                            surfacePtr: dc.tex0.surfacePtr,
                                                                            width: dc.tex0.width,
                                                                            height: dc.tex0.height,
                                                                            pitch: dc.tex0.pitch,
                                                                            bpp: dc.tex0.bpp,
                                                                        });
                                                                    }
                                                                }}
                                                            />
                                                        </td>
                                                    </tr>
                                                )}
                                            </React.Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function ExpandedDrawCall({ dc, texPreview, bit15Stats, onCheckBit15 }: {
    dc: CapturedDrawCall; texPreview?: string;
    bit15Stats?: { total: number; bit15set: number; bit15clear: number; blackWithBit15: number; blackWithoutBit15: number; sample: Array<{ x: number; y: number; raw: number; bit15: number; r: number; g: number; b: number }> };
    onCheckBit15: () => void;
}) {
    const secStyle: React.CSSProperties = { marginBottom: 8 };
    const labelStyle: React.CSSProperties = { color: "#4CAF50", fontWeight: "bold", marginBottom: 2 };
    const kvStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "140px 1fr", gap: "1px 12px" };

    return (
        <div style={{ display: "flex", gap: 20 }}>
            {/* Left: state dump */}
            <div style={{ flex: 1, minWidth: 0 }}>
                {/* Warnings */}
                {dc.warnings.length > 0 && (
                    <div style={secStyle}>
                        <div style={{ ...labelStyle, color: "#ff9800" }}>Warnings</div>
                        {dc.warnings.map((w, i) => (
                            <div key={i} style={{ color: "#ffcc80", paddingLeft: 8 }}>{w}</div>
                        ))}
                    </div>
                )}

                {/* Geometry */}
                <div style={secStyle}>
                    <div style={labelStyle}>Geometry</div>
                    <div style={kvStyle}>
                        <span style={{ color: "#888" }}>Primitive</span><span>{dc.primitiveTypeName} ({dc.primitiveType})</span>
                        <span style={{ color: "#888" }}>FVF</span><span>{hex(dc.vertexType)} {dc.isRHW ? "(RHW pre-transformed)" : "(XYZ)"}</span>
                        <span style={{ color: "#888" }}>Vertices</span><span>{dc.vertexCount}{dc.indexCount > 0 ? ` + ${dc.indexCount} indices` : ""}</span>
                        <span style={{ color: "#888" }}>Render Target</span><span>{hex(dc.rtSurfacePtr)} {dc.rtWidth}x{dc.rtHeight}</span>
                        <span style={{ color: "#888" }}>Cull</span><span>{CULL_NAMES[dc.cullMode] ?? dc.cullMode}</span>
                    </div>
                </div>

                {/* Texture 0 */}
                {dc.tex0 && (
                    <div style={secStyle}>
                        <div style={labelStyle}>Texture 0</div>
                        <div style={kvStyle}>
                            <span style={{ color: "#888" }}>Surface Ptr</span><span>{hex(dc.tex0.surfacePtr)}</span>
                            <span style={{ color: "#888" }}>Size</span><span>{dc.tex0.width}x{dc.tex0.height} {dc.tex0.bpp}bpp</span>
                            <span style={{ color: "#888" }}>aMask</span><span>{hex(dc.tex0.aMask)} {dc.tex0.aMask === 0x8000 ? "(ARGB1555)" : dc.tex0.aMask === 0xFF000000 ? "(ARGB8888)" : ""}</span>
                            <span style={{ color: "#888" }}>rMask</span><span>{hex(dc.tex0.rMask)}</span>
                            <span style={{ color: "#888" }}>GPU Format</span><span>{dc.tex0.gpuTextureFormat ?? "N/A"}</span>
                            <span style={{ color: "#888" }}>GPU View</span><span style={{ color: dc.tex0.hasGpuView ? "#4CAF50" : "#f44336" }}>{dc.tex0.hasGpuView ? "YES" : "NO"}</span>
                            <span style={{ color: "#888" }}>SrcColorKey</span>
                            <span>
                                {dc.tex0.srcColorKey
                                    ? `${hex(dc.tex0.srcColorKey.low)} - ${hex(dc.tex0.srcColorKey.high)}`
                                    : "none"}
                            </span>
                        </div>
                    </div>
                )}

                {/* Blend / Alpha */}
                <div style={secStyle}>
                    <div style={labelStyle}>Blend / Alpha State</div>
                    <div style={kvStyle}>
                        <span style={{ color: "#888" }}>AlphaBlend</span><span>{dc.alphaBlendEnabled ? "ON" : "off"} src={BLEND_NAMES[dc.srcBlend] ?? dc.srcBlend} dst={BLEND_NAMES[dc.dstBlend] ?? dc.dstBlend}</span>
                        <span style={{ color: "#888" }}>AlphaTest</span><span>{dc.alphaTestEnabled ? "ON" : "off"} func={CMPFUNC_NAMES[dc.alphaFunc] ?? dc.alphaFunc} ref={dc.alphaRef}</span>
                        <span style={{ color: "#888" }}>ColorKey RS</span><span>{dc.colorKeyRenderState ? "ON" : "off"}</span>
                        <span style={{ color: "#888" }}>Z Enable/Write</span><span>{yn(dc.zEnable)} / {yn(dc.zWrite)}</span>
                        <span style={{ color: "#888" }}>Lighting</span><span>{yn(dc.lightingEnabled)}</span>
                        <span style={{ color: "#888" }}>Fog</span><span>{yn(dc.fogEnabled)}</span>
                    </div>
                </div>

                {/* Texture Stage */}
                <div style={secStyle}>
                    <div style={labelStyle}>Texture Stage 0</div>
                    <div style={kvStyle}>
                        <span style={{ color: "#888" }}>ColorOp</span><span>{TEXOP_NAMES[dc.colorOp] ?? dc.colorOp}</span>
                        <span style={{ color: "#888" }}>AlphaOp</span><span>{TEXOP_NAMES[dc.alphaOp] ?? dc.alphaOp}</span>
                        <span style={{ color: "#888" }}>ColorArg1/2</span><span>{dc.colorArg1} / {dc.colorArg2}</span>
                        <span style={{ color: "#888" }}>AlphaArg1/2</span><span>{dc.alphaArg1} / {dc.alphaArg2}</span>
                        <span style={{ color: "#888" }}>Legacy RS sampler</span>
                        <span>
                            addr={dc.legacySamplerState.textureAddress}/{dc.legacySamplerState.textureAddressU}/{dc.legacySamplerState.textureAddressV}
                            {" "}mag={dc.legacySamplerState.textureMag} min={dc.legacySamplerState.textureMin} aniso={dc.legacySamplerState.anisotropy}
                        </span>
                        <span style={{ color: "#888" }}>Raw TSS sampler</span>
                        <span>
                            {FILTER_NAMES[dc.stage0SamplerState.minFilter] ?? dc.stage0SamplerState.minFilter}/
                            {FILTER_NAMES[dc.stage0SamplerState.magFilter] ?? dc.stage0SamplerState.magFilter}/
                            {MIPFILTER_NAMES[dc.stage0SamplerState.mipFilter] ?? dc.stage0SamplerState.mipFilter}
                            {" "}{ADDRESS_NAMES[dc.stage0SamplerState.addressU] ?? dc.stage0SamplerState.addressU}/
                            {ADDRESS_NAMES[dc.stage0SamplerState.addressV] ?? dc.stage0SamplerState.addressV}
                        </span>
                    </div>
                </div>

                {/* Derived */}
                <div style={secStyle}>
                    <div style={labelStyle}>Derived (Executor)</div>
                    <div style={kvStyle}>
                        <span style={{ color: "#888" }}>useTexture</span><span>{dc.derivedUseTexture ? "YES" : "no"}</span>
                        <span style={{ color: "#888" }}>shouldBlend</span><span>{dc.derivedShouldBlend ? "YES" : "no"}</span>
                        <span style={{ color: "#888" }}>colorKeyEnabled</span><span>{dc.derivedColorKeyEnabled ? "YES" : "no"}</span>
                        <span style={{ color: "#888" }}>Effective sampler</span>
                        <span>
                            {dc.effectiveSamplerState
                                ? `${FILTER_NAMES[dc.effectiveSamplerState.minFilter] ?? dc.effectiveSamplerState.minFilter}/${FILTER_NAMES[dc.effectiveSamplerState.magFilter] ?? dc.effectiveSamplerState.magFilter}/${MIPFILTER_NAMES[dc.effectiveSamplerState.mipFilter] ?? dc.effectiveSamplerState.mipFilter} ${ADDRESS_NAMES[dc.effectiveSamplerState.addressU] ?? dc.effectiveSamplerState.addressU}/${ADDRESS_NAMES[dc.effectiveSamplerState.addressV] ?? dc.effectiveSamplerState.addressV}`
                                : "not prepared"}
                        </span>
                        <span style={{ color: "#888" }}>forcePointFilter</span>
                        <span>{dc.forcePointFilter ? "YES" : "no"}</span>
                    </div>
                </div>

                {/* Vertices */}
                {dc.firstVertices.length > 0 && (
                    <div style={secStyle}>
                        <div style={labelStyle}>First Vertices</div>
                        {dc.firstVertices.map((v, i) => (
                            <div key={i} style={{ paddingLeft: 8, color: "#ccc" }}>
                                v{i}: ({v.x.toFixed(2)}, {v.y.toFixed(2)}, {v.z.toFixed(4)}{v.w !== undefined ? `, w=${v.w.toFixed(4)}` : ""})
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Right: texture preview + bit15 analysis */}
            {dc.tex0 && (
                <div style={{ width: 220, flexShrink: 0, textAlign: "center" }}>
                    <div style={{ ...labelStyle, color: "#4CAF50", textAlign: "center" }}>Preview</div>
                    {texPreview ? (
                        <img
                            src={texPreview}
                            style={{ maxWidth: 128, maxHeight: 128, border: "1px solid #444", imageRendering: "pixelated" }}
                            alt="texture"
                        />
                    ) : (
                        <div style={{ color: "#666", fontSize: 10, paddingTop: 20 }}>Loading...</div>
                    )}
                    {dc.tex0.aMask === 0x8000 && (
                        <div style={{ marginTop: 8, textAlign: "left" }}>
                            <button
                                onClick={onCheckBit15}
                                style={{ padding: "3px 8px", border: "1px solid #555", borderRadius: 4, backgroundColor: "#252540", color: "#e0e0e0", cursor: "pointer", fontSize: 11, marginBottom: 4 }}
                            >
                                Check bit15 (alpha)
                            </button>
                            {bit15Stats && (
                                <div style={{ fontSize: 10, lineHeight: 1.5, color: "#ccc" }}>
                                    <div>Total: {bit15Stats.total}</div>
                                    <div style={{ color: "#4CAF50" }}>bit15=1 (opaque): {bit15Stats.bit15set} ({(bit15Stats.bit15set / bit15Stats.total * 100).toFixed(1)}%)</div>
                                    <div style={{ color: "#f44336" }}>bit15=0 (transp): {bit15Stats.bit15clear} ({(bit15Stats.bit15clear / bit15Stats.total * 100).toFixed(1)}%)</div>
                                    <div style={{ color: "#ff9800", fontWeight: "bold" }}>
                                        Black+bit15=1: {bit15Stats.blackWithBit15}
                                    </div>
                                    <div style={{ color: "#f44336", fontWeight: "bold" }}>
                                        Black+bit15=0: {bit15Stats.blackWithoutBit15}
                                    </div>
                                    {bit15Stats.sample.length > 0 && (
                                        <div style={{ marginTop: 4, fontSize: 9, maxHeight: 100, overflow: "auto" }}>
                                            <div style={{ color: "#888" }}>Sample pixels:</div>
                                            {bit15Stats.sample.map((s, i) => (
                                                <div key={i}>
                                                    ({s.x},{s.y}) raw={hex(s.raw)} b15={s.bit15} rgb=({s.r},{s.g},{s.b})
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
