// Layout persistence + the precedence resolver. The store must be TOTAL: junk in
// localStorage yields null, never a throw, or the touch overlay has no layout at first
// paint.

import { beforeEach, describe, expect, test } from "bun:test";
import {
    clearLayout,
    isPinned,
    loadLayout,
    loadUserLayout,
    resolveActiveLayout,
    saveGlobalDefault,
    saveLayout,
} from "../../src/input/layout-store";

class MemoryStorage {
    private map = new Map<string, string>();
    get length() { return this.map.size; }
    key(i: number) { return [...this.map.keys()][i] ?? null; }
    getItem(k: string) { return this.map.get(k) ?? null; }
    setItem(k: string, v: string) { this.map.set(k, String(v)); }
    removeItem(k: string) { this.map.delete(k); }
    clear() { this.map.clear(); }
    raw() { return this.map; }
}

let store: MemoryStorage;

beforeEach(() => {
    store = new MemoryStorage();
    (globalThis as any).localStorage = store as unknown as Storage;
});

describe("layout store", () => {
    test("saves and loads a per-game record under the versioned key", () => {
        saveLayout("gog:1207658695", { presetId: "wasd-look", mode: "trackpad" });
        expect([...store.raw().keys()]).toEqual(["bottleship_touch_layout_v1:gog:1207658695"]);
        expect(loadLayout("gog:1207658695")).toEqual({ presetId: "wasd-look", mode: "trackpad", pinned: true });
    });

    test("a saved per-game record pins the game against auto-select", () => {
        expect(isPinned("app:foo")).toBe(false);
        saveLayout("app:foo", { presetId: "pointer" });
        expect(isPinned("app:foo")).toBe(true);
        clearLayout("app:foo");
        expect(isPinned("app:foo")).toBe(false);
    });

    test("the global default is not a pin", () => {
        saveGlobalDefault({ presetId: "pointer-rmb" });
        expect(loadLayout(null)).toEqual({ presetId: "pointer-rmb" });
        expect(isPinned(null)).toBe(false);
    });

    test("malformed JSON yields null instead of throwing", () => {
        store.setItem("bottleship_touch_layout_v1:app:bad", "{not json");
        expect(loadLayout("app:bad")).toBeNull();
    });

    test("junk fields are dropped, not trusted", () => {
        store.setItem("bottleship_touch_layout_v1:app:junk", JSON.stringify({ presetId: 7, mode: "sideways", pinned: "yes" }));
        expect(loadLayout("app:junk")).toBeNull();
    });

    test("a layout object goes through the caller's validator", () => {
        store.setItem("bottleship_touch_layout_v1:app:v", JSON.stringify({ layout: { widgets: [] } }));
        expect(loadLayout("app:v", () => null)).toBeNull();
        expect(loadLayout<{ widgets: unknown[] }>("app:v", (raw) => raw as { widgets: unknown[] }))
            .toEqual({ layout: { widgets: [] } });
    });

    test("no localStorage at all is survivable", () => {
        delete (globalThis as any).localStorage;
        expect(loadLayout("app:foo")).toBeNull();
        expect(() => saveLayout("app:foo", { presetId: "pointer" })).not.toThrow();
    });
});

describe("resolveActiveLayout", () => {
    test("falls back to pointer with nothing supplied", () => {
        expect(resolveActiveLayout({})).toEqual({
            presetId: "pointer", layout: null, mode: "auto", moveKeys: null, tier: "fallback",
        });
    });

    test("each tier beats the ones below it", () => {
        const tiers = {
            session: { presetId: "session" },
            userOverride: { presetId: "user" },
            globalDefault: { presetId: "global" },
            manifest: { presetId: "manifest" },
            autoPick: { presetId: "auto" },
        };
        expect(resolveActiveLayout(tiers).tier).toBe("session");
        expect(resolveActiveLayout({ ...tiers, session: null }).tier).toBe("user");
        expect(resolveActiveLayout({ ...tiers, session: null, userOverride: null }).tier).toBe("global");
        expect(resolveActiveLayout({ ...tiers, session: null, userOverride: null, globalDefault: null }).tier).toBe("manifest");
        expect(resolveActiveLayout({ manifest: null, autoPick: { presetId: "auto" } }).tier).toBe("auto");
    });

    test("an authored layout object wins over a lower tier's preset id", () => {
        const layout = { id: "custom", widgets: [] };
        const r = resolveActiveLayout({ manifest: { layout }, autoPick: { presetId: "pad" } });
        expect(r.layout).toBe(layout);
        expect(r.tier).toBe("manifest");
    });

    test("mode resolves independently so a reshaped layout keeps the authored mode", () => {
        const r = resolveActiveLayout({
            userOverride: { layout: { id: "mine" } },
            manifest: { presetId: "wasd-look", mode: "trackpad" },
        });
        expect(r.tier).toBe("user");
        expect(r.mode).toBe("trackpad");
    });

    test("the auto-picked mode applies when nothing above states one", () => {
        expect(resolveActiveLayout({ autoPick: { presetId: "wasd-look", mode: "trackpad" } }).mode).toBe("trackpad");
    });

    test("moveKeys resolves independently: a bundle's numpad survives an auto-picked preset", () => {
        const r = resolveActiveLayout({ manifest: { moveKeys: "numpad" }, autoPick: { presetId: "wasd-look" } });
        expect(r.presetId).toBe("wasd-look");
        expect(r.tier).toBe("auto");
        expect(r.moveKeys).toBe("numpad");
        // ...and the player's choice beats the bundle's.
        expect(resolveActiveLayout({ userOverride: { moveKeys: "arrows" }, manifest: { moveKeys: "numpad" } }).moveKeys)
            .toBe("arrows");
    });
});

describe("per-orientation records", () => {
    test("each orientation keeps its own layout; moveKeys is shared by the game", () => {
        saveLayout("app:h", { moveKeys: "numpad", pinned: false });
        saveLayout("app:h", { presetId: "pad" }, "landscape");
        saveLayout("app:h", { presetId: "dpad-buttons" }, "portrait");
        expect([...store.raw().keys()].sort()).toEqual([
            "bottleship_touch_layout_v1:app:h",
            "bottleship_touch_layout_v1:app:h@landscape",
            "bottleship_touch_layout_v1:app:h@portrait",
        ]);
        expect(loadUserLayout("app:h", "landscape")).toEqual({ presetId: "pad", moveKeys: "numpad", pinned: true });
        expect(loadUserLayout("app:h", "portrait")).toEqual({ presetId: "dpad-buttons", moveKeys: "numpad", pinned: true });
    });

    test("a game-wide layout from an older build still applies to an orientation with none of its own", () => {
        saveLayout("app:old", { presetId: "pointer-rmb" });
        expect(loadUserLayout("app:old", "portrait")?.presetId).toBe("pointer-rmb");
        saveLayout("app:old", { presetId: "pad" }, "portrait");
        expect(loadUserLayout("app:old", "portrait")?.presetId).toBe("pad");
        expect(loadUserLayout("app:old", "landscape")?.presetId).toBe("pointer-rmb");
    });

    test("choosing movement keys alone does not pin the game against auto-select", () => {
        saveLayout("app:k", { moveKeys: "numpad", pinned: false });
        expect(isPinned("app:k")).toBe(false);
        expect(isPinned("app:k", "portrait")).toBe(false);
        saveLayout("app:k", { presetId: "pad" }, "portrait");
        expect(isPinned("app:k", "portrait")).toBe(true);
        expect(isPinned("app:k", "landscape")).toBe(false);
    });

    test("clearLayout drops both orientations too", () => {
        saveLayout("app:c", { presetId: "pad" }, "landscape");
        saveLayout("app:c", { presetId: "pad" }, "portrait");
        clearLayout("app:c");
        expect(store.raw().size).toBe(0);
    });
});
