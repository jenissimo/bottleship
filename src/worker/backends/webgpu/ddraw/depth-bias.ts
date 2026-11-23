/** D3D7/8 ZBIAS is a DWORD in [0, 16]. D3D9 DEPTHBIAS uses float bits instead. */
export function legacyZBias(raw: number): number {
    const value = raw >>> 0;
    return value <= 16 ? value : 0;
}

/** Old ZBIAS offsets window-space depth. A larger DWORD subtracts depth even under
 *  GREATER; the compare function is independent of the rasterizer's offset. */
export function legacyDepthBias(
    zBias: number,
    depthEnabled: boolean,
    topology: GPUPrimitiveTopology,
    coplanarPass = false,
): Pick<GPUDepthStencilState, "depthBias" | "depthBiasSlopeScale" | "depthBiasClamp"> {
    // WebGPU rejects nonzero bias for point and line topologies.
    const enabled = depthEnabled && (topology === "triangle-list" || topology === "triangle-strip");
    const amount = enabled ? legacyZBias(zBias) : 0;
    const coplanar = enabled && coplanarPass;
    return {
        // Keep the existing constant scale for the backend's implementation-defined depth24plus.
        depthBias: amount ? -4 * amount : coplanar ? -1 : 0,
        // The legacy rasterizer scales slope and constant terms by the same DWORD.
        depthBiasSlopeScale: amount ? -amount : coplanar ? -1 : 0,
        depthBiasClamp: 0,
    };
}
