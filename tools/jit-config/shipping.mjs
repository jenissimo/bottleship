// The ONE production JIT configuration, shared by every offline tool that has to reproduce
// BottleShip's codegen shape: tools/bench-v86, the AOT oracle arms, the AOT capture job.
// A private copy drifts silently, and a number taken against a shape the emulator never
// runs is a confident answer to the wrong question.
//
// Values here are what `get_jit_config` READS BACK, not what the setter was handed: the arms
// verify each index by readback and abort on a mismatch, and three indices do not round-trip
// the naive way (25 reads log2, 27 reads mask+1, 30 is masked to 20 bits). Authority for every
// number is vendor/v86/src/rust/jit.rs; tools/validate-jit-shipping-config.ts re-derives it
// from that file plus PreemptionManager and fails when the two disagree.

export const JIT_CONFIG_ABI_VERSION = 4;                // jit.rs:6199
export const JIT_CONFIG_SUPPORTED_MASK = 0xFFFB_FDFF;   // jit.rs:6200 — slots 9 and 18 retired

export const SUPPORTED_INDICES = Object.freeze(
    Array.from({ length: 32 }, (_, i) => i).filter(i => (JIT_CONFIG_SUPPORTED_MASK & (1 << i)) !== 0));

/**
 * Production values. The nine indices PreemptionManager applies at every v86 init are the
 * live product's own choices; the rest are the engine's Rust defaults, applied explicitly so
 * a reused process cannot leak a diagnostic value into a run labelled "shipping".
 */
export const SHIPPING_JIT = new Map([
    [0, 0], [1, 3], [2, 1], [3, 250], [4, 0],
    [5, 1],                     // PreemptionManager: dead-flag elision ON
    [6, 0], [7, 5], [8, 8],
    [10, 0],                    // PreemptionManager: x87 stack-top locals OFF
    [11, 1],                    // PreemptionManager: push-run coalescing ON
    [12, 1], [13, 1],           // PreemptionManager: RET chaining + target speculation ON
    [14, 24],
    [15, 0],                    // PreemptionManager: tier-2 hotness threshold OFF (opt-in)
    [16, 96], [17, 8],
    [19, 0],                    // PreemptionManager: fastmem writes OFF
    [20, 1],
    [21, 0],                    // PreemptionManager: arithmetic-flag locals OFF
    [22, 1],                    // PreemptionManager: wasm branch hints, guard group 0
    [23, 0], [24, 0], [25, 9], [26, 0], [27, 32], [28, 1], [29, 0],
    // jit.rs:6329 masks the setter's argument to 20 bits, so the Rust default (u32::MAX) is
    // not a value the engine can be asked to hold. 0xFFFFF is that default as stored, and it
    // is inert for the same reason: mode (idx 29) is 0.
    [30, 0xFFFFF],
    [31, 1],
]);

/**
 * The smallest value an index may hold and still describe a working engine.
 *
 * An "all features off" reference is built from THESE, not from zeros. A zero at a budget
 * index does not turn a feature off — it removes something the engine needs in order to
 * compile at all — and at a clamped index the setter silently substitutes its floor, which
 * the arms' readback gate then reports as a provenance mismatch and aborts.
 */
export const MIN_VALID = new Map([
    [1, 1],     // jit.rs:2916-2925 — MAX_PAGES caps the page walk; a 0-page budget compiles nothing
    [3, 1],     // control_flow.rs:286 — budget compared against entries*group; 0 is unsatisfiable
    [7, 1],     // jit.rs:3139 — percent-of-hits share a region target must reach
    [8, 1],     // jit.rs:2918 — indirect-region page budget
    [14, 1],    // jit.rs:3314 — RET-speculation instruction budget
    [16, 1],    // jit.rs:3314 — the same budget on the tier-2 path
    [17, 1],    // jit.rs:2922 — tier-2 page budget
    [25, 4],    // jit.rs:6313 — setter clamps to >= 4
    [27, 1],    // jit.rs:6324 — setter clamps to >= 1
]);

export const minValid = (index) => MIN_VALID.get(index) ?? 0;

/**
 * All production-controlled features off, at the minimum VALID value for each index.
 *
 * Idx 2 (loop safety) goes to 0 like any other feature: it is the engine's periodic exit out
 * of a compiled loop, so a guest loop with no natural exit will not yield under this
 * reference. That is what "all off" means; the runner's watchdog is the backstop.
 */
export const REFERENCE_ALL_OFF = new Map(SUPPORTED_INDICES.map(i => [i, minValid(i)]));

export const formatFlags = (flags) =>
    [...flags.entries()].map(([index, value]) => `${index}=${value}`).join(",");

export const parseFlags = (text) => new Map(String(text || "").split(",").filter(Boolean).map(pair => {
    const [index, value] = pair.split("=").map(Number);
    return [index, value];
}));

/** `base` with the listed [index, value] pairs replaced — the only way to build an arm. */
export const flagsWith = (base, changes) => {
    const flags = new Map(base);
    for (const [index, value] of changes) {
        if (!flags.has(index)) throw new Error(`JIT config index ${index} is not in the supported envelope`);
        flags.set(index, value);
    }
    return flags;
};

export const shippingWith = (...changes) => flagsWith(SHIPPING_JIT, changes);
export const referenceWith = (...changes) => flagsWith(REFERENCE_ALL_OFF, changes);

/**
 * Code-shaping switches that live OUTSIDE the set_jit_config slots (the slot envelope is full):
 * each is an exported `set_<name>` / `get_<name>` pair in vendor/v86, a codegen input, and part
 * of "shipping" exactly like an index above. PreemptionManager applies every one of them at v86
 * init through `applyCodegenSwitch` (before the guest runs, so before any compile);
 * tools/validate-jit-shipping-config.ts checks the two lists agree and that every offline
 * consumer of SHIPPING_JIT applies these too.
 */
export const SHIPPING_CODEGEN_SWITCHES = Object.freeze(new Map([
    ["jit_page_tails", 1],          // compile instructions in the last 15 bytes of a page
    ["jit_hot_edge_regions", 0],    // hot-edge region formation: measured −3..−4 %, OFF
]));

/** The all-off reference for the switches. */
export const REFERENCE_CODEGEN_SWITCHES = Object.freeze(new Map(
    [...SHIPPING_CODEGEN_SWITCHES.keys()].map((name) => [name, 0])));

/**
 * Apply switches to a v86 exports object and PROVE they took (readback). An engine without a
 * switch is accepted only when the requested value is 0: that engine predates the feature,
 * which is the same thing as the feature being off. Returns {name: readback | "absent"}.
 */
export function applyCodegenSwitches(ex, switches = SHIPPING_CODEGEN_SWITCHES) {
    const effective = {};
    for (const [name, value] of switches) {
        const set = ex[`set_${name}`], get = ex[`get_${name}`];
        if (typeof set !== "function" || typeof get !== "function") {
            if (value !== 0) throw new Error(`engine lacks set_${name}/get_${name} but the shape asks for ${value}`);
            effective[name] = "absent";
            continue;
        }
        set(value);
        const got = get() >>> 0;
        if (got !== value) throw new Error(`set_${name}(${value}) read back ${got}`);
        effective[name] = got;
    }
    return effective;
}

export const formatSwitches = (switches) =>
    [...switches.entries()].map(([name, value]) => `${name}=${value}`).join(",");
export const parseSwitches = (text) => new Map(String(text || "").split(",").filter(Boolean).map((pair) => {
    const [name, value] = pair.split("=");
    if (!SHIPPING_CODEGEN_SWITCHES.has(name)) throw new Error(`unknown codegen switch ${name}`);
    return [name, Number(value)];
}));
