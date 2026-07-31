/**
 * D3D9 COM reference registry: the counts, the finalizers, the backing-store
 * disposers — and nothing else.
 *
 * Deliberately a LEAF module. The WebGPU backend holds real references on every
 * COM object it binds (textures, buffers, shaders), so it needs these functions;
 * importing them from shared-state would close a value-level cycle
 * (shared-state → resource-registry → d3d9-device → shared-state) that only
 * evaluates today because every use sits inside a method body.
 */

const comRefCounts: Map<number, number> = new Map();
const comFinalizers: Map<number, () => void> = new Map();
/** Frees the object's guest allocation; owned by whoever allocated it. */
const comDisposers: Map<number, () => void> = new Map();

/** Seed a freshly allocated COM object at refcount 1 (the creator's reference). */
export function trackComObject(ptr: number, dispose?: () => void): void {
    const key = ptr >>> 0;
    comRefCounts.set(key, 1);
    if (dispose) comDisposers.set(key, dispose);
}

export function addComRef(ptr: number): number | undefined {
    const key = ptr >>> 0;
    const current = comRefCounts.get(key);
    if (current === undefined) return undefined;
    const next = current + 1;
    comRefCounts.set(key, next);
    return next;
}

export function releaseComRef(ptr: number): number | undefined {
    const key = ptr >>> 0;
    const current = comRefCounts.get(key);
    if (current === undefined) return undefined;
    const next = current - 1;
    if (next > 0) {
        comRefCounts.set(key, next);
        return next;
    }

    comRefCounts.delete(key);
    // Unregister before running: a finalizer that reaches back here (forgetComObject
    // on a subresource, a parent release) must not re-enter this object's teardown.
    const finalizer = comFinalizers.get(key);
    comFinalizers.delete(key);
    const dispose = comDisposers.get(key);
    comDisposers.delete(key);
    try {
        finalizer?.();
    } finally {
        dispose?.();
    }
    return 0;
}

export function registerComFinalizer(ptr: number, finalizer: () => void): void {
    comFinalizers.set(ptr >>> 0, finalizer);
}

/**
 * Keep a D3D9 device alive for the complete lifetime of one of its child COM
 * objects — real D3D9 holds a device reference for every resource, state block
 * and shader it created. The finally block guarantees a balanced parent
 * reference even if a resource-specific cleanup path throws.
 */
export function registerDeviceChildFinalizer(
    childPtr: number,
    devicePtr: number,
    finalizer: () => void,
): void {
    const retainedDevice = addComRef(devicePtr) !== undefined;
    registerComFinalizer(childPtr, () => {
        try {
            finalizer();
        } finally {
            if (retainedDevice) releaseComRef(devicePtr);
        }
    });
}

/** Drop an object outright (an implicit subresource dying with its owner). */
export function forgetComObject(ptr: number): void {
    const key = ptr >>> 0;
    comRefCounts.delete(key);
    comFinalizers.delete(key);
    const dispose = comDisposers.get(key);
    comDisposers.delete(key);
    dispose?.();
}

export function getComRefCount(ptr: number): number | undefined {
    return comRefCounts.get(ptr >>> 0);
}

/**
 * Run every outstanding finalizer once and drop the registry. Module reset must
 * go through here: the finalizers are what return GPU textures, VB/IB and WASM
 * block slots, and a reused WebGPU device would otherwise inherit all of them.
 * Guest allocations are NOT disposed — the address space goes with the session.
 */
export function drainComFinalizers(): void {
    const pending = [...comFinalizers.values()];
    comFinalizers.clear();
    for (const finalizer of pending) {
        try {
            finalizer();
        } catch {
            /* one broken finalizer must not strand the rest */
        }
    }
    comRefCounts.clear();
    comDisposers.clear();
}
