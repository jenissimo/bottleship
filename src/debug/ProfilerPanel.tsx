import { ChartBar, ListBullets, MagnifyingGlass, Skull, Trophy, Warning } from "@phosphor-icons/react";
import React, { useEffect, useState, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ProfilerEntry = {
    avgTime: number;
    totalTime: number;
    count: number;
    maxTime: number;
    counters: Record<string, number>;
};

type FrameCategoryBreakdown = {
    thunk: number;
    gpu: number;
    present: number;
    audio: number;
    scheduler: number;
    v86: number;
    idle: number;
};

type FrameCategory = keyof FrameCategoryBreakdown;

type FrameSample = {
    frameMs: number;
    fps: number;
    v86Ms: number;
    timestamp: number;
    categories: FrameCategoryBreakdown;
    threadSwitchCount?: number;
    activeThreadCount?: number;
};

export type ThunkAggregate = {
    count: number;
    totalMs: number;
};

export type BadFrameCapture = {
    id: number;
    timestamp: number;
    frameMs: number;
    categories: Record<FrameCategory, number>;
    thunkAggregates: Record<string, ThunkAggregate>;
    threadSwitchCount: number;
    activeThreadCount: number;
    reason: "spike" | "threshold" | "manual";
};

type FrameStatsSnapshot = {
    enabled: boolean;
    source: string | null;
    sampleCount: number;
    windowSize: number;
    latest?: FrameSample;
    average?: FrameSample;
    samples: FrameSample[];
    badFrames?: BadFrameCapture[];
};

type LoggerStats = {
    calls: number;
    totalMs: number;
    consoleCalls: number;
    consoleMs: number;
    periodMs: number;
};

type BusyWaitStats = {
    yieldCount: number;
    callsInWindow: number;
    timeWarpActive: boolean;
};

type ProfilerPanelProps = {
    isOpen: boolean;
    onClose: () => void;
    worker: Worker | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Category Colors & Constants
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<FrameCategory | "untracked", string> = {
    v86: "#4a9eff",       // Blue - x86 emulation
    thunk: "#ff6b6b",     // Red - HLE overhead
    gpu: "#50c878",       // Green - GPU submission
    present: "#ffd93d",   // Yellow - Present/Flip
    audio: "#a78bfa",     // Purple - Audio processing
    scheduler: "#f97316", // Orange - Thread scheduling
    idle: "#334155",      // Dark Slate - Sleep/Wait time
    untracked: "#6b7280", // Gray - Unaccounted time
};

const CATEGORY_LABELS: Record<FrameCategory | "untracked", string> = {
    v86: "V86 (x86)",
    thunk: "Thunk (HLE)",
    gpu: "GPU Submit",
    present: "Present",
    audio: "Audio",
    scheduler: "Scheduler",
    idle: "Idle (Yield)",
    untracked: "Untracked",
};

const FRAME_TIME_60FPS = 16.67;
const FRAME_TIME_30FPS = 33.33;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function getCategoryTotal(sample: FrameSample): number {
    const c = sample.categories;
    return (c.thunk || 0) + (c.gpu || 0) + (c.present || 0) + (c.audio || 0) + (c.scheduler || 0) + (c.v86 || 0) + (c.idle || 0);
}

function getUntracked(sample: FrameSample): number {
    return Math.max(0, sample.frameMs - getCategoryTotal(sample));
}

function findBestWorstFrames(samples: FrameSample[]): { best: FrameSample | null; worst: FrameSample | null } {
    if (samples.length === 0) return { best: null, worst: null };
    let best = samples[0];
    let worst = samples[0];
    for (const s of samples) {
        if (s.frameMs < best.frameMs) best = s;
        if (s.frameMs > worst.frameMs) worst = s;
    }
    return { best, worst };
}

// ─────────────────────────────────────────────────────────────────────────────
// FrameTimelineChart - Stacked bar chart showing recent frames
// ─────────────────────────────────────────────────────────────────────────────

type FrameTimelineChartProps = {
    samples: FrameSample[];
    visibleCategories: Set<FrameCategory | "untracked">;
    onHoverFrame: (index: number | null) => void;
    hoveredFrame: number | null;
};

function FrameTimelineChart({ samples, visibleCategories, onHoverFrame, hoveredFrame }: FrameTimelineChartProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        const padding = { top: 20, right: 10, bottom: 25, left: 45 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;

        // Clear
        ctx.fillStyle = "#1a1a2e";
        ctx.fillRect(0, 0, width, height);

        if (samples.length === 0) {
            ctx.fillStyle = "#888";
            ctx.font = "12px monospace";
            ctx.textAlign = "center";
            ctx.fillText("No frame data yet", width / 2, height / 2);
            return;
        }

        // Determine max frame time for Y scale
        const maxFrameMs = Math.max(50, ...samples.map(s => s.frameMs));
        const barWidth = Math.max(2, chartWidth / samples.length - 1);
        const gap = 1;

        // Draw reference lines
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "#4ade80";
        ctx.lineWidth = 1;
        const y60fps = padding.top + chartHeight * (1 - FRAME_TIME_60FPS / maxFrameMs);
        ctx.beginPath();
        ctx.moveTo(padding.left, y60fps);
        ctx.lineTo(width - padding.right, y60fps);
        ctx.stroke();

        ctx.strokeStyle = "#fbbf24";
        const y30fps = padding.top + chartHeight * (1 - FRAME_TIME_30FPS / maxFrameMs);
        ctx.beginPath();
        ctx.moveTo(padding.left, y30fps);
        ctx.lineTo(width - padding.right, y30fps);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw Y axis labels
        ctx.fillStyle = "#888";
        ctx.font = "10px monospace";
        ctx.textAlign = "right";
        ctx.fillText("60fps", padding.left - 4, y60fps + 3);
        ctx.fillText("30fps", padding.left - 4, y30fps + 3);
        ctx.fillText(`${maxFrameMs.toFixed(0)}ms`, padding.left - 4, padding.top + 3);

        // Stack order for drawing (bottom to top)
        const stackOrder: (FrameCategory | "untracked")[] = ["idle", "v86", "thunk", "gpu", "present", "audio", "scheduler", "untracked"];

        // Draw bars
        samples.forEach((sample, i) => {
            const x = padding.left + i * (barWidth + gap);
            let yBottom = padding.top + chartHeight;

            for (const cat of stackOrder) {
                if (!visibleCategories.has(cat)) continue;
                const value = cat === "untracked" ? getUntracked(sample) : sample.categories[cat];
                if (value <= 0) continue;

                const barHeight = (value / maxFrameMs) * chartHeight;
                const yTop = yBottom - barHeight;

                ctx.fillStyle = CATEGORY_COLORS[cat];
                ctx.fillRect(x, yTop, barWidth, barHeight);
                yBottom = yTop;
            }

            // Highlight hovered frame
            if (hoveredFrame === i) {
                ctx.strokeStyle = "#fff";
                ctx.lineWidth = 2;
                ctx.strokeRect(x - 1, padding.top, barWidth + 2, chartHeight);
            }
        });

        // X axis label
        ctx.fillStyle = "#666";
        ctx.font = "10px monospace";
        ctx.textAlign = "center";
        ctx.fillText(`← older    ${samples.length} frames    newer →`, width / 2, height - 5);
    }, [samples, visibleCategories, hoveredFrame]);

    useEffect(() => {
        draw();
    }, [draw]);

    const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas || samples.length === 0) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const padding = { left: 45, right: 10 };
        const chartWidth = canvas.width - padding.left - padding.right;
        const barWidth = chartWidth / samples.length;

        if (x < padding.left || x > canvas.width - padding.right) {
            onHoverFrame(null);
            return;
        }

        const index = Math.floor((x - padding.left) / barWidth);
        if (index >= 0 && index < samples.length) {
            onHoverFrame(index);
        } else {
            onHoverFrame(null);
        }
    };

    return (
        <div ref={containerRef} style={{ position: "relative" }}>
            <canvas
                ref={canvasRef}
                width={560}
                height={120}
                style={{ display: "block" }}
                onMouseMove={handleMouseMove}
                onMouseLeave={() => onHoverFrame(null)}
            />
            {hoveredFrame !== null && samples[hoveredFrame] && (
                <div style={{
                    position: "absolute",
                    top: 5,
                    right: 10,
                    background: "rgba(0,0,0,0.85)",
                    padding: "6px 10px",
                    borderRadius: 4,
                    fontSize: 10,
                    color: "#fff",
                    pointerEvents: "none",
                }}>
                    <div><b>Frame #{hoveredFrame + 1}</b></div>
                    <div>{samples[hoveredFrame].frameMs.toFixed(2)} ms ({samples[hoveredFrame].fps.toFixed(1)} FPS)</div>
                </div>
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// FrameDistributionHistogram - Shows frame time distribution
// ─────────────────────────────────────────────────────────────────────────────

type FrameDistributionHistogramProps = {
    samples: FrameSample[];
};

function FrameDistributionHistogram({ samples }: FrameDistributionHistogramProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        const padding = { top: 15, right: 10, bottom: 25, left: 35 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;

        // Clear
        ctx.fillStyle = "#1a1a2e";
        ctx.fillRect(0, 0, width, height);

        if (samples.length === 0) {
            ctx.fillStyle = "#888";
            ctx.font = "11px monospace";
            ctx.textAlign = "center";
            ctx.fillText("No data", width / 2, height / 2);
            return;
        }

        // Create buckets: 0-10, 10-16.67, 16.67-20, 20-33.33, 33.33-50, 50+
        const buckets = [
            { label: "<10", max: 10, count: 0, color: "#22c55e" },
            { label: "10-17", max: 16.67, count: 0, color: "#4ade80" },
            { label: "17-20", max: 20, count: 0, color: "#fbbf24" },
            { label: "20-33", max: 33.33, count: 0, color: "#f97316" },
            { label: "33-50", max: 50, count: 0, color: "#ef4444" },
            { label: "50+", max: Infinity, count: 0, color: "#dc2626" },
        ];

        for (const s of samples) {
            for (const b of buckets) {
                if (s.frameMs < b.max) {
                    b.count++;
                    break;
                }
            }
        }

        const maxCount = Math.max(1, ...buckets.map(b => b.count));
        const barWidth = chartWidth / buckets.length - 4;

        // Draw bars
        buckets.forEach((bucket, i) => {
            const x = padding.left + i * (barWidth + 4) + 2;
            const barHeight = (bucket.count / maxCount) * chartHeight;
            const y = padding.top + chartHeight - barHeight;

            ctx.fillStyle = bucket.color;
            ctx.fillRect(x, y, barWidth, barHeight);

            // Count label on top
            if (bucket.count > 0) {
                ctx.fillStyle = "#fff";
                ctx.font = "9px monospace";
                ctx.textAlign = "center";
                ctx.fillText(String(bucket.count), x + barWidth / 2, y - 3);
            }

            // X label
            ctx.fillStyle = "#888";
            ctx.font = "9px monospace";
            ctx.textAlign = "center";
            ctx.fillText(bucket.label, x + barWidth / 2, height - 5);
        });

        // Y axis
        ctx.fillStyle = "#666";
        ctx.font = "9px monospace";
        ctx.textAlign = "right";
        ctx.fillText("ms", padding.left - 4, padding.top + chartHeight + 12);
    }, [samples]);

    return (
        <canvas ref={canvasRef} width={280} height={100} style={{ display: "block" }} />
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// FrameComparison - Best vs Worst frame breakdown
// ─────────────────────────────────────────────────────────────────────────────

type FrameComparisonProps = {
    samples: FrameSample[];
};

function FrameComparison({ samples }: FrameComparisonProps) {
    const { best, worst } = findBestWorstFrames(samples);

    if (!best || !worst || samples.length < 2) {
        return (
            <div style={{ padding: 10, color: "#888", fontSize: 11, textAlign: "center" }}>
                Need more samples to compare
            </div>
        );
    }

    const categories: (FrameCategory | "untracked")[] = ["idle", "v86", "thunk", "gpu", "present", "audio", "scheduler", "untracked"];

    const getValue = (sample: FrameSample, cat: FrameCategory | "untracked") =>
        cat === "untracked" ? getUntracked(sample) : sample.categories[cat];

    // Find culprit: largest delta
    let culprit: FrameCategory | "untracked" = "untracked";
    let maxDelta = 0;
    for (const cat of categories) {
        const delta = getValue(worst, cat) - getValue(best, cat);
        if (delta > maxDelta) {
            maxDelta = delta;
            culprit = cat;
        }
    }

    const formatMs = (v: number) => v.toFixed(2);
    const totalDelta = worst.frameMs - best.frameMs;

    return (
        <div style={{ fontSize: 11 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, padding: "0 6px" }}>
                <span style={{ color: "#4ade80" }}><Trophy size={15} aria-hidden /> Best: {formatMs(best.frameMs)} ms</span>
                <span style={{ color: "#ef4444" }}><Skull size={15} aria-hidden /> Worst: {formatMs(worst.frameMs)} ms</span>
                <span style={{ color: "#fbbf24" }}>Δ {formatMs(totalDelta)} ms</span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                <thead>
                    <tr style={{ color: "#888", borderBottom: "1px solid #333" }}>
                        <th style={{ padding: "2px 4px", textAlign: "left" }}>Category</th>
                        <th style={{ padding: "2px 4px", textAlign: "right" }}>Best</th>
                        <th style={{ padding: "2px 4px", textAlign: "right" }}>Worst</th>
                        <th style={{ padding: "2px 4px", textAlign: "right" }}>Δ</th>
                    </tr>
                </thead>
                <tbody>
                    {categories.map(cat => {
                        const bestVal = getValue(best, cat);
                        const worstVal = getValue(worst, cat);
                        const delta = worstVal - bestVal;
                        const isCulprit = cat === culprit && delta > 0;
                        return (
                            <tr key={cat} style={{
                                borderBottom: "1px solid #222",
                                backgroundColor: isCulprit ? "rgba(239, 68, 68, 0.15)" : undefined,
                            }}>
                                <td style={{ padding: "2px 4px", color: CATEGORY_COLORS[cat] }}>
                                    {isCulprit && <Warning size={14} aria-hidden />} {CATEGORY_LABELS[cat]}
                                </td>
                                <td style={{ padding: "2px 4px", textAlign: "right", color: "#4ade80" }}>
                                    {formatMs(bestVal)}
                                </td>
                                <td style={{ padding: "2px 4px", textAlign: "right", color: "#ef4444" }}>
                                    {formatMs(worstVal)}
                                </td>
                                <td style={{ padding: "2px 4px", textAlign: "right", color: delta > 0 ? "#fbbf24" : "#666" }}>
                                    {delta > 0 ? `+${formatMs(delta)}` : formatMs(delta)}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// HotThunksTable - Displays hot thunks for a bad frame
// ─────────────────────────────────────────────────────────────────────────────

type HotThunksTableProps = {
    thunkAggregates: Record<string, ThunkAggregate>;
};

type ThunkSortKey = "totalMs" | "count" | "avgMs";

function HotThunksTable({ thunkAggregates }: HotThunksTableProps) {
    const [sortKey, setSortKey] = useState<ThunkSortKey>("totalMs");

    const getAvg = (agg: ThunkAggregate) => agg.count > 0 ? agg.totalMs / agg.count : 0;

    const hotThunks = Object.entries(thunkAggregates)
        .sort((a, b) => {
            if (sortKey === "count") return b[1].count - a[1].count;
            if (sortKey === "avgMs") return getAvg(b[1]) - getAvg(a[1]);
            return b[1].totalMs - a[1].totalMs;
        })
        .slice(0, 10);

    const formatMs = (v: number) => v.toFixed(2);
    const formatUs = (v: number) => (v * 1000).toFixed(0);

    const thStyle = (key: ThunkSortKey): React.CSSProperties => ({
        textAlign: "right" as const,
        padding: "2px 0",
        cursor: "pointer",
        color: sortKey === key ? "#4a9eff" : "#888",
        userSelect: "none" as const,
    });

    return (
        <div style={{ flex: 1.5 }}>
            <div style={{ fontSize: 11, color: "#ef4444", marginBottom: 4, fontWeight: "bold" }}>
                Hot Thunks (WinAPI)
                <span style={{ fontWeight: "normal", color: "#666", marginLeft: 6, fontSize: 9 }}>click header to sort</span>
            </div>
            {hotThunks.length > 0 ? (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                    <thead>
                        <tr style={{ borderBottom: "1px solid #333" }}>
                            <th style={{ textAlign: "left", padding: "2px 0", color: "#888" }}>Call Name</th>
                            <th style={thStyle("count")} onClick={() => setSortKey("count")}>
                                Count{sortKey === "count" ? " v" : ""}
                            </th>
                            <th style={thStyle("avgMs")} onClick={() => setSortKey("avgMs")}>
                                Avg{sortKey === "avgMs" ? " v" : ""}
                            </th>
                            <th style={thStyle("totalMs")} onClick={() => setSortKey("totalMs")}>
                                Total{sortKey === "totalMs" ? " v" : ""}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {hotThunks.map(([name, agg]) => {
                            const avg = getAvg(agg);
                            return (
                                <tr key={name} style={{ borderBottom: "1px solid #222" }}>
                                    <td style={{ padding: "3px 0", color: "#e0e0e0" }}>{name}</td>
                                    <td style={{ padding: "3px 0", textAlign: "right", color: sortKey === "count" ? "#4a9eff" : "#888", fontWeight: sortKey === "count" ? "bold" : "normal" }}>
                                        {agg.count}
                                    </td>
                                    <td style={{ padding: "3px 0", textAlign: "right", color: sortKey === "avgMs" ? "#fbbf24" : "#888", fontWeight: sortKey === "avgMs" ? "bold" : "normal" }}>
                                        {formatUs(avg)}us
                                    </td>
                                    <td style={{ padding: "3px 0", textAlign: "right", color: sortKey === "totalMs" ? "#ff6b6b" : "#888", fontWeight: sortKey === "totalMs" ? "bold" : "normal" }}>
                                        {formatMs(agg.totalMs)}ms
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            ) : (
                <div style={{ color: "#666", fontSize: 10 }}>No thunk data recorded for this frame</div>
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// BadFrameInspector - Detailed view of a specific bad frame
// ─────────────────────────────────────────────────────────────────────────────

type BadFrameInspectorProps = {
    badFrame: BadFrameCapture;
};

function BadFrameInspector({ badFrame }: BadFrameInspectorProps) {
    const categories: (FrameCategory | "untracked")[] = ["idle", "v86", "thunk", "gpu", "present", "audio", "scheduler", "untracked"];
    
    // Calculate total categorized time
    const cats = badFrame.categories;
    const categorizedTotal = (cats.thunk || 0) + (cats.gpu || 0) + (cats.present || 0) + (cats.audio || 0) + (cats.scheduler || 0) + (cats.v86 || 0) + (cats.idle || 0);
    const untracked = Math.max(0, badFrame.frameMs - categorizedTotal);

    const getValue = (cat: FrameCategory | "untracked") => cat === "untracked" ? untracked : cats[cat as FrameCategory];

    const formatMs = (v: number) => v.toFixed(2);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Breakdown bar */}
            <div style={{ height: 16, display: "flex", borderRadius: 4, overflow: "hidden", border: "1px solid #333" }}>
                {categories.map(cat => {
                    const val = getValue(cat);
                    const pct = (val / badFrame.frameMs) * 100;
                    if (pct < 1) return null;
                    return (
                        <div key={cat} style={{ 
                            width: `${pct}%`, 
                            backgroundColor: CATEGORY_COLORS[cat], 
                            height: "100%" 
                        }} title={`${CATEGORY_LABELS[cat]}: ${formatMs(val)}ms (${pct.toFixed(1)}%)`} />
                    );
                })}
            </div>

            <div style={{ display: "flex", gap: 15 }}>
                {/* Left: Category List */}
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: "#888", marginBottom: 4, fontWeight: "bold" }}>Breakdown</div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                        <tbody>
                            {categories.map(cat => {
                                const val = getValue(cat);
                                const pct = (val / badFrame.frameMs) * 100;
                                if (val <= 0) return null;
                                return (
                                    <tr key={cat} style={{ borderBottom: "1px solid #222" }}>
                                        <td style={{ padding: "2px 0", color: CATEGORY_COLORS[cat] }}>{CATEGORY_LABELS[cat]}</td>
                                        <td style={{ padding: "2px 0", textAlign: "right" }}>{formatMs(val)} ms</td>
                                        <td style={{ padding: "2px 0", textAlign: "right", color: "#666" }}>{pct.toFixed(1)}%</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    {/* Thread Stats */}
                    <div style={{ flex: 1, marginTop: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                            <span style={{ fontSize: 10, opacity: 0.7 }}>Thread Stats</span>
                            <span style={{ fontSize: 10, color: "#38bdf8" }}>
                                {badFrame.activeThreadCount || 0} active, {badFrame.threadSwitchCount || 0} switches
                            </span>
                        </div>
                    </div>
                </div>

                {/* Right: Hot Thunks */}
                <HotThunksTable thunkAggregates={badFrame.thunkAggregates} />
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// CategoryLegend - Interactive legend with toggles
// ─────────────────────────────────────────────────────────────────────────────

type CategoryLegendProps = {
    visibleCategories: Set<FrameCategory | "untracked">;
    onToggle: (cat: FrameCategory | "untracked") => void;
};

function CategoryLegend({ visibleCategories, onToggle }: CategoryLegendProps) {
    const categories: (FrameCategory | "untracked")[] = ["idle", "v86", "thunk", "gpu", "present", "audio", "scheduler", "untracked"];

    return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", fontSize: 10, padding: "4px 0" }}>
            {categories.map(cat => (
                <label
                    key={cat}
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        cursor: "pointer",
                        opacity: visibleCategories.has(cat) ? 1 : 0.4,
                    }}
                >
                    <span style={{
                        width: 10,
                        height: 10,
                        backgroundColor: CATEGORY_COLORS[cat],
                        borderRadius: 2,
                    }} />
                    <input
                        type="checkbox"
                        checked={visibleCategories.has(cat)}
                        onChange={() => onToggle(cat)}
                        style={{ display: "none" }}
                    />
                    <span style={{ color: CATEGORY_COLORS[cat] }}>{CATEGORY_LABELS[cat]}</span>
                </label>
            ))}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProfilerPanel - Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function ProfilerPanel({ isOpen, onClose, worker }: ProfilerPanelProps) {
    const [stats, setStats] = useState<Record<string, ProfilerEntry>>({});
    const [isProfiling, setIsProfiling] = useState(false);
    const [lastUpdate, setLastUpdate] = useState(0);
    const [frameStats, setFrameStats] = useState<FrameStatsSnapshot | null>(null);
    const [loggerStats, setLoggerStats] = useState<LoggerStats | null>(null);
    const [busyWaitStats, setBusyWaitStats] = useState<BusyWaitStats | null>(null);
    const [loggerProfilingEnabled, setLoggerProfilingEnabled] = useState(false);

    // New state for enhanced profiler
    const [hoveredFrame, setHoveredFrame] = useState<number | null>(null);
    const [visibleCategories, setVisibleCategories] = useState<Set<FrameCategory | "untracked">>(
        new Set(["v86", "thunk", "gpu", "present", "audio", "scheduler", "untracked", "idle"])
    );
    const [activeTab, setActiveTab] = useState<"timeline" | "worst" | "ops">("timeline");
    const [selectedBadFrameId, setSelectedBadFrameId] = useState<number | null>(null);

    useEffect(() => {
        if (!worker || !isOpen) return;

        const handler = (event: MessageEvent) => {
            const { type, ok, stats: newStats, enabled, frameStats: newFrameStats, loggerStats: newLoggerStats, busyWaitStats: newBusyWaitStats } = event.data;

            if (type === "profiler_stats" && ok) {
                setStats(newStats);
                if (newFrameStats) {
                    setFrameStats(newFrameStats);
                }
                if (newLoggerStats) {
                    setLoggerStats(newLoggerStats);
                }
                if (newBusyWaitStats) {
                    setBusyWaitStats(newBusyWaitStats);
                }
                setLastUpdate(Date.now());
            } else if (type === "profiler_enable" && ok) {
                setIsProfiling(enabled);
            } else if (type === "logger_profiling_enable" && ok) {
                setLoggerProfilingEnabled(enabled);
            }
        };

        worker.addEventListener("message", handler);
        
        // Initial stats request
        worker.postMessage({ type: "profiler_stats" });
        
        // Start periodic polling
        const interval = setInterval(() => {
            worker.postMessage({ type: "profiler_stats" });
        }, 1000);

        return () => {
            worker.removeEventListener("message", handler);
            clearInterval(interval);
        };
    }, [worker, isOpen]);

    const toggleProfiling = () => {
        if (!worker) return;
        const newState = !isProfiling;
        worker.postMessage({ type: "profiler_enable", enabled: newState });
        setIsProfiling(newState);
    };

    const resetStats = () => {
        if (!worker) return;
        worker.postMessage({ type: "profiler_reset" });
        setStats({});
        setFrameStats(null);
    };

    const toggleCategory = (cat: FrameCategory | "untracked") => {
        setVisibleCategories(prev => {
            const next = new Set(prev);
            if (next.has(cat)) {
                next.delete(cat);
            } else {
                next.add(cat);
            }
            return next;
        });
    };

    if (!isOpen) return null;

    const entries = Object.entries(stats).sort((a, b) => b[1].totalTime - a[1].totalTime);
    const samples = frameStats?.samples ?? [];
    const averageFrame = frameStats?.average;
    const latestFrame = frameStats?.latest;
    const formatMs = (value: number) => value.toFixed(2);

    return (
        <div style={{
            position: "fixed",
            top: 10,
            right: 10,
            width: 600,
            maxHeight: "95vh",
            backgroundColor: "#1a1a2e",
            border: "1px solid #4a4a6a",
            borderRadius: 8,
            boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
            zIndex: 10001,
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
                <span style={{ fontWeight: "bold", fontSize: 14 }}>System Profiler</span>
                <div style={{ display: "flex", gap: 8 }}>
                    <button
                        onClick={toggleProfiling}
                        style={{
                            padding: "4px 8px",
                            backgroundColor: isProfiling ? "#f44336" : "#4CAF50",
                            border: "none",
                            borderRadius: 4,
                            color: "white",
                            cursor: "pointer",
                        }}
                    >
                        {isProfiling ? "Stop Profiling" : "Start Profiling"}
                    </button>
                    <button
                        onClick={resetStats}
                        style={{
                            padding: "4px 8px",
                            backgroundColor: "#555",
                            border: "none",
                            borderRadius: 4,
                            color: "white",
                            cursor: "pointer",
                        }}
                    >
                        Reset
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

            {/* Tab Switcher */}
            <div style={{
                display: "flex",
                borderBottom: "1px solid #333",
                backgroundColor: "#1f1f33",
            }}>
                <button
                    onClick={() => setActiveTab("timeline")}
                    style={{
                        flex: 1,
                        padding: "8px",
                        backgroundColor: activeTab === "timeline" ? "#2a2a4a" : "transparent",
                        border: "none",
                        borderBottom: activeTab === "timeline" ? "2px solid #4a9eff" : "2px solid transparent",
                        color: activeTab === "timeline" ? "#fff" : "#888",
                        cursor: "pointer",
                        fontSize: 11,
                    }}
                >
                    <ChartBar size={16} aria-hidden /> Frame Analysis
                </button>
                <button
                    onClick={() => setActiveTab("worst")}
                    style={{
                        flex: 1,
                        padding: "8px",
                        backgroundColor: activeTab === "worst" ? "#2a2a4a" : "transparent",
                        border: "none",
                        borderBottom: activeTab === "worst" ? "2px solid #ef4444" : "2px solid transparent",
                        color: activeTab === "worst" ? "#fff" : "#888",
                        cursor: "pointer",
                        fontSize: 11,
                    }}
                >
                    <Skull size={15} aria-hidden /> Worst Frames
                </button>
                <button
                    onClick={() => setActiveTab("ops")}
                    style={{
                        flex: 1,
                        padding: "8px",
                        backgroundColor: activeTab === "ops" ? "#2a2a4a" : "transparent",
                        border: "none",
                        borderBottom: activeTab === "ops" ? "2px solid #4ade80" : "2px solid transparent",
                        color: activeTab === "ops" ? "#fff" : "#888",
                        cursor: "pointer",
                        fontSize: 11,
                    }}
                >
                    <ListBullets size={16} aria-hidden /> Operations
                </button>
            </div>

            {/* FPS Summary Row */}
            {averageFrame && latestFrame && (
                <div style={{
                    padding: "8px 15px",
                    borderBottom: "1px solid #333",
                    backgroundColor: "#1f1f33",
                    display: "flex",
                    gap: 20,
                    fontSize: 11,
                }}>
                    <span style={{ color: "#4ade80" }}>
                        FPS: <b>{latestFrame.fps.toFixed(1)}</b> (avg {averageFrame.fps.toFixed(1)})
                    </span>
                    <span style={{ color: "#8aa0ff" }}>
                        Frame: <b>{formatMs(latestFrame.frameMs)} ms</b> (avg {formatMs(averageFrame.frameMs)} ms)
                    </span>
                    {(latestFrame.activeThreadCount ?? 0) > 0 && (
                        <span style={{ color: "#aaccff" }}>
                            Threads: {latestFrame.activeThreadCount}
                        </span>
                    )}
                    <span style={{ color: "#888" }}>
                        {frameStats?.source ?? ""} | {samples.length} samples
                    </span>
                </div>
            )}

            {/* Content Area */}
            <div style={{ flex: 1, overflowY: "auto" }}>
                {activeTab === "timeline" && (
                    <div>
                        {/* Category Legend */}
                        <div style={{ padding: "8px 15px", borderBottom: "1px solid #333" }}>
                            <CategoryLegend
                                visibleCategories={visibleCategories}
                                onToggle={toggleCategory}
                            />
                        </div>

                        {/* Frame Timeline Chart */}
                        <div style={{ padding: "10px 15px", borderBottom: "1px solid #333" }}>
                            <div style={{ marginBottom: 6, color: "#cfd3ff", fontSize: 11, fontWeight: "bold" }}>
                                Frame Timeline
                                <span style={{ fontWeight: "normal", color: "#666", marginLeft: 8 }}>
                                    (hover for details)
                                </span>
                            </div>
                            <FrameTimelineChart
                                samples={samples}
                                visibleCategories={visibleCategories}
                                onHoverFrame={setHoveredFrame}
                                hoveredFrame={hoveredFrame}
                            />
                        </div>

                        {/* Histogram + Comparison Row */}
                        <div style={{
                            display: "flex",
                            borderBottom: "1px solid #333",
                        }}>
                            {/* Histogram */}
                            <div style={{ flex: 1, padding: 10, borderRight: "1px solid #333" }}>
                                <div style={{ marginBottom: 6, color: "#cfd3ff", fontSize: 11, fontWeight: "bold" }}>
                                    Frame Distribution
                                </div>
                                <FrameDistributionHistogram samples={samples} />
                            </div>

                            {/* Best vs Worst */}
                            <div style={{ flex: 1, padding: 10 }}>
                                <div style={{ marginBottom: 6, color: "#cfd3ff", fontSize: 11, fontWeight: "bold" }}>
                                    Best vs Worst Frame
                                </div>
                                <FrameComparison samples={samples} />
                            </div>
                        </div>

                        {/* Logger & Busy-wait Stats */}
                        {(loggerStats || busyWaitStats) && (
                            <div style={{ padding: 10, borderBottom: "1px solid #333", backgroundColor: "#1a1a2a", display: "flex", gap: 20, fontSize: 11 }}>
                                {loggerStats && loggerStats.periodMs > 0 && (
                                    <div>
                                        <span style={{ color: "#888" }}>Logger: </span>
                                        <span style={{ color: "#b8ffb8" }}>{loggerStats.calls} calls</span>
                                        <span style={{ color: "#666" }}> / </span>
                                        <span style={{ color: "#ffb8b8" }}>{loggerStats.totalMs.toFixed(1)}ms</span>
                                        <span style={{ color: "#666" }}> ({(loggerStats.totalMs / loggerStats.periodMs * 100).toFixed(1)}% of time)</span>
                                        {loggerStats.consoleCalls > 0 && (
                                            <span style={{ color: "#888" }}> | console: {loggerStats.consoleCalls} calls, {loggerStats.consoleMs.toFixed(1)}ms</span>
                                        )}
                                    </div>
                                )}
                                {busyWaitStats && (
                                    <div>
                                        <span style={{ color: "#888" }}>Busy-wait: </span>
                                        <span style={{ color: busyWaitStats.timeWarpActive ? "#ffff88" : "#88ff88" }}>
                                            {busyWaitStats.timeWarpActive ? "ACTIVE" : "idle"}
                                        </span>
                                        <span style={{ color: "#666" }}> | QPC/window: {busyWaitStats.callsInWindow}</span>
                                        <span style={{ color: "#666" }}> | yields: {busyWaitStats.yieldCount}</span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {activeTab === "worst" && (
                    <div style={{ padding: "10px 15px", display: "flex", flexDirection: "column", gap: 15 }}>
                        <div style={{ fontSize: 11, color: "#888" }}>
                            Automatically captures frames that are significantly slower than average or miss the frame budget. 
                            Last {frameStats?.badFrames?.length ?? 0} captures.
                        </div>

                        {(!frameStats?.badFrames || frameStats.badFrames.length === 0) ? (
                            <div style={{ 
                                padding: "40px 0", 
                                textAlign: "center", 
                                color: "#666", 
                                border: "1px dashed #333",
                                borderRadius: 8
                            }}>
                                No performance spikes captured yet.
                            </div>
                        ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
                                {/* List of bad frames */}
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", borderBottom: "1px solid #333", paddingBottom: 10 }}>
                                    {frameStats.badFrames.map(bf => (
                                        <button 
                                            key={bf.id}
                                            onClick={() => setSelectedBadFrameId(bf.id)}
                                            style={{
                                                padding: "6px 10px",
                                                backgroundColor: (selectedBadFrameId === bf.id || (selectedBadFrameId === null && bf.id === frameStats.badFrames![frameStats.badFrames!.length - 1].id)) ? "#3b3b6a" : "#1f1f33",
                                                border: "1px solid",
                                                borderColor: (selectedBadFrameId === bf.id || (selectedBadFrameId === null && bf.id === frameStats.badFrames![frameStats.badFrames!.length - 1].id)) ? "#ef4444" : "#333",
                                                borderRadius: 4,
                                                color: (selectedBadFrameId === bf.id || (selectedBadFrameId === null && bf.id === frameStats.badFrames![frameStats.badFrames!.length - 1].id)) ? "#fff" : "#888",
                                                cursor: "pointer",
                                                fontSize: 10,
                                                textAlign: "left"
                                            }}
                                        >
                                            <div style={{ fontWeight: "bold", color: bf.reason === "spike" ? "#ef4444" : "#fbbf24" }}>
                                                {bf.reason === "spike" ? "SPIKE" : "SLOW"} #{bf.id}
                                            </div>
                                            <div>{bf.frameMs.toFixed(1)} ms</div>
                                        </button>
                                    ))}
                                </div>

                                {/* Inspector */}
                                {(() => {
                                    const selected = frameStats.badFrames.find(f => f.id === (selectedBadFrameId ?? frameStats.badFrames![frameStats.badFrames!.length - 1].id));
                                    if (!selected) return null;
                                    return (
                                        <div style={{ 
                                            padding: 12, 
                                            backgroundColor: "#1f1f33", 
                                            borderRadius: 8,
                                            border: "1px solid #444"
                                        }}>
                                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                                                <div style={{ fontSize: 13, fontWeight: "bold" }}>
                                                    <MagnifyingGlass size={16} aria-hidden /> Inspecting Frame #{selected.id}
                                                </div>
                                                <div style={{ fontSize: 11, color: "#888" }}>
                                                    {new Date(selected.timestamp).toLocaleTimeString()} · {selected.frameMs.toFixed(2)} ms
                                                </div>
                                            </div>
                                            <BadFrameInspector badFrame={selected} />
                                        </div>
                                    );
                                })()}
                            </div>
                        )}
                    </div>
                )}

                {activeTab === "ops" && (
                    <div style={{ padding: 10 }}>
                        {!isProfiling && entries.length === 0 && (
                            <div style={{ padding: 20, textAlign: "center", color: "#888" }}>
                                Click "Start Profiling" to begin measuring performance.
                            </div>
                        )}
                        
                        {entries.length > 0 && (
                            <table style={{ width: "100%", borderCollapse: "collapse" }} title="Operations sorted by Total time — top rows are the main cost">
                                <thead>
                                    <tr style={{ textAlign: "left", color: "#888", borderBottom: "1px solid #333" }}>
                                        <th style={{ padding: "4px 8px" }}>Operation</th>
                                        <th style={{ padding: "4px 8px" }}>Avg (ms)</th>
                                        <th style={{ padding: "4px 8px" }}>Max (ms)</th>
                                        <th style={{ padding: "4px 8px" }}>Count</th>
                                        <th style={{ padding: "4px 8px" }}>Total (ms)</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {entries.map(([id, entry]) => (
                                        <React.Fragment key={id}>
                                            <tr style={{ borderBottom: "1px solid #222" }}>
                                                <td style={{ padding: "6px 8px", color: "#8888ff" }}>{id}</td>
                                                <td style={{ padding: "6px 8px" }}>{entry.avgTime.toFixed(3)}</td>
                                                <td style={{ padding: "6px 8px" }}>{entry.maxTime.toFixed(2)}</td>
                                                <td style={{ padding: "6px 8px" }}>{entry.count}</td>
                                                <td style={{ padding: "6px 8px", fontWeight: "bold" }}>{entry.totalTime.toFixed(1)}</td>
                                            </tr>
                                            {Object.keys(entry.counters).length > 0 && (
                                                <tr>
                                                    <td colSpan={5} style={{ padding: "2px 20px", color: "#aaa", fontSize: 11, fontStyle: "italic" }}>
                                                        {Object.entries(entry.counters).map(([name, val]) => (
                                                            <span key={name} style={{ marginRight: 15 }}>
                                                                {name}: {name.includes("bytes") ? (val / 1024 / 1024).toFixed(2) + " MB" : val}
                                                            </span>
                                                        ))}
                                                    </td>
                                                </tr>
                                            )}
                                        </React.Fragment>
                                    ))}
                                </tbody>
                            </table>
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
                <span>{activeTab === "timeline" ? "Frame times at Flip/Present" : "Sorted by Total Time"}</span>
            </div>
        </div>
    );
}
