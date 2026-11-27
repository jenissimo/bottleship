//! D3D9 WASM-resident state mirror + command arena.
//!
//! Plain Rust static (same pattern as HYPERCALL_PAGE, see hypercall.rs) exposing a
//! zero-copy shared-memory region JS reads/writes directly via typed-array views
//! (`get_d3d9_arena_ptr()`, mirrors `get_hypercall_page_ptr()`). Unlike HYPERCALL_PAGE,
//! this is NOT wired into the OUT-trap dispatch table — D3D9 setters already ride the
//! no-trap WBUF ring and draws are synchronous FastPath calls, both already correctly
//! ordered by the existing JS dispatch. JS calls the exported functions below directly,
//! at the same call sites it uses today.
//!
//! Scope: the PROGRAMMABLE (VS+PS-bound) draw path only. FFP draws (vsHandle==0 ||
//! psHandle==0) are declined (record_draw* returns -1) — callers must fall back to the
//! legacy TS path for those. State fields needed only by FFP (texture-stage-state,
//! full per-stage sampler matrices, materials/lights/clip planes) are deliberately NOT
//! mirrored here.
//!
//! ---- Byte layout ----
//! State mirror (written by JS setter wrappers — plain data, no derived logic):
//!   renderStates       i32[256]   — full D3DRENDERSTATETYPE mirror (blend/alpha/cull/z fields)
//!   samplerStage0      i32[16]    — D3DSAMPLERSTATETYPE values for stage 0 ONLY, indexed by
//!                                   the real enum value (ADDRESSU=1..MAXANISOTROPY=10); the
//!                                   programmable path resolves a single shared sampler from
//!                                   stage 0 (see d3d9-backend-executor.ts resolveStageSampler(0))
//!   streamSource       {bufferId, offset, stride} u32 x3
//!   indexBuffer        {bufferId, format} u32 x2
//!   vsHandle/psHandle/declHandle/fvf   u32 x4
//!   textureBoundIds    u32[8]     — per-stage bound texture id
//!   textureCubeFlags   u8[4096]   — indexed by texture id, written at CreateCubeTexture
//!   shaderConstLenVs   u16[1024]  — indexed by VS handle: declared float count
//!   shaderConstLenPs   u16[1024]  — indexed by PS handle: declared float count
//!   vsConstants        f32[1024] (256 vec4)
//!   psConstants        f32[896]  (224 vec4)
//!   vsConstVersion/psConstVersion   u32 x2 — bumped by JS on every SetVertexShaderConstantF/
//!                                   SetPixelShaderConstantF (coarse change signal for the
//!                                   draw-state reuse memo, see LAST_DRAW_STATE below)
//!   pipelineIdentity   u32[16]   — canonical programmable pipeline identity supplied by TS;
//!                                   Rust hashes every word into the command key
//!
//! Command SoA (written only by d3d9_record_draw*, capacity headroom for ~2560 draws/frame):
//!   commandTypes/A/B/C   u32[CMD_CAP] x4 — same 4-parallel-array shape as RenderFrame
//!   pipelineKey/bindGroupKey   u32[CMD_CAP] x2
//!   commandCount         u32
//!
//! Frame bump arena (per-draw programmable state snapshot — vertex/index UP capture +
//! VS/PS constant-prefix capture-at-call, reset every frame):
//!   bumpArena            u8[BUMP_CAP]
//!   bumpCursor           u32
//!
//! Counters (mirrors the slab's alloc_count/fallback_count observability style):
//!   commandsEmitted, arenaHighWaterMark, overflowCount, ffpFallbackCount, mismatchCount   u32 x5

use std::ptr::{addr_of, addr_of_mut};

use crate::guest_mem::guest_mem;

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const RENDER_STATE_COUNT: usize = 256;
const SAMPLER_STAGE0_COUNT: usize = 16;
const TEXTURE_ID_SLOTS: usize = 8;
const TEXTURE_CUBE_FLAG_SLOTS: usize = 4096;
const SHADER_HANDLE_SLOTS: usize = 1024;
const VS_CONST_FLOATS: usize = 256 * 4;
const PS_CONST_FLOATS: usize = 224 * 4;
// Every draw emits AT LEAST 3 SoA rows (SetPipeline + BindProgrammable + Draw/DrawIndexed
// — no redundant-emission elision in this pass), plus occasional SetVertexBuffer/
// SetIndexBuffer rows on a binding change. Heavy scenes can exceed ~2700 draws/frame,
// so CMD_CAP is sized at 16384 (~5400 draws of headroom) to avoid arena overflow.
pub const CMD_CAP: usize = 16384;
const BUMP_CAP: usize = 16 * 1024 * 1024;
/** The x86 thunk write-buffer is 512 KiB. One static scratch lets a whole alternating
 * constant/draw run cross the paging-aware guest-memory callback exactly once. */
const WBUF_RUN_CAP: usize = 512 * 1024;
/// Shared-memory ABI version. Increment whenever the layout or exported command
/// signatures change in a way the JS adapter cannot safely infer.
const D3D9_ARENA_ABI_VERSION: u32 = 4;

const OFF_RENDER_STATES: usize = 0;
const OFF_SAMPLER_STAGE0: usize = OFF_RENDER_STATES + RENDER_STATE_COUNT * 4;
const OFF_STREAM_SOURCE: usize = OFF_SAMPLER_STAGE0 + SAMPLER_STAGE0_COUNT * 4;
const OFF_INDEX_BUFFER: usize = OFF_STREAM_SOURCE + 12;
const OFF_VS_HANDLE: usize = OFF_INDEX_BUFFER + 8;
const OFF_PS_HANDLE: usize = OFF_VS_HANDLE + 4;
const OFF_DECL_HANDLE: usize = OFF_PS_HANDLE + 4;
const OFF_FVF: usize = OFF_DECL_HANDLE + 4;
const OFF_TEXTURE_BOUND_IDS: usize = OFF_FVF + 4;
const OFF_TEXTURE_CUBE_FLAGS: usize = OFF_TEXTURE_BOUND_IDS + TEXTURE_ID_SLOTS * 4;
const OFF_SHADER_CONST_LEN_VS: usize = OFF_TEXTURE_CUBE_FLAGS + TEXTURE_CUBE_FLAG_SLOTS;
const OFF_SHADER_CONST_LEN_PS: usize = OFF_SHADER_CONST_LEN_VS + SHADER_HANDLE_SLOTS * 2;
const OFF_VS_CONSTANTS: usize = OFF_SHADER_CONST_LEN_PS + SHADER_HANDLE_SLOTS * 2;
const OFF_PS_CONSTANTS: usize = OFF_VS_CONSTANTS + VS_CONST_FLOATS * 4;
const OFF_VS_CONST_VERSION: usize = OFF_PS_CONSTANTS + PS_CONST_FLOATS * 4;
const OFF_PS_CONST_VERSION: usize = OFF_VS_CONST_VERSION + 4;
const PIPELINE_IDENTITY_WORDS: usize = 16;
const OFF_PIPELINE_IDENTITY: usize = OFF_PS_CONST_VERSION + 4;

const OFF_CMD_TYPES: usize = (OFF_PIPELINE_IDENTITY + PIPELINE_IDENTITY_WORDS * 4 + 15) & !15; // 16-byte align
const OFF_CMD_A: usize = OFF_CMD_TYPES + CMD_CAP * 4;
const OFF_CMD_B: usize = OFF_CMD_A + CMD_CAP * 4;
const OFF_CMD_C: usize = OFF_CMD_B + CMD_CAP * 4;
const OFF_PIPELINE_KEY: usize = OFF_CMD_C + CMD_CAP * 4;
const OFF_BIND_GROUP_KEY: usize = OFF_PIPELINE_KEY + CMD_CAP * 4;
const OFF_COMMAND_COUNT: usize = OFF_BIND_GROUP_KEY + CMD_CAP * 4;

const OFF_BUMP_ARENA: usize = OFF_COMMAND_COUNT + 4;
const OFF_BUMP_CURSOR: usize = OFF_BUMP_ARENA + BUMP_CAP;

const OFF_COUNTERS: usize = OFF_BUMP_CURSOR + 4;
const OFF_COMMANDS_EMITTED: usize = OFF_COUNTERS;
const OFF_ARENA_HIGH_WATER: usize = OFF_COMMANDS_EMITTED + 4;
const OFF_OVERFLOW_COUNT: usize = OFF_ARENA_HIGH_WATER + 4;
const OFF_FFP_FALLBACK_COUNT: usize = OFF_OVERFLOW_COUNT + 4;
const OFF_MISMATCH_COUNT: usize = OFF_FFP_FALLBACK_COUNT + 4;

// ---------------------------------------------------------------------------
// State-block slots.
// A slot is the arena-resident image of one "arena-coverable" IDirect3DStateBlock9:
// bitmasks/ranges say WHICH states the block recorded; the value arrays hold the
// block's captured values. JS writes masks/ranges/initial values through views at
// End/CreateStateBlock; d3d9_block_capture refreshes the values from the live mirror
// (Capture's refresh-only semantics); d3d9_block_apply diffs the slot against the
// mirror and emits a compact changed-list JS replays through the ordinary device
// setters (which themselves keep the mirror + JS trackers + setter shadows coherent —
// the arena never writes the mirror on Apply).
//
// Per-slot layout (offsets published via LAYOUT_TABLE; JS never hardcodes them):
//   maskRenderStates u32[8]        which of renderStates[256] the block recorded
//   maskSampler0     u32           which of samplerStage0[16]
//   vsConstRanges    {u16 startReg, u16 floatCount}[4]  (count=0 = unused)
//   psConstRanges    {u16 startReg, u16 floatCount}[4]
//   (pad to 72)
//   rsValues         i32[256]
//   sampValues       i32[16]
//   constPool        f32[512]      vs ranges' data in order, then ps ranges' data
// Handle-shaped entries (texture/vs/ps/decl/fvf — a handful per block, and their
// values are COM pointers only JS can resolve) stay on the JS entry path.
const BLOCK_SLOT_COUNT: usize = 128;
const BLOCK_MASK_RS: usize = 0;
const BLOCK_MASK_SAMP: usize = 32;
const BLOCK_VS_RANGES: usize = 36;
const BLOCK_PS_RANGES: usize = 52;
const BLOCK_RS_VALUES: usize = 72;
const BLOCK_SAMP_VALUES: usize = BLOCK_RS_VALUES + RENDER_STATE_COUNT * 4;
const BLOCK_CONST_POOL: usize = BLOCK_SAMP_VALUES + SAMPLER_STAGE0_COUNT * 4;
const BLOCK_CONST_POOL_FLOATS: usize = 512;
const BLOCK_SLOT_SIZE: usize = (BLOCK_CONST_POOL + BLOCK_CONST_POOL_FLOATS * 4 + 15) & !15;
const BLOCK_RANGE_COUNT: usize = 4;
/// Changed-list entry = (kind<<16 | index, value) u32 pair. Kinds: 0=renderState
/// (index=state, value=new value), 1=sampler0 (index=type), 2=vsConstRange /
/// 3=psConstRange (index=range idx, value=pool float offset — JS reads the floats
/// from the slot's constPool view).
const BLOCK_CHANGED_CAP: usize = 512;

const OFF_BLOCK_SLOTS: usize = (OFF_MISMATCH_COUNT + 4 + 15) & !15;
const OFF_BLOCK_CHANGED: usize = OFF_BLOCK_SLOTS + BLOCK_SLOT_COUNT * BLOCK_SLOT_SIZE;

const ARENA_SIZE: usize = OFF_BLOCK_CHANGED + BLOCK_CHANGED_CAP * 8;

// RenderFrame::RenderCommandType (render-frame.ts) — 1-6 kept numerically identical so
// the executor adapter can share dispatch code with the legacy RenderFrame consumer.
const CMD_SET_PIPELINE: u32 = 1;
const CMD_SET_VERTEX_BUFFER: u32 = 2;
const CMD_DRAW: u32 = 3;
const CMD_SET_INDEX_BUFFER: u32 = 4;
const CMD_DRAW_INDEXED: u32 = 5;
const CMD_BIND_PROGRAMMABLE: u32 = 6;
// Arena-only additions (7-8): UP draws have no persistent vertex/index buffer, so their
// payload shape differs from CMD_DRAW/CMD_DRAW_INDEXED and needs its own type — reusing
// CMD_DRAW_INDEXED with different A/B/C semantics would make the executor unable to tell
// the two shapes apart from cmd_type alone.
//   CMD_DRAW_UP:          A=vertexCount, B=bumpArena vertex-capture byte offset, C=byteLen
//   CMD_DRAW_INDEXED_UP:  A=indexCount, B=vertex-capture offset, C=index-capture offset,
//                         pipelineKey slot repurposed = indexByteLen,
//                         bindGroupKey slot repurposed = (vertexByteLen << 1 | indexIs16Bit)
//                         (the real pipeline/bind-group key isn't needed on Draw* rows —
//                         the executor already applied it from the preceding SetPipeline/
//                         BindProgrammable rows, same as the legacy RenderFrame consumer)
const CMD_DRAW_UP: u32 = 7;
const CMD_DRAW_INDEXED_UP: u32 = 8;

/// Shadow/authoritative Compact MegaRun descriptor stored in the frame bump arena.
/// The RenderFrame owns the generation-safe material template while this payload owns
/// every per-instance VS delta and the common indexed geometry.
const COMPACT_RUN_MAGIC_SPARSE: u32 = 0x434d_5201; // "CMR" + sparse version 1
const COMPACT_RUN_MAGIC_STORAGE: u32 = 0x434d_5202; // storage-ready version 2
const COMPACT_RUN_HEADER_WORDS: usize = 10;
static mut LAST_WBUF_COMPACT_OFFSET: i32 = -1;

// ---------------------------------------------------------------------------
// Layout table — the ONE place a byte offset is allowed to be duplicated on the JS
// side. JS reads this table once at boot (get_d3d9_arena_layout_ptr) instead of
// hardcoding offsets, so the two sides can never drift the way the slab control block
// once did (see memory: slab-hpbase-guest-unreachable). Order here IS the contract —
// the TS-side LAYOUT_IDX_* constants must list the same names in the same order.
// ---------------------------------------------------------------------------
const LAYOUT_LEN: usize = 45;
const LAYOUT_TABLE: [u32; LAYOUT_LEN] = [
    OFF_RENDER_STATES as u32,      // 0
    OFF_SAMPLER_STAGE0 as u32,     // 1
    OFF_STREAM_SOURCE as u32,      // 2
    OFF_INDEX_BUFFER as u32,       // 3
    OFF_VS_HANDLE as u32,          // 4
    OFF_PS_HANDLE as u32,          // 5
    OFF_DECL_HANDLE as u32,        // 6
    OFF_FVF as u32,                // 7
    OFF_TEXTURE_BOUND_IDS as u32,  // 8
    OFF_TEXTURE_CUBE_FLAGS as u32, // 9
    OFF_SHADER_CONST_LEN_VS as u32,// 10
    OFF_SHADER_CONST_LEN_PS as u32,// 11
    OFF_VS_CONSTANTS as u32,       // 12
    OFF_PS_CONSTANTS as u32,       // 13
    OFF_VS_CONST_VERSION as u32,   // 14
    OFF_PS_CONST_VERSION as u32,   // 15
    OFF_PIPELINE_IDENTITY as u32,  // 16
    OFF_CMD_TYPES as u32,          // 17
    OFF_CMD_A as u32,              // 18
    OFF_CMD_B as u32,              // 19
    OFF_CMD_C as u32,              // 20
    OFF_PIPELINE_KEY as u32,       // 21
    OFF_BIND_GROUP_KEY as u32,     // 22
    OFF_COMMAND_COUNT as u32,      // 23
    OFF_BUMP_ARENA as u32,         // 24
    OFF_BUMP_CURSOR as u32,        // 25
    OFF_COMMANDS_EMITTED as u32,   // 26
    OFF_ARENA_HIGH_WATER as u32,   // 27
    OFF_OVERFLOW_COUNT as u32,     // 28
    OFF_FFP_FALLBACK_COUNT as u32, // 29
    OFF_MISMATCH_COUNT as u32,     // 30
    CMD_CAP as u32,                // 31 — capacity, not an offset
    ARENA_SIZE as u32,             // 32 — total size, not an offset
    OFF_BLOCK_SLOTS as u32,        // 33
    BLOCK_SLOT_SIZE as u32,        // 34 — stride, not an offset
    BLOCK_SLOT_COUNT as u32,       // 35 — capacity, not an offset
    OFF_BLOCK_CHANGED as u32,      // 36
    BLOCK_CHANGED_CAP as u32,      // 37 — capacity (u32 pairs), not an offset
    BLOCK_MASK_RS as u32,          // 38 — intra-slot offsets from here down
    BLOCK_MASK_SAMP as u32,        // 39
    BLOCK_VS_RANGES as u32,        // 40
    BLOCK_PS_RANGES as u32,        // 41
    BLOCK_RS_VALUES as u32,        // 42
    BLOCK_SAMP_VALUES as u32,      // 43
    BLOCK_CONST_POOL as u32,       // 44
];

#[no_mangle]
pub static LAYOUT_TABLE_STATIC: [u32; LAYOUT_LEN] = LAYOUT_TABLE;

/// Pointer to the u32 layout table (see LAYOUT_TABLE above for the order
/// contract). JS reads this once at boot to build its typed views — no offset is ever
/// hardcoded on the JS side.
#[no_mangle]
pub fn get_d3d9_arena_layout_ptr() -> u32 {
    addr_of!(LAYOUT_TABLE_STATIC) as u32
}

// Backing storage as [u64; N] rather than [u8; N] — JS builds Uint32Array/Float32Array
// views directly over this memory (byteOffset must be a multiple of the element size),
// so the static's base address must be aligned; a u64 array element naturally aligns
// to 8 bytes (Rust guarantees array alignment == element alignment), which is enough
// headroom for every view type used here (max native alignment needed is 4).
const ARENA_SIZE_U64: usize = (ARENA_SIZE + 7) / 8;

#[no_mangle]
pub static mut D3D9_ARENA: [u64; ARENA_SIZE_U64] = [0u64; ARENA_SIZE_U64];

// Last-emitted stream-source/index-buffer binding, so a draw only appends a
// SetVertexBuffer/SetIndexBuffer command when the binding actually changed (mirrors the
// legacy path, which only records these on change).
static mut LAST_BOUND_STREAM: (u32, u32, u32) = (0, 0, 0); // bufferId, offset, stride
static mut LAST_BOUND_INDEX: (u32, u32) = (0, 0); // bufferId, format

// Single-entry draw-state reuse memo (mirrors d3d9-device.ts's `_lr*` last-resolve fast
// path): if pipelineKey + constant versions are unchanged since the previous draw, reuse
// its bump-arena slot instead of re-capturing. Comparing on pipelineKey (not vs/ps handle)
// is required for correctness — pipelineKey already hashes every raw field the slot
// stores, so an unchanged key guarantees the previously-captured fields are still valid.
static mut LAST_DRAW_STATE_VALID: bool = false;
static mut LAST_DRAW_STATE_PIPELINE_KEY: u32 = 0;
static mut LAST_DRAW_STATE_VS_VERSION: u32 = 0;
static mut LAST_DRAW_STATE_PS_VERSION: u32 = 0;
static mut LAST_DRAW_STATE_BIND_GROUP_KEY: u32 = 0;
static mut LAST_DRAW_STATE_OFFSET: u32 = 0;
static mut LAST_DRAW_STATE_IDENTITY: [u32; PIPELINE_IDENTITY_WORDS] = [0; PIPELINE_IDENTITY_WORDS];
static mut WBUF_RUN_SCRATCH: [u32; WBUF_RUN_CAP / 4] = [0; WBUF_RUN_CAP / 4];
static mut WBUF_CONST_ROLLBACK: [u32; VS_CONST_FLOATS] = [0; VS_CONST_FLOATS];
static mut COMPACT_RUN_TEMPLATE: [u32; VS_CONST_FLOATS] = [0; VS_CONST_FLOATS];
static mut COMPACT_RUN_TEMPLATE_WORDS: usize = 0;

#[inline(always)]
unsafe fn arena_ptr() -> *mut u8 {
    addr_of_mut!(D3D9_ARENA).cast::<u8>()
}

#[inline(always)]
unsafe fn rd_u32(off: usize) -> u32 {
    *(arena_ptr().add(off) as *const u32)
}

#[inline(always)]
unsafe fn wr_u32(off: usize, v: u32) {
    *(arena_ptr().add(off) as *mut u32) = v;
}

#[inline(always)]
unsafe fn rd_i32(off: usize) -> i32 {
    *(arena_ptr().add(off) as *const i32)
}

#[inline(always)]
unsafe fn rd_u16(off: usize) -> u16 {
    *(arena_ptr().add(off) as *const u16)
}

/// Returns the WASM-linear pointer to D3D9_ARENA for JS to create typed views.
#[no_mangle]
pub fn get_d3d9_arena_ptr() -> u32 {
    unsafe { arena_ptr() as u32 }
}

/// Runtime guard for the JS wrapper. The wrapper must reject older binaries before
/// constructing typed views or calling the i64-returning draw exports.
#[no_mangle]
pub fn get_d3d9_arena_abi_version() -> u32 {
    D3D9_ARENA_ABI_VERSION
}

/// Reset per-frame cursors (command count, bump arena). Called from JS's existing
/// Present/EndScene handler, alongside RenderFrame::reset().
#[no_mangle]
pub unsafe fn d3d9_reset_frame() {
    wr_u32(OFF_COMMAND_COUNT, 0);
    wr_u32(OFF_BUMP_CURSOR, 0);
    d3d9_clear_pipeline_identity();
    LAST_BOUND_STREAM = (0, 0, 0);
    LAST_BOUND_INDEX = (0, 0);
    LAST_DRAW_STATE_VALID = false;
    LAST_DRAW_STATE_BIND_GROUP_KEY = 0;
    LAST_DRAW_STATE_IDENTITY = [0; PIPELINE_IDENTITY_WORDS];
    LAST_WBUF_COMPACT_OFFSET = -1;
    COMPACT_RUN_TEMPLATE_WORDS = 0;
}

/// Offset of the descriptor emitted by the most recent successful WBUF run, or -1 when
/// compact shadowing was disabled/declined. Relative to OFF_BUMP_ARENA.
#[no_mangle]
pub unsafe fn d3d9_get_last_wbuf_compact_offset() -> i32 {
    LAST_WBUF_COMPACT_OFFSET
}

#[no_mangle]
pub fn get_d3d9_compact_template_ptr() -> u32 {
    addr_of!(COMPACT_RUN_TEMPLATE) as u32
}

/// Publish the valid prefix previously copied through the zero-copy pointer above.
#[no_mangle]
pub unsafe fn d3d9_set_compact_template_words(words: u32) -> u32 {
    let words = words as usize;
    if words == 0 || words > VS_CONST_FLOATS {
        COMPACT_RUN_TEMPLATE_WORDS = 0;
        return 0;
    }
    COMPACT_RUN_TEMPLATE_WORDS = words;
    words as u32
}

/// Roll back a speculative draw recording transaction.  JS records the compact arena row
/// before resolving the full TS pipeline identity so a cache hit can avoid the legacy key
/// construction.  If that resolution declines the draw, restore both cursors; stale rows or
/// UP capture bytes must never become visible to the next draw in the same frame.
#[no_mangle]
pub unsafe fn d3d9_truncate_frame(command_count: u32, bump_cursor: u32) {
    let current_command_count = rd_u32(OFF_COMMAND_COUNT);
    let current_bump_cursor = rd_u32(OFF_BUMP_CURSOR);
    // A truncate is a rollback, never a write-forward operation. Refuse a JS-side
    // validation bug instead of exposing uninitialised command rows or bump bytes.
    if command_count > current_command_count || bump_cursor > current_bump_cursor
        || (command_count as usize) > CMD_CAP || (bump_cursor as usize) > BUMP_CAP {
        return;
    }
    wr_u32(OFF_COMMAND_COUNT, command_count);
    wr_u32(OFF_BUMP_CURSOR, bump_cursor);
    // A rollback may remove the last binding rows; force the next prelude to re-emit them.
    LAST_BOUND_STREAM = (0, 0, 0);
    LAST_BOUND_INDEX = (0, 0);
    LAST_DRAW_STATE_VALID = false;
    LAST_DRAW_STATE_BIND_GROUP_KEY = 0;
    LAST_DRAW_STATE_IDENTITY = [0; PIPELINE_IDENTITY_WORDS];
}

/// Clear the canonical programmable pipeline identity. JS normally writes a fresh identity
/// through its zero-copy view before each arena draw; this export is useful for teardown and
/// compatibility with hosts that do not yet provide the extended identity.
#[no_mangle]
pub unsafe fn d3d9_clear_pipeline_identity() {
    std::ptr::write_bytes(
        arena_ptr().add(OFF_PIPELINE_IDENTITY),
        0,
        PIPELINE_IDENTITY_WORDS * 4,
    );
}

// ---------------------------------------------------------------------------
// Key derivation — ports of resolveProgrammablePipeline (d3d9-device.ts:2149-2240) and
// acquireProgBindGroup's dedupe fields (d3d9-backend-executor.ts:855-889).
// ---------------------------------------------------------------------------

const D3DRS_ZENABLE: usize = 7;
const D3DRS_CULLMODE: usize = 22;
const D3DRS_ZWRITEENABLE: usize = 14;
const D3DRS_ALPHATESTENABLE: usize = 15;
const D3DRS_SRCBLEND: usize = 19;
const D3DRS_DESTBLEND: usize = 20;
const D3DRS_ALPHAFUNC: usize = 25;
const D3DRS_ALPHAREF: usize = 24;
const D3DRS_ALPHABLENDENABLE: usize = 27;
const D3DRS_BLENDOP: usize = 171;
const D3DRS_COLORWRITEENABLE: usize = 168;
const D3DRS_SEPARATEALPHABLENDENABLE: usize = 206;
const D3DRS_SRCBLENDALPHA: usize = 207;
const D3DRS_DESTBLENDALPHA: usize = 208;
const D3DRS_BLENDOPALPHA: usize = 209;

#[inline(always)]
unsafe fn rs(state: usize) -> i32 {
    rd_i32(OFF_RENDER_STATES + state * 4)
}

/// Port of computeBlendKey (d3d9-blend.ts:138-144) + alphaTestKey (d3d9-device.ts:2126-2129).
/// CRITICAL: both TS functions COLLAPSE their key to a constant when the corresponding
/// *ENABLE render state is off — `computeBlendKey` returns bare `n${writeMask}` when
/// D3DRS_ALPHABLENDENABLE=0 (srcBlend/dstBlend/blendOp/separateAlpha/*Alpha are irrelevant
/// and NOT part of the key), and `alphaTestKey` returns `"a0"` when D3DRS_ALPHATESTENABLE=0
/// (func/ref irrelevant). These fields MUST be hashed conditionally, not
/// unconditionally: D3D9 doesn't require an app to zero blend/alpha-test registers
/// when disabling them, so leftover/stale values would differ across draws that TS
/// (correctly) treats as the SAME pipeline identity, causing pipelineKey cross-check
/// mismatches. Mirror the exact same collapse-when-disabled behavior here.
unsafe fn derive_blend_alpha_fields() -> (u32, u32, u32) {
    let write_mask = (rs(D3DRS_COLORWRITEENABLE) & 0xf) as u32;
    let alpha_blend_enable = (rs(D3DRS_ALPHABLENDENABLE) != 0) as u32;
    let (blend_core, blend_alpha_key) = if alpha_blend_enable != 0 {
        let src_blend = (rs(D3DRS_SRCBLEND) & 0x1f) as u32;
        let dst_blend = (rs(D3DRS_DESTBLEND) & 0x1f) as u32;
        let blend_op = (rs(D3DRS_BLENDOP) & 0x7) as u32;
        let core = src_blend | (dst_blend << 5) | (blend_op << 10);

        let separate_alpha = (rs(D3DRS_SEPARATEALPHABLENDENABLE) != 0) as u32;
        let src_blend_a = (rs(D3DRS_SRCBLENDALPHA) & 0x1f) as u32;
        let dst_blend_a = (rs(D3DRS_DESTBLENDALPHA) & 0x1f) as u32;
        let blend_op_a = (rs(D3DRS_BLENDOPALPHA) & 0x7) as u32;
        let bak = separate_alpha | (src_blend_a << 1) | (dst_blend_a << 6) | (blend_op_a << 11);
        (core, bak)
    } else {
        (0u32, 0u32) // matches computeBlendKey's `n${writeMask}` short-circuit
    };
    // writeMask + the enable flag itself are always part of the key (present in both of
    // computeBlendKey's branches), so they ride outside the if/else.
    let blend_key = blend_core | (alpha_blend_enable << 15) | (write_mask << 16);

    let alpha_test = (rs(D3DRS_ALPHATESTENABLE) != 0) as u32;
    let alpha_key = if alpha_test != 0 {
        let alpha_func = (rs(D3DRS_ALPHAFUNC) & 0xf) as u32;
        let alpha_ref = (rs(D3DRS_ALPHAREF) & 0xff) as u32;
        alpha_test | (alpha_func << 1) | (alpha_ref << 5)
    } else {
        0 // matches alphaTestKey's "a0" short-circuit
    };

    (blend_key, blend_alpha_key, alpha_key)
}

/// Numeric pipeline identity for the programmable path — the canonical identity supplied by
/// TypeScript is hashed first, followed by the legacy local fields. Keeping the legacy fields
/// in the digest preserves compatibility for callers that leave the canonical words zeroed.
/// Same fields as
/// resolveProgrammablePipeline's `stateBits` (cull/zEnable/zWrite only), plus
/// vs/ps/decl/stride/topology/blend/alpha/cubeMask. NOT a GPU pipeline object — a stable
/// numeric key the JS executor looks up in its own `Map<number, GPURenderPipeline>`,
/// exactly like the legacy path's cache key.
unsafe fn derive_pipeline_key(
    vs_handle: u32,
    ps_handle: u32,
    decl_handle: u32,
    stride: u32,
    topology: u32,
    force_cull_none: u32,
    cube_mask: u32,
) -> u32 {
    // Matches the TS cache key: raw cullMode stays in stateBits, forceCullNone rides as
    // an independent flag (d3d9-device.ts:2184's cacheKey template has both slots).
    let cull = (rs(D3DRS_CULLMODE) & 0xff) as u32;
    let z_enable = (rs(D3DRS_ZENABLE) != 0) as u32;
    let z_write = (rs(D3DRS_ZWRITEENABLE) != 0) as u32;
    let state_bits = cull | (z_enable << 8) | (z_write << 9);

    let (blend_key, blend_alpha_key, alpha_key) = derive_blend_alpha_fields();

    // FNV-1a style mix — a stable numeric identity is all that's required (the executor
    // never derives a GPU object from this key directly, only looks it up). Include every
    // canonical word before the legacy fields so additions to the TS cache identity do not
    // require duplicating shader/attachment policy in Rust.
    let mut h: u32 = 0x811c9dc5;
    for i in 0..PIPELINE_IDENTITY_WORDS {
        h ^= rd_u32(OFF_PIPELINE_IDENTITY + i * 4);
        h = h.wrapping_mul(0x01000193);
    }
    for v in [
        vs_handle,
        ps_handle,
        decl_handle,
        stride,
        topology,
        force_cull_none,
        state_bits,
        blend_key,
        blend_alpha_key,
        alpha_key,
        cube_mask,
    ] {
        h ^= v;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

/// Numeric bind-group identity — dedupes on the same fields acquireProgBindGroup's ring
/// compares: the resolved stage-0 sampler settings, cubeMask, and the 8 bound texture ids.
unsafe fn derive_bind_group_key(cube_mask: u32) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for i in 0..SAMPLER_STAGE0_COUNT {
        let v = rd_i32(OFF_SAMPLER_STAGE0 + i * 4) as u32;
        h ^= v;
        h = h.wrapping_mul(0x01000193);
    }
    h ^= cube_mask;
    h = h.wrapping_mul(0x01000193);
    for i in 0..TEXTURE_ID_SLOTS {
        let v = rd_u32(OFF_TEXTURE_BOUND_IDS + i * 4);
        h ^= v;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

unsafe fn cube_mask() -> u32 {
    let mut mask = 0u32;
    for stage in 0..TEXTURE_ID_SLOTS {
        let tex_id = rd_u32(OFF_TEXTURE_BOUND_IDS + stage * 4);
        if tex_id != 0 && tex_id < TEXTURE_CUBE_FLAG_SLOTS as u32 {
            let flag = *(arena_ptr().add(OFF_TEXTURE_CUBE_FLAGS + tex_id as usize) as *const u8);
            if flag != 0 {
                mask |= 1 << stage;
            }
        }
    }
    mask
}

// ---------------------------------------------------------------------------
// Per-draw programmable-state capture (constant-prefix capture-at-call, mirrors
// RenderFrame::nextDrawState / captureDrawState).
// ---------------------------------------------------------------------------

/// Bump-allocate `len` bytes in the frame arena, rounded up to a 4-byte boundary so every
/// returned offset stays a valid Uint32Array/Float32Array byteOffset on the JS side (the
/// cursor starts at 0, which is aligned, and every allocation preserves that invariant by
/// always advancing a multiple of 4). Returns the offset, or u32::MAX on overflow (caller
/// must treat as "arena full", decline the draw, bump overflowCount).
unsafe fn bump_alloc(len: usize) -> u32 {
    let cursor = rd_u32(OFF_BUMP_CURSOR) as usize;
    let aligned_len = (len + 3) & !3;
    if cursor + aligned_len > BUMP_CAP {
        let overflow = rd_u32(OFF_OVERFLOW_COUNT);
        wr_u32(OFF_OVERFLOW_COUNT, overflow.wrapping_add(1));
        return u32::MAX;
    }
    wr_u32(OFF_BUMP_CURSOR, (cursor + aligned_len) as u32);
    let high_water = rd_u32(OFF_ARENA_HIGH_WATER);
    if (cursor + aligned_len) as u32 > high_water {
        wr_u32(OFF_ARENA_HIGH_WATER, (cursor + aligned_len) as u32);
    }
    cursor as u32
}

/// Slot header field count (see layout comment below) — used by the executor to find
/// where the VS/PS constant bytes start within a captured slot.
const DRAW_STATE_HEADER_LEN: usize = 2 + 2 + 4 + 4 + TEXTURE_ID_SLOTS * 4 + 4 * 4 + 4
    + PIPELINE_IDENTITY_WORDS * 4;

/// Snapshot everything the executor needs to either (a) build a NEW GPURenderPipeline/
/// bind group on a cache miss, or (b) upload this draw's VS/PS constants — captured at
/// call time so a mid-frame state change after this draw can't corrupt what gets used
/// at end-of-frame drain (same capture-at-call discipline as UP vertex/index bytes;
/// this is the pipeline-creation analogue of that problem: pipelineKey is only a HASH,
/// the executor needs the raw ingredients back on a miss). Reuses the previous draw's
/// slot when `pipeline_key`+constant versions+bind-group key are unchanged (single-entry memo,
/// mirrors `_lrValid`). Texture ids are not part of the 16 pipeline-identity words, so the
/// explicit bind-group comparison prevents a SetTexture between otherwise-identical draws from
/// reusing the previous slot's textureIds/bindGroupKey.
///
/// Slot layout: u16 vsLen, u16 psLen, u32 cubeMask, u32 bindGroupKey, u32[8] texIds,
/// u32[4] renderStateBits (packed: [0]=cull|zEnable<<8|zWrite<<9|topology<<16|
/// forceCullNone<<24, [1]=blendKey, [2]=blendAlphaKey, [3]=alphaKey), u32 declHandle,
/// u32[16] canonical pipeline identity, then f32[vsLen] vsConstants, f32[psLen] psConstants.
#[allow(clippy::too_many_arguments)]
unsafe fn capture_draw_state(
    vs_handle: u32,
    ps_handle: u32,
    decl_handle: u32,
    stride: u32,
    topology: u32,
    force_cull_none: u32,
    pipeline_key: u32,
) -> u32 {
    let vs_version = rd_u32(OFF_VS_CONST_VERSION);
    let ps_version = rd_u32(OFF_PS_CONST_VERSION);
    let cmask = cube_mask();
    let bind_group_key = derive_bind_group_key(cmask);

    let mut identity_unchanged = true;
    for i in 0..PIPELINE_IDENTITY_WORDS {
        if rd_u32(OFF_PIPELINE_IDENTITY + i * 4) != LAST_DRAW_STATE_IDENTITY[i] {
            identity_unchanged = false;
            break;
        }
    }
    if LAST_DRAW_STATE_VALID
        && LAST_DRAW_STATE_PIPELINE_KEY == pipeline_key
        && LAST_DRAW_STATE_VS_VERSION == vs_version
        && LAST_DRAW_STATE_PS_VERSION == ps_version
        && LAST_DRAW_STATE_BIND_GROUP_KEY == bind_group_key
        && identity_unchanged
    {
        return LAST_DRAW_STATE_OFFSET;
    }

    let vs_len = rd_u16(OFF_SHADER_CONST_LEN_VS + (vs_handle as usize % SHADER_HANDLE_SLOTS) * 2) as usize;
    let ps_len = rd_u16(OFF_SHADER_CONST_LEN_PS + (ps_handle as usize % SHADER_HANDLE_SLOTS) * 2) as usize;
    let vs_bytes = vs_len.min(VS_CONST_FLOATS) * 4;
    let ps_bytes = ps_len.min(PS_CONST_FLOATS) * 4;

    let slot_len = DRAW_STATE_HEADER_LEN + vs_bytes + ps_bytes;
    let offset = bump_alloc(slot_len);
    if offset == u32::MAX {
        return offset;
    }

    let cull = (rs(D3DRS_CULLMODE) & 0xff) as u32;
    let z_enable = (rs(D3DRS_ZENABLE) != 0) as u32;
    let z_write = (rs(D3DRS_ZWRITEENABLE) != 0) as u32;
    let render_bits0 = cull | (z_enable << 8) | (z_write << 9) | (topology << 16) | (force_cull_none << 24);

    let (blend_key, blend_alpha_key, alpha_key) = derive_blend_alpha_fields();

    let slot = arena_ptr().add(OFF_BUMP_ARENA + offset as usize);
    *(slot as *mut u16) = vs_len as u16;
    *(slot.add(2) as *mut u16) = ps_len as u16;
    *(slot.add(4) as *mut u32) = cmask;
    *(slot.add(8) as *mut u32) = bind_group_key;
    for i in 0..TEXTURE_ID_SLOTS {
        let v = rd_u32(OFF_TEXTURE_BOUND_IDS + i * 4);
        *(slot.add(12 + i * 4) as *mut u32) = v;
    }
    let rs_off = 12 + TEXTURE_ID_SLOTS * 4;
    *(slot.add(rs_off) as *mut u32) = render_bits0;
    *(slot.add(rs_off + 4) as *mut u32) = blend_key;
    *(slot.add(rs_off + 8) as *mut u32) = blend_alpha_key;
    *(slot.add(rs_off + 12) as *mut u32) = alpha_key;
    *(slot.add(rs_off + 16) as *mut u32) = decl_handle;
    for i in 0..PIPELINE_IDENTITY_WORDS {
        *(slot.add(64 + i * 4) as *mut u32) = rd_u32(OFF_PIPELINE_IDENTITY + i * 4);
    }
    let _ = stride; // stride already folded into pipeline_key; kept as a param for clarity/future use

    let vs_src = arena_ptr().add(OFF_VS_CONSTANTS);
    let ps_src = arena_ptr().add(OFF_PS_CONSTANTS);
    std::ptr::copy_nonoverlapping(vs_src, slot.add(DRAW_STATE_HEADER_LEN), vs_bytes);
    std::ptr::copy_nonoverlapping(ps_src, slot.add(DRAW_STATE_HEADER_LEN + vs_bytes), ps_bytes);

    LAST_DRAW_STATE_VALID = true;
    LAST_DRAW_STATE_PIPELINE_KEY = pipeline_key;
    LAST_DRAW_STATE_VS_VERSION = vs_version;
    LAST_DRAW_STATE_PS_VERSION = ps_version;
    LAST_DRAW_STATE_BIND_GROUP_KEY = bind_group_key;
    LAST_DRAW_STATE_OFFSET = offset;
    for i in 0..PIPELINE_IDENTITY_WORDS {
        LAST_DRAW_STATE_IDENTITY[i] = rd_u32(OFF_PIPELINE_IDENTITY + i * 4);
    }
    offset
}

// ---------------------------------------------------------------------------
// Command SoA emission
// ---------------------------------------------------------------------------

unsafe fn push_command(cmd_type: u32, a: u32, b: u32, c: u32, pipeline_key: u32, bind_group_key: u32) -> bool {
    let count = rd_u32(OFF_COMMAND_COUNT) as usize;
    if count >= CMD_CAP {
        let overflow = rd_u32(OFF_OVERFLOW_COUNT);
        wr_u32(OFF_OVERFLOW_COUNT, overflow.wrapping_add(1));
        return false;
    }
    wr_u32(OFF_CMD_TYPES + count * 4, cmd_type);
    wr_u32(OFF_CMD_A + count * 4, a);
    wr_u32(OFF_CMD_B + count * 4, b);
    wr_u32(OFF_CMD_C + count * 4, c);
    wr_u32(OFF_PIPELINE_KEY + count * 4, pipeline_key);
    wr_u32(OFF_BIND_GROUP_KEY + count * 4, bind_group_key);
    wr_u32(OFF_COMMAND_COUNT, (count + 1) as u32);
    let emitted = rd_u32(OFF_COMMANDS_EMITTED);
    wr_u32(OFF_COMMANDS_EMITTED, emitted.wrapping_add(1));
    true
}

/// Emit SetVertexBuffer/SetIndexBuffer commands if the binding changed since the last
/// draw, then SetPipeline + BindProgrammable, returning (pipelineKey, bindGroupKey) or
/// None if the arena is full or this isn't a programmable (VS+PS-bound) draw.
unsafe fn emit_draw_prelude(topology: u32, stride: u32, force_cull_none: u32) -> Option<(u32, u32)> {
    let vs_handle = rd_u32(OFF_VS_HANDLE);
    let ps_handle = rd_u32(OFF_PS_HANDLE);
    if vs_handle == 0 || ps_handle == 0 {
        let ffp = rd_u32(OFF_FFP_FALLBACK_COUNT);
        wr_u32(OFF_FFP_FALLBACK_COUNT, ffp.wrapping_add(1));
        return None;
    }
    let decl_handle = rd_u32(OFF_DECL_HANDLE);

    let stream_buffer = rd_u32(OFF_STREAM_SOURCE);
    let stream_offset = rd_u32(OFF_STREAM_SOURCE + 4);
    let stream_stride = rd_u32(OFF_STREAM_SOURCE + 8);
    if LAST_BOUND_STREAM != (stream_buffer, stream_offset, stream_stride) {
        if !push_command(CMD_SET_VERTEX_BUFFER, stream_buffer, stream_offset, stream_stride, 0, 0) {
            return None;
        }
        LAST_BOUND_STREAM = (stream_buffer, stream_offset, stream_stride);
    }

    let index_buffer = rd_u32(OFF_INDEX_BUFFER);
    let index_format = rd_u32(OFF_INDEX_BUFFER + 4);
    if LAST_BOUND_INDEX != (index_buffer, index_format) {
        if !push_command(CMD_SET_INDEX_BUFFER, index_buffer, index_format, 0, 0, 0) {
            return None;
        }
        LAST_BOUND_INDEX = (index_buffer, index_format);
    }

    let cmask = cube_mask();
    let pipeline_key = derive_pipeline_key(vs_handle, ps_handle, decl_handle, stride, topology, force_cull_none, cmask);
    let bind_group_key = derive_bind_group_key(cmask);

    // Captured BEFORE emitting SetPipeline so its slot offset can ride commandB —
    // on a cache miss the executor needs the raw ingredients back (pipelineKey is only
    // a hash), and this capture is what makes those ingredients frame-timing-safe.
    let draw_state_offset = capture_draw_state(vs_handle, ps_handle, decl_handle, stride, topology, force_cull_none, pipeline_key);
    if draw_state_offset == u32::MAX {
        return None;
    }

    if !push_command(CMD_SET_PIPELINE, pipeline_key, draw_state_offset, 0, pipeline_key, bind_group_key) {
        return None;
    }
    if !push_command(CMD_BIND_PROGRAMMABLE, draw_state_offset, 0, 0, pipeline_key, bind_group_key) {
        return None;
    }

    Some((pipeline_key, bind_group_key))
}

/// IDirect3DDevice9_DrawPrimitive — record a non-indexed draw. `topology` is a small
/// caller-resolved code (0=triangle-list,1=triangle-strip,2=line-list,3=line-strip,
/// 4=point-list); vertex_count/start_vertex are already resolved by the caller from
/// (PrimitiveType, PrimitiveCount), same as the legacy TS path computes today. Returns
/// the derived pipelineKey (for the JS-side cross-check), or -1 if declined.
#[no_mangle]
pub unsafe fn d3d9_record_draw(
    topology: u32,
    vertex_count: u32,
    start_vertex: u32,
    stride: u32,
    force_cull_none: u32,
) -> i64 {
    match emit_draw_prelude(topology, stride, force_cull_none) {
        Some((pipeline_key, _bind_group_key)) => {
            if !push_command(CMD_DRAW, vertex_count, start_vertex, 0, pipeline_key, 0) {
                return -1;
            }
            // Return a signed 64-bit status so every u32 pipeline hash, including
            // 0xffffffff, remains distinguishable from the -1 decline sentinel in JS.
            pipeline_key as i64
        }
        None => -1,
    }
}

/// IDirect3DDevice9_DrawIndexedPrimitive.
#[no_mangle]
pub unsafe fn d3d9_record_draw_indexed(
    topology: u32,
    index_count: u32,
    start_index: u32,
    base_vertex: u32,
    stride: u32,
    force_cull_none: u32,
) -> i64 {
    match emit_draw_prelude(topology, stride, force_cull_none) {
        Some((pipeline_key, _bind_group_key)) => {
            if !push_command(CMD_DRAW_INDEXED, index_count, start_index, base_vertex, pipeline_key, 0) {
                return -1;
            }
            pipeline_key as i64
        }
        None => -1,
    }
}

/// Record an exact alternating WBUF run:
///   SetVertexShaderConstantF(this,start,count,inlineBits) ->
///   DrawIndexedPrimitive(this,TRIANGLELIST,base,min,numVertices,startIndex,primitiveCount)
///
/// The complete source range is copied through the paging-aware guest accessor once, then
/// fully validated before the arena mirror or command cursors are touched. Any unexpected
/// recorder decline restores every mutable field involved in the transaction. Returns the
/// number of recorded pairs, or -1 so JS can replay the ordinary handlers exactly once.
#[no_mangle]
pub unsafe fn d3d9_record_wbuf_indexed_run(
    guest_start: i32,
    byte_len: u32,
    vs_func_id: u32,
    draw_func_id: u32,
    expected_device: u32,
    stride: u32,
    force_cull_none: u32,
    compact_mode: u32,
    index_capacity: u32,
) -> i32 {
    LAST_WBUF_COMPACT_OFFSET = -1;
    let len = byte_len as usize;
    if compact_mode > 3 || guest_start == 0 || len == 0 || len > WBUF_RUN_CAP || (len & 3) != 0
        || expected_device == 0 || stride == 0
    {
        return -1;
    }
    let gm = match guest_mem() { Some(gm) => gm, None => return -1 };
    let scratch_ptr = addr_of_mut!(WBUF_RUN_SCRATCH).cast::<u8>();
    if !(gm.read_block)(guest_start, scratch_ptr, byte_len) { return -1; }
    let words = std::slice::from_raw_parts(scratch_ptr.cast::<u32>(), len / 4);

    // Pass one: exact shape + bounds + a stable constant range. A state setter between the
    // two calls cannot be hidden because the dispatcher only hands us a contiguous run.
    let mut at = 0usize;
    let mut pairs = 0usize;
    let mut run_start_reg = 0usize;
    let mut run_float_count = 0usize;
    let mut run_index_count = 0u32;
    let mut run_start_index = 0u32;
    let mut run_base_vertex = 0u32;
    while at < words.len() {
        if words.len() - at < 4 || words[at] != vs_func_id || words[at + 1] != expected_device {
            return -1;
        }
        let start_reg = words[at + 2] as usize;
        let vec_count = words[at + 3] as usize;
        let float_count = match vec_count.checked_mul(4) { Some(v) if v > 0 => v, _ => return -1 };
        let float_start = match start_reg.checked_mul(4) { Some(v) => v, None => return -1 };
        if float_start >= VS_CONST_FLOATS || float_count > VS_CONST_FLOATS - float_start {
            return -1;
        }
        if pairs == 0 { run_start_reg = start_reg; run_float_count = float_count; }
        else if start_reg != run_start_reg || float_count != run_float_count { return -1; }
        let constant_words = match 4usize.checked_add(float_count) {
            Some(v) if v <= words.len() - at => v,
            _ => return -1,
        };
        at += constant_words;
        if words.len() - at < 8 || words[at] != draw_func_id || words[at + 1] != expected_device {
            return -1;
        }
        // The specialized host command is deliberately list-only and non-instanced.
        if words[at + 2] != 4 || (words[at + 3] as i32) < 0 { return -1; }
        let primitive_count = words[at + 7];
        if primitive_count == 0 || primitive_count > u32::MAX / 3 { return -1; }
        let index_count = primitive_count * 3;
        let start_index = words[at + 6];
        let base_vertex = words[at + 3];
        if compact_mode != 0 {
            if index_capacity == 0 || index_count > index_capacity
                || start_index > index_capacity - index_count
            {
                return -1;
            }
            if pairs == 0 {
                run_index_count = index_count;
                run_start_index = start_index;
                run_base_vertex = base_vertex;
            } else if index_count != run_index_count || start_index != run_start_index
                || base_vertex != run_base_vertex
            {
                return -1;
            }
        }
        at += 8;
        pairs += 1;
    }
    if at != words.len() || pairs < 2 { return -1; }

    let vs_handle = rd_u32(OFF_VS_HANDLE) as usize;
    let ps_handle = rd_u32(OFF_PS_HANDLE) as usize;
    if vs_handle == 0 || ps_handle == 0 { return -1; }
    let vs_bytes = (rd_u16(OFF_SHADER_CONST_LEN_VS + (vs_handle % SHADER_HANDLE_SLOTS) * 2) as usize)
        .min(VS_CONST_FLOATS) * 4;
    let ps_bytes = (rd_u16(OFF_SHADER_CONST_LEN_PS + (ps_handle % SHADER_HANDLE_SLOTS) * 2) as usize)
        .min(PS_CONST_FLOATS) * 4;
    let slot_bytes = (DRAW_STATE_HEADER_LEN + vs_bytes + ps_bytes + 3) & !3;
    let command_count = rd_u32(OFF_COMMAND_COUNT) as usize;
    let bump_cursor = rd_u32(OFF_BUMP_CURSOR) as usize;
    let compact_stride_words = if compact_mode == 3 {
        let words = COMPACT_RUN_TEMPLATE_WORDS;
        let float_start = run_start_reg * 4;
        if words == 0 || float_start > words || run_float_count > words - float_start {
            return -1;
        }
        words
    } else {
        run_float_count
    };
    let compact_bytes = if compact_mode != 0 {
        match pairs.checked_mul(compact_stride_words)
            .and_then(|words| words.checked_add(COMPACT_RUN_HEADER_WORDS))
            .and_then(|words| words.checked_mul(4))
        {
            Some(bytes) => bytes,
            None => return -1,
        }
    } else { 0 };
    // Legacy/shadow mode still materializes three rows + one state slot per pair.
    // Authoritative compact mode needs only its sparse descriptor/payload.
    if compact_bytes > BUMP_CAP.saturating_sub(bump_cursor)
        || (compact_mode < 2 && (
            pairs > (CMD_CAP.saturating_sub(command_count + 2)) / 3
            || pairs > BUMP_CAP.saturating_sub(bump_cursor + compact_bytes) / slot_bytes.max(1)
        ))
    {
        return -1;
    }

    // Transaction checkpoint. High-water marks intentionally remain monotonic telemetry;
    // visible cursors, counters, mirrors and reuse/binding memos are restored on decline.
    let old_command_count = rd_u32(OFF_COMMAND_COUNT);
    let old_bump_cursor = rd_u32(OFF_BUMP_CURSOR);
    let old_emitted = rd_u32(OFF_COMMANDS_EMITTED);
    let old_vs_version = rd_u32(OFF_VS_CONST_VERSION);
    let old_bound_stream = LAST_BOUND_STREAM;
    let old_bound_index = LAST_BOUND_INDEX;
    let old_state_valid = LAST_DRAW_STATE_VALID;
    let old_state_pipeline = LAST_DRAW_STATE_PIPELINE_KEY;
    let old_state_vs_version = LAST_DRAW_STATE_VS_VERSION;
    let old_state_ps_version = LAST_DRAW_STATE_PS_VERSION;
    let old_state_bind = LAST_DRAW_STATE_BIND_GROUP_KEY;
    let old_state_offset = LAST_DRAW_STATE_OFFSET;
    let old_state_identity = LAST_DRAW_STATE_IDENTITY;
    let float_start = run_start_reg * 4;
    std::ptr::copy_nonoverlapping(
        arena_ptr().add(OFF_VS_CONSTANTS + float_start * 4).cast::<u32>(),
        addr_of_mut!(WBUF_CONST_ROLLBACK).cast::<u32>(),
        run_float_count,
    );

    let compact_offset = if compact_mode != 0 {
        let offset = bump_alloc(compact_bytes);
        if offset == u32::MAX { return -1; }
        let header = arena_ptr().add(OFF_BUMP_ARENA + offset as usize).cast::<u32>();
        *header.add(0) = if compact_mode == 3 {
            COMPACT_RUN_MAGIC_STORAGE
        } else {
            COMPACT_RUN_MAGIC_SPARSE
        };
        *header.add(1) = pairs as u32;
        *header.add(2) = run_start_reg as u32;
        *header.add(3) = run_float_count as u32;
        *header.add(4) = offset + (COMPACT_RUN_HEADER_WORDS * 4) as u32;
        *header.add(5) = (pairs * compact_stride_words) as u32;
        *header.add(6) = run_index_count;
        *header.add(7) = run_start_index;
        *header.add(8) = run_base_vertex;
        *header.add(9) = compact_stride_words as u32;
        offset as i32
    } else { -1 };

    at = 0;
    let mut recorded = 0usize;
    while at < words.len() {
        let float_count = (words[at + 3] as usize) * 4;
        if compact_offset >= 0 {
            let payload = arena_ptr().add(
                OFF_BUMP_ARENA + compact_offset as usize + COMPACT_RUN_HEADER_WORDS * 4,
            ).cast::<u32>();
            let instance = payload.add(recorded * compact_stride_words);
            if compact_mode == 3 {
                std::ptr::copy_nonoverlapping(
                    addr_of!(COMPACT_RUN_TEMPLATE).cast::<u32>(),
                    instance,
                    compact_stride_words,
                );
            }
            std::ptr::copy_nonoverlapping(
                words.as_ptr().add(at + 4),
                instance.add(if compact_mode == 3 { float_start } else { 0 }),
                float_count,
            );
        }
        std::ptr::copy_nonoverlapping(
            words.as_ptr().add(at + 4),
            arena_ptr().add(OFF_VS_CONSTANTS + float_start * 4).cast::<u32>(),
            float_count,
        );
        wr_u32(OFF_VS_CONST_VERSION, rd_u32(OFF_VS_CONST_VERSION).wrapping_add(1));
        at += 4 + float_count;
        let base_vertex = words[at + 3];
        let start_index = words[at + 6];
        let index_count = words[at + 7] * 3;
        if compact_mode < 2
            && d3d9_record_draw_indexed(
                0, index_count, start_index, base_vertex, stride, force_cull_none,
            ) < 0
        {
            std::ptr::copy_nonoverlapping(
                addr_of!(WBUF_CONST_ROLLBACK).cast::<u32>(),
                arena_ptr().add(OFF_VS_CONSTANTS + float_start * 4).cast::<u32>(),
                run_float_count,
            );
            wr_u32(OFF_COMMAND_COUNT, old_command_count);
            wr_u32(OFF_BUMP_CURSOR, old_bump_cursor);
            wr_u32(OFF_COMMANDS_EMITTED, old_emitted);
            wr_u32(OFF_VS_CONST_VERSION, old_vs_version);
            LAST_BOUND_STREAM = old_bound_stream;
            LAST_BOUND_INDEX = old_bound_index;
            LAST_DRAW_STATE_VALID = old_state_valid;
            LAST_DRAW_STATE_PIPELINE_KEY = old_state_pipeline;
            LAST_DRAW_STATE_VS_VERSION = old_state_vs_version;
            LAST_DRAW_STATE_PS_VERSION = old_state_ps_version;
            LAST_DRAW_STATE_BIND_GROUP_KEY = old_state_bind;
            LAST_DRAW_STATE_OFFSET = old_state_offset;
            LAST_DRAW_STATE_IDENTITY = old_state_identity;
            LAST_WBUF_COMPACT_OFFSET = -1;
            return -1;
        }
        at += 8;
        recorded += 1;
    }
    LAST_WBUF_COMPACT_OFFSET = compact_offset;
    recorded as i32
}

/// IDirect3DDevice9_DrawPrimitiveUP — capture-at-call: copies `byte_len` bytes from the
/// GUEST vertex pointer into the frame bump arena immediately (before returning), same
/// timing guarantee as the legacy synchronous JS path. The executor reads the recorded
/// bump-arena offset/length back out at drain time to build/refresh its pooled upload
/// buffer — Rust only records the byte range, it never touches a GPU object.
#[no_mangle]
pub unsafe fn d3d9_record_draw_up(
    topology: u32,
    vertex_count: u32,
    guest_vertex_ptr: i32,
    stride: u32,
    byte_len: u32,
    force_cull_none: u32,
) -> i64 {
    let capture_offset = bump_alloc(byte_len as usize);
    if capture_offset == u32::MAX {
        return -1;
    }
    if copy_guest_bytes(guest_vertex_ptr, OFF_BUMP_ARENA + capture_offset as usize, byte_len).is_err() {
        return -1;
    }
    match emit_draw_prelude(topology, stride, force_cull_none) {
        Some((pipeline_key, _bind_group_key)) => {
            // B carries the bump-arena byte offset of the captured vertex data, C its
            // length — the executor reads both to build/refresh the pooled upload
            // buffer, mirroring RenderFrame::queueUpload today.
            if !push_command(CMD_DRAW_UP, vertex_count, capture_offset, byte_len, pipeline_key, 0) {
                return -1;
            }
            pipeline_key as i64
        }
        None => -1,
    }
}

/// IDirect3DDevice9_DrawIndexedPrimitiveUP — same capture-at-call discipline as
/// d3d9_record_draw_up, for both the vertex AND index guest buffers.
#[no_mangle]
pub unsafe fn d3d9_record_draw_indexed_up(
    topology: u32,
    index_count: u32,
    guest_index_ptr: i32,
    index_byte_len: u32,
    index_is_16bit: u32,
    guest_vertex_ptr: i32,
    stride: u32,
    vertex_byte_len: u32,
    force_cull_none: u32,
) -> i64 {
    let vertex_capture_offset = bump_alloc(vertex_byte_len as usize);
    if vertex_capture_offset == u32::MAX {
        return -1;
    }
    if copy_guest_bytes(guest_vertex_ptr, OFF_BUMP_ARENA + vertex_capture_offset as usize, vertex_byte_len).is_err() {
        return -1;
    }
    let index_capture_offset = bump_alloc(index_byte_len as usize);
    if index_capture_offset == u32::MAX {
        return -1;
    }
    if copy_guest_bytes(guest_index_ptr, OFF_BUMP_ARENA + index_capture_offset as usize, index_byte_len).is_err() {
        return -1;
    }
    match emit_draw_prelude(topology, stride, force_cull_none) {
        Some((pipeline_key, _bind_group_key)) => {
            // A=indexCount, B=vertex-capture offset, C=index-capture offset. Draw* rows
            // don't need their own pipeline/bind-group key (the executor already applied
            // the preceding SetPipeline/BindProgrammable rows), so those two columns
            // carry indexByteLen and (vertexByteLen<<1 | indexIs16Bit) instead.
            let packed_vertex_len = (vertex_byte_len << 1) | (index_is_16bit & 1);
            if !push_command(
                CMD_DRAW_INDEXED_UP,
                index_count,
                vertex_capture_offset,
                index_capture_offset,
                index_byte_len,
                packed_vertex_len,
            ) {
                return -1;
            }
            pipeline_key as i64
        }
        None => -1,
    }
}

// ---------------------------------------------------------------------------
// State-block Capture/Apply — see the slot layout comment above.
// ---------------------------------------------------------------------------

#[inline(always)]
unsafe fn block_slot_off(slot: u32) -> Option<usize> {
    if (slot as usize) < BLOCK_SLOT_COUNT {
        Some(OFF_BLOCK_SLOTS + slot as usize * BLOCK_SLOT_SIZE)
    }
    else {
        None
    }
}

/// Iterate the slot's const ranges (vs then ps, in order), calling `f(kind, range_idx,
/// pool_float_off, mirror_byte_off, float_count)` for each used range. Pool packing is
/// cumulative in range order — the SAME order JS packed the initial values in, so both
/// sides agree on each range's pool offset without storing it.
unsafe fn block_for_each_const_range(s: usize, mut f: impl FnMut(u32, usize, usize, usize, usize)) {
    let mut pool = 0usize;
    for (kind, ranges_off, mirror_off, mirror_floats) in [
        (2u32, BLOCK_VS_RANGES, OFF_VS_CONSTANTS, VS_CONST_FLOATS),
        (3u32, BLOCK_PS_RANGES, OFF_PS_CONSTANTS, PS_CONST_FLOATS),
    ] {
        for r in 0..BLOCK_RANGE_COUNT {
            let start_reg = rd_u16(s + ranges_off + r * 4) as usize;
            let count = rd_u16(s + ranges_off + r * 4 + 2) as usize;
            if count == 0 {
                continue;
            }
            let start_float = start_reg * 4;
            if start_float + count > mirror_floats || pool + count > BLOCK_CONST_POOL_FLOATS {
                // Malformed range (JS classification should prevent this) — stop rather
                // than read/write out of bounds.
                return;
            }
            f(kind, r, pool, mirror_off + start_float * 4, count);
            pool += count;
        }
    }
}

/// Capture = refresh the slot's recorded values from the live mirror (matches
/// captureStateBlockData's refresh-only semantics). Copying the full rs/sampler value
/// arrays (masked entries are the only ones ever read back) is simpler and faster than
/// a bit walk. Handle-shaped entries are refreshed on the JS side.
#[no_mangle]
pub unsafe fn d3d9_block_capture(slot: u32) {
    let s = match block_slot_off(slot) {
        Some(s) => s,
        None => return,
    };
    std::ptr::copy_nonoverlapping(
        arena_ptr().add(OFF_RENDER_STATES),
        arena_ptr().add(s + BLOCK_RS_VALUES),
        RENDER_STATE_COUNT * 4,
    );
    std::ptr::copy_nonoverlapping(
        arena_ptr().add(OFF_SAMPLER_STAGE0),
        arena_ptr().add(s + BLOCK_SAMP_VALUES),
        SAMPLER_STAGE0_COUNT * 4,
    );
    block_for_each_const_range(s, |_kind, _r, pool_off, mirror_byte_off, count| {
        std::ptr::copy_nonoverlapping(
            arena_ptr().add(mirror_byte_off),
            arena_ptr().add(s + BLOCK_CONST_POOL + pool_off * 4),
            count * 4,
        );
    });
}

/// Apply = diff the slot against the live mirror and emit a compact changed-list
/// (u32 pairs at OFF_BLOCK_CHANGED, count returned). The mirror is NOT written here —
/// JS replays each delta through the ordinary device setter, which updates the mirror,
/// the JS state tracker, and the setter shadow through the one existing write path.
#[no_mangle]
pub unsafe fn d3d9_block_apply(slot: u32) -> u32 {
    let s = match block_slot_off(slot) {
        Some(s) => s,
        None => return 0,
    };
    let ch = arena_ptr().add(OFF_BLOCK_CHANGED) as *mut u32;
    let mut n = 0usize;
    let mut push = |kind_idx: u32, value: u32| {
        if n < BLOCK_CHANGED_CAP {
            *ch.add(n * 2) = kind_idx;
            *ch.add(n * 2 + 1) = value;
            n += 1;
        }
    };

    for w in 0..RENDER_STATE_COUNT / 32 {
        let mut m = rd_u32(s + BLOCK_MASK_RS + w * 4);
        while m != 0 {
            let bit = m.trailing_zeros() as usize;
            m &= m - 1;
            let state = w * 32 + bit;
            let bv = rd_i32(s + BLOCK_RS_VALUES + state * 4);
            if bv != rd_i32(OFF_RENDER_STATES + state * 4) {
                push(state as u32, bv as u32); // kind 0
            }
        }
    }

    let mut m = rd_u32(s + BLOCK_MASK_SAMP);
    while m != 0 {
        let ty = m.trailing_zeros() as usize;
        m &= m - 1;
        let bv = rd_i32(s + BLOCK_SAMP_VALUES + ty * 4);
        if bv != rd_i32(OFF_SAMPLER_STAGE0 + ty * 4) {
            push(1 << 16 | ty as u32, bv as u32);
        }
    }

    block_for_each_const_range(s, |kind, r, pool_off, mirror_byte_off, count| {
        let block_bytes =
            std::slice::from_raw_parts(arena_ptr().add(s + BLOCK_CONST_POOL + pool_off * 4), count * 4);
        let mirror_bytes = std::slice::from_raw_parts(arena_ptr().add(mirror_byte_off), count * 4);
        if block_bytes != mirror_bytes {
            push(kind << 16 | r as u32, pool_off as u32);
        }
    });

    n as u32
}

/// Bulk-copy `len` bytes from a GUEST address into the arena at `dst_off` (our own
/// static memory — no guest-address validation needed for the destination). Guest-side
/// bounds/mmap checking lives in the host's injected read_block (see guest_mem.rs).
unsafe fn copy_guest_bytes(guest_src: i32, dst_off: usize, len: u32) -> Result<(), ()> {
    if guest_src == 0 || len == 0 {
        return Ok(());
    }
    let gm = guest_mem().ok_or(())?;
    let dst = arena_ptr().add(dst_off);
    if (gm.read_block)(guest_src, dst, len) {
        Ok(())
    } else {
        Err(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guest_mem::{set_guest_mem, GuestMem};
    use std::sync::Mutex;

    const GUEST_BASE: i32 = 0x1000;
    static mut GUEST: [u32; 4096 / 4] = [0; 4096 / 4];
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn read_guest(addr: i32, dst: *mut u8, len: u32) -> bool {
        let off = addr.wrapping_sub(GUEST_BASE);
        if off < 0 || off as usize > 4096usize.saturating_sub(len as usize) { return false; }
        unsafe {
            std::ptr::copy_nonoverlapping(
                addr_of!(GUEST).cast::<u8>().add(off as usize), dst, len as usize,
            );
        }
        true
    }

    unsafe fn install_run(second_device: u32) -> u32 {
        let words = std::slice::from_raw_parts_mut(addr_of_mut!(GUEST).cast::<u32>(), 4096 / 4);
        let packet: [u32; 32] = [
            11, 99, 4, 1, 1, 2, 3, 4,
            22, 99, 4, 0, 0, 3, 7, 2,
            11, 99, 4, 1, 5, 6, 7, 8,
            22, second_device, 4, 0, 0, 3, 11, 3,
        ];
        words[..packet.len()].copy_from_slice(&packet);
        (packet.len() * 4) as u32
    }

    unsafe fn prepare_arena() {
        set_guest_mem(GuestMem { read_block: read_guest });
        d3d9_reset_frame();
        wr_u32(OFF_VS_HANDLE, 1);
        wr_u32(OFF_PS_HANDLE, 1);
        *(arena_ptr().add(OFF_SHADER_CONST_LEN_VS + 2).cast::<u16>()) = 32;
        *(arena_ptr().add(OFF_SHADER_CONST_LEN_PS + 2).cast::<u16>()) = 4;
        wr_u32(OFF_STREAM_SOURCE, 10);
        wr_u32(OFF_STREAM_SOURCE + 4, 0);
        wr_u32(OFF_STREAM_SOURCE + 8, 32);
        wr_u32(OFF_INDEX_BUFFER, 20);
        wr_u32(OFF_INDEX_BUFFER + 4, 16);
    }

    #[test]
    fn wbuf_indexed_run_is_atomic_and_captures_each_constant_value() {
        let _guard = TEST_LOCK.lock().unwrap();
        unsafe {
            prepare_arena();
            let len = install_run(99);
            assert_eq!(d3d9_record_wbuf_indexed_run(GUEST_BASE, len, 11, 22, 99, 32, 0, 0, 0), 2);
            assert_eq!(rd_u32(OFF_COMMAND_COUNT), 8);
            assert_eq!(rd_u32(OFF_CMD_TYPES + 4 * 4), CMD_DRAW_INDEXED);
            assert_eq!(rd_u32(OFF_CMD_A + 4 * 4), 6);
            assert_eq!(rd_u32(OFF_CMD_B + 4 * 4), 7);
            assert_eq!(rd_u32(OFF_CMD_TYPES + 7 * 4), CMD_DRAW_INDEXED);
            assert_eq!(rd_u32(OFF_CMD_A + 7 * 4), 9);
            assert_eq!(rd_u32(OFF_CMD_B + 7 * 4), 11);
            assert_eq!(rd_u32(OFF_VS_CONSTANTS + 16 * 4), 5);
            let first_state = rd_u32(OFF_CMD_B + 2 * 4) as usize;
            assert_eq!(rd_u32(OFF_BUMP_ARENA + first_state + DRAW_STATE_HEADER_LEN + 16 * 4), 1);
        }
    }

    #[test]
    fn malformed_wbuf_run_declines_without_mutation() {
        let _guard = TEST_LOCK.lock().unwrap();
        unsafe {
            prepare_arena();
            wr_u32(OFF_VS_CONSTANTS + 16 * 4, 0xdead_beef);
            let len = install_run(100);
            let command_before = rd_u32(OFF_COMMAND_COUNT);
            let bump_before = rd_u32(OFF_BUMP_CURSOR);
            assert_eq!(d3d9_record_wbuf_indexed_run(GUEST_BASE, len, 11, 22, 99, 32, 0, 0, 0), -1);
            assert_eq!(rd_u32(OFF_COMMAND_COUNT), command_before);
            assert_eq!(rd_u32(OFF_BUMP_CURSOR), bump_before);
            assert_eq!(rd_u32(OFF_VS_CONSTANTS + 16 * 4), 0xdead_beef);
        }
    }

    #[test]
    fn truncated_wbuf_constant_payload_declines_without_panicking_or_mutation() {
        let _guard = TEST_LOCK.lock().unwrap();
        unsafe {
            prepare_arena();
            let words = std::slice::from_raw_parts_mut(
                addr_of_mut!(GUEST).cast::<u32>(), 4096 / 4,
            );
            // vec_count=256 is valid against the 1024-float VS bank, but the packet ends
            // immediately after its header. Validation must reject before advancing `at`.
            words[..4].copy_from_slice(&[11, 99, 0, 256]);
            wr_u32(OFF_VS_CONSTANTS, 0xdead_beef);
            let command_before = rd_u32(OFF_COMMAND_COUNT);
            let bump_before = rd_u32(OFF_BUMP_CURSOR);
            assert_eq!(
                d3d9_record_wbuf_indexed_run(GUEST_BASE, 16, 11, 22, 99, 32, 0, 0, 0),
                -1,
            );
            assert_eq!(rd_u32(OFF_COMMAND_COUNT), command_before);
            assert_eq!(rd_u32(OFF_BUMP_CURSOR), bump_before);
            assert_eq!(rd_u32(OFF_VS_CONSTANTS), 0xdead_beef);
        }
    }

    #[test]
    fn compact_wbuf_run_emits_sparse_payload_without_draw_rows() {
        let _guard = TEST_LOCK.lock().unwrap();
        unsafe {
            prepare_arena();
            let len = install_run(99);
            let words = std::slice::from_raw_parts_mut(
                addr_of_mut!(GUEST).cast::<u32>(), 4096 / 4,
            );
            // Compact physical instancing requires the geometry tuple to be identical.
            words[30] = 7;
            words[31] = 2;
            assert_eq!(
                d3d9_record_wbuf_indexed_run(
                    GUEST_BASE, len, 11, 22, 99, 32, 0, 2, 64,
                ),
                2,
            );
            assert_eq!(rd_u32(OFF_COMMAND_COUNT), 0);
            let offset = d3d9_get_last_wbuf_compact_offset();
            assert!(offset >= 0);
            let header = OFF_BUMP_ARENA + offset as usize;
            assert_eq!(rd_u32(header), COMPACT_RUN_MAGIC_SPARSE);
            assert_eq!(rd_u32(header + 4), 2);
            assert_eq!(rd_u32(header + 8), 4);
            assert_eq!(rd_u32(header + 12), 4);
            assert_eq!(rd_u32(header + 20), 8);
            assert_eq!(rd_u32(header + 24), 6);
            let payload = rd_u32(header + 16) as usize;
            assert_eq!(rd_u32(OFF_BUMP_ARENA + payload), 1);
            assert_eq!(rd_u32(OFF_BUMP_ARENA + payload + 4 * 4), 5);
            assert_eq!(rd_u32(OFF_VS_CONSTANTS + 16 * 4), 5);
        }
    }

    #[test]
    fn storage_ready_compact_run_expands_template_in_rust() {
        let _guard = TEST_LOCK.lock().unwrap();
        unsafe {
            prepare_arena();
            let len = install_run(99);
            let words = std::slice::from_raw_parts_mut(
                addr_of_mut!(GUEST).cast::<u32>(), 4096 / 4,
            );
            words[30] = 7;
            words[31] = 2;
            for word in 0..24 {
                COMPACT_RUN_TEMPLATE[word] = 100 + word as u32;
            }
            assert_eq!(d3d9_set_compact_template_words(24), 24);
            assert_eq!(
                d3d9_record_wbuf_indexed_run(
                    GUEST_BASE, len, 11, 22, 99, 32, 0, 3, 64,
                ),
                2,
            );
            let header = OFF_BUMP_ARENA + d3d9_get_last_wbuf_compact_offset() as usize;
            assert_eq!(rd_u32(header), COMPACT_RUN_MAGIC_STORAGE);
            assert_eq!(rd_u32(header + 9 * 4), 24);
            let payload = rd_u32(header + 16) as usize;
            assert_eq!(rd_u32(OFF_BUMP_ARENA + payload), 100);
            assert_eq!(rd_u32(OFF_BUMP_ARENA + payload + 16 * 4), 1);
            assert_eq!(rd_u32(OFF_BUMP_ARENA + payload + (24 + 16) * 4), 5);
        }
    }
}
