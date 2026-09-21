/**
 * D3DRENDERSTATETYPE → pipeline-key classification. One table, one owner.
 *
 * WHY THIS EXISTS. The D3D9 pipeline key must be a tuple of ids and a CLASSIFIED SUBSET of
 * state (plan/perf-campaign/d3d9-target-architecture.md §3). The render-state BANK's version
 * must not enter that key: `SetRenderState(D3DRS_FOGCOLOR)` changes the bank and changes no
 * pipeline, so keying on the bank version turns every such write into a memo miss. Each render
 * state is therefore classified ONCE, at ingest, as either
 *
 *   - *pipeline-affecting* — it bumps one or more pipeline SUB-KEYS (blend / depth-stencil /
 *     rasterizer / sample / other), or
 *   - *uniform/other* — it bumps only the bank version (and, where applicable, a dynamic
 *     render-pass command such as setBlendConstant / setStencilReference / setScissorRect).
 *
 * SHAPE. The runtime artifact is two flat 256-entry lookups (`D3D9_RENDER_STATE_CLASS`, a
 * Uint8Array of bitmasks, and `D3D9_RENDER_STATE_NAMES`), indexed by the raw D3D9 ordinal.
 * No object tree, no Map: the Rust ingest side (arena.rs) will mirror the same byte table, and
 * the JS state tracker reads it with one array index on the setter path.
 *
 * A state's byte is a BITMASK, not an enum, because a state can lower into more than one
 * descriptor section (D3DRS_ZENABLE is both the depth-stencil state and the W-buffer raster
 * gate). Zero means uniform/other.
 *
 * SUB-KEY ASSIGNMENT IS GROUPING, NOT CORRECTNESS. Every sub-key is part of the same pipeline
 * key tuple, so filing a pipeline-affecting state under the "wrong" sub-key costs extra memo
 * misses inside that group and can never build a wrong pipeline. The dangerous error is the
 * CLASS: calling a pipeline-affecting state uniform silently reuses a pipeline built under
 * different state. That asymmetry is why the default below is what it is.
 *
 * THE DEFAULT IS CONSERVATIVE AND COUNTED. An ordinal this table does not classify gets
 * `D3D9_RS_CONSERVATIVE` — the UNCLASSIFIED marker bit OR'd with EVERY sub-key bit. It
 * therefore bumps every sub-key (never a wrong pipeline, only a guaranteed memo miss) and is
 * simultaneously visible: `classifyD3D9RenderStateWrite` counts it, and
 * `d3d9UnclassifiedRenderStateStats()` names the ordinal. An unclassified state shows up as a
 * memo miss you can SEE, which is the whole point — a silent default of "uniform" would be a
 * wrong pipeline nobody notices.
 *
 * SOURCES. The mapping was derived from what this repo's own pipeline construction already
 * reads (`backends/webgpu/d3d9/d3d9-blend.ts` computeBlendKey/computeDepthKey,
 * `d3d9-device.ts` rasterStateKey/alphaTestKey/prepareArenaPipelineIdentity/
 * compactPipelineFastKey, `raster-emulation.ts`, `ffp-*.ts`) — any state that reaches a
 * pipeline descriptor or a shader emitter there is pipeline-affecting by construction — plus
 * the documented D3D9 semantics of the states that do not yet reach one.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * STATES I WAS UNSURE ABOUT, AND WHY. Five honest question marks beat a confident wrong row.
 *
 *  1. D3DRS_SRGBWRITEENABLE (194) — filed under BLEND. It is not a blend field: it selects an
 *     sRGB VIEW of the render target, i.e. the color-target FORMAT. §3 lists "RT format/MSAA"
 *     as its own component of the key. BLEND is the closest existing descriptor section
 *     (GPUColorTargetState carries both format and blend) and our `stateKeyTarget` already
 *     folds it in, so this row is right about the CLASS and arguable about the sub-key.
 *
 *  2. D3DRS_SPECULARENABLE (29), COLORVERTEX (141), LOCALVIEWER (142), NORMALIZENORMALS (143),
 *     the four *MATERIALSOURCE (145-148) — filed as UNIFORM. In THIS backend they are verified
 *     uniform: they reach `packFfpUniforms` only and the FFP shader branches on the uniform.
 *     DXVK bakes the equivalents into its FFP vertex-shader key. If our FFP emitter ever
 *     specializes on one of them, that row MUST move to OTHER in the same change — the test
 *     pins the current answer precisely so that move is deliberate.
 *
 *  3. D3DRS_FOGENABLE (28) / FOGTABLEMODE (35) / FOGVERTEXMODE (140) — filed as OTHER
 *     (pipeline-affecting) even though `resolveFfpFogMode` deliberately encodes them into a
 *     single uniform float so fog changes do NOT rebuild a pipeline. This is a deliberate
 *     over-approximation: fog enable is a shader permutation on every reference implementation
 *     I looked at, the programmable pixel-fog path reads them at shader-emit time, and the
 *     cost of being wrong in the safe direction is a handful of misses on a state games change
 *     per-section, not per-draw. D3DRS_FOGCOLOR/START/END/DENSITY stay UNIFORM — those are the
 *     §3 example and are unambiguous.
 *
 *  4. D3DRS_WRAP0..15 (128-135, 198-205) and the tessellation block (163, 172, 173, 178-184) —
 *     filed OTHER on conservatism alone. Nothing in this backend reads them today: texture-
 *     coordinate wrapping is not implemented, and N-patch/RT-patch tessellation is driven by
 *     SetNPatchMode rather than by these. If they were implemented they would be shader /
 *     vertex-stage permutations, so OTHER is where they would land; until then this is a
 *     no-op that costs nothing (they are set once at init, if ever).
 *     D3DRS_ADAPTIVETESS_Y (181) additionally carries the SAMPLE bit: the 'ATOC' FourCC
 *     alpha-to-coverage hack writes alpha-to-coverage state through that ordinal, and
 *     alpha-to-coverage IS a GPUMultisampleState field. We do not implement the hack; the bit
 *     is there so implementing it cannot silently reuse a pipeline.
 *
 *  5. D3DRS_DITHERENABLE (26) and D3DRS_LASTPIXEL (16) — filed UNIFORM. WebGPU has no
 *     dithering and no last-pixel control, so neither can change a pipeline we are able to
 *     build. That is a statement about our backend, not about D3D9 hardware; it becomes wrong
 *     the day either is emulated in a shader.
 *
 *  Deliberately LEFT UNCLASSIFIED (so they surface through the counter rather than through a
 *  guess): every D3D8/D3D7-only ordinal — D3DRS_LINEPATTERN (10), EDGEANTIALIAS (40),
 *  COLORKEYENABLE (41), ZVISIBLE (44), ZBIAS (47), PATCHSEGMENTS (164), and the undefined gaps.
 *  None is a legal D3D9 SetRenderState, and a d3d8to9 wrapper converts the ones that matter
 *  before they reach us (ZBIAS → SLOPESCALEDEPTHBIAS/DEPTHBIAS; see d3d9-blend.ts). If one
 *  starts showing up in `d3d9UnclassifiedRenderStateStats()` on a real title, that is a finding
 *  about the wrapper, and the answer is a row here — not a default.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * This module is inert: nothing consumes it yet. It is the precondition §3 names.
 */

// ── Sub-key bits ────────────────────────────────────────────────────────────────────────
/** GPUColorTargetState: blend equation/factors, write mask, target format. */
export const D3D9_RS_BLEND = 0x01;
/** GPUDepthStencilState: depth test/write/compare, stencil, depth bias. */
export const D3D9_RS_DEPTH_STENCIL = 0x02;
/** GPUPrimitiveState + the raster gates that decide whether a pipeline can exist at all. */
export const D3D9_RS_RASTERIZER = 0x04;
/** GPUMultisampleState: sample count, sample mask, alpha-to-coverage. */
export const D3D9_RS_SAMPLE = 0x08;
/** Pipeline identity that is not one of the four descriptor sections — chiefly shader
 *  permutation (alpha test, FFP lighting/fog/skinning, clip planes, point sprites). */
export const D3D9_RS_OTHER = 0x10;

/** Every sub-key bit. */
export const D3D9_RS_SUBKEY_MASK = 0x1f;
/** Marker bit: this ordinal has no row in the table. Never a sub-key. */
export const D3D9_RS_UNCLASSIFIED = 0x80;

/** Bank-only: the write bumps the render-state bank version and no pipeline sub-key. */
export const D3D9_RS_UNIFORM = 0x00;

/**
 * The default for an ordinal with no row: unclassified AND every sub-key.
 * Conservative (it can only over-invalidate) and loud (the marker bit + the counter).
 */
export const D3D9_RS_CONSERVATIVE = D3D9_RS_UNCLASSIFIED | D3D9_RS_SUBKEY_MASK;

/** The render-state array this table indexes — the tracker's own Int32Array(256) bound. */
export const D3D9_RENDER_STATE_COUNT = 256;

// ── The table ───────────────────────────────────────────────────────────────────────────
// Declared as flat [ordinal, name, mask] rows and folded into the two lookups below. The rows
// are the documentation; the Uint8Array is the artifact.
type Row = readonly [ordinal: number, name: string, mask: number];

const P = D3D9_RS_BLEND, D = D3D9_RS_DEPTH_STENCIL, R = D3D9_RS_RASTERIZER,
    S = D3D9_RS_SAMPLE, O = D3D9_RS_OTHER, U = D3D9_RS_UNIFORM;

const ROWS: readonly Row[] = [
    // ── Depth / stencil ─────────────────────────────────────────────────────────────────
    // ZENABLE also gates the W-buffer refusal in rasterStateKey, hence the raster bit.
    [7, "ZENABLE", D | R],
    [14, "ZWRITEENABLE", D],
    [23, "ZFUNC", D],
    [52, "STENCILENABLE", D],
    [53, "STENCILFAIL", D],
    [54, "STENCILZFAIL", D],
    [55, "STENCILPASS", D],
    [56, "STENCILFUNC", D],
    // STENCILREF is the dynamic setStencilReference command, NOT a pipeline field.
    [57, "STENCILREF", U],
    [58, "STENCILMASK", D],
    [59, "STENCILWRITEMASK", D],
    [185, "TWOSIDEDSTENCILMODE", D],
    [186, "CCW_STENCILFAIL", D],
    [187, "CCW_STENCILZFAIL", D],
    [188, "CCW_STENCILPASS", D],
    [189, "CCW_STENCILFUNC", D],
    [175, "SLOPESCALEDEPTHBIAS", D],
    [195, "DEPTHBIAS", D],

    // ── Blend / output merger ───────────────────────────────────────────────────────────
    [19, "SRCBLEND", P],
    [20, "DESTBLEND", P],
    [27, "ALPHABLENDENABLE", P],
    [171, "BLENDOP", P],
    [206, "SEPARATEALPHABLENDENABLE", P],
    [207, "SRCBLENDALPHA", P],
    [208, "DESTBLENDALPHA", P],
    [209, "BLENDOPALPHA", P],
    [168, "COLORWRITEENABLE", P],
    [190, "COLORWRITEENABLE1", P],
    [191, "COLORWRITEENABLE2", P],
    [192, "COLORWRITEENABLE3", P],
    // BLENDFACTOR is the dynamic setBlendConstant command, NOT a pipeline field.
    [193, "BLENDFACTOR", U],
    // Selects the sRGB view of the target — the color-target FORMAT. See note 1.
    [194, "SRGBWRITEENABLE", P],

    // ── Rasterizer ──────────────────────────────────────────────────────────────────────
    [8, "FILLMODE", R],
    [22, "CULLMODE", R],
    [176, "ANTIALIASEDLINEENABLE", R],
    // D3DRS_CLIPPING maps onto depth-clip control, which is pipeline state.
    [136, "CLIPPING", R],
    // SCISSORTESTENABLE is the dynamic setScissorRect command; the scissor RECT is a
    // draw-record field (§3), not pipeline identity.
    [174, "SCISSORTESTENABLE", U],
    // Not representable in WebGPU; cannot change a pipeline we can build. See note 5.
    [16, "LASTPIXEL", U],
    [26, "DITHERENABLE", U],

    // ── Multisample ─────────────────────────────────────────────────────────────────────
    [161, "MULTISAMPLEANTIALIAS", S],
    [162, "MULTISAMPLEMASK", S],

    // ── Shader permutation / other pipeline identity ────────────────────────────────────
    // Flat shading is lowered by the FFP emitter (provoking-vertex handling).
    [9, "SHADEMODE", O],
    // Alpha test is a fragment `discard`; ALPHAREF is baked into the shader, so the REF is
    // pipeline identity too (alphaTestKey is `a<func>.<ref>`).
    [15, "ALPHATESTENABLE", O],
    [24, "ALPHAREF", O],
    [25, "ALPHAFUNC", O],
    // Fog: mode selectors are permutations (note 3), the parameters are uniforms.
    [28, "FOGENABLE", O],
    [35, "FOGTABLEMODE", O],
    [140, "FOGVERTEXMODE", O],
    [48, "RANGEFOGENABLE", O],
    // FFP lighting master switch — buildShader's `lit` variant and the tracker's key bit 24.
    [137, "LIGHTING", O],
    // User clip planes: the ENABLE MASK selects the shader (`cp` in both pipeline keys);
    // the plane equations themselves are uniforms (SetClipPlane, not a render state).
    [152, "CLIPPLANEENABLE", O],
    // Point sprites: the enable selects generated UVs in the expansion shader.
    [156, "POINTSPRITEENABLE", O],
    [157, "POINTSCALEENABLE", O],
    // Fixed-function skinning: mode + indexed-enable decide the vertex stage and can refuse
    // the draw outright (resolvePipelineId).
    [151, "VERTEXBLEND", O],
    [167, "INDEXEDVERTEXBLENDENABLE", O],
    // Switching vertex processing mode changes which vertex stage runs.
    [153, "SOFTWAREVERTEXPROCESSING", O],
    // Texture-coordinate wrapping — not implemented; conservative. See note 4.
    [128, "WRAP0", O], [129, "WRAP1", O], [130, "WRAP2", O], [131, "WRAP3", O],
    [132, "WRAP4", O], [133, "WRAP5", O], [134, "WRAP6", O], [135, "WRAP7", O],
    [198, "WRAP8", O], [199, "WRAP9", O], [200, "WRAP10", O], [201, "WRAP11", O],
    [202, "WRAP12", O], [203, "WRAP13", O], [204, "WRAP14", O], [205, "WRAP15", O],
    // N-patch / RT-patch tessellation — not implemented; conservative. See note 4.
    [163, "PATCHEDGESTYLE", O],
    [172, "POSITIONDEGREE", O],
    [173, "NORMALDEGREE", O],
    [178, "MINTESSELLATIONLEVEL", O],
    [179, "MAXTESSELLATIONLEVEL", O],
    [180, "ADAPTIVETESS_X", O],
    // Also the 'ATOC' alpha-to-coverage FourCC channel — hence the SAMPLE bit. See note 4.
    [181, "ADAPTIVETESS_Y", O | S],
    [182, "ADAPTIVETESS_Z", O],
    [183, "ADAPTIVETESS_W", O],
    [184, "ENABLEADAPTIVETESSELLATION", O],

    // ── Uniform / bank-only ─────────────────────────────────────────────────────────────
    // The §3 example: changes the bank, changes no pipeline.
    [34, "FOGCOLOR", U],
    [36, "FOGSTART", U],
    [37, "FOGEND", U],
    [38, "FOGDENSITY", U],
    [60, "TEXTUREFACTOR", U],
    [139, "AMBIENT", U],
    [170, "TWEENFACTOR", U],
    // FFP lighting inputs — verified uniform in this backend. See note 2.
    [29, "SPECULARENABLE", U],
    [141, "COLORVERTEX", U],
    [142, "LOCALVIEWER", U],
    [143, "NORMALIZENORMALS", U],
    [145, "DIFFUSEMATERIALSOURCE", U],
    [146, "SPECULARMATERIALSOURCE", U],
    [147, "AMBIENTMATERIALSOURCE", U],
    [148, "EMISSIVEMATERIALSOURCE", U],
    // Point-size parameters ride in the vertex constant block.
    [154, "POINTSIZE", U],
    [155, "POINTSIZE_MIN", U],
    [166, "POINTSIZE_MAX", U],
    [158, "POINTSCALE_A", U],
    [159, "POINTSCALE_B", U],
    [160, "POINTSCALE_C", U],
    // A driver debug hook with no rendering effect.
    [165, "DEBUGMONITORTOKEN", U],
];

const CLASS = new Uint8Array(D3D9_RENDER_STATE_COUNT).fill(D3D9_RS_CONSERVATIVE);
const NAMES: string[] = new Array(D3D9_RENDER_STATE_COUNT).fill("");
for (const [ordinal, name, mask] of ROWS) {
    CLASS[ordinal] = mask;
    NAMES[ordinal] = name;
}

/** Flat lookup, indexed by the raw D3D9 render-state ordinal. Mirrored by the Rust ingest. */
export const D3D9_RENDER_STATE_CLASS: Readonly<Uint8Array> = CLASS;
/** Parallel names, "" for an unclassified ordinal. Diagnostics only. */
export const D3D9_RENDER_STATE_NAMES: readonly string[] = NAMES;

// ── Accessors ───────────────────────────────────────────────────────────────────────────

/**
 * The sub-key bitmask for one render state. PURE — it counts nothing, so a resolve-side
 * probe cannot inflate the ingest census. Out-of-range ordinals answer conservatively.
 */
export function d3d9RenderStateClass(state: number): number {
    const s = state >>> 0;
    return s < D3D9_RENDER_STATE_COUNT ? CLASS[s]! : D3D9_RS_CONSERVATIVE;
}

/** True when an effective write to this state must bump at least one pipeline sub-key. */
export function d3d9RenderStateAffectsPipeline(state: number): boolean {
    return (d3d9RenderStateClass(state) & D3D9_RS_SUBKEY_MASK) !== 0;
}

/** True when this state bumps only the bank version (plus any dynamic render-pass command). */
export function d3d9RenderStateIsUniform(state: number): boolean {
    return d3d9RenderStateClass(state) === D3D9_RS_UNIFORM;
}

/** True when this ordinal has no row in the table and is being handled conservatively. */
export function d3d9RenderStateIsUnclassified(state: number): boolean {
    return (d3d9RenderStateClass(state) & D3D9_RS_UNCLASSIFIED) !== 0;
}

/** Human-readable name, or `RS(<n>)` for an ordinal with no row. */
export function d3d9RenderStateName(state: number): string {
    const s = state >>> 0;
    if (s === D3D9_RENDER_STATE_COUNT) return "RS(out-of-range)";
    const name = s < D3D9_RENDER_STATE_COUNT ? NAMES[s]! : "";
    return name !== "" ? name : `RS(${state})`;
}

// ── Unclassified census ─────────────────────────────────────────────────────────────────
// Conservative is only half the contract: the other half is that an unclassified state is
// VISIBLE. Every effective ingest write goes through classifyD3D9RenderStateWrite, which is
// the single place the counter lives.

let unclassifiedTotal = 0;
const unclassifiedCounts = new Map<number, number>();

/**
 * Ingest entry point: classify one EFFECTIVE render-state write and count it when the
 * ordinal has no row. Returns the sub-key bitmask the caller must OR into its dirty set
 * (0 = bank only). This is the only function that records the census.
 */
export function classifyD3D9RenderStateWrite(state: number): number {
    const mask = d3d9RenderStateClass(state);
    if ((mask & D3D9_RS_UNCLASSIFIED) !== 0) {
        unclassifiedTotal++;
        // The ordinal is guest-supplied, so the key space has to be the table's, not the
        // guest's: everything past the table folds into one bucket rather than growing a map
        // a guest could enlarge at will. Out of range is one finding, not 2^32 of them.
        const key = (state >>> 0) < D3D9_RENDER_STATE_COUNT ? (state >>> 0) : D3D9_RENDER_STATE_COUNT;
        unclassifiedCounts.set(key, (unclassifiedCounts.get(key) ?? 0) + 1);
    }
    return mask & D3D9_RS_SUBKEY_MASK;
}

/**
 * `total: 0` means no unclassified state was written — which is the expected reading, and is
 * only meaningful next to a run that actually issued render-state writes. The verdict names
 * the ordinals so the fix is a row in the table above, never a widened default.
 */
export function d3d9UnclassifiedRenderStateStats(reset = false): {
    total: number;
    distinct: number;
    states: Array<{ state: number; name: string; count: number }>;
    verdict: string;
} {
    const states = [...unclassifiedCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([state, count]) => ({ state, name: d3d9RenderStateName(state), count }));
    const out = {
        total: unclassifiedTotal,
        distinct: states.length,
        states,
        verdict: unclassifiedTotal === 0
            ? "no unclassified render-state writes"
            : `${states.length} unclassified ordinal(s) forced a full pipeline-key bump: `
                + states.map(s => `${s.name}x${s.count}`).join(", "),
    };
    if (reset) { unclassifiedTotal = 0; unclassifiedCounts.clear(); }
    return out;
}
