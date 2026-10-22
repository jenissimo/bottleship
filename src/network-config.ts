export interface NetworkConfig {
  serverUrl: string;
  room: string;
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
  const { serverUrl, room } = value as Partial<NetworkConfig>;
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
  return { serverUrl: url.origin, room: name };
}

export function networkConfigFromLocation(search: string, saved: NetworkConfig | null): NetworkConfig | null {
  const params = new URLSearchParams(search);
  if (!params.has("lanServer") && !params.has("room")) return saved;
  return normalizeNetworkConfig({
    serverUrl: params.get("lanServer") ?? saved?.serverUrl,
    room: params.get("room") ?? saved?.room,
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
