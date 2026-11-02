/** Local namespace provenance only. This is never a public relay/wire extension. */
export interface LocalUdpEndpoint {
    family: 2 | 23;
    address: Uint8Array;
    port: number;
    scopeId?: number;
    flowInfo?: number;
}
export interface LocalUdpContext {
    source: LocalUdpEndpoint;
    destination: LocalUdpEndpoint;
}
/** Canonical queue charge, separate from binary frame and JS allocator size. */
export const LOCAL_UDP_CONTEXT_BYTES = 64;
const u32 = (value: unknown): value is number => typeof value === "number"
    && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
function copyEndpoint(value: unknown): LocalUdpEndpoint | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const {family, address, port, scopeId, flowInfo} = value as Partial<LocalUdpEndpoint>;
    if ((family !== 2 && family !== 23)
        || !(address instanceof Uint8Array) || address.length !== (family === 2 ? 4 : 16)
        || !Number.isInteger(port) || port! < 1 || port! > 65535
        || (scopeId !== undefined && !u32(scopeId)) || (flowInfo !== undefined && !u32(flowInfo))) return;
    return {
        family, address: Uint8Array.from(address), port: port!,
        ...(scopeId !== undefined ? {scopeId} : {}),
        ...(flowInfo !== undefined ? {flowInfo} : {}),
    };
}
/** Invalid-present must be rejected by the caller; it must not become legacy traffic. */
export function copyLocalUdpContext(value: unknown): LocalUdpContext | undefined {
    try {
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const context = value as Partial<LocalUdpContext>;
        const source = copyEndpoint(context.source), destination = copyEndpoint(context.destination);
        if (!source || !destination || source.family !== destination.family) return;
        return {source, destination};
    } catch {
        // Detached/foreign views and malformed accessors cannot grant provenance.
        return;
    }
}
/** Admission and retirement must charge the same envelope, including rejected metadata. */
export function localUdpFrameBytes(frame: Uint8Array, localUdp?: unknown): number {
    return frame.byteLength + (localUdp === undefined ? 0 : LOCAL_UDP_CONTEXT_BYTES);
}
