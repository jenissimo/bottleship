export type ResolveErrorCode = "HOST_NOT_FOUND" | "TRY_AGAIN" | "NO_RECOVERY" | "NO_DATA" | "CANCELLED" | "NETWORK_DOWN" | "ACCESS_DENIED";
export interface ResolveRequest { host: string; family: 0 | 4 | 6; reverse?: boolean }
export interface ResolveResult { canonicalName: string; addresses: { address: string; family: 4 | 6; node?: number[]; scopeId?: number }[] }
export type ResolveReply = { result: ResolveResult; error?: never } | { result?: never; error: { code: ResolveErrorCode; message: string } };
export class NetResolveError extends Error {
    constructor(readonly code: ResolveErrorCode, message: string = code) { super(message); this.name = "NetResolveError"; }
}
