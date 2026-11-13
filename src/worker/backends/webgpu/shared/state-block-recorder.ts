/**
 * Generic keyed state-block recorder shared by the D3D8 and D3D9 backends.
 *
 * BeginStateBlock/EndStateBlock semantics are identical in both APIs: Set* calls
 * between Begin and End are journaled (NOT applied — the recorder's caller gates
 * that) and a later Apply replays them. Re-setting the same state while recording
 * overwrites the previous entry in place (keyed dedup), preserving first-write
 * ordering like the real runtime's per-state capture masks.
 *
 * Entry types differ per API (D3D9 uses COM pointers, D3D8 DWORD tokens), so the
 * recorder is generic over the entry type with a caller-supplied key function.
 */
export class KeyedStateBlockRecorder<E> {
    private active = false;
    private entries: E[] = [];
    private keyToIndex = new Map<string, number>();

    constructor(private readonly keyOf: (entry: E) => string) {}

    isRecording(): boolean {
        return this.active;
    }

    begin(): void {
        this.active = true;
        this.entries = [];
        this.keyToIndex.clear();
    }

    end(): E[] {
        this.active = false;
        const result = this.entries;
        this.entries = [];
        this.keyToIndex.clear();
        return result;
    }

    record(entry: E): E | undefined {
        if (!this.active) return;
        const key = this.keyOf(entry);
        const existing = this.keyToIndex.get(key);
        if (existing !== undefined) {
            const previous = this.entries[existing];
            this.entries[existing] = entry;
            return previous;
        } else {
            this.keyToIndex.set(key, this.entries.length);
            this.entries.push(entry);
        }
    }
}
