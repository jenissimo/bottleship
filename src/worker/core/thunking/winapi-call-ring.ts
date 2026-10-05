// winapi-call-ring.ts
// Fixed-size ring buffer of recent WinAPI thunk calls, kept for crash forensics.
// Records raw numbers (id/esp/arg0/retVal/retAddr) on the hot path with zero string
// allocation; strings are generated lazily only when a getter is called (on errors).

const HISTORY_SIZE = 256;

// WinAPI calls too noisy to be useful in a crash trace (per-pixel GDI, rect math,
// high-frequency D3D/DDraw state). Filtered out of getCalls() unless includeNoisy.
const NOISY_PREFIXES: ReadonlyArray<string> = [
    'ddraw:', 'd3d9:', 'd3d8:', 'd3d:', 'opengl32:', 'glu32:',
];
const NOISY_NAMES: ReadonlySet<string> = new Set([
    'gdi32:bitblt', 'gdi32:stretchblt', 'gdi32:patblt', 'gdi32:transparentblt',
    'gdi32:getpixel', 'gdi32:setpixel',
    'user32:isrectempty', 'user32:offsetrect', 'user32:unionrect',
    'user32:intersectrect', 'user32:clienttoscreen', 'user32:screentoclient',
]);

export interface RichWinApiCall {
    id: number; name: string; esp: number; retAddrBefore: number; stackHash: number;
}

export class WinApiCallRing {
    private readonly size = HISTORY_SIZE;
    private ids = new Uint16Array(HISTORY_SIZE);
    private esps = new Uint32Array(HISTORY_SIZE);
    private arg0s = new Uint32Array(HISTORY_SIZE);
    private retVals = new Uint32Array(HISTORY_SIZE);
    /** 1 once recordReturnValue filled retVals[i]. Without it a printed `-> 0x0` is ambiguous
     *  between "returned zero" and "never returned" — and the newest entry is normally the
     *  in-flight one, which is exactly the entry a crash reader cares about most. */
    private retSet = new Uint8Array(HISTORY_SIZE);
    private retAddrsBefore = new Uint32Array(HISTORY_SIZE);
    private stackHashes = new Uint32Array(HISTORY_SIZE);
    private threadIds = new Uint16Array(HISTORY_SIZE);
    private index = 0;
    private count = 0;

    /** @param names id -> "dll:Func" registry, held by reference and resolved lazily on format. */
    constructor(private names: Array<string | null>) {}

    /** Record a call at entry. retAddrBefore is the return address read from [esp].
     *  threadId tags the entry so crash forensics can isolate ONE thread's tail — the
     *  global ring is otherwise flushed by a busy render/audio thread, evicting the
     *  calls of the thread that actually went wild. */
    record(id: number, esp: number, arg0: number, retAddrBefore: number, threadId = 0): void {
        const idx = this.index;
        this.ids[idx] = id;
        this.esps[idx] = esp;
        this.arg0s[idx] = arg0 >>> 0;
        this.retVals[idx] = 0; // filled in by recordReturnValue after the thunk returns
        this.retSet[idx] = 0;
        this.retAddrsBefore[idx] = retAddrBefore >>> 0;
        this.stackHashes[idx] = 0;
        this.threadIds[idx] = threadId & 0xffff;
        this.index = (idx + 1) % this.size;
        if (this.count < this.size) this.count++;
    }

    /** Fill in EAX for the most recently recorded call (after its thunk returns). */
    recordReturnValue(value: number): void {
        const prevIdx = (this.index - 1 + this.size) % this.size;
        this.retVals[prevIdx] = value >>> 0;
        this.retSet[prevIdx] = 1;
    }

    /**
     * Fill the return value for an ASYNC completion, which lands long after its own entry
     * stopped being the newest — other calls were recorded while the thunk was parked, so
     * recordReturnValue() (which writes the newest slot) would attribute the result to an
     * unrelated call. Walk back to the most recent still-unreturned entry with this name;
     * that is this completion's own call. Returns false when it has already been evicted,
     * so the caller can leave the ring honest instead of guessing.
     */
    recordAsyncReturnByName(name: string, value: number): boolean {
        for (let back = 1; back <= this.count; back++) {
            const idx = (this.index - back + this.size) % this.size;
            if (this.retSet[idx]) continue;
            if ((this.names[this.ids[idx]] || "") !== name) continue;
            this.retVals[idx] = value >>> 0;
            this.retSet[idx] = 1;
            return true;
        }
        return false;
    }

    /** `-> 0x…` for a completed call, `-> (in flight)` for one that never returned. That
     *  distinction is the point of these rings for the "we returned an error the game did
     *  not check" crash class: the culprit is the LAST COMPLETED call, and the entry after
     *  it is the guest code that used the result. */
    private retStr(idx: number): string {
        return this.retSet[idx] ? ` -> 0x${this.retVals[idx].toString(16)}` : " -> (in flight)";
    }

    reset(): void {
        this.ids.fill(0);
        this.esps.fill(0);
        this.arg0s.fill(0);
        this.retVals.fill(0);
        this.retSet.fill(0);
        this.retAddrsBefore.fill(0);
        this.stackHashes.fill(0);
        this.threadIds.fill(0);
        this.index = 0;
        this.count = 0;
    }

    private isNoisy(name: string): boolean {
        const lower = name.toLowerCase();
        if (NOISY_NAMES.has(lower)) return true;
        for (const prefix of NOISY_PREFIXES) {
            if (lower.startsWith(prefix)) return true;
        }
        return false;
    }

    /**
     * Recent calls as "0xID:name(ESP=0x..)" strings, oldest..newest. Skips noisy thunks
     * unless includeNoisy; if filtering leaves nothing, retries including noisy ones.
     * This is the ONLY place where we allocate strings for history.
     */
    getCalls(count = 8, options?: { includeNoisy?: boolean }): string[] {
        const safeCount = Math.max(1, Math.min(count, this.count));
        const includeNoisy = options?.includeNoisy ?? false;
        if (safeCount <= 0) return [];

        const selected: number[] = [];
        for (let back = 1; back <= this.count && selected.length < safeCount; back++) {
            const idx = (this.index - back + this.size) % this.size;
            const name = this.names[this.ids[idx]] || "unknown";
            if (!includeNoisy && this.isNoisy(name)) continue;
            selected.push(idx);
        }

        if (selected.length === 0 && !includeNoisy) {
            return this.getCalls(count, { includeNoisy: true });
        }

        const entries: string[] = [];
        for (let i = selected.length - 1; i >= 0; i--) {
            const idx = selected[i];
            const id = this.ids[idx];
            const name = this.names[id] || "unknown";
            entries.push(`0x${id.toString(16)}:${name}(ESP=0x${this.esps[idx].toString(16)})${this.retStr(idx)}`);
        }
        return entries;
    }

    /**
     * Recent calls made by ONE thread, oldest..newest, as
     * "0xID:name(esp=0x..,[esp]=0x..)" strings. Each entry carries the ESP at entry
     * and the return address read from [esp] — so a thread whose stack pointer went
     * wild (ESP jumping outside its stack, [esp] turning into garbage) is visible
     * directly in the crash window, independent of the ESP-scan backtrace (which is
     * useless once ESP is corrupt). No noisy-prefix filtering: when a thread dies we
     * want its true tail, render-loop spam included. Allocates only when called.
     */
    getThreadTail(threadId: number, count = 24): string[] {
        const want = threadId & 0xffff;
        const entries: string[] = [];
        // Walk newest..oldest collecting this thread's entries, then reverse.
        for (let back = 1; back <= this.count && entries.length < count; back++) {
            const idx = (this.index - back + this.size) % this.size;
            if (this.threadIds[idx] !== want) continue;
            const id = this.ids[idx];
            const name = this.names[id] || `id_0x${id.toString(16)}`;
            entries.push(
                `0x${id.toString(16)}:${name}(esp=0x${this.esps[idx].toString(16)},` +
                `[esp]=0x${this.retAddrsBefore[idx].toString(16)})${this.retStr(idx)}`);
        }
        return entries.reverse();
    }

    /** Recent calls with rich data (retAddrBefore, stackHash) for jump-into-stack forensics. */
    getCallsRich(count = 50): RichWinApiCall[] {
        const safeCount = Math.max(1, Math.min(count, this.count));
        const entries: RichWinApiCall[] = [];
        for (let i = 0; i < safeCount; i++) {
            const idx = (this.index - safeCount + i + this.size) % this.size;
            const id = this.ids[idx];
            entries.push({
                id,
                name: this.names[id] || "unknown",
                esp: this.esps[idx],
                retAddrBefore: this.retAddrsBefore[idx],
                stackHash: this.stackHashes[idx],
            });
        }
        return entries;
    }

    getTrace(count = 16): string[] {
        const safeCount = Math.max(1, Math.min(count, this.count));
        const lines: string[] = [];
        for (let i = 0; i < safeCount; i++) {
            const idx = (this.index - safeCount + i + this.size) % this.size;
            const id = this.ids[idx];
            const name = this.names[id] || `id_0x${id.toString(16)}`;
            lines.push(`[${i}] ${name}(arg0=0x${this.arg0s[idx].toString(16)}) -> 0x${this.retVals[idx].toString(16)}`);
        }
        return lines;
    }

    /** Crash-trace variant: up to maxCount entries oldest..newest, 2-space indented (no min-1 clamp). */
    getCrashTraceLines(maxCount = 50): string[] {
        const count = Math.min(maxCount, this.count);
        const lines: string[] = [];
        for (let i = 0; i < count; i++) {
            const idx = (this.index - count + i + this.size) % this.size;
            const id = this.ids[idx];
            const name = this.names[id] || `id_0x${id.toString(16)}`;
            // ESP at entry is what makes a 4-byte stack drift visible here: consecutive
            // calls from the same guest frame must share an ESP, and a step that no guest
            // push explains names the thunk whose RET N disagreed with the caller.
            lines.push(`  [${i}] ${name}(arg0=0x${this.arg0s[idx].toString(16)})`
                + ` esp=0x${this.esps[idx].toString(16)} ret=0x${this.retAddrsBefore[idx].toString(16)}`
                + this.retStr(idx));
        }
        return lines;
    }
}
