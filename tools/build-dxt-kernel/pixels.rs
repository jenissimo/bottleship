// Surface pixel conversion fused with colour keying.
//
// KIND is the PixelFormat discriminant from ddraw/gpu-texture-utils.ts; the two
// enumerations must stay in step (1 RGB565, 2 RGB555, 3 ARGB1555, 6 ARGB8888,
// 7 XRGB8888). Formats with no bulk win — palettised, 4444, 24-bit — are never
// dispatched here and deliberately have no arm.

use core::ptr;
#[cfg(target_feature = "simd128")]
use core::arch::wasm32::*;

/// The colour-key comparison mask: the format's R|G|B masks, alpha excluded.
fn mask<const KIND: u32>() -> u32 {
    if KIND == 1 {
        0xffff
    } else if KIND == 2 || KIND == 3 {
        0x7fff
    } else {
        0xffffff
    }
}

fn pixel<const KIND: u32>(p: u32) -> u32 {
    if KIND == 6 || KIND == 7 {
        // Guest layout is little-endian ARGB (B,G,R,A in memory); RGBA8 wants R first.
        let a = if KIND == 7 { 0xff000000 } else { p & 0xff000000 };
        a | (p & 0xff00) | ((p & 255) << 16) | ((p >> 16) & 255)
    } else {
        // (v*527+23)>>6 and (v*259+33)>>6 are exactly round(v*255/31) and
        // round(v*255/63) over the whole domain — the rounded expansion the
        // EXPAND_5_TO_8 / EXPAND_6_TO_8 tables hold, without the tables.
        let r = ((p >> if KIND == 1 { 11 } else { 10 }) & 31) * 527 + 23;
        let g = if KIND == 1 {
            ((p >> 5) & 63) * 259 + 33
        } else {
            ((p >> 5) & 31) * 527 + 23
        };
        let b = (p & 31) * 527 + 23;
        // ARGB1555 alone carries alpha, as a single bit.
        let a = if KIND == 3 && p & 0x8000 == 0 { 0 } else { 0xff000000 };
        a | (r >> 6) | ((g >> 6) << 8) | ((b >> 6) << 16)
    }
}

#[cfg(target_feature = "simd128")]
#[inline]
unsafe fn pixels4<const KIND: u32>(p: v128) -> v128 {
    if KIND == 6 || KIND == 7 {
        let rgba = u8x16_shuffle::<2, 1, 0, 3, 6, 5, 4, 7, 10, 9, 8, 11, 14, 13, 12, 15>(p, p);
        if KIND == 7 {
            v128_or(rgba, u32x4_splat(0xff000000))
        } else {
            rgba
        }
    } else {
        let r = v128_and(u32x4_shr(p, if KIND == 1 { 11 } else { 10 }), u32x4_splat(31));
        let g = v128_and(u32x4_shr(p, 5), u32x4_splat(if KIND == 1 { 63 } else { 31 }));
        let b = v128_and(p, u32x4_splat(31));
        let expand5 =
            |v| u32x4_shr(i32x4_add(i32x4_mul(v, i32x4_splat(527)), i32x4_splat(23)), 6);
        let g = if KIND == 1 {
            u32x4_shr(i32x4_add(i32x4_mul(g, i32x4_splat(259)), i32x4_splat(33)), 6)
        } else {
            expand5(g)
        };
        let a = if KIND == 3 {
            v128_and(u32x4_ge(p, u32x4_splat(0x8000)), u32x4_splat(0xff000000))
        } else {
            u32x4_splat(0xff000000)
        };
        v128_or(
            v128_or(expand5(r), u32x4_shl(g, 8)),
            v128_or(u32x4_shl(expand5(b), 16), a),
        )
    }
}

unsafe fn convert<const KIND: u32, const KEY: bool>(
    src: *const u8,
    pitch: usize,
    w: usize,
    h: usize,
    dst: *mut u8,
    low: u32,
    high: u32,
) {
    let bpp = if KIND == 6 || KIND == 7 { 4 } else { 2 };
    let mask = mask::<KIND>();
    let low = low & mask;
    let high = high & mask;
    for y in 0..h {
        let row = src.add(y * pitch);
        let out = dst.add(y * w * 4);
        let mut x = 0;
        #[cfg(target_feature = "simd128")]
        while x + 4 <= w {
            // Both loads cover exactly four pixels, so a row never reads past its
            // own pitch; neither form requires an aligned address.
            let p = if bpp == 4 {
                v128_load(row.add(x * 4).cast())
            } else {
                u32x4_extend_low_u16x8(v128_load64_zero(row.add(x * 2).cast()))
            };
            let mut rgba = pixels4::<KIND>(p);
            if KEY {
                let pm = v128_and(p, u32x4_splat(mask));
                let keyed = v128_or(
                    v128_and(u32x4_ge(pm, u32x4_splat(low)), u32x4_le(pm, u32x4_splat(high))),
                    i32x4_eq(p, i32x4_splat(0)),
                );
                rgba = v128_andnot(rgba, v128_and(keyed, u32x4_splat(0xff000000)));
            }
            v128_store(out.add(x * 4).cast(), rgba);
            x += 4;
        }
        while x < w {
            let p = if bpp == 4 {
                u32::from_le(ptr::read_unaligned(row.add(x * 4).cast()))
            } else {
                u16::from_le(ptr::read_unaligned(row.add(x * 2).cast())) as u32
            };
            let pm = p & mask;
            let mut rgba = pixel::<KIND>(p);
            // A key match clears ALPHA ONLY. SetColorKey does not modify pixels:
            // the key is a per-operation modifier and the blit/sampling shaders
            // still compare against the source colour, so zeroing RGB here would
            // make the key unmatchable and render the region as opaque black.
            // Classic DirectDraw additionally treats an all-zero texel as keyed.
            if KEY && ((pm >= low && pm <= high) || p == 0) {
                rgba &= 0xffffff;
            }
            ptr::write_unaligned(out.add(x * 4).cast::<u32>(), rgba.to_le());
            x += 1;
        }
    }
}

/// Returns 0 on success, 1 for invalid format/geometry, 2 for invalid spans,
/// 3 for overlapping source/destination. A rejected call writes nothing.
#[no_mangle]
pub unsafe extern "C" fn convert_pixels(
    kind: u32,
    src: u32,
    src_len: u32,
    pitch: u32,
    width: u32,
    height: u32,
    dst: u32,
    dst_len: u32,
    keyed: u32,
    low: u32,
    high: u32,
) -> u32 {
    let bpp = match kind {
        1 | 2 | 3 => 2,
        6 | 7 => 4,
        _ => return 1,
    };
    if keyed > 1 {
        return 1;
    }
    if width == 0 || height == 0 {
        return 0;
    }
    let row = width as u64 * bpp;
    if (pitch as u64) < row {
        return 1;
    }
    let input = (height as u64 - 1) * pitch as u64 + row;
    let Some(output) = (width as u64)
        .checked_mul(height as u64)
        .and_then(|n| n.checked_mul(4))
    else {
        return 2;
    };
    let status = super::validate_spans(src, src_len, input, dst, dst_len, output);
    if status != 0 {
        return status;
    }
    macro_rules! run {
        ($k:literal) => {
            if keyed == 0 {
                convert::<$k, false>(
                    src as *const u8,
                    pitch as usize,
                    width as usize,
                    height as usize,
                    dst as *mut u8,
                    low,
                    high,
                )
            } else {
                convert::<$k, true>(
                    src as *const u8,
                    pitch as usize,
                    width as usize,
                    height as usize,
                    dst as *mut u8,
                    low,
                    high,
                )
            }
        };
    }
    match kind {
        1 => run!(1),
        2 => run!(2),
        3 => run!(3),
        6 => run!(6),
        7 => run!(7),
        _ => unreachable!(),
    }
    0
}
