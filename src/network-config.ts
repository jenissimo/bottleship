export interface DirectPlay8NetworkPolicy { provider: "native"; hostListener: string }
export interface DirectPlay4NetworkPolicy { provider: "native"; tcpHostListener: string; udpHostListener: string }
export interface WinsockNetworkPolicy { provider: "native"; hostListener: string }
export interface NetworkConfig {
  serverUrl: string;
  room: string;
  invite?: string;
  directPlay8?: DirectPlay8NetworkPolicy;
  directPlay4?: DirectPlay4NetworkPolicy;
  winsock?: WinsockNetworkPolicy;
}

export interface NetworkStatus {
  state: "offline" | "connecting" | "connected" | "disconnected" | "error";
  address?: string;
  reason?: string;
}

export const NETWORK_SETTINGS_KEY = "bottleship_network_v1";
/** Per-game "Remember for this game" answers of the network permission dialog. */
export const NETWORK_CONSENT_KEY = "bottleship_network_consent_v1";

/** The relay this deployment offers; empty means the dialog asks for one. */
export const DEFAULT_LAN_SERVER: string = import.meta.env.VITE_LAN_SERVER ?? "";

const ROOM_ADJECTIVES = ["quiet", "brave", "lucky", "sunny", "swift", "clever", "gentle", "bold", "merry", "calm",
    "bright", "jolly", "keen", "proud", "silver", "amber", "misty", "rusty", "salty", "windy"];
const ROOM_ANIMALS = ["otter", "falcon", "badger", "heron", "walrus", "lynx", "marten", "puffin", "beaver", "gecko",
    "narwhal", "osprey", "panda", "raven", "seal", "tapir", "wombat", "yak", "koala", "dolphin"];
/** A room name a person can read aloud: quiet-otter-4821. */
export function generateRoomName(random: (n: number) => number = n => {
    const value = new Uint32Array(1); crypto.getRandomValues(value); return value[0] % n;
}): string {
    return `${ROOM_ADJECTIVES[random(ROOM_ADJECTIVES.length)]}-${ROOM_ANIMALS[random(ROOM_ANIMALS.length)]}-${String(1000 + random(9000))}`;
}

/** What a pasted "Join room" text names: a whole invite link, or just a room name. */
export interface RoomInput { room: string; serverUrl?: string; invite?: string }
export function parseRoomInput(text: string): RoomInput {
    const value = text.trim();
    if (/^[A-Za-z0-9_-]{1,64}$/.test(value)) return { room: value };
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("Paste the link your friend sent, or a room name such as quiet-otter-4821."); }
    const room = url.searchParams.get("room");
    if (!room || !/^[A-Za-z0-9_-]{1,64}$/.test(room)) throw new Error("That link has no room in it.");
    const serverUrl = url.searchParams.get("lanServer") ?? undefined;
    const invite = new URLSearchParams(url.hash.replace(/^#/, "")).get("lanInvite") ?? undefined;
    return { room, ...(serverUrl ? { serverUrl } : {}), ...(invite ? { invite } : {}) };
}

/** True when the page was opened with network settings in its URL (an invite link). */
export function networkFromLink(search: string, hash = ""): boolean {
    const params = new URLSearchParams(search);
    return params.has("room") || params.has("lanServer") || new URLSearchParams(hash.replace(/^#/, "")).has("lanInvite");
}

/**
 * What the permission dialog offers before the user touched anything: the link's room and
 * server, else the saved choice, else the deployment's server and no room. A link with a
 * room but no server (a friend's room-only link) uses the default server.
 */
export interface NetworkSuggestion { serverUrl: string; room: string; invite?: string; fromLink: boolean }
export function networkSuggestion(search: string, hash: string, saved: NetworkConfig | null, defaultServer = DEFAULT_LAN_SERVER): NetworkSuggestion {
    const params = new URLSearchParams(search);
    const fromLink = networkFromLink(search, hash);
    const room = params.get("room") ?? (fromLink ? "" : saved?.room ?? "");
    const serverUrl = params.get("lanServer") ?? saved?.serverUrl ?? defaultServer;
    const invite = new URLSearchParams(hash.replace(/^#/, "")).get("lanInvite") ?? undefined;
    return { serverUrl, room: /^[A-Za-z0-9_-]{1,64}$/.test(room) ? room : "", ...(invite ? { invite } : {}), fromLink };
}

/** `?lanConsent=auto` answers the permission prompt with the configured room, for tests. */
export function networkConsentAutoFromLocation(search: string): boolean {
    return new URLSearchParams(search).get("lanConsent") === "auto";
}

/** How a friend opens the same game: the catalog id, or a public bundle URL for ?game=dev. */
export interface ShareableGame { catalogId?: string; publicLoadUrl?: string }
/**
 * The link a friend opens to land in this game and this room. A game they cannot open from
 * a URL (a local file, an OPFS import, a dev drop-folder bundle) gets a room-only link, and
 * `includesGame` says so — the friend needs their own copy.
 */
export function buildFriendLink(origin: string, config: NetworkConfig, game: ShareableGame): { url: string; includesGame: boolean } {
    const url = new URL("/", origin);
    let includesGame = false;
    if (game.catalogId && game.catalogId !== "dev") { url.searchParams.set("game", game.catalogId); includesGame = true; }
    else if (game.publicLoadUrl) { url.searchParams.set("game", "dev"); url.searchParams.set("load", game.publicLoadUrl); includesGame = true; }
    url.searchParams.set("lanServer", config.serverUrl);
    url.searchParams.set("room", config.room);
    return { url: networkInviteUrl(url.toString(), config), includesGame };
}

/** A `?load=` value only names something a friend can open if it is a public http(s) URL. */
export function publicLoadUrl(load: string | null, origin: string): string | undefined {
    if (!load) return undefined;
    let url: URL;
    try { url = new URL(load, origin); } catch { return undefined; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.pathname.startsWith("/__wgb") || url.pathname.startsWith("/apps/external-wgb")) return undefined;
    const host = url.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost")) return undefined;
    return url.origin === origin ? url.pathname + url.search : url.toString();
}

export type RememberedConsent = { choice: "offline" } | { choice: "connect"; serverUrl: string; room: string };
export function loadRememberedConsent(game: string, storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): RememberedConsent | null {
    try {
        const entry = JSON.parse(storage?.getItem(NETWORK_CONSENT_KEY) ?? "{}")?.[game];
        if (entry?.choice === "offline") return { choice: "offline" };
        if (entry?.choice === "connect") {
            const config = normalizeNetworkConfig({ serverUrl: entry.serverUrl, room: entry.room });
            if (config) return { choice: "connect", serverUrl: config.serverUrl, room: config.room };
        }
    } catch { /* Invalid or unavailable storage: ask again. */ }
    return null;
}
export function saveRememberedConsent(game: string, value: RememberedConsent | null,
    storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
    try {
        const all = JSON.parse(storage?.getItem(NETWORK_CONSENT_KEY) ?? "{}") ?? {};
        if (value) all[game] = value; else delete all[game];
        storage?.setItem(NETWORK_CONSENT_KEY, JSON.stringify(all));
    } catch { /* Storage may be unavailable. */ }
}

export function normalizeNetworkConfig(value: unknown): NetworkConfig | null {
  if (value == null) return null;
  if (typeof value !== "object") throw new Error("Network settings must contain a server URL and room.");
  const { serverUrl, room, invite, directPlay8, directPlay4, winsock } = value as Partial<NetworkConfig>;
  if (winsock !== undefined && (!winsock || winsock.provider !== "native" ||
      typeof winsock.hostListener !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(winsock.hostListener)))
    throw new Error("Native Winsock requires a configured TCP Host listener ID.");
  if (directPlay4 !== undefined && (!directPlay4 || directPlay4.provider !== "native" ||
      typeof directPlay4.tcpHostListener !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(directPlay4.tcpHostListener) ||
      typeof directPlay4.udpHostListener !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(directPlay4.udpHostListener) ||
      !winsock || winsock.hostListener !== directPlay4.tcpHostListener))
    throw new Error("Native DirectPlay 4 requires UDP and matching Winsock TCP listener IDs.");
  if (directPlay8 !== undefined && (!directPlay8 || directPlay8.provider !== "native" ||
      typeof directPlay8.hostListener !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(directPlay8.hostListener)))
    throw new Error("Native DirectPlay requires a configured UDP Host listener ID.");
  if (typeof serverUrl !== "string" || typeof room !== "string") {
    throw new Error("Enter a LAN server URL and room.");
  }
  if (invite !== undefined && (typeof invite !== "string" || invite.length > 4096 || !/^bs1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(invite))) throw new Error("Invalid room invitation.");
  const name = room.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error("Room names use 1–64 letters, numbers, underscores or hyphens.");
  }
  let url: URL;
  try { url = new URL(serverUrl.trim()); }
  catch { throw new Error("Enter a complete LAN server URL, such as https://lan.example.org."); }
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use an HTTP(S) server address without a path, query or credentials.");
  }
  return { serverUrl: url.origin, room: name, ...(invite ? {invite} : {}), ...(directPlay8 ? {directPlay8: {provider: "native" as const, hostListener: directPlay8.hostListener}} : {}),
    ...(winsock ? {winsock: {provider: "native" as const, hostListener: winsock.hostListener}} : {}),
    ...(directPlay4 ? {directPlay4: {provider: "native" as const, tcpHostListener: directPlay4.tcpHostListener, udpHostListener: directPlay4.udpHostListener}} : {}) };
}

export function networkConfigFromLocation(search: string, saved: NetworkConfig | null, hash = ""): NetworkConfig | null {
  const params = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  if (!fragment.has("lanInvite") && !params.has("dp4Provider") && !params.has("dp4TcpHostListener") && !params.has("dp4UdpHostListener") && !params.has("lanServer") && !params.has("room") && !params.has("dp8Provider") && !params.has("dp8HostListener") && !params.has("winsockProvider") && !params.has("winsockHostListener")) return saved;
  const provider = params.get("dp8Provider");
  if (provider !== null && provider !== "native") throw new Error("Invalid DirectPlay provider.");
  const directPlay8 = params.has("dp8Provider") || params.has("dp8HostListener") ?
    {provider: "native" as const, hostListener: params.get("dp8HostListener") ?? saved?.directPlay8?.hostListener ?? ""} : saved?.directPlay8;
  const winsockProvider = params.get("winsockProvider");
  if (winsockProvider !== null && winsockProvider !== "native") throw new Error("Invalid Winsock provider.");
  const winsock = params.has("winsockProvider") || params.has("winsockHostListener") ?
    {provider: "native" as const, hostListener: params.get("winsockHostListener") ?? saved?.winsock?.hostListener ?? ""} : saved?.winsock;
  const dp4Provider = params.get("dp4Provider");
  if (dp4Provider !== null && dp4Provider !== "native") throw new Error("Invalid DirectPlay 4 provider.");
  const directPlay4 = params.has("dp4Provider") || params.has("dp4TcpHostListener") || params.has("dp4UdpHostListener") ?
    {provider: "native" as const, tcpHostListener: params.get("dp4TcpHostListener") ?? saved?.directPlay4?.tcpHostListener ?? "",
      udpHostListener: params.get("dp4UdpHostListener") ?? saved?.directPlay4?.udpHostListener ?? ""} : saved?.directPlay4;
  return normalizeNetworkConfig({
    invite: fragment.get("lanInvite") ?? ((params.get("room") ?? saved?.room) === saved?.room && (params.get("lanServer") ?? saved?.serverUrl) === saved?.serverUrl ? saved?.invite : undefined),
    directPlay4,
    winsock,
    serverUrl: params.get("lanServer") ?? saved?.serverUrl,
    room: params.get("room") ?? saved?.room,
    directPlay8,
  });
}

export function networkInviteUrl(href: string, config: NetworkConfig | null): string {
  const url = new URL(href);
  if (config) {
    url.searchParams.set("lanServer", config.serverUrl);
    url.searchParams.set("room", config.room);
  } else {
    url.searchParams.delete("lanServer");
    url.searchParams.delete("room");
  }
  if (config?.directPlay4) {
    url.searchParams.set("dp4Provider", "native");
    url.searchParams.set("dp4TcpHostListener", config.directPlay4.tcpHostListener);
    url.searchParams.set("dp4UdpHostListener", config.directPlay4.udpHostListener);
  } else {
    url.searchParams.delete("dp4Provider"); url.searchParams.delete("dp4TcpHostListener"); url.searchParams.delete("dp4UdpHostListener");
  }
  if (config?.directPlay8) {
    url.searchParams.set("dp8Provider", "native"); url.searchParams.set("dp8HostListener", config.directPlay8.hostListener);
  } else { url.searchParams.delete("dp8Provider"); url.searchParams.delete("dp8HostListener"); }
  if (config?.winsock) {
    url.searchParams.set("winsockProvider", "native"); url.searchParams.set("winsockHostListener", config.winsock.hostListener);
  } else { url.searchParams.delete("winsockProvider"); url.searchParams.delete("winsockHostListener"); }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  if (config?.invite) fragment.set("lanInvite", config.invite); else fragment.delete("lanInvite");
  url.hash = fragment.toString();
  return url.toString();
}

export function networkConfigForStorage(config: NetworkConfig | null): NetworkConfig | null {
  if (!config) return null;
  const saved = {...config}; delete saved.invite; return saved;
}

export function loadNetworkConfig(): NetworkConfig | null {
  if (typeof window === "undefined") return null;
  let saved: NetworkConfig | null = null;
  try { saved = normalizeNetworkConfig(JSON.parse(localStorage.getItem(NETWORK_SETTINGS_KEY) ?? "null")); }
  catch { /* Ignore invalid persisted preferences. */ }
  try { return networkConfigFromLocation(window.location.search, saved, window.location.hash); }
  catch { return null; }
}
