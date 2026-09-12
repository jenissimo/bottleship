// Bulk CPU texture kernels: S3TC block decode and surface pixel conversion.
//
// Freestanding by construction — no host imports, no allocator, no memory the
// host did not hand us. The module owns a private linear memory that is NOT the
// guest address space: every call stages its input in, decodes, and the host
// copies the RGBA result back out. That is two copies, so only bulk work is
// routed here (see the TS loader's minimum-pixel gate).

#![no_std]

use core::{arch::wasm32, panic::PanicInfo, ptr};

mod pixels;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    wasm32::unreachable()
}

fn channel5(v: u32) -> u32 {
    (v << 3) | (v >> 2)
}
fn channel6(v: u32) -> u32 {
    (v << 2) | (v >> 4)
}
fn rgb565(c: u32) -> [u32; 3] {
    [channel5(c >> 11), channel6((c >> 5) & 63), channel5(c & 31)]
}
/// Pack as little-endian RGBA8 so one unaligned u32 store emits R,G,B,A.
fn rgba(c: [u32; 3]) -> u32 {
    0xff000000 | c[0] | (c[1] << 8) | (c[2] << 16)
}

/// `kind` is the DXT FourCC's digit: 1..=5 for DXT1..DXT5.
unsafe fn decode(kind: u32, src: *const u8, pitch: usize, w: usize, h: usize, dst: *mut u8) {
    let block_bytes = if kind == 1 { 8 } else { 16 };
    for by in 0..h.div_ceil(4) {
        for bx in 0..w.div_ceil(4) {
            let block = src.add(by * pitch + bx * block_bytes);
            // BC2/BC3 put the 8-byte alpha sub-block first; BC1 has none.
            let color = block.add(if kind == 1 { 0 } else { 8 });
            let c0 = u16::from_le(ptr::read_unaligned(color.cast::<u16>())) as u32;
            let c1 = u16::from_le(ptr::read_unaligned(color.add(2).cast::<u16>())) as u32;
            let a = rgb565(c0);
            let b = rgb565(c1);
            let mut palette = [rgba(a), rgba(b), 0, 0];
            // Endpoint order selects the mode for BC1 only; BC2/BC3 colour blocks
            // are always 4-colour because their alpha lives in its own sub-block.
            if kind != 1 || c0 > c1 {
                let mut c = [0; 3];
                let mut d = [0; 3];
                for i in 0..3 {
                    c[i] = (2 * a[i] + b[i] + 1) / 3;
                    d[i] = (a[i] + 2 * b[i] + 1) / 3;
                }
                palette[2] = rgba(c);
                palette[3] = rgba(d);
            } else {
                // BC1 punch-through: index 3 stays transparent black (RGB and
                // alpha both zero), which is why palette[3] is left at 0.
                palette[2] = rgba([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
            }
            let mut alpha = [255u8; 16];
            if kind == 2 || kind == 3 {
                // BC2: 16 explicit 4-bit alphas, low nibble first, *17 to 8 bits.
                for i in 0..8 {
                    let v = *block.add(i);
                    alpha[2 * i] = (v & 15) * 17;
                    alpha[2 * i + 1] = (v >> 4) * 17;
                }
            } else if kind == 4 || kind == 5 {
                let a0 = *block as u32;
                let a1 = *block.add(1) as u32;
                // a0 <= a1 is the 6-value mode: two of the eight entries are the
                // fixed 0 and 255 endpoints, hence the pre-seeded tail.
                let mut ap = [a0 as u8, a1 as u8, 0, 0, 0, 0, 0, 255];
                if a0 > a1 {
                    for i in 1..7 {
                        ap[i + 1] = (((7 - i) as u32 * a0 + i as u32 * a1 + 3) / 7) as u8;
                    }
                } else {
                    for i in 1..5 {
                        ap[i + 1] = (((5 - i) as u32 * a0 + i as u32 * a1 + 2) / 5) as u8;
                    }
                }
                // Two 24-bit streams keep the 3-bit index walk in i32 arithmetic.
                for half in 0..2 {
                    let p = block.add(2 + half * 3);
                    let mut bits =
                        *p as u32 | ((*p.add(1) as u32) << 8) | ((*p.add(2) as u32) << 16);
                    for i in 0..8 {
                        alpha[half * 8 + i] = ap[(bits & 7) as usize];
                        bits >>= 3;
                    }
                }
            }
            let mut bits = u32::from_le(ptr::read_unaligned(color.add(4).cast::<u32>()));
            // Edge blocks are decoded whole but written clipped; the destination
            // is tightly packed at width*4, not block-aligned.
            let rows = core::cmp::min(4, h - by * 4);
            let cols = core::cmp::min(4, w - bx * 4);
            for ty in 0..rows {
                let mut row = bits;
                bits >>= 8;
                let out = dst.add(((by * 4 + ty) * w + bx * 4) * 4);
                for tx in 0..cols {
                    let mut pixel = palette[(row & 3) as usize];
                    row >>= 2;
                    if kind != 1 {
                        pixel = (pixel & 0xffffff) | ((alpha[ty * 4 + tx] as u32) << 24);
                    }
                    ptr::write_unaligned(out.add(tx * 4).cast::<u32>(), pixel.to_le());
                }
            }
        }
    }
}

/// Returns 0 on success, 1 for invalid format/geometry, 2 for invalid spans,
/// 3 for overlapping source/destination. A rejected call writes nothing.
#[no_mangle]
pub unsafe extern "C" fn decode_dxt(
    kind: u32,
    src: u32,
    src_len: u32,
    pitch: u32,
    width: u32,
    height: u32,
    dst: u32,
    dst_len: u32,
) -> u32 {
    if !(1..=5).contains(&kind) {
        return 1;
    }
    if width == 0 || height == 0 {
        return 0;
    }
    let row = (width as u64).div_ceil(4) * if kind == 1 { 8 } else { 16 };
    if (pitch as u64) < row {
        return 1;
    }
    let input = ((height as u64).div_ceil(4) - 1) * pitch as u64 + row;
    let Some(output) = (width as u64)
        .checked_mul(height as u64)
        .and_then(|n| n.checked_mul(4))
    else {
        return 2;
    };
    let status = validate_spans(src, src_len, input, dst, dst_len, output);
    if status != 0 {
        return status;
    }
    decode(
        kind,
        src as *const u8,
        pitch as usize,
        width as usize,
        height as usize,
        dst as *mut u8,
    );
    0
}

/// The exported entry points are the only place raw pointers are constructed, so
/// this is the whole memory-safety argument: both spans must sit above the data
/// segments and stack (`__heap_base`), inside the current linear memory, inside
/// the lengths the caller declared, and must not overlap each other.
fn validate_spans(src: u32, src_len: u32, input: u64, dst: u32, dst_len: u32, output: u64) -> u32 {
    let mem_len = wasm32::memory_size::<0>() as u64 * 65536;
    extern "C" {
        static __heap_base: u8;
    }
    let heap = ptr::addr_of!(__heap_base) as u64;
    let s = src as u64;
    let d = dst as u64;
    if s < heap
        || d < heap
        || input > src_len as u64
        || output > dst_len as u64
        || s + input > mem_len
        || d + output > mem_len
    {
        return 2;
    }
    if s < d + output && d < s + input {
        return 3;
    }
    0
}
