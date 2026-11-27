// EAGL parameter apply walkers extracted from hypercall_eagl.rs. The conversion
// and cursor rules are unchanged. The execution backend supplies guest accesses.
use super::{ftol_low32, Guest};

// --- EAGL shader-parameter APPLY converter family (handlers 129-131) ------

#[derive(Clone, Copy, PartialEq)]
enum ApplyFamily {
    /// FUN_005c85c1: 1 = i32→f32 (FILD/FSTP), 2 = u32→f32 (+2^32 correction),
    /// 3 = f32 copy (FLD/FSTP float).
    Int,
    /// FUN_005c8303 / FUN_005cad01: 1|2 = raw u32 copy (MOV), 3 = f32→i32
    /// via CRT _ftol (truncate; NaN/overflow → low32 = 0).
    Float,
}

#[derive(Clone, Copy, PartialEq)]
enum ApplyLayout {
    /// Budget counts 4-float registers; dst advances ceil(rows/4)*16 per column.
    Register,
    /// Budget counts elements; dst advances n*4 per column (FUN_005cad01).
    Packed,
}

const APPLY_E_FAIL: i32 = 0x80004005u32 as i32; // -0x7fffbffb
const APPLY_MAX_DEPTH: u32 = 8;

/// handler_id 129/130/131 — semantically identical to the JS kernels in
/// `hle-lib/libs/eagl/apply-kernels.ts` (RE-verified, unit-tested against a
/// decompilation-transcribed reference). ABI: stdcall ret 0x10, four BY-REF
/// args at [esp+4..]: desc**, src**, dst**, budget*. Any structural doubt
/// (unmapped memory, insane dims, over-deep nesting) restores the four cursor
/// cells to their entry values and returns false — the JS kernel re-runs the
/// whole call from clean cursors (its writes are a superset of any partial
/// WASM-side writes, so the retry converges).
pub(super) unsafe fn dispatch_apply(guest: Guest, id: u8) -> Option<u32> {
    let (family, layout) = match id {
        129 => (ApplyFamily::Int, ApplyLayout::Register),
        130 => (ApplyFamily::Float, ApplyLayout::Register),
        131 => (ApplyFamily::Float, ApplyLayout::Packed),
        _ => return None,
    };
    let desc_cur = guest.arg(0)? as i32;
    let src_cur = guest.arg(1)? as i32;
    let dst_cur = guest.arg(2)? as i32;
    let budget = guest.arg(3)? as i32;

    // The cells must also be writable so the rollback cannot be interrupted.
    if !guest.span(desc_cur as u32, 4, true)
        || !guest.span(src_cur as u32, 4, true)
        || !guest.span(dst_cur as u32, 4, true)
        || !guest.span(budget as u32, 4, true)
    {
        return None;
    }
    // Entry snapshot of the by-ref cells for clean fall-through on abort.
    let d0 = match guest.read_i32(desc_cur) {
        Ok(v) => v,
        Err(_) => return None,
    };
    let s0 = match guest.read_i32(src_cur) {
        Ok(v) => v,
        Err(_) => return None,
    };
    let t0 = match guest.read_i32(dst_cur) {
        Ok(v) => v,
        Err(_) => return None,
    };
    let b0 = match guest.read_i32(budget) {
        Ok(v) => v,
        Err(_) => return None,
    };
    // Same sane envelope as the JS guard — beyond it, defer to the guest.
    if b0 as u32 > 4096 {
        return None;
    }

    match eagl_apply_walk(
        guest, family, layout, desc_cur, src_cur, dst_cur, budget, 0, true,
    ) {
        Ok(eax) => Some(eax as u32),
        Err(()) => {
            // Best-effort cursor restore; cells were readable at entry.
            let _ = guest.write_i32(desc_cur, d0);
            let _ = guest.write_i32(src_cur, s0);
            let _ = guest.write_i32(dst_cur, t0);
            let _ = guest.write_i32(budget, b0);
            None
        }
    }
}

/// The recursive walk. Err(()) = abort to JS (memory fault / insane shape);
/// Ok(eax) = completed with the guest-visible result (0 or E_FAIL).
///
/// `commit == false` is the phase-3 scan-pass DRY RUN: every read, bound
/// check and cursor-cell advance happens (the four cursor cells are cfg
/// scratch RAM on that path — our own structures), but the guest-visible DST
/// writes are suppressed, so a later decline leaves guest state pristine.
unsafe fn eagl_apply_walk(
    guest: Guest,
    family: ApplyFamily,
    layout: ApplyLayout,
    desc_cur: i32,
    src_cur: i32,
    dst_cur: i32,
    budget: i32,
    depth: u32,
    commit: bool,
) -> Result<i32, ()> {
    if depth > APPLY_MAX_DEPTH {
        return Err(());
    }
    let d = guest.read_i32(desc_cur).map_err(|_| ())?;
    let cls = guest.read_i32(d + 4).map_err(|_| ())?;
    let mut items = guest.read_i32(d + 0x10).map_err(|_| ())? as u32;
    if items == 0 {
        items = 1;
    }
    if items > 1024 {
        return Err(());
    }

    if cls >= 0 && cls <= 3 {
        let mode = guest.read_i32(d).map_err(|_| ())? as u32;
        let rows = guest.read_i32(d + 0x14).map_err(|_| ())? as u32;
        let cols = guest.read_i32(d + 0x18).map_err(|_| ())? as u32;
        if mode < 1 || mode > 3 {
            return Ok(APPLY_E_FAIL);
        }
        if rows > 64 || cols > 64 {
            return Err(());
        }

        // Sticky clamp state (the guest's spilled locals, set once per call).
        let mut regs = (rows >> 2) + ((rows & 3 != 0) as u32);
        let mut elems = rows;
        let mut n = rows;

        for _ in 0..items {
            if guest.read_i32(budget).map_err(|_| ())? == 0 {
                break;
            }
            let src_base = guest.read_i32(src_cur).map_err(|_| ())?;
            for j in 0..cols as i32 {
                let rem = guest.read_i32(budget).map_err(|_| ())? as u32;
                if rem == 0 {
                    break;
                }
                let (count, dst_step, budget_step) = match layout {
                    ApplyLayout::Register => {
                        if rem < regs {
                            elems = rem * 4;
                            regs = rem;
                        }
                        (elems, regs * 16, regs)
                    }
                    ApplyLayout::Packed => {
                        if rem < n {
                            n = rem;
                        }
                        (n, n * 4, n)
                    }
                };
                let dst_base = guest.read_i32(dst_cur).map_err(|_| ())?;
                for e in 0..count as i32 {
                    let s = src_base + (j + e * cols as i32) * 4;
                    let dst = dst_base + e * 4;
                    let sv = guest.read_i32(s).map_err(|_| ())?;
                    let out = match family {
                        ApplyFamily::Int => match mode {
                            1 => ((sv as f64) as f32).to_bits() as i32, // FILD i32 → FSTP f32
                            2 => ((sv as u32 as f64) as f32).to_bits() as i32, // u32 → f32 (FADD 2^32)
                            _ => ((f32::from_bits(sv as u32) as f64) as f32).to_bits() as i32, // FLD/FSTP
                        },
                        ApplyFamily::Float => match mode {
                            3 => ftol_low32(f32::from_bits(sv as u32) as f64) as i32, // _ftol
                            _ => sv,                                                  // MOV copy
                        },
                    };
                    if commit {
                        guest.write_i32(dst, out).map_err(|_| ())?;
                    } else {
                        let _ = out;
                    }
                }
                guest
                    .write_i32(dst_cur, dst_base.wrapping_add(dst_step as i32))
                    .map_err(|_| ())?;
                guest
                    .write_i32(budget, (rem - budget_step) as i32)
                    .map_err(|_| ())?;
            }
            guest
                .write_i32(src_cur, src_base.wrapping_add((cols * rows * 4) as i32))
                .map_err(|_| ())?;
        }
        guest
            .write_i32(desc_cur, d.wrapping_add(0x1c))
            .map_err(|_| ())?;
        return Ok(0);
    }

    if cls == 5 {
        let children = guest.read_i32(d + 0x14).map_err(|_| ())? as u32;
        if children > 64 {
            return Err(());
        }
        guest
            .write_i32(desc_cur, d.wrapping_add(0x18))
            .map_err(|_| ())?;
        let mut ret = 0i32;
        for _ in 0..items {
            if guest.read_i32(budget).map_err(|_| ())? == 0 {
                return Ok(ret);
            }
            guest
                .write_i32(desc_cur, d.wrapping_add(0x18))
                .map_err(|_| ())?;
            for _ in 0..children {
                if guest.read_i32(budget).map_err(|_| ())? == 0 {
                    break;
                }
                // FUN_005cad01's container recurses into the REGISTER-layout
                // float walk (FUN_005c8303); the other two into themselves.
                ret = match layout {
                    ApplyLayout::Packed => eagl_apply_walk(
                        guest,
                        ApplyFamily::Float,
                        ApplyLayout::Register,
                        desc_cur,
                        src_cur,
                        dst_cur,
                        budget,
                        depth + 1,
                        commit,
                    )?,
                    ApplyLayout::Register => eagl_apply_walk(
                        guest,
                        family,
                        layout,
                        desc_cur,
                        src_cur,
                        dst_cur,
                        budget,
                        depth + 1,
                        commit,
                    )?,
                };
                if ret < 0 {
                    return Ok(ret);
                }
            }
        }
        return Ok(ret);
    }

    Ok(APPLY_E_FAIL)
}
