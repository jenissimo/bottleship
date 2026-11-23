//! Injected guest-memory accessors — the crate's ONE host coupling point.
//!
//! The embedding emulator calls [`set_guest_mem`] once at boot (before any draw is
//! recorded) with fn pointers wrapping its own paging-aware readers (v86: safe_read32s /
//! safe_read8). Reads must be bounds/mmap-checked by the host; a `false`/`Err` return
//! means the guest range faulted and the caller declines the draw (same contract the
//! in-tree copy_guest_bytes had). Tests inject a mock over a flat buffer.

/// Guest-memory accessor table. All functions take guest virtual addresses as `i32`
/// (matching the host emulator's convention for 32-bit guests).
pub struct GuestMem {
    /// Bulk-copy `len` bytes from guest `addr` into `dst` (crate-owned memory).
    /// Returns `false` if any part of the range faulted — the destination contents are
    /// then unspecified and the caller must treat the operation as failed.
    /// This is the hot path (one indirect call per UP-draw capture, not per word).
    pub read_block: fn(addr: i32, dst: *mut u8, len: u32) -> bool,
}

static mut GUEST_MEM: Option<GuestMem> = None;

/// Install the host's accessors. Call once at emulator init, before any arena function
/// that touches guest memory (d3d9_record_draw_up / d3d9_record_draw_indexed_up).
pub fn set_guest_mem(gm: GuestMem) {
    unsafe { GUEST_MEM = Some(gm) }
}

pub(crate) fn guest_mem() -> Option<&'static GuestMem> {
    unsafe { (*std::ptr::addr_of!(GUEST_MEM)).as_ref() }
}
