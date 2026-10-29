export interface DirectPlay8NetworkPolicy { provider: "native"; hostListener: string }
export interface WinsockNetworkPolicy { provider: "native"; hostListener: string }
export interface NetworkConfig {
  serverUrl: string;
  room: string;
  directPlay8?: DirectPlay8NetworkPolicy;
  winsock?: WinsockNetworkPolicy;
}

export interface NetworkStatus {
  state: "offline" | "connecting" | "connected" | "disconnected" | "error";
  address?: string;
  reason?: string;
}

export const NETWORK_SETTINGS_KEY = "bottleship_network_v1";

export function normalizeNetworkConfig(value: unknown): NetworkConfig | null {
  if (value == null) return null;
  if (typeof value !== "object") throw new Error("Network settings must contain a server URL and room.");
  const { serverUrl, room, directPlay8, winsock } = value as Partial<NetworkConfig>;
  if (winsock !== undefined && (!winsock || winsock.provider !== "native" ||
      typeof winsock.hostListener !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(winsock.hostListener)))
    throw new Error("Native Winsock requires a configured TCP Host listener ID.");
  if (directPlay8 !== undefined && (!directPlay8 || directPlay8.provider !== "native" ||
      typeof directPlay8.hostListener !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(directPlay8.hostListener)))
    throw new Error("Native DirectPlay requires a configured UDP Host listener ID.");
  if (typeof serverUrl !== "string" || typeof room !== "string") {
    throw new Error("Enter a LAN server URL and room.");
  }
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
  return { serverUrl: url.origin, room: name, ...(directPlay8 ? {directPlay8: {provider: "native" as const, hostListener: directPlay8.hostListener}} : {}),
    ...(winsock ? {winsock: {provider: "native" as const, hostListener: winsock.hostListener}} : {}) };
}

export function networkConfigFromLocation(search: string, saved: NetworkConfig | null): NetworkConfig | null {
  const params = new URLSearchParams(search);
  if (!params.has("lanServer") && !params.has("room") && !params.has("dp8Provider") && !params.has("dp8HostListener") && !params.has("winsockProvider") && !params.has("winsockHostListener")) return saved;
  const provider = params.get("dp8Provider");
  if (provider !== null && provider !== "native") throw new Error("Invalid DirectPlay provider.");
  const directPlay8 = params.has("dp8Provider") || params.has("dp8HostListener") ?
    {provider: "native" as const, hostListener: params.get("dp8HostListener") ?? saved?.directPlay8?.hostListener ?? ""} : saved?.directPlay8;
  const winsockProvider = params.get("winsockProvider");
  if (winsockProvider !== null && winsockProvider !== "native") throw new Error("Invalid Winsock provider.");
  const winsock = params.has("winsockProvider") || params.has("winsockHostListener") ?
    {provider: "native" as const, hostListener: params.get("winsockHostListener") ?? saved?.winsock?.hostListener ?? ""} : saved?.winsock;
  return normalizeNetworkConfig({
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
  if (config?.directPlay8) {
    url.searchParams.set("dp8Provider", "native"); url.searchParams.set("dp8HostListener", config.directPlay8.hostListener);
  } else { url.searchParams.delete("dp8Provider"); url.searchParams.delete("dp8HostListener"); }
  if (config?.winsock) {
    url.searchParams.set("winsockProvider", "native"); url.searchParams.set("winsockHostListener", config.winsock.hostListener);
  } else { url.searchParams.delete("winsockProvider"); url.searchParams.delete("winsockHostListener"); }
  return url.toString();
}

export function loadNetworkConfig(): NetworkConfig | null {
  if (typeof window === "undefined") return null;
  let saved: NetworkConfig | null = null;
  try { saved = normalizeNetworkConfig(JSON.parse(localStorage.getItem(NETWORK_SETTINGS_KEY) ?? "null")); }
  catch { /* Ignore invalid persisted preferences. */ }
  try { return networkConfigFromLocation(window.location.search, saved); }
  catch { return null; }
}
