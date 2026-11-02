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

/** Error-only actor metadata uses plain byte arrays, validated before any Uint8Array conversion. */
export interface WsaActorUdpReceiveError {
    version: 1;
    family: 2 | 23;
    address: number[];
    node: number[];
    port: number;
    scopeId?: number;
    flowInfo?: number;
}
export function copyActorUdpReceiveError(value: unknown): WsaActorUdpReceiveError | undefined {
    try {
        if (!value || typeof value !== "object" || Array.isArray(value) ||
            Object.getPrototypeOf(value) !== Object.prototype) return;
        const item = value as Partial<WsaActorUdpReceiveError>;
        const allowed = new Set(["version", "family", "address", "node", "port", "scopeId", "flowInfo"]);
        if (Object.keys(item).some(key => !allowed.has(key)) || item.version !== 1 ||
            (item.family !== 2 && item.family !== 23)) return;
        const bytes = (input: unknown, length: number): input is number[] => {
            if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length !== length) return false;
            for (let i = 0; i < length; i++) {
                if (!Object.prototype.hasOwnProperty.call(input, i) || !Number.isInteger(input[i]) || input[i] < 0 || input[i] > 255) return false;
            }
            return true;
        };
        const u32 = (input: unknown): input is number =>
            typeof input === "number" && Number.isInteger(input) && input >= 0 && input <= 0xffffffff;
        if (!bytes(item.address, item.family === 2 ? 4 : 16) || !bytes(item.node, 6) ||
            !Number.isInteger(item.port) || item.port! < 1 || item.port! > 65535 ||
            (item.scopeId !== undefined && !u32(item.scopeId)) ||
            (item.flowInfo !== undefined && !u32(item.flowInfo)) ||
            (item.family === 2 && (item.scopeId !== undefined || item.flowInfo !== undefined))) return;
        return { version: 1, family: item.family, address: [...item.address], node: [...item.node], port: item.port!,
            ...(item.scopeId !== undefined ? { scopeId: item.scopeId } : {}),
            ...(item.flowInfo !== undefined ? { flowInfo: item.flowInfo } : {}) };
    } catch { return; }
}
