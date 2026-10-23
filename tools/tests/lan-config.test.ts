import { afterEach, describe, expect, test } from "bun:test";
import { networkConfigFromLocation, networkInviteUrl, normalizeNetworkConfig } from "../../src/network-config";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";

describe("LAN connection configuration", () => {
  const config = EmulatorConfig.getInstance();
  afterEach(() => { config.setNetwork(null); config.reset(); });

  test("WebSocket URLs normalize to the same Socket.IO server origin", () => {
    expect(normalizeNetworkConfig({ serverUrl: "wss://lan.example.org:443/", room: " friends " }))
      .toEqual({ serverUrl: "https://lan.example.org", room: "friends" });
    expect(normalizeNetworkConfig({ serverUrl: "ws://127.0.0.1:9001", room: "test_1" }))
      .toEqual({ serverUrl: "http://127.0.0.1:9001", room: "test_1" });
  });

  test("rejects malformed or ambiguous endpoints and room identities", () => {
    for (const serverUrl of [
      "not a URL", "file:///tmp/server", "https://user:password@example.org",
      "https://example.org/namespace", "https://example.org/?room=other", "https://example.org/#room",
    ]) {
      expect(() => normalizeNetworkConfig({ serverUrl, room: "friends" })).toThrow();
    }
    for (const room of ["", "../friends", "two rooms", "x".repeat(65), 123, null]) {
      expect(() => normalizeNetworkConfig({ serverUrl: "https://lan.example.org", room })).toThrow();
    }
    expect(normalizeNetworkConfig(null)).toBeNull();
  });

  test("invites select the requested server and room without changing the saved preference", () => {
    const saved = { serverUrl: "https://old.example.org", room: "old" };
    expect(networkConfigFromLocation("?game=dev", saved)).toEqual(saved);
    expect(networkConfigFromLocation("?lanServer=https%3A%2F%2Fnew.example.org&room=new", saved))
      .toEqual({ serverUrl: "https://new.example.org", room: "new" });
    expect(saved.room).toBe("old");
    expect(() => networkConfigFromLocation("?room=../invalid", saved)).toThrow();
  });

  test("changing or disconnecting an invitation survives reload and preserves the game URL", () => {
    const original = "https://bottleship.example/?game=dev&bs=lan&room=old&lanServer=https%3A%2F%2Fold.example.org";
    const selected = { serverUrl: "https://new.example.org", room: "new" };
    const connected = new URL(networkInviteUrl(original, selected));
    expect(networkConfigFromLocation(connected.search, null)).toEqual(selected);
    expect(connected.searchParams.get("game")).toBe("dev");
    expect(connected.searchParams.get("bs")).toBe("lan");
    const disconnected = new URL(networkInviteUrl(connected.href, null));
    expect(disconnected.searchParams.has("room")).toBe(false);
    expect(disconnected.searchParams.has("lanServer")).toBe(false);
    expect(networkConfigFromLocation(disconnected.search, null)).toBeNull();
  });

  test("network membership survives a game reset and is inherited by child processes", () => {
    const selected = { serverUrl: "https://lan.example.org", room: "friends" };
    config.setNetwork(selected);
    config.reset();
    expect(config.network).toEqual(selected);
    const inherited = config.snapshotForChild();
    config.setNetwork(null);
    config.restoreForChild(inherited);
    expect(config.network).toEqual(selected);
    (inherited.network as { room: string }).room = "different";
    expect(config.network?.room).toBe("friends");
  });

  test("explicit native DirectPlay policy roundtrips through configuration and invitations", () => {
    const selected = {serverUrl:"https://lan.example.org",room:"friends",directPlay8:{provider:"native" as const,hostListener:"game-host"}};
    config.setNetwork(selected); selected.directPlay8.hostListener="mutated";
    expect(config.network?.directPlay8?.hostListener).toBe("game-host");
    const inherited=config.snapshotForChild(); config.setNetwork(null); config.restoreForChild(inherited);
    expect(config.network?.directPlay8).toEqual({provider:"native",hostListener:"game-host"});
    const url=new URL(networkInviteUrl("https://bottleship.example/?game=dev",config.network));
    expect(networkConfigFromLocation(url.search,null)).toEqual(config.network);
    expect(new URL(networkInviteUrl(url.href,null)).searchParams.has("dp8Provider")).toBe(false);
    for(const directPlay8 of [null,{provider:"native"},{provider:"other",hostListener:"game"},{provider:"native",hostListener:"../bad"}])
      expect(()=>normalizeNetworkConfig({...selected,directPlay8})).toThrow();
  });

  test("invalid settings leave the previous valid configuration intact", () => {
    config.setNetwork({ serverUrl: "https://lan.example.org", room: "friends" });
    expect(() => config.setNetwork({ serverUrl: "bad", room: "friends" })).toThrow();
    expect(config.network?.room).toBe("friends");
  });
});
