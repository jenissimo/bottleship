import { Circle } from "@phosphor-icons/react";
import React, { useEffect, useState, useRef } from "react";

type RegionInfo = {
    id: number;
    base: number;
    size: number;
    perms: string;
    kind: string;
    owner?: string;
    tag?: string;
};

type LeaseInfo = {
    id: number;
    base: number;
    size: number;
    owner: string;
    perms: "r" | "rw";
    tag?: string;
    durationMs: number;
};

type MemoryEvent = {
    timestamp: number;
    type: string;
    address: number;
    size: number;
    context?: string;
};

type GCPressureStats = {
    sampleCount: number;
    avgAllocRate: number;      // bytes/sec average
    peakAllocRate: number;     // bytes/sec peak
    totalAllocated: number;    // cumulative bytes since start
    totalFreed: number;        // cumulative bytes freed
    netGrowth: number;         // total - freed
    allocsPerSecond: number;   // allocation count rate
    freesPerSecond: number;    // free count rate
};

type MemoryStats = {
    totalMemory: number;
    usedHeap: number;
    regions: RegionInfo[];
    leases: LeaseInfo[];
    recentEvents: MemoryEvent[];
    gcPressure: GCPressureStats;
};

type MemoryMonitorBodyProps = {
    worker: Worker | null;
};

type HeapSample = {
    timestamp: number;
    usedHeap: number;
    allocRate: number;
};

const MAX_HISTORY = 60; // 60 samples for sparkline

/** Allocator/heap/GC tab of the Memory panel (memory_* worker RPC). Mount-scoped —
 *  subscribes and polls (1s) while mounted. */
export default function MemoryMonitorBody({ worker }: MemoryMonitorBodyProps) {
    const [stats, setStats] = useState<MemoryStats | null>(null);
    const [lastUpdate, setLastUpdate] = useState(0);
    const [isMonitoring, setIsMonitoring] = useState(false);
    const [viewMode, setViewMode] = useState<"overview" | "regions" | "leases" | "events">("overview");
    const heapHistoryRef = useRef<HeapSample[]>([]);

    useEffect(() => {
        if (!worker) return;

        const handler = (event: MessageEvent) => {
            const { type, ok, memoryStats } = event.data;

            if (type === "memory_stats" && ok && memoryStats) {
                setStats(memoryStats);
                setLastUpdate(Date.now());
                
                // Track heap history for sparkline
                const sample: HeapSample = {
                    timestamp: Date.now(),
                    usedHeap: memoryStats.usedHeap || 0,
                    allocRate: memoryStats.gcPressure?.avgAllocRate || 0,
                };
                heapHistoryRef.current.push(sample);
                if (heapHistoryRef.current.length > MAX_HISTORY) {
                    heapHistoryRef.current.shift();
                }
            }

            if (type === "memory_monitor_enable" && ok) {
                setIsMonitoring(event.data.enabled);
            }
        };

        worker.addEventListener("message", handler);

        // Initial stats request
        worker.postMessage({ type: "memory_stats" });

        // Start periodic polling (every 1s for memory stats)
        const interval = setInterval(() => {
            worker.postMessage({ type: "memory_stats" });
        }, 1000);

        return () => {
            worker.removeEventListener("message", handler);
            clearInterval(interval);
        };
    }, [worker]);

    const toggleMonitoring = () => {
        if (!worker) return;
        const newState = !isMonitoring;
        worker.postMessage({ type: "memory_monitor_enable", enabled: newState });
        setIsMonitoring(newState);
    };

    const forceGC = () => {
        // Note: We can't actually force GC in the browser, but we can suggest it
        if (!worker) return;
        worker.postMessage({ type: "memory_gc_hint" });
    };

    const resetStats = () => {
        if (!worker) return;
        worker.postMessage({ type: "memory_stats_reset" });
        heapHistoryRef.current = [];
    };

    const formatBytes = (bytes: number): string => {
        if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
        if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
        if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
        return `${bytes} B`;
    };

    const formatRate = (bytesPerSec: number): string => {
        if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
        if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
        return `${bytesPerSec.toFixed(0)} B/s`;
    };

    const formatAddr = (addr: number): string => `0x${addr.toString(16).padStart(8, "0")}`;

    // Sparkline component
    const renderSparkline = (data: HeapSample[], width: number, height: number) => {
        if (data.length < 2) return null;
        
        const values = data.map(d => d.usedHeap);
        const max = Math.max(...values);
        const min = Math.min(...values);
        const range = max - min || 1;
        
        const points = values.map((v, i) => {
            const x = (i / (data.length - 1)) * width;
            const y = height - ((v - min) / range) * height;
            return `${x},${y}`;
        }).join(" ");

        return (
            <svg width={width} height={height} style={{ display: "block" }}>
                <polyline
                    points={points}
                    fill="none"
                    stroke="#4CAF50"
                    strokeWidth={1.5}
                />
            </svg>
        );
    };

    // GC pressure indicator color
    const getGCPressureColor = (rate: number): string => {
        if (rate > 10 * 1024 * 1024) return "#f44336"; // Red: >10 MB/s
        if (rate > 1 * 1024 * 1024) return "#ff9800";  // Orange: >1 MB/s
        if (rate > 100 * 1024) return "#ffeb3b";       // Yellow: >100 KB/s
        return "#4CAF50";                               // Green: low
    };

    const regionKindColors: Record<string, string> = {
        HEAP: "#4CAF50",
        SURFACE_PIXELS: "#2196F3",
        THUNK_CODE: "#ff5722",
        THUNK_DATA: "#ff9800",
        LOW_MEM: "#9c27b0",
        MODULES: "#673ab7",
        RESERVED: "#607d8b",
        GUARD: "#f44336",
        ROM: "#795548",
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
            {/* Action strip */}
            <div style={{
                padding: "8px 15px",
                borderBottom: "1px solid #4a4a6a",
                display: "flex",
                justifyContent: "flex-end",
                alignItems: "center",
                backgroundColor: "#252540",
            }}>
                <div style={{ display: "flex", gap: 8 }}>
                    <button
                        onClick={toggleMonitoring}
                        style={{
                            padding: "4px 8px",
                            backgroundColor: isMonitoring ? "#f44336" : "#4CAF50",
                            border: "none",
                            borderRadius: 4,
                            color: "white",
                            cursor: "pointer",
                        }}
                    >
                        {isMonitoring ? "Stop" : "Start"} GC Tracking
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
                </div>
            </div>

            {/* Tab Navigation */}
            <div style={{
                display: "flex",
                borderBottom: "1px solid #333",
                backgroundColor: "#1f1f33",
            }}>
                {(["overview", "regions", "leases", "events"] as const).map(mode => (
                    <button
                        key={mode}
                        onClick={() => setViewMode(mode)}
                        style={{
                            flex: 1,
                            padding: "8px",
                            backgroundColor: viewMode === mode ? "#333355" : "transparent",
                            border: "none",
                            borderBottom: viewMode === mode ? "2px solid #6666ff" : "2px solid transparent",
                            color: viewMode === mode ? "#fff" : "#888",
                            cursor: "pointer",
                            fontSize: 11,
                            textTransform: "uppercase",
                        }}
                    >
                        {mode}
                    </button>
                ))}
            </div>

            {/* Content */}
            <div style={{ padding: 10, overflowY: "auto", flex: 1 }}>
                {!stats ? (
                    <div style={{ padding: 20, textAlign: "center", color: "#888" }}>
                        Loading memory stats...
                    </div>
                ) : viewMode === "overview" ? (
                    <div>
                        {/* Memory Overview */}
                        <div style={{ marginBottom: 15 }}>
                            <div style={{ fontWeight: "bold", marginBottom: 8, color: "#cfd3ff" }}>
                                Memory Summary
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                                <div style={{ padding: 10, backgroundColor: "#252540", borderRadius: 4 }}>
                                    <div style={{ color: "#888", fontSize: 10 }}>Total Memory</div>
                                    <div style={{ fontSize: 18, fontWeight: "bold" }}>{formatBytes(stats.totalMemory)}</div>
                                </div>
                                <div style={{ padding: 10, backgroundColor: "#252540", borderRadius: 4 }}>
                                    <div style={{ color: "#888", fontSize: 10 }}>Used Heap</div>
                                    <div style={{ fontSize: 18, fontWeight: "bold" }}>{formatBytes(stats.usedHeap)}</div>
                                </div>
                            </div>
                        </div>

                        {/* Heap History Sparkline */}
                        <div style={{ marginBottom: 15 }}>
                            <div style={{ fontWeight: "bold", marginBottom: 8, color: "#cfd3ff" }}>
                                Heap Usage (Last {MAX_HISTORY}s)
                            </div>
                            <div style={{ backgroundColor: "#252540", borderRadius: 4, padding: 8 }}>
                                {renderSparkline(heapHistoryRef.current, 600, 50)}
                            </div>
                        </div>

                        {/* GC Pressure */}
                        <div style={{ marginBottom: 15 }}>
                            <div style={{ fontWeight: "bold", marginBottom: 8, color: "#cfd3ff", display: "flex", alignItems: "center", gap: 8 }}>
                                GC Pressure
                                <span 
                                    style={{ 
                                        width: 8, 
                                        height: 8, 
                                        borderRadius: "50%", 
                                        backgroundColor: getGCPressureColor(stats.gcPressure?.avgAllocRate || 0) 
                                    }} 
                                    title={`Alloc rate: ${formatRate(stats.gcPressure?.avgAllocRate || 0)}`}
                                />
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                                <div style={{ padding: 8, backgroundColor: "#252540", borderRadius: 4 }}>
                                    <div style={{ color: "#888", fontSize: 10 }}>Alloc Rate</div>
                                    <div style={{ fontSize: 14, color: getGCPressureColor(stats.gcPressure?.avgAllocRate || 0) }}>
                                        {formatRate(stats.gcPressure?.avgAllocRate || 0)}
                                    </div>
                                </div>
                                <div style={{ padding: 8, backgroundColor: "#252540", borderRadius: 4 }}>
                                    <div style={{ color: "#888", fontSize: 10 }}>Allocs/sec</div>
                                    <div style={{ fontSize: 14 }}>{(stats.gcPressure?.allocsPerSecond || 0).toFixed(1)}</div>
                                </div>
                                <div style={{ padding: 8, backgroundColor: "#252540", borderRadius: 4 }}>
                                    <div style={{ color: "#888", fontSize: 10 }}>Net Growth</div>
                                    <div style={{ 
                                        fontSize: 14, 
                                        color: (stats.gcPressure?.netGrowth || 0) > 0 ? "#ff9800" : "#4CAF50" 
                                    }}>
                                        {(stats.gcPressure?.netGrowth || 0) > 0 ? "+" : ""}{formatBytes(stats.gcPressure?.netGrowth || 0)}
                                    </div>
                                </div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
                                <div style={{ padding: 8, backgroundColor: "#252540", borderRadius: 4 }}>
                                    <div style={{ color: "#888", fontSize: 10 }}>Total Allocated</div>
                                    <div style={{ fontSize: 14 }}>{formatBytes(stats.gcPressure?.totalAllocated || 0)}</div>
                                </div>
                                <div style={{ padding: 8, backgroundColor: "#252540", borderRadius: 4 }}>
                                    <div style={{ color: "#888", fontSize: 10 }}>Total Freed</div>
                                    <div style={{ fontSize: 14 }}>{formatBytes(stats.gcPressure?.totalFreed || 0)}</div>
                                </div>
                            </div>
                        </div>

                        {/* Quick Stats */}
                        <div style={{ display: "flex", gap: 15, fontSize: 11, color: "#888" }}>
                            <span>Regions: {stats.regions?.length || 0}</span>
                            <span>Active Leases: {stats.leases?.length || 0}</span>
                            <span>Recent Events: {stats.recentEvents?.length || 0}</span>
                        </div>
                    </div>
                ) : viewMode === "regions" ? (
                    <div>
                        <div style={{ fontWeight: "bold", marginBottom: 8, color: "#cfd3ff" }}>
                            Memory Regions ({stats.regions?.length || 0})
                        </div>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                            <thead>
                                <tr style={{ textAlign: "left", color: "#888", borderBottom: "1px solid #333" }}>
                                    <th style={{ padding: "4px 6px" }}>Kind</th>
                                    <th style={{ padding: "4px 6px" }}>Base</th>
                                    <th style={{ padding: "4px 6px" }}>Size</th>
                                    <th style={{ padding: "4px 6px" }}>Perms</th>
                                    <th style={{ padding: "4px 6px" }}>Owner</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(stats.regions || []).map((region) => (
                                    <tr key={region.id} style={{ borderBottom: "1px solid #222" }}>
                                        <td style={{ 
                                            padding: "4px 6px", 
                                            color: regionKindColors[region.kind] || "#888" 
                                        }}>{region.kind}</td>
                                        <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>{formatAddr(region.base)}</td>
                                        <td style={{ padding: "4px 6px" }}>{formatBytes(region.size)}</td>
                                        <td style={{ padding: "4px 6px" }}>{region.perms}</td>
                                        <td style={{ padding: "4px 6px", color: "#aaa", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}>
                                            {region.owner || "-"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : viewMode === "leases" ? (
                    <div>
                        <div style={{ fontWeight: "bold", marginBottom: 8, color: "#cfd3ff" }}>
                            Active Leases ({stats.leases?.length || 0})
                            <span style={{ fontWeight: "normal", fontSize: 10, color: "#888", marginLeft: 8 }}>
                                (Lock/Unlock tracking for surface memory)
                            </span>
                        </div>
                        {(stats.leases?.length || 0) === 0 ? (
                            <div style={{ color: "#888", padding: 10 }}>No active leases</div>
                        ) : (
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                                <thead>
                                    <tr style={{ textAlign: "left", color: "#888", borderBottom: "1px solid #333" }}>
                                        <th style={{ padding: "4px 6px" }}>ID</th>
                                        <th style={{ padding: "4px 6px" }}>Owner</th>
                                        <th style={{ padding: "4px 6px" }}>Base</th>
                                        <th style={{ padding: "4px 6px" }}>Size</th>
                                        <th style={{ padding: "4px 6px" }}>Perms</th>
                                        <th style={{ padding: "4px 6px" }}>Duration</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {(stats.leases || []).map((lease) => (
                                        <tr key={lease.id} style={{ borderBottom: "1px solid #222" }}>
                                            <td style={{ padding: "4px 6px" }}>{lease.id}</td>
                                            <td style={{ padding: "4px 6px", color: "#8888ff" }}>{lease.owner}</td>
                                            <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>{formatAddr(lease.base)}</td>
                                            <td style={{ padding: "4px 6px" }}>{formatBytes(lease.size)}</td>
                                            <td style={{ 
                                                padding: "4px 6px", 
                                                color: lease.perms === "rw" ? "#ff9800" : "#4CAF50" 
                                            }}>{lease.perms}</td>
                                            <td style={{ 
                                                padding: "4px 6px",
                                                color: lease.durationMs > 100 ? "#ff9800" : "#4CAF50"
                                            }}>{lease.durationMs.toFixed(1)}ms</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                ) : viewMode === "events" ? (
                    <div>
                        <div style={{ fontWeight: "bold", marginBottom: 8, color: "#cfd3ff" }}>
                            Recent Memory Events ({stats.recentEvents?.length || 0})
                        </div>
                        {(stats.recentEvents?.length || 0) === 0 ? (
                            <div style={{ color: "#888", padding: 10 }}>No recent events</div>
                        ) : (
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                                <thead>
                                    <tr style={{ textAlign: "left", color: "#888", borderBottom: "1px solid #333" }}>
                                        <th style={{ padding: "4px 6px" }}>Time</th>
                                        <th style={{ padding: "4px 6px" }}>Type</th>
                                        <th style={{ padding: "4px 6px" }}>Address</th>
                                        <th style={{ padding: "4px 6px" }}>Size</th>
                                        <th style={{ padding: "4px 6px" }}>Context</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {(stats.recentEvents || []).slice(-50).reverse().map((event, idx) => {
                                        const eventColors: Record<string, string> = {
                                            alloc: "#4CAF50",
                                            free: "#f44336",
                                            lock: "#2196F3",
                                            unlock: "#03A9F4",
                                            blt: "#9C27B0",
                                            flip: "#FF9800",
                                        };
                                        return (
                                            <tr key={idx} style={{ borderBottom: "1px solid #222" }}>
                                                <td style={{ padding: "4px 6px", color: "#888" }}>
                                                    {(event.timestamp / 1000).toFixed(2)}s
                                                </td>
                                                <td style={{ 
                                                    padding: "4px 6px", 
                                                    color: eventColors[event.type] || "#888",
                                                    fontWeight: "bold"
                                                }}>{event.type}</td>
                                                <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>
                                                    {formatAddr(event.address)}
                                                </td>
                                                <td style={{ padding: "4px 6px" }}>{formatBytes(event.size)}</td>
                                                <td style={{ 
                                                    padding: "4px 6px", 
                                                    color: "#aaa",
                                                    maxWidth: 200,
                                                    overflow: "hidden",
                                                    textOverflow: "ellipsis",
                                                    whiteSpace: "nowrap"
                                                }}>{event.context || "-"}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </div>
                ) : null}
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
                <span><Circle size={12} weight={isMonitoring ? "fill" : "regular"} color={isMonitoring ? "var(--coral)" : undefined} aria-hidden /> {isMonitoring ? "GC Tracking Active" : "GC Tracking Idle"}</span>
            </div>
        </div>
    );
}
