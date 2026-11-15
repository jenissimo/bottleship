/** Exhausted guest allocation, distinct from a malformed request or allocator bug. */
export class MemoryAllocationError extends Error {
    constructor(message: string) { super(message); this.name = "MemoryAllocationError"; }
}
