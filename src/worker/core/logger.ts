/**
 * Ring buffer logger for BottleShip
 *
 * Only outputs to console on errors/unimplemented calls,
 * showing the last N calls as context.
 */

import { TimeService } from "../runtime/time";

export enum LogLevel {
    SILENT = 0,    // Nothing
    ERROR = 1,     // Only errors and unimplemented
    WARN = 2,      // Errors + warnings
    NORMAL = 3,    // Errors + important events (window creation, etc)
    VERBOSE = 4,   // Everything (for debugging)
}

export enum LogCategory {
    THUNK = 'THUNK',
    USER32 = 'USER32',
    GDI32 = 'GDI32',
    KERNEL32 = 'KERNEL32',
    D3D9 = 'D3D9',
    DDRAW = 'DDRAW',
    SYSTEM = 'SYSTEM',
    THREAD = 'THREAD',
    CALLBACK = 'CALLBACK',
    COM = 'COM',
    RESOURCE = 'RESOURCE',
}

export interface LogEntry {
    timestamp: number;
    category: LogCategory;
    level: LogLevel;
    message: string;
}

type VerboseStoreConfig = {
    enabled: boolean;
    dbName?: string;
    storeName?: string;
};

class IndexedDbVerboseStore {
    private enabled = false;
    private dbName = "bottleship-logs";
    private storeName = "verbose";
    private dbPromise: Promise<IDBDatabase> | null = null;
    private pending: LogEntry[] = [];
    private flushHandle: number | null = null;

    configure(config: VerboseStoreConfig): void {
        this.enabled = config.enabled;
        if (config.dbName) this.dbName = config.dbName;
        if (config.storeName) this.storeName = config.storeName;
        if (!this.enabled) {
            this.pending = [];
            if (this.flushHandle !== null) {
                clearTimeout(this.flushHandle);
                this.flushHandle = null;
            }
        }
    }

    isEnabled(): boolean {
        return this.enabled && this.canAccess();
    }

    enqueue(entry: LogEntry): void {
        if (!this.isEnabled()) return;
        this.pending.push(entry);
        if (this.flushHandle === null) {
            this.flushHandle = setTimeout(() => this.flush(), 50) as unknown as number;
        }
    }

    async exportText(): Promise<string> {
        if (!this.canAccess()) {
            return this.pendingToText(this.pending);
        }
        await this.flushNow();
        const db = await this.openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, "readonly");
            const store = tx.objectStore(this.storeName);
            const lines: string[] = [];
            const cursorReq = store.openCursor();
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor) {
                    resolve(lines.join("\n"));
                    return;
                }
                const value = cursor.value as any;
                const ts = typeof value.timestamp === "number" ? value.timestamp : 0;
                const levelName = LogLevel[value.level as LogLevel] ?? String(value.level);
                lines.push(`[${(ts / 1000).toFixed(3)}s] [${levelName}] [${value.category}] ${value.message}`);
                cursor.continue();
            };
            cursorReq.onerror = () => reject(cursorReq.error);
        });
    }

    async clear(): Promise<void> {
        if (!this.canAccess()) return;
        const db = await this.openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(this.storeName, "readwrite");
            const store = tx.objectStore(this.storeName);
            const req = store.clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    private async flush(): Promise<void> {
        if (!this.isEnabled()) {
            this.pending = [];
            this.flushHandle = null;
            return;
        }
        const entries = this.pending.splice(0, this.pending.length);
        this.flushHandle = null;
        if (entries.length === 0) return;
        await this.flushEntries(entries);
    }

    private async flushNow(): Promise<void> {
        if (!this.isEnabled()) return;
        if (this.flushHandle !== null) {
            clearTimeout(this.flushHandle);
            this.flushHandle = null;
        }
        const entries = this.pending.splice(0, this.pending.length);
        if (entries.length === 0) return;
        await this.flushEntries(entries);
    }

    private async flushEntries(entries: LogEntry[]): Promise<void> {
        try {
            const db = await this.openDb();
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(this.storeName, "readwrite");
                const store = tx.objectStore(this.storeName);
                for (const entry of entries) {
                    store.add({
                        timestamp: entry.timestamp,
                        category: entry.category,
                        level: entry.level,
                        message: entry.message
                    });
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch {
            // Ignore IndexedDB failures silently
        }
    }

    private openDb(): Promise<IDBDatabase> {
        if (this.dbPromise) return this.dbPromise;
        this.dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { autoIncrement: true });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return this.dbPromise;
    }

    private canAccess(): boolean {
        return typeof indexedDB !== "undefined";
    }

    private pendingToText(entries: LogEntry[]): string {
        return entries
            .map((entry) => {
                const relTime = (entry.timestamp / 1000).toFixed(3);
                const levelName = LogLevel[entry.level] ?? String(entry.level);
                return `[${relTime}s] [${levelName}] [${entry.category}] ${entry.message}`;
            })
            .join("\n");
    }
}

type LogStreamCallback = (batch: LogEntry[]) => void;

// Rate limiting configuration for high-frequency categories
// Temporary diagnostics: keep disabled while tracing HL menu bootstrap, because
// the loader emits important file/paint events in a short burst.
const DISABLE_LOG_RATE_LIMITS = false;

const SAMPLING_RATE: Partial<Record<LogCategory, number>> = {
    [LogCategory.THUNK]: 100,  // Max 100 logs per second
    [LogCategory.SYSTEM]: 50,  // Max 50 logs per second
    // Other categories: unlimited
};

// Batch configuration
const BATCH_SIZE = 50;
const BATCH_TIMEOUT_MS = 16; // One frame at 60fps

class LoggerImpl {
    private buffer: LogEntry[] = [];
    private bufferSize = 50;
    private globalLevel: LogLevel = LogLevel.NORMAL;
    private categoryLevels: Map<LogCategory, LogLevel> = new Map();
    private writeIndex = 0;
    private entryCount = 0;
    private verboseStore = new IndexedDbVerboseStore();
    private streamCallback: LogStreamCallback | null = null;
    /** Lightweight per-entry taps (harness log hub: live watchLog + full-session
     *  aggregation). Independent of the batched/sampled streamCallback path. Empty
     *  by default → zero cost in the hot log path. */
    private taps: Array<(e: LogEntry) => void> = [];
    private streamCategories: Set<LogCategory> | null = null;

    // Batching for streaming
    private streamBatch: LogEntry[] = [];
    private streamBatchTimer: number | null = null;

    // Profiling stats
    private profilingEnabled = false;
    private logCallCount = 0;
    private logTotalTimeMs = 0;
    private consoleCallCount = 0;
    private consoleTotalTimeMs = 0;
    private lastStatsReset = 0;

    // Rate limiting counters (sliding window) — one for stream batching, one for
    // direct console output. Kept separate so that back-pressure on one sink
    // doesn't starve the other (e.g. if WebSocket log server is off we still
    // want console-side suppression to kick in on its own budget).
    private categoryCounters: Map<LogCategory, { count: number; windowStart: number }> = new Map();
    private consoleCounters: Map<LogCategory, { count: number; windowStart: number; suppressed: number }> = new Map();

    // Global kill switch - when false, all console output is suppressed
    private globalEnabled = true;

    /**
     * Global enable/disable for all console output.
     * When disabled, logs still go to ring buffer but not to console.
     */
    setGlobalEnabled(enabled: boolean): void {
        this.globalEnabled = enabled;
    }

    isGlobalEnabled(): boolean {
        return this.globalEnabled;
    }

    setLevel(level: LogLevel): void {
        this.globalLevel = level;
    }

    setCategoryLevel(category: LogCategory, level: LogLevel): void {
        this.categoryLevels.set(category, level);
    }

    /**
     * Enable/disable logger profiling
     */
    setProfilingEnabled(enabled: boolean): void {
        this.profilingEnabled = enabled;
        if (enabled) {
            this.resetProfilingStats();
        }
    }

    /**
     * Reset profiling statistics
     */
    resetProfilingStats(): void {
        this.logCallCount = 0;
        this.logTotalTimeMs = 0;
        this.consoleCallCount = 0;
        this.consoleTotalTimeMs = 0;
        this.lastStatsReset = performance.now();
    }

    /**
     * Get profiling statistics
     */
    getProfilingStats(): { calls: number; totalMs: number; consoleCalls: number; consoleMs: number; periodMs: number } {
        return {
            calls: this.logCallCount,
            totalMs: this.logTotalTimeMs,
            consoleCalls: this.consoleCallCount,
            consoleMs: this.consoleTotalTimeMs,
            periodMs: performance.now() - this.lastStatsReset,
        };
    }

    /**
     * Check if a log level is enabled for a category.
     * Includes verbose storage/streaming for VERBOSE level.
     */
    isEnabled(category: LogCategory, level: LogLevel): boolean {
        if (level === LogLevel.VERBOSE) {
            return (
                this.getCategoryLevel(category) >= LogLevel.VERBOSE ||
                this.verboseStore.isEnabled() ||
                this.streamCallback !== null
            );
        }
        return this.getCategoryLevel(category) >= level;
    }

    getCategoryLevel(category: LogCategory): LogLevel {
        return this.categoryLevels.get(category) ?? this.globalLevel;
    }

    resetCategoryLevels(): void {
        this.categoryLevels.clear();
    }

    // Senior dev preset: optimized for debugging without log explosion
    applySeniorDebugPreset(): void {
        this.globalLevel = LogLevel.ERROR;
        // Only enable verbose for specific problematic categories
        this.setCategoryLevel(LogCategory.THUNK, LogLevel.SILENT); // Thunk calls are too noisy
        this.setCategoryLevel(LogCategory.SYSTEM, LogLevel.NORMAL); // System events are useful
        this.setCategoryLevel(LogCategory.THREAD, LogLevel.NORMAL); // Thread lifecycle is critical
        this.setCategoryLevel(LogCategory.D3D9, LogLevel.NORMAL);   // Graphics debugging
        this.setCategoryLevel(LogCategory.DDRAW, LogLevel.NORMAL);  // DirectDraw debugging
        this.setCategoryLevel(LogCategory.COM, LogLevel.WARN);     // COM operations
    }

    setBufferSize(size: number): void {
        this.bufferSize = size;
        this.buffer = [];
        this.writeIndex = 0;
        this.entryCount = 0;
    }

    /**
     * Log a verbose message with lazy evaluation (only shown in VERBOSE mode or when flushed).
     * Use this when message construction is expensive (e.g., string interpolation, hex formatting).
     * The messageFn is only called if logging is actually enabled.
     */
    verboseLazy(category: LogCategory, messageFn: () => string): void {
        const isVerboseEnabled = this.globalEnabled && this.getCategoryLevel(category) >= LogLevel.VERBOSE;
        const isStoreEnabled = this.verboseStore.isEnabled();
        const isStreamEnabled = this.streamCallback !== null;

        if (!isVerboseEnabled && !isStoreEnabled && !isStreamEnabled) return;

        // Only now evaluate the message
        this.verbose(category, messageFn());
    }

    /**
     * Log a normal message with lazy evaluation.
     * Use this when message construction is expensive.
     */
    logLazy(category: LogCategory, messageFn: () => string): void {
        if (!this.globalEnabled && !this.streamCallback) return;
        if (this.getCategoryLevel(category) < LogLevel.NORMAL && !this.streamCallback) return;

        this.log(category, messageFn());
    }

    /**
     * Log a verbose message (only shown in VERBOSE mode or when flushed)
     */
    verbose(category: LogCategory, message: string): void {
        const isVerboseEnabled = this.globalEnabled && this.getCategoryLevel(category) >= LogLevel.VERBOSE;
        const isStoreEnabled = this.verboseStore.isEnabled();
        const isStreamEnabled = this.streamCallback !== null;

        // Don't skip if streaming is enabled - we need to capture verbose logs for stream
        if (!isVerboseEnabled && !isStoreEnabled && !isStreamEnabled) return;

        const t0 = this.profilingEnabled ? performance.now() : 0;
        const entry = this.addToBuffer(category, LogLevel.VERBOSE, message);
        if (isStoreEnabled) {
            this.verboseStore.enqueue(entry);
        }
        if (isVerboseEnabled && this.shouldEmitToConsole(category)) {
            const tc = this.profilingEnabled ? performance.now() : 0;
            console.log(`[${category}] ${message}`);
            if (this.profilingEnabled) {
                this.consoleCallCount++;
                this.consoleTotalTimeMs += performance.now() - tc;
            }
        }
        if (this.profilingEnabled) {
            this.logCallCount++;
            this.logTotalTimeMs += performance.now() - t0;
        }
    }

    /**
     * Log a normal message (shown in NORMAL+ mode)
     */
    log(category: LogCategory, message: string): void {
        const t0 = this.profilingEnabled ? performance.now() : 0;
        this.addToBuffer(category, LogLevel.NORMAL, message);
        if (this.globalEnabled &&
            this.getCategoryLevel(category) >= LogLevel.NORMAL &&
            this.shouldEmitToConsole(category)) {
            const tc = this.profilingEnabled ? performance.now() : 0;
            console.log(`[${category}] ${message}`);
            if (this.profilingEnabled) {
                this.consoleCallCount++;
                this.consoleTotalTimeMs += performance.now() - tc;
            }
        }
        if (this.profilingEnabled) {
            this.logCallCount++;
            this.logTotalTimeMs += performance.now() - t0;
        }
    }

    /**
     * Log an info message - alias for log (shown in NORMAL+ mode)
     */
    info(category: LogCategory, message: string): void {
        this.log(category, message);
    }

    /**
     * Log a warning - always added to buffer, shown in WARN+ mode
     */
    warn(category: LogCategory, message: string): void {
        const t0 = this.profilingEnabled ? performance.now() : 0;
        this.addToBuffer(category, LogLevel.WARN, message);
        if (this.globalEnabled && this.getCategoryLevel(category) >= LogLevel.WARN) {
            const tc = this.profilingEnabled ? performance.now() : 0;
            console.warn(`[${category}] ${message}`);
            if (this.profilingEnabled) {
                this.consoleCallCount++;
                this.consoleTotalTimeMs += performance.now() - tc;
            }
        }
        if (this.profilingEnabled) {
            this.logCallCount++;
            this.logTotalTimeMs += performance.now() - t0;
        }
    }

    /**
     * Log an error - always shown and flushes recent context (unless globally disabled)
     */
    error(category: LogCategory, message: string): void {
        this.addToBuffer(category, LogLevel.ERROR, message);
        if (this.globalEnabled) {
            this.flushContext(`ERROR: ${message}`);
        }
    }

    /**
     * Log unimplemented API call - shows context buffer (unless globally disabled)
     */
    unimplemented(dllName: string, functionName: string): void {
        const message = `Unimplemented: ${dllName}!${functionName}`;
        this.addToBuffer(LogCategory.THUNK, LogLevel.ERROR, message);
        if (this.globalEnabled) {
            this.flushContext(message);
        }
    }

    /**
     * Log a thunk call (only shown in VERBOSE mode or when flushed)
     */
    thunkCall(dllName: string, functionName: string, extra?: string): void {
        const msg = extra
            ? `${dllName}!${functionName} - ${extra}`
            : `${dllName}!${functionName}`;
        this.verbose(LogCategory.THUNK, msg);
    }

    /**
     * Does this entry earn a RING slot? Only an EXPLICITLY configured category filters
     * (setCategoryLevel / harness `logLevel`), so the ring's default contents never
     * depend on console verbosity. ERROR is never dropped. This is the ring only —
     * taps and streaming still see the entry, because the durable archive must not
     * lose what the ring is being asked to make room for.
     */
    private keepInRing(category: LogCategory, level: LogLevel): boolean {
        if (level <= LogLevel.ERROR) return true;
        const configured = this.categoryLevels.get(category);
        return configured === undefined || configured >= level;
    }

    private addToBuffer(category: LogCategory, level: LogLevel, message: string): LogEntry {
        const entry: LogEntry = {
            timestamp: TimeService.getInstance().nowMs(),
            category,
            level,
            message,
        };

        if (this.keepInRing(category, level)) {
            if (this.buffer.length < this.bufferSize) {
                this.buffer.push(entry);
            } else {
                this.buffer[this.writeIndex] = entry;
            }

            this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
            this.entryCount++;
        }

        // Per-entry taps (harness log hub). Guarded so there's zero cost when none.
        if (this.taps.length) {
            for (const tap of this.taps) {
                try { tap(entry); } catch { /* a tap must never disrupt logging */ }
            }
        }

        // Stream to callback if configured (with batching and sampling)
        if (this.streamCallback) {
            const shouldStream = !this.streamCategories || this.streamCategories.has(category);
            if (shouldStream) {
                // Apply rate limiting for high-frequency categories
                if (this.shouldSample(category)) {
                    this.addToStreamBatch(entry);
                }
            }
        }

        return entry;
    }

    private flushContext(triggerMessage: string): void {
        console.error(`🚨 BottleShip: ${triggerMessage}`);
    }

    /**
     * Get entries in chronological order
     */
    private getOrderedEntries(): LogEntry[] {
        if (this.buffer.length < this.bufferSize) {
            return [...this.buffer];
        }

        // Ring buffer is full - reorder from oldest to newest
        const result: LogEntry[] = [];
        for (let i = 0; i < this.bufferSize; i++) {
            const idx = (this.writeIndex + i) % this.bufferSize;
            result.push(this.buffer[idx]);
        }
        return result;
    }

    /**
     * Manually dump the buffer (for debugging)
     */
    dump(): void {
        this.flushContext('Manual dump');
    }

    /**
     * Clear the buffer
     */
    clear(): void {
        this.buffer = [];
        this.writeIndex = 0;
        this.entryCount = 0;
    }

    enableVerboseIndexedDb(config: VerboseStoreConfig): void {
        this.verboseStore.configure(config);
    }

    exportVerboseIndexedDb(): Promise<string> {
        return this.verboseStore.exportText();
    }

    clearVerboseIndexedDb(): Promise<void> {
        return this.verboseStore.clear();
    }

    /**
     * Check if entry should be sampled based on rate limiting
     */
    private shouldSample(category: LogCategory): boolean {
        if (DISABLE_LOG_RATE_LIMITS) return true;
        const rate = SAMPLING_RATE[category];
        if (!rate) return true; // No limit for this category

        const now = TimeService.getInstance().nowMs();
        const counter = this.categoryCounters.get(category) || { count: 0, windowStart: now };

        // Reset window if new second started
        if (now - counter.windowStart >= 1000) {
            this.categoryCounters.set(category, { count: 1, windowStart: now });
            return true;
        }

        // Check if rate limit exceeded
        if (counter.count >= rate) {
            return false; // Rate limit exceeded, skip this entry
        }

        // Increment counter
        counter.count++;
        this.categoryCounters.set(category, counter);
        return true;
    }

    /**
     * Sliding-window rate limit for direct console output. When tracing is on
     * (THUNK raised to NORMAL+) a tight heap storm can emit 10k+ `console.log`
     * calls per second, saturating DevTools' buffer and freezing the tab — the
     * ring buffer can keep up but the browser cannot. Cap per category and
     * emit a one-line summary when the window rolls over so user still knows
     * activity happened.
     */
    private shouldEmitToConsole(category: LogCategory): boolean {
        if (DISABLE_LOG_RATE_LIMITS) return true;
        const rate = SAMPLING_RATE[category];
        if (!rate) return true;

        const now = TimeService.getInstance().nowMs();
        let counter = this.consoleCounters.get(category);
        if (!counter) {
            counter = { count: 1, windowStart: now, suppressed: 0 };
            this.consoleCounters.set(category, counter);
            return true;
        }

        if (now - counter.windowStart >= 1000) {
            // Window rolled over — emit suppression summary if we dropped anything.
            const suppressedCount = counter.suppressed;
            counter.count = 1;
            counter.windowStart = now;
            counter.suppressed = 0;
            if (suppressedCount > 0) {
                // Direct console.log to avoid recursing through the rate limiter itself.
                console.log(`[${category}] … suppressed ${suppressedCount} more entries in last 1s (rate limit ${rate}/s)`);
            }
            return true;
        }

        if (counter.count >= rate) {
            counter.suppressed++;
            return false;
        }

        counter.count++;
        return true;
    }

    /**
     * Flush stream batch to callback
     */
    private flushStreamBatch(): void {
        if (this.streamBatch.length === 0) return;

        const batch = this.streamBatch.splice(0);
        if (this.streamBatchTimer !== null) {
            clearTimeout(this.streamBatchTimer);
            this.streamBatchTimer = null;
        }

        if (this.streamCallback) {
            try {
                this.streamCallback(batch);
            } catch (err) {
                // Silently ignore callback errors to avoid disrupting logging
            }
        }
    }

    /**
     * Add entry to stream batch (with priority handling for ERROR/WARN)
     */
    private addToStreamBatch(entry: LogEntry): void {
        // ERROR/WARN are sent immediately for high priority
        if (entry.level <= LogLevel.WARN) {
            // Flush any pending batch first
            if (this.streamBatch.length > 0) {
                this.flushStreamBatch();
            }
            // Send high-priority entry immediately
            if (this.streamCallback) {
                try {
                    this.streamCallback([entry]);
                } catch (err) {
                    // Silently ignore callback errors
                }
            }
            return;
        }

        // Other levels are batched
        this.streamBatch.push(entry);

        // Flush if batch is full
        if (this.streamBatch.length >= BATCH_SIZE) {
            this.flushStreamBatch();
        } else if (!this.streamBatchTimer) {
            // Schedule flush after timeout
            this.streamBatchTimer = setTimeout(() => {
                this.streamBatchTimer = null;
                this.flushStreamBatch();
            }, BATCH_TIMEOUT_MS) as unknown as number;
        }
    }

    /**
     * Enable log streaming with optional category filter
     * @param callback Function to receive log entries in real-time (as batches)
     * @param categories Optional set of categories to stream (null = all categories)
     */
    setStreamCallback(callback: LogStreamCallback | null, categories?: LogCategory[]): void {
        // Flush any pending batch when changing callback
        if (this.streamBatch.length > 0) {
            this.flushStreamBatch();
        }
        this.streamCallback = callback;
        this.streamCategories = categories ? new Set(categories) : null;
    }

    /** Register a per-entry tap (sees EVERY entry, unbatched/unsampled). */
    addLogTap(fn: (e: LogEntry) => void): void {
        if (!this.taps.includes(fn)) this.taps.push(fn);
    }
    /** Remove a previously-registered tap. */
    removeLogTap(fn: (e: LogEntry) => void): void {
        const i = this.taps.indexOf(fn);
        if (i >= 0) this.taps.splice(i, 1);
    }

    /**
     * Get the last N entries from the ring buffer
     */
    getRecentEntries(count?: number): LogEntry[] {
        const entries = this.getOrderedEntries();
        if (count !== undefined && count > 0) {
            return entries.slice(-count);
        }
        return entries;
    }
}

// Singleton
export const Logger = new LoggerImpl();
