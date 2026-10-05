/**
 * Generation counter for the runtime D3D capability contracts (MSAA, float formats,
 * volumes, WebGPU limits).
 *
 * The capability queries are pure functions of their arguments AND of those contracts,
 * so anything that caches an answer must be able to see the contracts change. The bump
 * lives inside each contract SETTER — that is the only seam through which a contract can
 * change, so a cache added later cannot forget to hook it.
 *
 * Dependency-free on purpose: every contract module imports it, and it must never import
 * one back.
 */

let generation = 0;

export function capabilityGeneration(): number {
    return generation;
}

export function bumpCapabilityGeneration(): void {
    generation++;
}
