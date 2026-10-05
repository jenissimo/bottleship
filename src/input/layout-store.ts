// Persistence + precedence for the on-screen control layout.
//
// localStorage, not OPFS: the overlay needs a layout at FIRST PAINT and OPFS reads are
// async. Deliberately NOT part of UiSettings either — loadUiSettings is a single
// try/catch, so one malformed layout blob there would silently reset every setting to
// defaults. This module owns its own parse guard and fails to `null`, never throws.
//
// Layout objects are opaque here: validation belongs to src/input/controls/types.ts
// (validateLayout), which callers pass in. This module only owns storage + precedence.

const KEY_PREFIX = "bottleship_touch_layout_v1:";
const GLOBAL_KEY = "default";

export type TouchModePref = "auto" | "direct" | "trackpad";

/** One stored/resolved tier: a named preset, an authored layout, or both. */
export interface StoredLayout<L = unknown> {
    presetId?: string;
    layout?: L;
    mode?: TouchModePref;
    /**
     * Set when the user picked or edited a layout for this game. Auto-select stops for
     * that gameId — a runtime signal must never overwrite an explicit choice.
     */
    pinned?: boolean;
}

export type LayoutValidator<L> = (raw: unknown) => L | null;

function storage(): Storage | null {
    try {
        return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
        return null; // private-mode / blocked-cookies throws on access
    }
}

function storageKey(gameId: string | null | undefined): string {
    const id = (gameId ?? "").trim();
    return KEY_PREFIX + (id.length > 0 ? id : GLOBAL_KEY);
}

function parseStored<L>(raw: string | null, validate?: LayoutValidator<L>): StoredLayout<L> | null {
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    const out: StoredLayout<L> = {};
    if (typeof o.presetId === "string" && o.presetId.length > 0) out.presetId = o.presetId;
    if (o.mode === "auto" || o.mode === "direct" || o.mode === "trackpad") out.mode = o.mode;
    if (o.pinned === true) out.pinned = true;
    if (o.layout !== undefined && o.layout !== null) {
        const layout = validate ? validate(o.layout) : (o.layout as L);
        if (layout !== null) out.layout = layout;
    }
    if (out.presetId === undefined && out.layout === undefined && out.mode === undefined) return null;
    return out;
}

/** Per-game record (or the global default when gameId is null/empty). */
export function loadLayout<L = unknown>(
    gameId: string | null | undefined,
    validate?: LayoutValidator<L>,
): StoredLayout<L> | null {
    const s = storage();
    if (!s) return null;
    try {
        return parseStored<L>(s.getItem(storageKey(gameId)), validate);
    } catch {
        return null;
    }
}

export function loadGlobalDefault<L = unknown>(validate?: LayoutValidator<L>): StoredLayout<L> | null {
    return loadLayout<L>(null, validate);
}

/**
 * Write a per-game record. `pinned` defaults to true for a real gameId: reaching this
 * function means the user made a choice, which is what stops auto-select for that game.
 */
export function saveLayout<L>(gameId: string | null | undefined, value: StoredLayout<L>): void {
    const s = storage();
    if (!s) return;
    const id = (gameId ?? "").trim();
    const record: StoredLayout<L> = { ...value };
    if (id.length > 0 && record.pinned === undefined) record.pinned = true;
    try {
        s.setItem(storageKey(gameId), JSON.stringify(record));
    } catch {
        // quota / private mode — a lost layout is recoverable, a thrown UI is not
    }
}

export function saveGlobalDefault<L>(value: StoredLayout<L>): void {
    saveLayout<L>(null, { ...value, pinned: undefined });
}

export function clearLayout(gameId: string | null | undefined): void {
    const s = storage();
    if (!s) return;
    try {
        s.removeItem(storageKey(gameId));
    } catch {
        // ignore
    }
}

/** True once the user picked/edited a layout for this game — auto-select must stop. */
export function isPinned(gameId: string | null | undefined): boolean {
    const id = (gameId ?? "").trim();
    if (id.length === 0) return false;
    return loadLayout(id)?.pinned === true;
}

export type LayoutTier = "session" | "user" | "global" | "manifest" | "auto" | "fallback";

export interface LayoutTiers<L> {
    /** Editor in progress — memory only. */
    session?: StoredLayout<L> | null;
    /** localStorage per gameId. */
    userOverride?: StoredLayout<L> | null;
    /** localStorage ":default". */
    globalDefault?: StoredLayout<L> | null;
    /** Bundle manifest `emulator.touch`, delivered by bundle_meta. */
    manifest?: StoredLayout<L> | null;
    /** pickPreset() result. */
    autoPick?: StoredLayout<L> | null;
}

export interface ResolvedLayout<L> {
    presetId: string;
    layout: L | null;
    mode: TouchModePref;
    /** Which tier supplied the layout/preset (mode may come from a lower one). */
    tier: LayoutTier;
}

const TIER_ORDER: LayoutTier[] = ["session", "user", "global", "manifest", "auto"];

/**
 * Precedence, highest first: session > per-game user override > global default >
 * bundle manifest > auto-detected preset > built-in `pointer`.
 *
 * Layout and mode resolve INDEPENDENTLY: a user who reshapes the widgets should not
 * silently discard the bundle author's `mode: "trackpad"`, and an auto-picked mode
 * should still apply under an authored layout.
 */
export function resolveActiveLayout<L>(tiers: LayoutTiers<L>): ResolvedLayout<L> {
    const byTier: Record<LayoutTier, StoredLayout<L> | null | undefined> = {
        session: tiers.session,
        user: tiers.userOverride,
        global: tiers.globalDefault,
        manifest: tiers.manifest,
        auto: tiers.autoPick,
        fallback: null,
    };

    let presetId = "pointer";
    let layout: L | null = null;
    let tier: LayoutTier = "fallback";
    for (const t of TIER_ORDER) {
        const v = byTier[t];
        if (!v) continue;
        if (v.layout !== undefined) {
            layout = v.layout;
            if (v.presetId !== undefined) presetId = v.presetId;
            tier = t;
            break;
        }
        if (v.presetId !== undefined) {
            presetId = v.presetId;
            tier = t;
            break;
        }
    }

    let mode: TouchModePref = "auto";
    for (const t of TIER_ORDER) {
        const v = byTier[t];
        if (v?.mode !== undefined) {
            mode = v.mode;
            break;
        }
    }

    return { presetId, layout, mode, tier };
}
