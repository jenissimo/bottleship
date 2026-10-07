//! Installer/archive unpack codecs — WASM module (hand-rolled C ABI).
//!
//! LZMA1/LZMA2 (Inno Setup), srep (FreeArc) and RAR PPMd. The TS format parsers
//! stay thin; the heavy decompression lives here.
//!
//! # ABI (must match `packages/formats/src/unpack/unpack.ts`)
//!
//! ## Imports (module `"env"`)
//! - `unpack_read(ptr: *mut u8, cap: u32) -> u32` — pull compressed bytes; `0` = EOF
//! - `unpack_write(ptr: *const u8, len: u32) -> u32` — push decompressed bytes; return `0` to abort
//!
//! ## Exports
//! - `unpack_alloc(size: u32) -> *mut u8` — heap allocation via Rust global allocator (same linear memory as lzma-rust2)
//! - `unpack_free(ptr: *mut u8, size: u32)` — frees allocations from `unpack_alloc`
//! - `unpack_decode(kind: u32, props_ptr: *const u8, props_len: u32) -> i32`
//!   - `kind`: `0` = store (copy), `1` = LZMA1 (raw, props supplied), `2` = LZMA2, `3` = srep (FreeArc, no props)
//!   - `props` for LZMA1: 1-byte props + 4-byte LE dict size (Inno framing, see innoextract `stream/lzma.cpp`)
//!   - `props` for LZMA2: 4-byte LE dict size
//!   - srep: no props; input is a raw SREP stream (already LZMA-decoded by the caller)
//!   - Returns `0` on success, negative error code on failure
//! - `rar_ppm_new(input, len)` / `rar_ppm_free(session)` — persistent PPMd model
//! - `rar_ppm_block(session, input_offset, output, base, capacity)` — decode one coding block;
//!   `0` = EOF, `1` = new table, negative = error. Dictionary bytes before `base` are caller-owned.
//! - `rar_ppm_position(session)` / `rar_ppm_written(session)` — consumed/produced extents
//!
//! `unpack_decode` runs the whole stream to EOF in one call, invoking imports in a loop.
//! JS must copy bytes from `unpack_write` before returning — views are invalidated on memory growth.

use core::ptr;
use lzma_rust2::{Lzma2Reader, LzmaReader};
use std::alloc::{alloc, dealloc, Layout};
use std::io::{self, Read, Write};
mod rar;

/// Unknown uncompressed size — Inno solid chunks use this for LZMA1 streams.
const LZMA_UNKNOWN_SIZE: u64 = u64::MAX;

#[link(wasm_import_module = "env")]
extern "C" {
    fn unpack_read(ptr: *mut u8, cap: u32) -> u32;
    fn unpack_write(ptr: *const u8, len: u32) -> u32;
}

struct CallbackReader;

impl Read for CallbackReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let n = unsafe { unpack_read(buf.as_mut_ptr(), buf.len() as u32) };
        Ok(n as usize)
    }
}

struct CallbackWriter;

impl Write for CallbackWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let n = unsafe { unpack_write(buf.as_ptr(), buf.len() as u32) };
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "unpack_write aborted"));
        }
        Ok(n as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn copy_store() -> i32 {
    let mut reader = CallbackReader;
    let mut writer = CallbackWriter;
    let mut buf = [0u8; 65536];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(n) => n,
            Err(_) => return -3,
        };
        if n == 0 {
            break;
        }
        if writer.write_all(&buf[..n]).is_err() {
            return -4;
        }
    }
    0
}

/// Copy a Read to the output writer using a 1 MiB buffer. `io::copy`'s 8 KiB default means
/// ~237k host `unpack_write` calls (each a JS slice) for a 1.9 GB stream — 1 MiB cuts that
/// ~128× and is the difference between seconds and minutes on multi-GB FreeArc blocks.
fn copy_big<R: Read>(mut r: R) -> i32 {
    let mut writer = CallbackWriter;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => return -3,
        };
        if writer.write_all(&buf[..n]).is_err() {
            return -4;
        }
    }
    0
}

fn decode_lzma1(props_ptr: *const u8, props_len: u32) -> i32 {
    if props_len < 5 {
        return -2;
    }
    let props = unsafe { *props_ptr };
    let dict_size = unsafe { ptr::read_unaligned(props_ptr.add(1) as *const u32) };

    let reader = CallbackReader;
    let decoder = match LzmaReader::new_with_props(reader, LZMA_UNKNOWN_SIZE, props, dict_size, None) {
        Ok(d) => d,
        Err(_) => return -2,
    };
    copy_big(decoder)
}

fn decode_lzma2(props_ptr: *const u8, props_len: u32) -> i32 {
    if props_len < 4 {
        return -2;
    }
    let dict_size = unsafe { ptr::read_unaligned(props_ptr as *const u32) };

    let reader = CallbackReader;
    copy_big(Lzma2Reader::new(reader, dict_size, None))
}

// ──────────────────────────────────────────────────────────────────────────────
// srep — FreeArc long-range dedup decompressor (Bulat Ziganshin's SREP).
//
// The input is a raw SREP stream (the caller has already removed the outer LZMA layer).
// Format (all little-endian fixed uint32 — NO varints): a 16-byte archive header + a
// `hash_seed_size`-byte seed, then a sequence of blocks. Each block:
//   [12B sizes: datasize1(literals), origsize1(decoded), statsize1(match-list)]
//   [hash_size B hash — skipped] [statsize1 B match list] [datasize1 B literals]
// terminated by a header with datasize1==0 && origsize1==0.
//
// A match record (FUTURE_LZ / version 3) = 4×uint32: lit_len, offset_lo, offset_hi, len.
// Absolute positions: src = basic_pos + lit_len; dest = src + offset; len += BASE_LEN;
// basic_pos advances to src. dest > src always (forward refs). Reconstruction emits the
// output in `dest` order, filling literals between matches and overlap-copying matches
// from already-produced output. We keep the FULL output resident, so srep's save/restore
// + VM-spill (needed only when output blocks are freed) collapse to: a dest-ordered heap of
// pending matches whose source is always still in the buffer. (Ref: Intensity/srep
// decompress.cpp `decompress_FUTURE_LZ`, srep.cpp `DECODE_LZ_MATCH`.)
// ──────────────────────────────────────────────────────────────────────────────

use std::cmp::Reverse;
use std::collections::BinaryHeap;

const SREP_SIG: u32 = 0x2635_1817;
const SREP_MAGIC: u32 = 0x5045_5253; // "SREP" little-endian

#[derive(Clone, Copy, PartialEq, Eq)]
struct SrepMatch {
    dest: u64,
    src: u64,
    len: u64,
}
// Order by dest (min-heap via Reverse); tie-break keeps Ord total.
impl Ord for SrepMatch {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        self.dest.cmp(&o.dest).then(self.src.cmp(&o.src)).then(self.len.cmp(&o.len))
    }
}
impl PartialOrd for SrepMatch {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}

#[inline]
fn u32le(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

/// Read exactly `buf.len()` bytes; returns false on clean EOF before any byte (header probe).
fn read_exact_or_eof(r: &mut CallbackReader, buf: &mut [u8]) -> Result<bool, ()> {
    let mut got = 0;
    while got < buf.len() {
        let n = r.read(&mut buf[got..]).map_err(|_| ())?;
        if n == 0 {
            return if got == 0 { Ok(false) } else { Err(()) };
        }
        got += n;
    }
    Ok(true)
}

fn skip_bytes(r: &mut CallbackReader, mut n: usize) -> Result<(), ()> {
    let mut scratch = [0u8; 4096];
    while n > 0 {
        let want = n.min(scratch.len());
        let m = r.read(&mut scratch[..want]).map_err(|_| ())?;
        if m == 0 {
            return Err(());
        }
        n -= m;
    }
    Ok(())
}

fn decode_srep(props_ptr: *const u8, props_len: u32) -> i32 {
    let mut r = CallbackReader;

    // Archive header: 4×u32 + seed.
    let mut hdr = [0u8; 16];
    match read_exact_or_eof(&mut r, &mut hdr) {
        Ok(true) => {}
        _ => return -5,
    }
    if u32le(&hdr, 0) != SREP_SIG || u32le(&hdr, 4) != SREP_MAGIC {
        return -5;
    }
    let h2 = u32le(&hdr, 8);
    let base_len = u32le(&hdr, 12) as u64;
    let version = h2 & 0xff;
    let hash_seed_size = ((h2 >> 16) & 0xff) as usize;
    let hash_size = (((h2 >> 24) & 0xff) + 16) as usize;
    if version != 3 {
        return -5; // only FUTURE_LZ (v3) supported (what FreeArc repacks emit)
    }
    if skip_bytes(&mut r, hash_seed_size).is_err() {
        return -5;
    }

    // Pre-allocate the full output when the caller knows the total size (props = u32 LE).
    // A single up-front allocation avoids Vec's doubling-realloc spike (old+new ≈ 3× peak),
    // which otherwise blows the wasm32 linear-memory ceiling on multi-GB blocks (e.g. GTA3
    // data001 → 1.96 GB).
    let expected: usize = if props_len >= 4 {
        unsafe { ptr::read_unaligned(props_ptr as *const u32) as usize }
    } else {
        0
    };
    let mut out: Vec<u8> = Vec::new();
    if expected > 0 {
        out.try_reserve_exact(expected).ok();
    }
    let mut heap: BinaryHeap<Reverse<SrepMatch>> = BinaryHeap::new();
    let mut block_start: u64 = 0;

    loop {
        // Block header: 3×u32 sizes (+ hash bytes).
        let mut bh = [0u8; 12];
        match read_exact_or_eof(&mut r, &mut bh) {
            Ok(true) => {}
            Ok(false) => break, // clean end of stream
            Err(()) => return -5,
        }
        let datasize1 = u32le(&bh, 0) as usize;
        let origsize1 = u32le(&bh, 4) as usize;
        let statsize1 = u32le(&bh, 8) as usize;
        if datasize1 == 0 && origsize1 == 0 {
            break; // EOF block
        }
        if skip_bytes(&mut r, hash_size).is_err() {
            return -5;
        }

        let mut stat = vec![0u8; statsize1];
        if read_exact_or_eof(&mut r, &mut stat) != Ok(true) {
            return -5;
        }
        let mut lits = vec![0u8; datasize1];
        if read_exact_or_eof(&mut r, &mut lits) != Ok(true) {
            return -5;
        }

        let block_end = block_start + origsize1 as u64;
        out.resize(block_end as usize, 0);

        // Parse match records → dest-ordered heap (src in ascending order via basic_pos).
        let mut p = 0usize;
        let mut basic_pos = block_start;
        while statsize1 - p >= 16 {
            let lit_len = u32le(&stat, p) as u64;
            let off = (u32le(&stat, p + 4) as u64) | ((u32le(&stat, p + 8) as u64) << 32);
            let mlen = (u32le(&stat, p + 12) as u64) + base_len;
            p += 16;
            let src = basic_pos + lit_len;
            let dest = src + off;
            if dest <= src || dest + mlen > u64::MAX {
                return -5;
            }
            heap.push(Reverse(SrepMatch { dest, src, len: mlen }));
            basic_pos = src;
        }

        // Emit [block_start, block_end): drain matches with dest < block_end in dest order.
        let mut out_pos = block_start;
        let mut lit_pos = 0usize;
        while let Some(Reverse(m)) = heap.peek().copied() {
            if m.dest >= block_end {
                break;
            }
            heap.pop();
            // Bounds: literal gap and match must fit; src already produced (src < dest).
            let gap = match m.dest.checked_sub(out_pos) {
                Some(g) => g as usize,
                None => return -5, // dest before current position → corrupt
            };
            if lit_pos + gap > lits.len() {
                return -5;
            }
            let d0 = out_pos as usize;
            out[d0..d0 + gap].copy_from_slice(&lits[lit_pos..lit_pos + gap]);
            lit_pos += gap;
            out_pos = m.dest;

            let (s, d, l) = (m.src as usize, m.dest as usize, m.len as usize);
            if s >= d || d + l > out.len() {
                return -5;
            }
            if d - s >= l {
                out.copy_within(s..s + l, d); // non-overlapping forward copy
            } else {
                for i in 0..l {
                    out[d + i] = out[s + i]; // overlap (RLE) — must be byte-by-byte forward
                }
            }
            out_pos += m.len;
        }
        // Remaining literals up to block end.
        let tail = match block_end.checked_sub(out_pos) {
            Some(t) => t as usize,
            None => return -5,
        };
        if lit_pos + tail != lits.len() {
            return -5; // literal blob must be fully consumed
        }
        let op = out_pos as usize;
        out[op..op + tail].copy_from_slice(&lits[lit_pos..lit_pos + tail]);

        block_start = block_end;
    }

    // Flush the whole reconstructed output.
    let mut w = CallbackWriter;
    if w.write_all(&out).is_err() {
        return -4;
    }
    0
}

#[no_mangle]
pub extern "C" fn unpack_alloc(size: u32) -> *mut u8 {
    if size == 0 {
        return ptr::null_mut();
    }
    let layout = match Layout::from_size_align(size as usize, 8) {
        Ok(l) => l,
        Err(_) => return ptr::null_mut(),
    };
    unsafe { alloc(layout) }
}

#[no_mangle]
pub extern "C" fn unpack_free(ptr: *mut u8, size: u32) {
    if ptr.is_null() || size == 0 {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(size as usize, 8) {
        unsafe { dealloc(ptr, layout) };
    }
}

#[no_mangle]
pub extern "C" fn unpack_decode(kind: u32, props_ptr: *const u8, props_len: u32) -> i32 {
    match kind {
        0 => copy_store(),
        1 => decode_lzma1(props_ptr, props_len),
        2 => decode_lzma2(props_ptr, props_len),
        3 => decode_srep(props_ptr, props_len),
        _ => -1,
    }
}
