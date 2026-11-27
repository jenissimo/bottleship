//! HeapAlloc/HeapFree slab fast paths for the existing BottleShip guest control ABI.
//! The same blocks are shared with the generated x86 allocator stubs and JS heap.

use super::{put_u32, u32_at, write_bytes, Guest, OFF_HC_SLAB_CTL_PTR};
const CONTROL_SIZE: u32 = 128;
const BUMP: u32 = 0x08;
const ALLOC_COUNT: u32 = 0x10;
const FREE_COUNT: u32 = 0x14;
const FALLBACK_COUNT: u32 = 0x18;
const FREELIST: u32 = 0x20;
const FREELIST_TAIL: u32 = 0x48;
const FIFO_BIN: u32 = 6;
const MAX_BIN: u32 = 8;
const HEADER_SIZE: u32 = 16;
const SLAB_LINK: u32 = 8;
const MAGIC_BUSY: u32 = 0x534c4100;
const MAGIC_FREE: u32 = 0x534c4600;

#[derive(Clone, Copy)]
struct Slab {
    guest: Guest,
    control: u32,
    base: u32,
    end: u32,
}

impl Slab {
    unsafe fn new(guest: Guest, page: u32) -> Option<Self> {
        let control = u32_at(page + OFF_HC_SLAB_CTL_PTR);
        if control & 3 != 0 || !guest.span(control, CONTROL_SIZE, true) {
            return None;
        }
        let base = u32_at(control);
        let end = u32_at(control + 4);
        if base < 0x10000
            || end > guest.size
            || base >= end
            || base & 3 != 0
            || (control < end && base < control + CONTROL_SIZE)
        {
            return None;
        }
        Some(Self {
            guest,
            control,
            base,
            end,
        })
    }

    unsafe fn bump_counter(self, offset: u32) {
        let address = self.control + offset;
        put_u32(address, u32_at(address).wrapping_add(1));
    }

    unsafe fn writable_block(self, ptr: u32, size: u32) -> bool {
        ptr & 3 == 0
            && ptr >= self.base + HEADER_SIZE
            && ptr.checked_add(size).is_some_and(|end| end <= self.end)
            && self.guest.span(ptr - HEADER_SIZE, HEADER_SIZE + size, true)
    }

    unsafe fn free_node(self, ptr: u32, size: u32, bin: u32) -> bool {
        self.writable_block(ptr, size) && u32_at(ptr - 4) == MAGIC_FREE | bin
    }

    unsafe fn alloc(self) -> Option<u32> {
        let flags = self.guest.arg(1)?;
        let requested = self.guest.arg(2)?;
        if requested == 0 {
            return None;
        }
        if requested > 4096 {
            self.bump_counter(FALLBACK_COUNT);
            return None;
        }
        let size = requested.max(16).next_power_of_two();
        let bin = size.trailing_zeros() - 4;
        let list = self.control + FREELIST + 4 * bin;
        let tail = self.control + FREELIST_TAIL + 4 * bin;
        let head = u32_at(list);
        let pointer = if head != 0 {
            if !self.free_node(head, size, bin) {
                return None;
            }
            let next = u32_at(head - SLAB_LINK);
            if next == head || (next != 0 && !self.free_node(next, size, bin)) {
                return None;
            }
            put_u32(list, next);
            if bin >= FIFO_BIN && next == 0 {
                put_u32(tail, 0);
            }
            head
        } else {
            let cursor = u32_at(self.control + BUMP);
            let ptr = cursor.checked_add(HEADER_SIZE)?;
            if !self.writable_block(ptr, size) {
                if ptr >= self.base + HEADER_SIZE {
                    self.bump_counter(FALLBACK_COUNT);
                }
                return None;
            }
            put_u32(self.control + BUMP, ptr + size);
            ptr
        };
        put_u32(pointer - 4, MAGIC_BUSY | bin);
        if flags & 8 != 0 {
            write_bytes(pointer as *mut u8, 0, size as usize);
        }
        self.bump_counter(ALLOC_COUNT);
        Some(pointer)
    }

    unsafe fn free(self) -> Option<u32> {
        let ptr = self.guest.arg(2)?;
        if ptr == 0 {
            return Some(1);
        }
        let header = self.guest.read32(ptr.checked_sub(4)?)?;
        let bin = header & 0xff;
        if header & 0xffff_ff00 != MAGIC_BUSY
            || bin > MAX_BIN
            || !self.writable_block(ptr, 16 << bin)
        {
            return None;
        }
        let size = 16 << bin;
        let list = self.control + FREELIST + 4 * bin;
        let head = u32_at(list);
        if head != 0 && !self.free_node(head, size, bin) {
            return None;
        }
        if bin >= FIFO_BIN {
            let tail_slot = self.control + FREELIST_TAIL + 4 * bin;
            let tail = u32_at(tail_slot);
            if (head == 0) != (tail == 0) {
                return None;
            }
            if tail != 0 && (!self.free_node(tail, size, bin) || u32_at(tail - SLAB_LINK) != 0) {
                return None;
            }
            put_u32(ptr - SLAB_LINK, 0);
            if tail == 0 {
                put_u32(list, ptr);
            } else {
                put_u32(tail - SLAB_LINK, ptr);
            }
            put_u32(tail_slot, ptr);
        } else {
            put_u32(ptr - SLAB_LINK, head);
            put_u32(list, ptr);
        }
        put_u32(ptr - 4, MAGIC_FREE | bin);
        self.bump_counter(FREE_COUNT);
        Some(1)
    }
}

pub(super) unsafe fn dispatch(guest: Guest, page: u32, alloc: bool) -> Option<u32> {
    let slab = Slab::new(guest, page)?;
    if alloc {
        slab.alloc()
    } else {
        slab.free()
    }
}
