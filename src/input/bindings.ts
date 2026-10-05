// What an input control produces. The same value type describes a physical key,
// an on-screen button, a d-pad direction and a stick axis, so remapping a widget
// is a data edit rather than new machinery.

export type HostAction =
    | "fullscreen"
    | "pause"
    | "releaseRelative"
    | "keyboard"
    | "toggleControls"
    | "editLayout";

export type Binding =
    | { t: "key"; vk: number }
    | { t: "mouse"; button: 0 | 1 | 2 }
    | { t: "wheel"; delta: number }
    | { t: "pad"; button: number }
    | { t: "axis"; axis: 0 | 1 | 2 | 3; value: number }
    /** Handled by the host shell, never forwarded to the guest. */
    | { t: "host"; action: HostAction };

const HOST_ACTIONS: readonly HostAction[] = [
    "fullscreen", "pause", "releaseRelative", "keyboard", "toggleControls", "editLayout",
];

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Total parser: returns null instead of throwing. Bindings arrive from bundle
 * manifests and from localStorage written by older builds, so a malformed one
 * must degrade to "this widget does nothing", never to a broken layout.
 */
export function parseBinding(x: unknown): Binding | null {
    if (!x || typeof x !== "object") return null;
    const b = x as Record<string, unknown>;
    switch (b["t"]) {
        case "key":
            return isInt(b["vk"]) && b["vk"] >= 0 && b["vk"] <= 0xff ? { t: "key", vk: b["vk"] } : null;
        case "mouse":
            return b["button"] === 0 || b["button"] === 1 || b["button"] === 2
                ? { t: "mouse", button: b["button"] }
                : null;
        case "wheel":
            return typeof b["delta"] === "number" && Number.isFinite(b["delta"])
                ? { t: "wheel", delta: b["delta"] }
                : null;
        case "pad":
            return isInt(b["button"]) && b["button"] >= 0 && b["button"] < 16
                ? { t: "pad", button: b["button"] }
                : null;
        case "axis": {
            const axis = b["axis"];
            if (axis !== 0 && axis !== 1 && axis !== 2 && axis !== 3) return null;
            const value = b["value"];
            if (typeof value !== "number" || !Number.isFinite(value)) return null;
            return { t: "axis", axis, value: Math.max(-1, Math.min(1, value)) };
        }
        case "host":
            return HOST_ACTIONS.includes(b["action"] as HostAction)
                ? { t: "host", action: b["action"] as HostAction }
                : null;
        default:
            return null;
    }
}

const VK_LABEL: Record<number, string> = {
    0x08: "Backspace", 0x09: "Tab", 0x0d: "Enter", 0x10: "Shift", 0x11: "Ctrl",
    0x12: "Alt", 0x13: "Pause", 0x14: "Caps", 0x1b: "Esc", 0x20: "Space",
    0x21: "PgUp", 0x22: "PgDn", 0x23: "End", 0x24: "Home",
    0x25: "←", 0x26: "↑", 0x27: "→", 0x28: "↓",
    0x2d: "Ins", 0x2e: "Del",
    0xa0: "LShift", 0xa1: "RShift", 0xa2: "LCtrl", 0xa3: "RCtrl", 0xa4: "LAlt", 0xa5: "RAlt",
};

/** Short human label for the editor and for widget chrome with no explicit label. */
export function describeBinding(b: Binding): string {
    switch (b.t) {
        case "key": {
            if (VK_LABEL[b.vk]) return VK_LABEL[b.vk]!;
            if (b.vk >= 0x30 && b.vk <= 0x5a) return String.fromCharCode(b.vk);
            if (b.vk >= 0x60 && b.vk <= 0x69) return `Num${b.vk - 0x60}`;
            if (b.vk >= 0x70 && b.vk <= 0x7b) return `F${b.vk - 0x6f}`;
            return `VK 0x${b.vk.toString(16).padStart(2, "0")}`;
        }
        case "mouse":
            return ["LMB", "RMB", "MMB"][b.button]!;
        case "wheel":
            return b.delta < 0 ? "Wheel ↑" : "Wheel ↓";
        case "pad":
            return `Pad ${b.button}`;
        case "axis":
            return `Axis ${b.axis} ${b.value < 0 ? "−" : "+"}`;
        case "host":
            return b.action;
    }
}
