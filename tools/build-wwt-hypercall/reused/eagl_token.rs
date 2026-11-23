// Original EAGL state-token routing, with WWT guest memory and counters.
use super::{u32_at, Guest};

struct EaglTokenCfg {
    token_table: i32,
    ring_ctrl: i32,
    ring_base: i32,
    capacity: i32,
    owner_global: i32,
    srs_fid: i32,
    srs_shadow: i32,
    srs_skip: i32,
    samp_fid: i32,
    samp_shadow: i32,
    samp_skip: i32,
    tss_fid: i32,
    fvf_fid: i32,
    svs_fid: i32,
    sps_fid: i32,
    vscf_fid: i32,
    pscf_fid: i32,
    tex_fid: i32,
}

impl EaglTokenCfg {
    unsafe fn read(guest: Guest, addr: u32) -> Option<Self> {
        if !guest.span(addr, 0x54, false) {
            return None;
        }
        let r = |offset: u32| u32_at(addr + offset) as i32;
        if !matches!(r(0), 2..=3) {
            return None;
        }
        let capacity = r(0x10);
        let ring_base = r(0x0c);
        let ring_ctrl = r(0x08);
        if !(64..=0x80000).contains(&capacity)
            || (ring_base as u32).checked_add(capacity as u32)? > guest.size
            || !guest.span(ring_ctrl as u32, 4, true)
        {
            return None;
        }
        Some(Self {
            token_table: r(0x04),
            ring_ctrl,
            ring_base,
            capacity,
            owner_global: r(0x14),
            srs_fid: r(0x18),
            srs_shadow: r(0x1c),
            srs_skip: r(0x20),
            samp_fid: r(0x24),
            samp_shadow: r(0x28),
            samp_skip: r(0x2c),
            tss_fid: r(0x30),
            fvf_fid: r(0x3c),
            svs_fid: r(0x40),
            sps_fid: r(0x44),
            vscf_fid: r(0x48),
            pscf_fid: r(0x4c),
            tex_fid: r(0x50),
        })
    }
}

pub(super) unsafe fn dispatch(guest: Guest, page: u32) -> Option<u32> {
    let c = EaglTokenCfg::read(guest, u32_at(page + 0x1c54))?;
    let this_ctx = u32_at(guest.regs + 4) as i32;
    let node = guest.arg(0)? as i32;
    let mut stage = guest.arg(1)? as i32;
    if node == 0 {
        return None;
    }
    if stage == -1 {
        stage = guest.read_i32(node + 4).ok()?;
    }
    let mut n = node;
    let mut tok = guest.read_i32(n).ok()?;
    if tok == -1 {
        n = guest.read_i32(node + 0x64).ok()?;
        tok = guest.read_i32(n).ok()?;
    }
    let desc = guest
        .read_i32(c.token_table.wrapping_add(tok.wrapping_mul(0x1c)))
        .ok()? as u32;
    let class = desc >> 24;
    let dev = guest.read_i32(this_ctx + 8).ok()?;
    let vt = guest.read_i32(dev).ok()?;
    match class {
        1 | 2 | 8 => eagl_dispatch_simple(guest, &c, dev, vt, class, desc, stage, n).then_some(0),
        6 => eagl_dispatch_class6_batch(guest, &c, this_ctx, dev, vt, node, stage),
        _ => None,
    }
}

/// Single-pass hot path for classes 1/2/8 (~1M calls/s — every read counts).
unsafe fn eagl_dispatch_simple(
    guest: Guest,
    c: &EaglTokenCfg,
    dev: i32,
    vt: i32,
    class: u32,
    desc: u32,
    stage: i32,
    n: i32,
) -> bool {
    let d3d_enum = (desc & 0xff_ffff) as i32;
    // Value = node[0x1a] for all three classes.
    let value = match guest.read_i32(n + 0x68) {
        Ok(v) => v,
        Err(_) => return false,
    };

    // (vtable offset, expected funcId, shadow table/skip addr, shadow slot key, argc)
    let (vt_off, expect_fid, shadow_base, skip_addr, slot, argc): (i32, i32, i32, i32, i32, i32) =
        match class {
            1 => (
                0xe4,
                c.srs_fid,
                c.srs_shadow,
                c.srs_skip,
                if (d3d_enum as u32) < 256 {
                    d3d_enum
                } else {
                    -1
                },
                3,
            ),
            2 => (0x10c, c.tss_fid, 0, 0, -1, 4),
            8 => (
                0x114,
                c.samp_fid,
                c.samp_shadow,
                c.samp_skip,
                if (stage as u32) < 16 && (d3d_enum as u32) < 16 {
                    (stage << 4) | d3d_enum
                } else {
                    -1
                },
                4,
            ),
            _ => return false,
        };

    // Perform the virtual call — but only for the KNOWN callee shape: our WBUF
    // setter stub starts `B8 <funcId:u32>`. Anything else (proxied device,
    // unpatched setter) → the JS tier / original.
    let fid = match eagl_stub_fid(guest, vt, vt_off, expect_fid) {
        Ok(v) => v,
        Err(_) => return false,
    };

    // Ring capacity gate FIRST (before any shadow mutation): the trampoline's
    // .ovf path OUT-traps to the real setter thunk (drain-first) — replicated
    // by returning false so the JS tier (which runs after the standard
    // pre-dispatch drain) completes the call.
    let ring_ctrl = c.ring_ctrl;
    let head = match guest.read_i32(ring_ctrl) {
        Ok(v) => v,
        Err(_) => return false,
    };
    if head < 0 || head >= c.capacity - 36 {
        return false;
    }

    // Value shadow (same fold + owner gate as writeShadowTrampoline). Decide
    // the skip HERE, but defer the slot update until the ring-entry bytes are
    // written: a false-return between shadow-update and head-bump would lose
    // the set (JS retry would see value==shadow and skip a state change the
    // device never received). Entry bytes below the un-bumped head are
    // invisible, so this order makes every abort point safe.
    let mut shadow_slot_addr = 0i32;
    if shadow_base != 0 && slot >= 0 && c.owner_global != 0 {
        let owner = match guest.read_i32(c.owner_global) {
            Ok(v) => v,
            Err(_) => return false,
        };
        if owner == dev {
            let slot_addr = shadow_base + slot * 4;
            let cur = match guest.read_i32(slot_addr) {
                Ok(v) => v,
                Err(_) => return false,
            };
            if cur == value {
                // Redundant set: bump the skip counter, EAX = D3D_OK.
                if skip_addr != 0 {
                    let cnt = match guest.read_i32(skip_addr) {
                        Ok(v) => v,
                        Err(_) => return false,
                    };
                    if guest.write_i32(skip_addr, cnt.wrapping_add(1)).is_err() {
                        return false;
                    }
                }
                return true;
            }
            shadow_slot_addr = slot_addr;
        }
    }

    // Ring append: [funcId][dev][(stage)][enum][value], head += stride.
    let Some(entry) = ring_entry(guest, c, head, (argc + 1) * 4) else {
        return false;
    };
    if shadow_slot_addr != 0 && !guest.span(shadow_slot_addr as u32, 4, true) {
        return false;
    }
    if guest.write_i32(entry, fid).is_err() {
        return false;
    }
    if guest.write_i32(entry + 4, dev).is_err() {
        return false;
    }
    let ok = if argc == 3 {
        guest.write_i32(entry + 8, d3d_enum).is_ok() && guest.write_i32(entry + 12, value).is_ok()
    } else {
        guest.write_i32(entry + 8, stage).is_ok()
            && guest.write_i32(entry + 12, d3d_enum).is_ok()
            && guest.write_i32(entry + 16, value).is_ok()
    };
    if !ok {
        return false;
    }
    if shadow_slot_addr != 0 {
        if guest.write_i32(shadow_slot_addr, value).is_err() {
            return false;
        }
    }
    if guest.write_i32(ring_ctrl, head + (argc + 1) * 4).is_err() {
        return false;
    }
    true
}

// --- class-6 batch engine (scan-then-commit) -------------------------------

/// D3D9 device vtable offsets used by the batch paths (standard
/// IDirect3DDevice9 layout, RE-verified against the guest jump table).
const VT_SET_TEXTURE: i32 = 0x104;
const VT_SET_FVF: i32 = 0x164;
const VT_SET_VERTEX_SHADER: i32 = 0x170;
const VT_SET_VS_CONST_F: i32 = 0x178;
const VT_SET_PIXEL_SHADER: i32 = 0x1ac;
const VT_SET_PS_CONST_F: i32 = 0x1b4;

/// EAGL's abort HRESULT (-0x7fffbffb = E_FAIL) — returned by the guest when a
/// shader record is unbound or a pixel default-constant entry has an unknown
/// type. Guest-visible; must be replicated bit-exact.
const EAGL_E_FAIL: i32 = 0x80004005u32 as i32;

/// Ring cursor for the two-pass class-6 walk. The scan pass bumps `head`
/// without writing (every potential append counted — shadow skips are decided
/// only at commit, so the scan total is a safe upper bound for the room
/// check); the commit pass writes entry bytes at `head` and then bumps.
/// The guest-visible ring head (cfg ringCtrl) is written ONCE, after the
/// commit walk finishes — entry bytes above the un-bumped head are invisible,
/// so every abort point leaves a consistent ring.
struct EaglPass {
    commit: bool,

    head: i32,
    /// Scan-side model of guest-visible cell writes made earlier in the SAME
    /// crossing (shadow slots, dirty flags, entry statuses, header bits):
    /// the scan performs NO guest writes, so any read of a cell the crossing
    /// already "wrote" must come from this model or the scan diverges from
    /// the commit replay (e.g. the walk sets `node[10] |= 1` and the same
    /// node's cdca7 tail tests that bit). 64 slots covers observed crossings;
    /// overflow sets model_ovf (callers decline or degrade to upper bounds).
    model_addr: [i32; 64],
    model_val: [i32; 64],
    model_n: usize,
    model_ovf: bool,
}

impl EaglPass {
    fn new(commit: bool, head: i32) -> EaglPass {
        EaglPass {
            commit,
            head,
            model_addr: [0; 64],
            model_val: [0; 64],
            model_n: 0,
            model_ovf: false,
        }
    }
    fn model_get(&self, addr: i32) -> Option<i32> {
        for i in 0..self.model_n {
            if unsafe { *self.model_addr.as_ptr().add(i) } == addr {
                return Some(unsafe { *self.model_val.as_ptr().add(i) });
            }
        }
        None
    }
    fn model_put(&mut self, addr: i32, val: i32) {
        for i in 0..self.model_n {
            if unsafe { *self.model_addr.as_ptr().add(i) } == addr {
                unsafe {
                    *self.model_val.as_mut_ptr().add(i) = val;
                }
                return;
            }
        }
        if self.model_n < 64 {
            unsafe {
                *self.model_addr.as_mut_ptr().add(self.model_n) = addr;
                *self.model_val.as_mut_ptr().add(self.model_n) = val;
            }
            self.model_n += 1;
        } else {
            self.model_ovf = true;
        }
    }
}

unsafe fn ring_entry(guest: Guest, cfg: &EaglTokenCfg, head: i32, size: i32) -> Option<i32> {
    if head < 0 || head.checked_add(size)? > cfg.capacity {
        return None;
    }
    let entry = (cfg.ring_base as u32).checked_add(head as u32)?;
    guest.span(entry, size as u32, true).then_some(entry as i32)
}

/// Resolve a device vtable slot and require the KNOWN callee shape: our WBUF
/// setter stub `B8 <funcId:u32>` with the expected id. Err = decline.
unsafe fn eagl_stub_fid(guest: Guest, vt: i32, vt_off: i32, expect_fid: i32) -> Result<i32, ()> {
    let target = guest.read_i32(vt + vt_off).map_err(|_| ())?;
    if guest.read_i8(target).map_err(|_| ())? != 0xB8 {
        return Err(());
    }
    let fid = guest.read_i32(target + 1).map_err(|_| ())?;
    if fid != expect_fid || fid == 0 {
        return Err(());
    }
    Ok(fid)
}

/// Class 1/2/8 state set inside a class-6 batch (sub-pass recursion), in
/// two-pass form: scan validates and reserves ring room; commit replicates
/// the shadow compare/skip/update + ring append of the single-pass path.
unsafe fn eagl_emit_state(
    guest: Guest,
    c: &EaglTokenCfg,
    dev: i32,
    vt: i32,
    class: u32,
    d3d_enum: i32,
    stage: i32,
    value: i32,
    p: &mut EaglPass,
) -> Result<(), ()> {
    let (vt_off, expect_fid, shadow_base, skip_addr, slot, argc): (i32, i32, i32, i32, i32, i32) =
        match class {
            1 => (
                0xe4,
                c.srs_fid,
                c.srs_shadow,
                c.srs_skip,
                if (d3d_enum as u32) < 256 {
                    d3d_enum
                } else {
                    -1
                },
                3,
            ),
            2 => (0x10c, c.tss_fid, 0, 0, -1, 4),
            8 => (
                0x114,
                c.samp_fid,
                c.samp_shadow,
                c.samp_skip,
                if (stage as u32) < 16 && (d3d_enum as u32) < 16 {
                    (stage << 4) | d3d_enum
                } else {
                    -1
                },
                4,
            ),
            _ => return Err(()),
        };
    let fid = eagl_stub_fid(guest, vt, vt_off, expect_fid)?;

    let mut shadow_slot_addr = 0i32;
    if shadow_base != 0 && slot >= 0 && c.owner_global != 0 {
        let owner = guest.read_i32(c.owner_global).map_err(|_| ())?;
        if owner == dev {
            let slot_addr = shadow_base + slot * 4;
            // Scan consults its local model first so earlier same-crossing
            // writes are seen (exact skip decisions → exact head prediction);
            // commit reads the real slot (its own writes ARE the model).
            let cur = match if p.commit {
                None
            } else {
                p.model_get(slot_addr)
            } {
                Some(v) => v,
                None => guest.read_i32(slot_addr).map_err(|_| ())?,
            };
            // Post-overflow the scan's view may miss an untracked earlier
            // write — stop skipping (over-reserve is safe, under-reserve is
            // not); commit always decides on real state.
            if cur == value && (p.commit || !p.model_ovf) {
                if skip_addr != 0 {
                    if !guest.span(skip_addr as u32, 4, true) {
                        return Err(());
                    }
                    if p.commit {
                        let cnt = guest.read_i32(skip_addr)?;
                        guest.write_i32(skip_addr, cnt.wrapping_add(1))?;
                    }
                }
                return Ok(());
            }
            shadow_slot_addr = slot_addr;
        }
    }
    if shadow_slot_addr != 0 {
        if !guest.span(shadow_slot_addr as u32, 4, true) {
            return Err(());
        }
        if !p.commit {
            p.model_put(shadow_slot_addr, value);
        }
    }

    let entry = ring_entry(guest, c, p.head, (argc + 1) * 4).ok_or(())?;
    if p.commit {
        guest.write_i32(entry, fid).map_err(|_| ())?;
        guest.write_i32(entry + 4, dev).map_err(|_| ())?;
        if argc == 3 {
            guest.write_i32(entry + 8, d3d_enum).map_err(|_| ())?;
            guest.write_i32(entry + 12, value).map_err(|_| ())?;
        } else {
            guest.write_i32(entry + 8, stage).map_err(|_| ())?;
            guest.write_i32(entry + 12, d3d_enum).map_err(|_| ())?;
            guest.write_i32(entry + 16, value).map_err(|_| ())?;
        }
        if shadow_slot_addr != 0 {
            guest.write_i32(shadow_slot_addr, value).map_err(|_| ())?;
        }
    }
    p.head += (argc + 1) * 4;
    Ok(())
}

/// Plain 2-arg ring entry (SetFVF / SetVertexShader / SetPixelShader):
/// [funcId][dev][value]. SetVertexShader/SetPixelShader carry the raw guest
/// COM pointer — the drain handler resolves it, same as the trampoline path.
unsafe fn eagl_emit_2arg(
    guest: Guest,
    c: &EaglTokenCfg,
    vt: i32,
    vt_off: i32,
    expect_fid: i32,
    dev: i32,
    value: i32,
    p: &mut EaglPass,
) -> Result<(), ()> {
    let fid = eagl_stub_fid(guest, vt, vt_off, expect_fid)?;
    let entry = ring_entry(guest, c, p.head, 12).ok_or(())?;
    if p.commit {
        guest.write_i32(entry, fid).map_err(|_| ())?;
        guest.write_i32(entry + 4, dev).map_err(|_| ())?;
        guest.write_i32(entry + 8, value).map_err(|_| ())?;
    }
    p.head += 12;
    Ok(())
}

/// Shader-constant-F ring entry with inline payload capture:
/// [funcId][dev][startReg][vec4Count][vec4Count×4 dwords] — same layout the
/// shader-constant trampoline emits and getWbufEntryStride expects (count
/// 1..=256; a zero-count call is a device no-op the guest also makes, so it
/// is skipped rather than appended).
unsafe fn eagl_emit_const_f(
    guest: Guest,
    c: &EaglTokenCfg,
    vt: i32,
    pix: bool,
    dev: i32,
    start_reg: i32,
    src: i32,
    cnt: i32,
    p: &mut EaglPass,
) -> Result<(), ()> {
    if cnt < 0 || cnt > 256 {
        return Err(());
    }
    if cnt == 0 {
        return Ok(());
    }
    let (vt_off, expect_fid) = if pix {
        (VT_SET_PS_CONST_F, c.pscf_fid)
    } else {
        (VT_SET_VS_CONST_F, c.vscf_fid)
    };
    let fid = eagl_stub_fid(guest, vt, vt_off, expect_fid)?;
    let bytes = cnt * 16;
    let entry = ring_entry(guest, c, p.head, 16 + bytes).ok_or(())?;
    if !p.commit {
        // Payload readability: ≤4KB spans at most two pages — first and last
        // dword touch both. The commit pass then reads every dword safely.
        guest.read_i32(src).map_err(|_| ())?;
        guest
            .read_i32(src.wrapping_add(bytes - 4))
            .map_err(|_| ())?;
    } else {
        guest.write_i32(entry, fid).map_err(|_| ())?;
        guest.write_i32(entry + 4, dev).map_err(|_| ())?;
        guest.write_i32(entry + 8, start_reg).map_err(|_| ())?;
        guest.write_i32(entry + 12, cnt).map_err(|_| ())?;
        for i in 0..cnt * 4 {
            let v = guest.read_i32(src.wrapping_add(i * 4)).map_err(|_| ())?;
            guest.write_i32(entry + 16 + i * 4, v).map_err(|_| ())?;
        }
    }
    p.head += 16 + bytes;
    Ok(())
}

/// Full FUN_005c97cb token dispatch inside a batch (top-level class-6 call or
/// a type-3 sub-pass recursion element). Replicates the entry semantics
/// (stage -1 → raw node[1], *node == -1 → alias at node[0x19]), then the
/// class switch. Ok(hr) = guest-visible result; Err = decline the WHOLE
/// top-level call (scan pass only — the ring is untouched).
unsafe fn eagl_dispatch_token(
    guest: Guest,
    c: &EaglTokenCfg,
    ctx: i32,
    mode: i32,
    dev: i32,
    vt: i32,
    node: i32,
    stage_in: i32,
    depth: u32,
    p: &mut EaglPass,
) -> Result<i32, ()> {
    if node == 0 {
        return Err(());
    }
    let mut stage = stage_in;
    if stage == -1 {
        stage = guest.read_i32(node + 4).map_err(|_| ())?;
    }
    let mut n = node;
    let mut tok = guest.read_i32(n).map_err(|_| ())?;
    if tok == -1 {
        n = guest.read_i32(node + 0x64).map_err(|_| ())?;
        tok = guest.read_i32(n).map_err(|_| ())?;
    }
    let desc = guest
        .read_i32(c.token_table.wrapping_add(tok.wrapping_mul(0x1c)))
        .map_err(|_| ())? as u32;
    match desc >> 24 {
        cls @ (1 | 2 | 8) => {
            let value = guest.read_i32(n + 0x68).map_err(|_| ())?;
            eagl_emit_state(
                guest,
                c,
                dev,
                vt,
                cls,
                (desc & 0xff_ffff) as i32,
                stage,
                value,
                p,
            )?;
            Ok(0)
        }
        5 => eagl_class5_texture(guest, c, ctx, mode, dev, vt, n, stage, p),
        6 => eagl_class6(guest, c, ctx, mode, dev, vt, n, desc, stage, depth, p),
        // Lights/material/misc: real staging-struct writes we do not
        // replicate — decline the whole batch.
        3 | 4 | 7 | 9 | 10 => Err(()),
        // Original's switch default: no side effects, returns 0.
        _ => Ok(0),
    }
}

/// The class-6 case body (guest 0x5c9b15..): SetFVF, direct shader-constant
/// sets, vs/ps bind + default-constant walk + type-3 recursion. Token
/// sub-ids and their exact guest routing are transcribed from the decompile
/// (the 0x60001xx-0x60004xx chain collapses to the two constant-F sets).
unsafe fn eagl_class6(
    guest: Guest,
    c: &EaglTokenCfg,
    ctx: i32,
    mode: i32,
    dev: i32,
    vt: i32,
    n: i32,
    desc: u32,
    stage: i32,
    depth: u32,
    p: &mut EaglPass,
) -> Result<i32, ()> {
    // Mode 2 = state-block record: every device call must go through the real
    // BeginStateBlock path, not the ring. The guest filter already routes
    // mode-2 calls to the original; this is the backstop.

    if mode == 2 {
        return Err(());
    }
    if desc == 0x6000008 {
        // SetFVF — the one class-6 token that also runs in mode 1 (degraded
        // mode forces FVF = 2 = D3DFVF_XYZ).
        let mut value = guest.read_i32(n + 0x68).map_err(|_| ())?;
        if mode == 1 {
            value = 2;
        }
        eagl_emit_2arg(guest, c, vt, VT_SET_FVF, c.fvf_fid, dev, value, p)?;
        return Ok(0);
    }
    if mode == 1 {
        // Degraded/FFP mode defers all other shader tokens — no side effects.
        return Ok(0);
    }
    match desc {
        // Direct constant-F uploads: (dev, stage, node[0x13] = data ptr,
        // node[0x2a] = vec4 count).
        0x6000002 | 0x6000102 | 0x6000202 | 0x6000302 | 0x6000402 => {
            let src = guest.read_i32(n + 0x4c).map_err(|_| ())?;
            let cnt = guest.read_i32(n + 0xa8).map_err(|_| ())?;
            eagl_emit_const_f(guest, c, vt, false, dev, stage, src, cnt, p)?;
            Ok(0)
        }
        0x6000005 | 0x6000105 | 0x6000205 | 0x6000305 | 0x6000405 => {
            let src = guest.read_i32(n + 0x4c).map_err(|_| ())?;
            let cnt = guest.read_i32(n + 0xa8).map_err(|_| ())?;
            eagl_emit_const_f(guest, c, vt, true, dev, stage, src, cnt, p)?;
            Ok(0)
        }
        // Integer/bool constant sets: no WBUF registration for the I/B
        // setters — the original handles these (rare) tokens.
        0x6000003 | 0x6000004 | 0x6000006 | 0x6000007 => Err(()),
        0x6000000 => eagl_class6_bind(guest, c, ctx, mode, dev, vt, n, false, depth, p),
        0x6000001 => eagl_class6_bind(guest, c, ctx, mode, dev, vt, n, true, depth, p),
        // Original's inner default: no side effects, returns 0.
        _ => Ok(0),
    }
}

/// The vs (0x6000000) / ps (0x6000001) bind path: resolve the shader resource
/// record through the ctx handle tables, bind the program, upload its
/// default-constant table, and (pixel only) recurse into type-3 sub-pass
/// arrays. Transcription notes (decompile, `re decompile 0x5c97cb`):
///   record   = *(ctx+0x24) + idx*0x1c, idx via *(ctx+0x8c)[node[3]] tables
///   rec+0x04 = shader COM pointer (SetVertexShader/SetPixelShader arg)
///   rec+0x0c = bound flag — 0 → return E_FAIL (before any device call)
///   rec+0x14 = default-constant table: count @+0xc, entries @ +(*(+0x10))+6,
///              stride 20 bytes: u16 type @-2, u16 reg @0, u16 vec4Count @+2
///   rec+0x18 → header ptr; *(hdr+0x44) = payload block: F data at +8+reg*16
///              (type 2); type 1 = int4, type 0 = bool — no WBUF path, decline;
///              *(hdrPtr+0x30)[k] = type-3 sub-pass descriptor
///   vertex walk: unknown type silently skipped; pixel walk: unknown type
///   aborts with E_FAIL (guest LAB_005c9ab3) — both replicated exactly.
/// mode==2 (CreateVertexDeclaration path) never reaches here — declined at
/// eagl_class6 entry.
/// The shared ctx handle-table resolve (classes 5 and 6 bind use the exact
/// same chain): *(ctx+0x8c)[node[3]] → per-resource record → index (direct
/// or via the double-indirect table) → the 0x1c-stride record at ctx+0x24.
unsafe fn eagl_resolve_record(guest: Guest, ctx: i32, n: i32) -> Result<i32, ()> {
    let page_tbl = guest.read_i32(ctx + 0x8c).map_err(|_| ())?;
    let nid = guest.read_i32(n + 0xc).map_err(|_| ())?;
    let r = guest
        .read_i32(page_tbl.wrapping_add(nid.wrapping_mul(4)))
        .map_err(|_| ())?;
    let t = guest.read_i32(r + 0x38).map_err(|_| ())?;
    let a = guest
        .read_i32(r + 0x28)
        .map_err(|_| ())?
        .wrapping_add(guest.read_i32(n + 0x14).map_err(|_| ())?);
    let idx = if t == 0 {
        let off = guest.read_i32(ctx + 0x2c).map_err(|_| ())?;
        guest.read_i32(a.wrapping_add(off)).map_err(|_| ())?
    } else {
        let inner_off = guest
            .read_i32(guest.read_i32(ctx + 0xc).map_err(|_| ())? + 8)
            .map_err(|_| ())?;
        let inner = guest.read_i32(a.wrapping_add(inner_off)).map_err(|_| ())?;
        guest
            .read_i32(
                guest
                    .read_i32(t + 8)
                    .map_err(|_| ())?
                    .wrapping_add(inner.wrapping_mul(4)),
            )
            .map_err(|_| ())?
    };
    Ok(idx
        .wrapping_mul(0x1c)
        .wrapping_add(guest.read_i32(ctx + 0x24).map_err(|_| ())?))
}

/// Class 5 — SetTexture (guest case 5, non-record mode): resolve the texture
/// record, ring-append SetTexture(dev, stage, *(rec+4)). The mode-2 branch
/// (GetDeviceCaps format validation) never reaches here — the whole batch is
/// gated on mode != 2.
unsafe fn eagl_class5_texture(
    guest: Guest,
    c: &EaglTokenCfg,
    ctx: i32,
    mode: i32,
    dev: i32,
    vt: i32,
    n: i32,
    stage: i32,
    p: &mut EaglPass,
) -> Result<i32, ()> {
    if mode == 2 || c.tex_fid == 0 {
        return Err(());
    }
    let rec = eagl_resolve_record(guest, ctx, n)?;
    let value = guest.read_i32(rec + 4).map_err(|_| ())?;
    let fid = eagl_stub_fid(guest, vt, VT_SET_TEXTURE, c.tex_fid)?;
    let entry = ring_entry(guest, c, p.head, 16).ok_or(())?;
    if p.commit {
        guest.write_i32(entry, fid).map_err(|_| ())?;
        guest.write_i32(entry + 4, dev).map_err(|_| ())?;
        guest.write_i32(entry + 8, stage).map_err(|_| ())?;
        guest.write_i32(entry + 12, value).map_err(|_| ())?;
    }
    p.head += 16;
    Ok(0)
}

unsafe fn eagl_class6_bind(
    guest: Guest,
    c: &EaglTokenCfg,
    ctx: i32,
    mode: i32,
    dev: i32,
    vt: i32,
    n: i32,
    pix: bool,
    depth: u32,
    p: &mut EaglPass,
) -> Result<i32, ()> {
    let rec = eagl_resolve_record(guest, ctx, n)?;
    if guest.read_i32(rec + 0xc).map_err(|_| ())? == 0 {
        // Unbound shader record: guest returns E_FAIL before any device call.
        return Ok(EAGL_E_FAIL);
    }
    let handle = guest.read_i32(rec + 4).map_err(|_| ())?;
    if pix {
        eagl_emit_2arg(guest, c, vt, VT_SET_PIXEL_SHADER, c.sps_fid, dev, handle, p)?;
    } else {
        eagl_emit_2arg(
            guest,
            c,
            vt,
            VT_SET_VERTEX_SHADER,
            c.svs_fid,
            dev,
            handle,
            p,
        )?;
    }

    let ct = guest.read_i32(rec + 0x14).map_err(|_| ())?;
    if ct == 0 {
        return Ok(0);
    }
    let hdr_ptr = guest.read_i32(rec + 0x18).map_err(|_| ())?;
    let hdr = guest.read_i32(hdr_ptr + 0x44).map_err(|_| ())?;
    let f_base = hdr.wrapping_add(8);
    let total = guest.read_i32(ct + 0xc).map_err(|_| ())?;
    if total as u32 > 1024 {
        return Err(());
    }
    let mut ep = ct
        .wrapping_add(guest.read_i32(ct + 0x10).map_err(|_| ())?)
        .wrapping_add(6);
    for k in 0..total {
        let typ = guest.read_i16(ep - 2).map_err(|_| ())?;
        let reg = guest.read_i16(ep).map_err(|_| ())?;
        let cn = guest.read_i16(ep + 2).map_err(|_| ())?;
        match typ {
            2 => {
                let src = f_base.wrapping_add(reg.wrapping_mul(16));
                eagl_emit_const_f(guest, c, vt, pix, dev, reg, src, cn, p)?;
            }
            // Types 0/1 = bool/int default constants — no WBUF registration.
            0 | 1 => return Err(()),
            3 if pix => {
                // Sub-pass recursion (the 0xac-stride array): one nesting
                // level is all the content uses — decline anything deeper.
                if depth != 0 {
                    return Err(());
                }
                let sub_arr = guest.read_i32(hdr_ptr + 0x30).map_err(|_| ())?;
                let sub = guest
                    .read_i32(sub_arr.wrapping_add(k.wrapping_mul(4)))
                    .map_err(|_| ())?;
                if sub != 0 {
                    let pass_id = guest
                        .read_i32(guest.read_i32(sub + 4).map_err(|_| ())? + 4)
                        .map_err(|_| ())?;
                    let page_tbl = guest.read_i32(ctx + 0x8c).map_err(|_| ())?;
                    let pr = guest
                        .read_i32(page_tbl.wrapping_add(pass_id.wrapping_mul(4)))
                        .map_err(|_| ())?;
                    let m = guest.read_i32(pr + 0x3c).map_err(|_| ())?;
                    if m as u32 > 256 {
                        return Err(());
                    }
                    let base = guest.read_i32(pr + 0x40).map_err(|_| ())?;
                    for i in 0..m {
                        let sub_node = base.wrapping_add(i.wrapping_mul(0xac));
                        let hr = eagl_dispatch_token(
                            guest,
                            c,
                            ctx,
                            mode,
                            dev,
                            vt,
                            sub_node,
                            reg,
                            depth + 1,
                            p,
                        )?;
                        if hr < 0 {
                            // Guest aborts the whole commit on a negative
                            // sub-result — partial device calls stand.
                            return Ok(hr);
                        }
                    }
                }
            }
            _ => {
                if pix {
                    // Pixel walk: unknown entry type aborts with E_FAIL after
                    // the calls made so far (guest LAB_005c9ab3).
                    return Ok(EAGL_E_FAIL);
                }
                // Vertex walk: unknown entry type is silently skipped.
            }
        }
        ep = ep.wrapping_add(20);
    }
    Ok(0)
}

/// Top-level class-6 entry: scan (no side effects, any doubt → decline to the
/// JS tier / original), room check, then commit. The guest-visible ring head
/// is published once, after the commit walk completes or aborts — every
/// intermediate state is invisible to the drain.
unsafe fn eagl_dispatch_class6_batch(
    guest: Guest,
    c: &EaglTokenCfg,
    ctx: i32,
    dev: i32,
    vt: i32,
    node: i32,
    stage: i32,
) -> Option<u32> {
    let mode = match guest.read_i32(ctx + 0x84) {
        Ok(v) => v,
        Err(_) => return None,
    };
    if mode == 2 {
        return None;
    }
    let head0 = match guest.read_i32(c.ring_ctrl) {
        Ok(v) => v,
        Err(_) => return None,
    };
    if head0 < 0 || head0 > c.capacity {
        return None;
    }
    let mut scan = EaglPass::new(false, head0);
    let hr = match eagl_dispatch_token(guest, c, ctx, mode, dev, vt, node, stage, 0, &mut scan) {
        Ok(v) => v,
        Err(_) => return None,
    };
    // Room for the whole batch plus slack; otherwise let the JS tier complete
    // via the original (its trampolines drain through the .ovf path).
    if scan.head > c.capacity - 64 {
        return None;
    }
    let mut com = EaglPass::new(true, head0);
    // The commit pass repeats exactly the scan's reads (no guest code ran in
    // between) and writes only to our own RW structures — an Err here is
    // effectively unreachable; fall back to the scan's hr with whatever
    // entries fully committed (head tracks complete entries only).
    let hr =
        eagl_dispatch_token(guest, c, ctx, mode, dev, vt, node, stage, 0, &mut com).unwrap_or(hr);
    if guest.write_i32(c.ring_ctrl, com.head).is_err() {
        return None;
    }
    Some(hr as u32)
}
