/** Bounded host-only RPC. Guest pointers and callback functions never cross this boundary. */
export const WSA_ACTOR_MAILBOX_BYTES = 512 * 1024;
export const WSA_ACTOR_HEADER_BYTES = 16;
export const WSA_ACTOR_PENDING = 0, WSA_ACTOR_DONE = 1, WSA_ACTOR_ERROR = 2, WSA_ACTOR_CANCELLED = 3, WSA_ACTOR_EXECUTING = 4;
export interface WsaActorIdentity { pid: number; slot: number; epoch: number; }
export interface WsaActorClientBoot extends WsaActorIdentity { port: MessagePort; }
export interface WsaActorRoute { family: 2 | 23; address: Uint8Array; node: Uint8Array; scopeId?: number; }
export interface WsaActorRequest { type: "request"; command: string; args: unknown[]; nativeHandleOnly?: boolean; routes?: WsaActorRoute[]; mailbox: SharedArrayBuffer; }
export type WsaActorNotification = { type: "changed" } | { type: "event"; socket: number; bit: number; error: number };
/** Cost bound is checked before structured cloning and again by the service. */
export function actorRequestFits(args: unknown[]): boolean {
    let bytes = 0, fields = 0; const seen = new Set<object>();
    const visit = (value: unknown, depth: number): boolean => {
        if (depth > 8 || ++fields > 256) return false;
        if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") { bytes += 8; return bytes <= 128 * 1024; }
        if (typeof value === "string") { bytes += value.length * 2; return bytes <= 128 * 1024; }
        if (value instanceof Uint8Array) { bytes += value.byteLength; return value.byteLength <= 65535 && bytes <= 128 * 1024; }
        if (!value || typeof value !== "object" || seen.has(value)) return false;
        seen.add(value); const entries = Object.entries(value);
        return entries.length <= 32 && entries.every(([key, item]) => { bytes += key.length * 2; return bytes <= 128 * 1024 && visit(item, depth + 1); });
    };
    return Array.isArray(args) && args.length <= 12 && visit(args, 0);
}
export function encodeActorValue(value: unknown): string {
    return JSON.stringify(value === undefined ? null : value, (_name, item) => item instanceof Uint8Array ? { "$wsaBytes": Array.from(item) } : item);
}
export function decodeActorValue(value: string): any {
    return JSON.parse(value, (_name, item) => item && typeof item === "object" && Array.isArray(item.$wsaBytes) ? Uint8Array.from(item.$wsaBytes) : item);
}
