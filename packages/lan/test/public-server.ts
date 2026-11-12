import { createLanServer, type LanServerOptions } from "../src/server";
export type { LanServer, LanServerOptions } from "../src/server";

/** Compatibility fixtures explicitly trust all configured native destinations. */
export function publicRoomAccess(gateway?: LanServerOptions["gateway"]): NonNullable<LanServerOptions["roomAccess"]> {
    return {defaultVisibility:"public",defaultGateway:{routes:gateway?.routes.map((r,i)=>r.id ?? `route-${i}`) ?? [],udpListeners:[],tcpListeners:gateway?.tcpListeners?.map(l=>l.id) ?? []}};
}
export function createPublicLanServer(options: LanServerOptions = {}) {
    return createLanServer({
        ...options,
        roomAccess: options.roomAccess ?? publicRoomAccess(options.gateway),
    });
}
