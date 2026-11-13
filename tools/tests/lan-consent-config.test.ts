import { describe, expect, test } from "bun:test";
import {
    buildFriendLink, DEFAULT_LAN_SERVER, generateRoomName, loadNetworkConfig, loadRememberedConsent, networkConfigFromLocation,
    networkConsentAutoFromLocation, networkFromLink, networkSuggestion, NETWORK_CONSENT_KEY, normalizeNetworkConfig,
    parseRoomInput, publicLoadUrl, saveRememberedConsent,
} from "../../src/network-config";

const memoryStorage = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data }; };
const config = { serverUrl: "https://lan.example.org", room: "quiet-otter-4821" };

describe("network permission configuration", () => {
    test("the default server comes from VITE_LAN_SERVER and is empty without it", () => {
        expect(DEFAULT_LAN_SERVER).toBe(process.env.VITE_LAN_SERVER ?? "");
    });
    test("generated room names are readable and valid room names", () => {
        let n = 0;
        expect(generateRoomName(max => (n++ * 7) % max)).toBe("quiet-puffin-1014");
        for (let i = 0; i < 50; i++) {
            const name = generateRoomName();
            expect(name).toMatch(/^[a-z]+-[a-z]+-\d{4}$/);
            expect(normalizeNetworkConfig({ serverUrl: "https://x.example", room: name })?.room).toBe(name);
        }
    });
    test("Join accepts a whole invite link or a bare room name", () => {
        expect(parseRoomInput("  quiet-otter-4821 ")).toEqual({ room: "quiet-otter-4821" });
        expect(parseRoomInput("https://b.example/?game=hommiii&lanServer=https%3A%2F%2Flan.example.org&room=brave-yak-1000#lanInvite=bs1.x.y"))
            .toEqual({ room: "brave-yak-1000", serverUrl: "https://lan.example.org", invite: "bs1.x.y" });
        expect(() => parseRoomInput("two words")).toThrow();
        expect(() => parseRoomInput("https://b.example/?game=x")).toThrow("no room");
    });
    test("an invite link preselects its room; a saved preference only prefills, the default fills the server", () => {
        const saved = { serverUrl: "https://saved.example.org", room: "saved-room" };
        expect(networkSuggestion("?game=dev", "", saved, "https://default.example")).toEqual({ serverUrl: saved.serverUrl, room: "saved-room", fromLink: false });
        expect(networkSuggestion("?room=brave-yak-1000", "", saved, "https://default.example"))
            .toEqual({ serverUrl: saved.serverUrl, room: "brave-yak-1000", fromLink: true });
        expect(networkSuggestion("?room=brave-yak-1000", "", null, "https://default.example"))
            .toEqual({ serverUrl: "https://default.example", room: "brave-yak-1000", fromLink: true });
        expect(networkSuggestion("?lanServer=https%3A%2F%2Fl.example&room=r", "#lanInvite=bs1.a.b", null, ""))
            .toEqual({ serverUrl: "https://l.example", room: "r", invite: "bs1.a.b", fromLink: true });
        expect(networkSuggestion("?room=../bad", "", null, "").room).toBe("");
        expect(networkFromLink("?game=dev", "")).toBe(false);
        expect(networkFromLink("?game=dev", "#lanInvite=bs1.a.b")).toBe(true);
    });
    test("existing URL parameters and saved bottleship_network_v1 settings keep parsing unchanged", () => {
        const saved = { serverUrl: "https://old.example.org", room: "old", winsock: { provider: "native" as const, hostListener: "tcp" } };
        expect(networkConfigFromLocation("?game=dev", saved)).toEqual(saved);
        expect(networkConfigFromLocation("?dp8Provider=native&dp8HostListener=h", saved)?.directPlay8).toEqual({ provider: "native", hostListener: "h" });
        expect(loadNetworkConfig()).toBeNull(); // no window in the test realm: nothing connects or loads by itself
    });
    test("?lanConsent=auto is the unattended answer", () => {
        expect(networkConsentAutoFromLocation("?game=dev&lanConsent=auto")).toBe(true);
        expect(networkConsentAutoFromLocation("?game=dev")).toBe(false);
    });
    test("Remember for this game is per game and survives bad storage", () => {
        const storage = memoryStorage();
        expect(loadRememberedConsent("hommiii", storage)).toBeNull();
        saveRememberedConsent("hommiii", { choice: "connect", serverUrl: "https://lan.example.org/", room: "r1" }, storage);
        saveRememberedConsent("worms", { choice: "offline" }, storage);
        expect(loadRememberedConsent("hommiii", storage)).toEqual({ choice: "connect", serverUrl: "https://lan.example.org", room: "r1" });
        expect(loadRememberedConsent("worms", storage)).toEqual({ choice: "offline" });
        saveRememberedConsent("worms", null, storage);
        expect(loadRememberedConsent("worms", storage)).toBeNull();
        storage.setItem(NETWORK_CONSENT_KEY, "{not json");
        expect(loadRememberedConsent("hommiii", storage)).toBeNull();
    });
});

describe("link for a friend", () => {
    test("a catalog game travels with the room", () => {
        const { url, includesGame } = buildFriendLink("https://bottleship.example", config, { catalogId: "hommiii" });
        const parsed = new URL(url);
        expect(includesGame).toBe(true);
        expect(parsed.origin + parsed.pathname).toBe("https://bottleship.example/");
        expect(parsed.searchParams.get("game")).toBe("hommiii");
        expect(parsed.searchParams.get("lanServer")).toBe("https://lan.example.org");
        expect(parsed.searchParams.get("room")).toBe("quiet-otter-4821");
        expect(networkConfigFromLocation(parsed.search, null, parsed.hash)).toEqual(config);
    });
    test("a public ?load= bundle travels as ?game=dev&load=", () => {
        const { url, includesGame } = buildFriendLink("https://bottleship.example", config, { publicLoadUrl: "https://cdn.example/g.wgb" });
        expect(includesGame).toBe(true);
        expect(new URL(url).searchParams.get("game")).toBe("dev");
        expect(new URL(url).searchParams.get("load")).toBe("https://cdn.example/g.wgb");
    });
    test("a local bundle gets a room-only link", () => {
        const { url, includesGame } = buildFriendLink("http://localhost:5192", config, { catalogId: "dev" });
        expect(includesGame).toBe(false);
        const parsed = new URL(url);
        expect(parsed.searchParams.has("game")).toBe(false);
        expect(parsed.searchParams.get("room")).toBe("quiet-otter-4821");
    });
    test("private invitations stay in the fragment", () => {
        const invite = "bs1." + "a".repeat(20) + "." + "b".repeat(43);
        const { url } = buildFriendLink("https://bottleship.example", { ...config, invite }, { catalogId: "worms" });
        expect(new URL(url).search).not.toContain(invite);
        expect(new URLSearchParams(new URL(url).hash.slice(1)).get("lanInvite")).toBe(invite);
    });
    test("only public bundle URLs are shareable", () => {
        const origin = "https://bottleship.example";
        expect(publicLoadUrl("https://cdn.example/a.wgb", origin)).toBe("https://cdn.example/a.wgb");
        expect(publicLoadUrl("/apps/demo.wgb", origin)).toBe("/apps/demo.wgb");
        expect(publicLoadUrl("/__wgb/?path=G%3A%2FWGB%2Fa.wgb", origin)).toBeUndefined();
        expect(publicLoadUrl("/apps/external-wgb/a.wgb", origin)).toBeUndefined();
        expect(publicLoadUrl("http://localhost:3001/wgb?path=x", origin)).toBeUndefined();
        expect(publicLoadUrl("blob:https://bottleship.example/1", origin)).toBeUndefined();
        expect(publicLoadUrl(null, origin)).toBeUndefined();
    });
});
