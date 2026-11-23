#![no_std]

use core::panic::PanicInfo;
use core::ptr::{copy, read_unaligned, write_bytes, write_unaligned};

#[panic_handler]
fn panic(_: &PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

// The worker publishes the existing BottleShip CPU-state ABI on each WWT crossing.
// Keep these in sync with CPU_VIEW_OFFSETS and the shared HYPERCALL_PAGE layout.
const REG32: u32 = 64;
const CR0: u32 = 580;
const CR3: u32 = 592;
const CPL: u32 = 612;
const RETIRED: u32 = 664;
const MEMORY_SIZE: u32 = 812;
const FPU_DIRTY: u32 = 632;
const FPU_EMPTY: u32 = 816;
const FPU_TOP: u32 = 1032;
const FPU_REGISTERS: u32 = 1152;
const RELAXED_F80: u16 = 0x7ffe;
const PAGE_MASK: u32 = !0xfff;
const PAGE_PRESENT: u32 = 1;
const PAGE_WRITABLE: u32 = 2;
const PAGE_USER: u32 = 4;
const CR0_PG: u32 = 1 << 31;
const CR0_WP: u32 = 1 << 16;
const SCAN_LIMIT: u32 = 0x10000;

unsafe fn u32_at(address: u32) -> u32 {
    read_unaligned(address as *const u32)
}

unsafe fn put_u32(address: u32, value: u32) {
    write_unaligned(address as *mut u32, value);
}

unsafe fn byte(address: u32) -> u8 {
    *(address as *const u8)
}

#[derive(Clone, Copy)]
struct Guest {
    cpu_base: u32,
    regs: u32,
    retired: u32,
    size: u32,
    cr0: u32,
    cr3: u32,
    cpl: u8,
    store_map: u32,
}

impl Guest {
    unsafe fn new(cpu_base: u32, store_map: u32) -> Self {
        Self::with_registers(cpu_base, store_map, cpu_base + REG32, cpu_base + RETIRED)
    }

    unsafe fn with_registers(cpu_base: u32, store_map: u32, regs: u32, retired: u32) -> Self {
        Self {
            cpu_base,
            regs,
            retired,
            size: u32_at(cpu_base + MEMORY_SIZE),
            cr0: u32_at(cpu_base + CR0),
            cr3: u32_at(cpu_base + CR3),
            cpl: byte(cpu_base + CPL),
            store_map,
        }
    }

    /// Require the same identity-mapped RAM the translated CPU sees. An executable
    /// or edge store-map page, external physical mapping or unmapped span falls back.
    unsafe fn span(self, addr: u32, len: u32, write: bool) -> bool {
        if len == 0 {
            return true;
        }
        let Some(end) = addr.checked_add(len) else {
            return false;
        };
        if addr < 0x10000 || end > self.size {
            return false;
        }
        let mut required = PAGE_PRESENT;
        if self.cpl == 3 {
            required |= PAGE_USER;
        }
        if write && (self.cpl == 3 || self.cr0 & CR0_WP != 0) {
            required |= PAGE_WRITABLE;
        }
        for page in (addr >> 12)..=((end - 1) >> 12) {
            if write && (self.store_map == 0 || byte(self.store_map + page) != 0) {
                return false;
            }
            if self.cr0 & CR0_PG == 0 {
                continue;
            }
            let pde_addr = (self.cr3 & PAGE_MASK) + (page >> 10) * 4;
            if pde_addr > self.size - 4 {
                return false;
            }
            let pde = u32_at(pde_addr);
            if pde & required != required || pde & (1 << 7) != 0 {
                return false;
            }
            let pte_addr = (pde & PAGE_MASK) + (page & 1023) * 4;
            if pte_addr > self.size - 4 {
                return false;
            }
            let pte = u32_at(pte_addr);
            if pte & required != required || pte & PAGE_MASK != page << 12 {
                return false;
            }
        }
        true
    }

    unsafe fn read32(self, addr: u32) -> Option<u32> {
        self.span(addr, 4, false).then(|| u32_at(addr))
    }

    unsafe fn read_i32(self, addr: i32) -> Result<i32, ()> {
        self.read32(addr as u32).map(|value| value as i32).ok_or(())
    }

    unsafe fn read_i8(self, addr: i32) -> Result<i32, ()> {
        self.unit(addr as u32, 1)
            .map(|value| value as i32)
            .ok_or(())
    }

    unsafe fn read_i16(self, addr: i32) -> Result<i32, ()> {
        self.unit(addr as u32, 2)
            .map(|value| value as i32)
            .ok_or(())
    }

    unsafe fn write_i32(self, addr: i32, value: i32) -> Result<(), ()> {
        if !self.span(addr as u32, 4, true) {
            return Err(());
        }
        put_u32(addr as u32, value as u32);
        Ok(())
    }

    unsafe fn unit(self, addr: u32, width: u32) -> Option<u32> {
        if !self.span(addr, width, false) {
            return None;
        }
        Some(if width == 1 {
            byte(addr) as u32
        } else {
            read_unaligned(addr as *const u16) as u32
        })
    }

    unsafe fn arg(self, n: u32) -> Option<u32> {
        self.read32(u32_at(self.regs + 16).checked_add(4 + 4 * n)?)
    }

    unsafe fn length(self, addr: u32, width: u32) -> Option<u32> {
        let length = self.length_up_to(addr, width, SCAN_LIMIT)?;
        (length < SCAN_LIMIT).then_some(length)
    }

    /// Scan within one checked page at a time. Only misaligned UTF-16 units may
    /// cross a page without joining the neighboring units in the word scan.
    unsafe fn length_up_to(self, start: u32, width: u32, limit: u32) -> Option<u32> {
        let mut chars = 0;
        let (low, high) = if width == 1 {
            (0x0101_0101_0101_0101, 0x8080_8080_8080_8080)
        } else {
            (0x0001_0001_0001_0001, 0x8000_8000_8000_8000)
        };
        while chars < limit {
            let addr = start.checked_add(chars * width)?;
            let room = ((0x1000 - (addr & 0xfff)) / width).min(limit - chars);
            if room == 0 {
                if self.unit(addr, width)? == 0 {
                    return Some(chars);
                }
                chars += 1;
                continue;
            }
            if !self.span(addr, room * width, false) {
                return None;
            }
            let mut i = 0;
            let word_units = 8 / width;
            while i + word_units <= room {
                let word = read_unaligned((addr + i * width) as *const u64);
                let zeroes = word.wrapping_sub(low) & !word & high;
                if zeroes != 0 {
                    return Some(chars + i + zeroes.trailing_zeros() / (width * 8));
                }
                i += word_units;
            }
            for j in i..room {
                let at = addr + j * width;
                let ch = if width == 1 {
                    byte(at) as u16
                } else {
                    read_unaligned(at as *const u16)
                };
                if ch == 0 {
                    return Some(chars + j);
                }
            }
            chars += room;
        }
        Some(chars)
    }

    unsafe fn compare(
        self,
        left: u32,
        right: u32,
        width: u32,
        fold: bool,
        limit: u32,
    ) -> Option<u32> {
        for i in 0..limit.min(SCAN_LIMIT) {
            let mut a = self.unit(left.checked_add(i * width)?, width)?;
            let mut b = self.unit(right.checked_add(i * width)?, width)?;
            if fold {
                a = ascii_lower(a);
                b = ascii_lower(b);
            }
            if a != b || a == 0 {
                return Some(a.wrapping_sub(b));
            }
        }
        (limit <= SCAN_LIMIT).then_some(0)
    }
}

fn ascii_lower(ch: u32) -> u32 {
    if ch >= b'A' as u32 && ch <= b'Z' as u32 {
        ch + 32
    } else {
        ch
    }
}

// Existing RTTI algorithm with the caller's guarded memory context.
mod heap_slab;
#[path = "reused/hypercall_rtti.rs"]
mod rtti;

unsafe fn string_copy(guest: Guest, width: u32, append: bool) -> Option<u32> {
    let dst = guest.arg(0)?;
    let src = guest.arg(1)?;
    if dst == 0 || src == 0 {
        return Some(dst);
    }
    let target = if append {
        dst.checked_add(guest.length(dst, width)? * width)?
    } else {
        dst
    };
    let bytes = (guest.length(src, width)? + 1) * width;
    if !guest.span(target, bytes, true) {
        return None;
    }
    if src < target + bytes && target < src + bytes {
        return None;
    }
    copy(src as *const u8, target as *mut u8, bytes as usize);
    Some(dst)
}

unsafe fn wcsncpy(guest: Guest) -> Option<u32> {
    let dst = guest.arg(0)?;
    let src = guest.arg(1)?;
    let count = guest.arg(2)?;
    if dst == 0 || count == 0 {
        return Some(dst);
    }
    if count > SCAN_LIMIT || !guest.span(dst, count * 2, true) {
        return None;
    }
    let chars = guest.length_up_to(src, 2, count)?;
    if chars > 0 {
        copy(src as *const u8, dst as *mut u8, (chars * 2) as usize);
    }
    if chars < count {
        write_bytes(
            (dst + chars * 2) as *mut u8,
            0,
            ((count - chars) * 2) as usize,
        );
    }
    Some(dst)
}

unsafe fn interlocked(guest: Guest, handler: u8) -> Option<u32> {
    let addr = guest.arg(0)?;
    if !guest.span(addr, 4, true) {
        return None;
    }
    let value = u32_at(addr);
    let (next, result) = match handler {
        7 => (value.wrapping_add(1), value.wrapping_add(1)),
        8 => (value.wrapping_sub(1), value.wrapping_sub(1)),
        9 => (guest.arg(1)?, value),
        10 => (
            if value == guest.arg(2)? {
                guest.arg(1)?
            } else {
                value
            },
            value,
        ),
        _ => return None,
    };
    put_u32(addr, next);
    Some(result)
}

unsafe fn critical_section(guest: Guest, page: u32, enter: bool) -> Option<u32> {
    let ptr = guest.arg(0)?;
    let thread = u32_at(page + 0x34);
    if thread == 0 || !guest.span(ptr, 20, true) {
        return None;
    }
    let owner = u32_at(ptr + 12);
    let recursion = u32_at(ptr + 8) as i32;
    if enter {
        if owner == 0 {
            put_u32(ptr + 4, 0);
            put_u32(ptr + 8, 1);
            put_u32(ptr + 12, thread);
        } else if owner == thread {
            put_u32(ptr + 8, recursion.wrapping_add(1) as u32);
        } else {
            return None;
        }
    } else {
        if owner != 0 && owner != thread {
            return None;
        }
        if recursion > 1 {
            put_u32(ptr + 8, (recursion - 1) as u32);
        } else {
            if u32_at(ptr + 16) != 0 {
                return None;
            }
            put_u32(ptr + 4, u32::MAX);
            put_u32(ptr + 8, 0);
            put_u32(ptr + 12, 0);
        }
    }
    Some(0)
}

unsafe fn tls(guest: Guest, page: u32, write: bool) -> Option<u32> {
    let index = guest.arg(0)?;
    if index >= 64 {
        return None;
    }
    let teb = u32_at(page + 0x28);
    if teb == 0 {
        return None;
    }
    let slot = teb.checked_add(0xe10 + index * 4)?;
    if write {
        if byte(page + 0xb8 + index) == 0 || !guest.span(slot, 4, true) {
            return None;
        }
        put_u32(slot, guest.arg(1)?);
        return Some(1);
    }
    let value = guest.read32(slot)?;
    if !guest.span(teb + 0x34, 4, true) {
        return None;
    }
    put_u32(teb + 0x34, 0);
    put_u32(page + 0x24, 0);
    Some(value)
}

unsafe fn substring(guest: Guest, width: u32) -> Option<u32> {
    let haystack = guest.arg(0)?;
    let needle = guest.arg(1)?;
    if haystack == 0 || needle == 0 {
        return Some(0);
    }
    let needle_length = guest.length(needle, width)?;
    if needle_length == 0 {
        return Some(haystack);
    }
    let haystack_length = guest.length(haystack, width)?;
    if needle_length > haystack_length {
        return Some(0);
    }
    // Decline unusually large search budgets to keep a Wasm leaf bounded.
    if (haystack_length as u64) * (needle_length as u64) > 16_000_000 {
        return None;
    }
    for i in 0..=(haystack_length - needle_length) {
        let address = haystack + i * width;
        let mut j = 0;
        while j < needle_length * width && byte(address + j) == byte(needle + j) {
            j += 1;
        }
        if j == needle_length * width {
            return Some(address);
        }
    }
    Some(0)
}

unsafe fn atoi(guest: Guest) -> Option<u32> {
    let mut ptr = guest.arg(0)?;
    if ptr == 0 {
        return Some(0);
    }
    let mut next = guest.unit(ptr, 1)? as u8;
    for _ in 0..SCAN_LIMIT {
        if !matches!(next, b' ' | 0x09..=0x0d) {
            break;
        }
        ptr += 1;
        next = guest.unit(ptr, 1)? as u8;
    }
    if matches!(next, b' ' | 0x09..=0x0d) {
        return None;
    }
    let negative = next == b'-';
    if next == b'+' || negative {
        ptr += 1;
        next = guest.unit(ptr, 1)? as u8;
    }
    let mut value = 0i64;
    for _ in 0..15 {
        if !next.is_ascii_digit() {
            break;
        }
        value = value * 10 + (next - b'0') as i64;
        ptr += 1;
        next = guest.unit(ptr, 1)? as u8;
    }
    if next.is_ascii_digit() {
        return None;
    }
    Some(if negative { -value } else { value } as u32)
}

// Matches hypercall-event-mirror.ts and the original v86 mirror ABI.
const EVENT_VALID: u8 = 0x01;
const EVENT_SIGNALED: u8 = 0x02;
const EVENT_MANUAL: u8 = 0x04;
const EVENT_HAS_WAITERS: u8 = 0x08;
const EVENT_PENDING_WAKE: u8 = 0x10;
const MUTEX_VALID: u32 = 0x8000_0000;
const MUTEX_DECLINE: u32 = 0x6000_0000; // waiter or abandoned
const MUTEX_OWNER: u32 = 0xffff;
const MUTEX_RECURSION: u32 = 0xff_0000;
const WAIT_TIMEOUT: u32 = 0x102;

unsafe fn synchronization_mirror(guest: Guest, page: u32, id: u8) -> Option<u32> {
    let slot = guest.arg(0)?.checked_sub(0x30000)? >> 2;
    if slot >= 2048 {
        return None;
    }
    let event_address = (page + 0x1448 + slot) as *mut u8;
    let flags = *event_address;
    if id == 72 {
        if flags & EVENT_VALID == 0 || flags & EVENT_HAS_WAITERS != 0 {
            return None;
        }
        let counter = u32_at(page + 0x1c48);
        let limit = u32_at(page + 0x1c4c);
        if limit != 0 && counter >= limit {
            put_u32(page + 0x1c48, 0);
            return None;
        }
        put_u32(page + 0x1c48, counter.wrapping_add(1));
        let wake = if flags & EVENT_MANUAL != 0 {
            EVENT_PENDING_WAKE
        } else {
            0
        };
        *event_address = flags | EVENT_SIGNALED | wake;
        return Some(1);
    }
    let thread = u32_at(page + 0x34);
    if thread == 0 || thread > MUTEX_OWNER {
        return None;
    }
    let wait = id == 81;
    let timeout = if wait { guest.arg(1)? } else { 0 };
    if wait && flags & EVENT_VALID != 0 {
        if flags & (EVENT_MANUAL | EVENT_PENDING_WAKE) != 0 {
            return None;
        }
        if flags & EVENT_SIGNALED != 0 {
            *event_address = flags & !EVENT_SIGNALED;
            return Some(0);
        }
        return (timeout == 0).then_some(WAIT_TIMEOUT);
    }
    let mirror = u32_at(page + 0x1c50);
    if mirror == 0 {
        return None;
    }
    let address = mirror.checked_add(4 * slot)?;
    if !guest.span(address, 4, true) {
        return None;
    }
    let mutex = u32_at(address);
    if mutex & MUTEX_VALID == 0 || mutex & MUTEX_DECLINE != 0 {
        return None;
    }
    let owner = mutex & MUTEX_OWNER;
    let recursion = (mutex & MUTEX_RECURSION) >> 16;
    if wait {
        if owner == 0 {
            put_u32(address, MUTEX_VALID | thread | (1 << 16));
        } else if owner == thread {
            if recursion == 255 {
                return None;
            }
            put_u32(address, MUTEX_VALID | owner | ((recursion + 1) << 16));
        } else {
            return (timeout == 0).then_some(WAIT_TIMEOUT);
        }
        return Some(0);
    }
    if owner != thread {
        return None;
    }
    let next = if recursion > 1 {
        (mutex & !MUTEX_RECURSION) | ((recursion - 1) << 16)
    } else {
        mutex & !(MUTEX_OWNER | MUTEX_RECURSION)
    };
    put_u32(address, next);
    Some(1)
}

unsafe fn mark_fpu_slot(cpu_base: u32, top: u8, empty: u8) {
    *((cpu_base + FPU_TOP) as *mut u8) = top;
    *((cpu_base + FPU_EMPTY) as *mut u8) = empty;
    *((cpu_base + FPU_DIRTY) as *mut u8) = 1;
}

unsafe fn float_to_integer(guest: Guest) -> Option<u32> {
    let top = byte(guest.cpu_base + FPU_TOP) & 7;
    let empty = byte(guest.cpu_base + FPU_EMPTY);
    let register = guest.cpu_base + FPU_REGISTERS + 16 * u32::from(top);
    let exponent = read_unaligned((register + 8) as *const u16);
    if empty & (1 << top) != 0 || exponent != RELAXED_F80 {
        return None;
    }
    let value = read_unaligned(register as *const f64) as i64;
    mark_fpu_slot(guest.cpu_base, (top + 1) & 7, empty | (1 << top));
    put_u32(guest.cpu_base + REG32 + 8, (value >> 32) as u32);
    Some(value as u32)
}

unsafe fn absolute_double(guest: Guest) -> Option<u32> {
    let top = byte(guest.cpu_base + FPU_TOP).wrapping_sub(1) & 7;
    let empty = byte(guest.cpu_base + FPU_EMPTY);
    if empty & (1 << top) == 0 {
        return None;
    }
    let address = u32_at(guest.cpu_base + REG32 + 16).checked_add(4)?;
    if !guest.span(address, 8, false) {
        return None;
    }
    let bits = read_unaligned(address as *const u64) & 0x7fff_ffff_ffff_ffff;
    let register = guest.cpu_base + FPU_REGISTERS + 16 * u32::from(top);
    write_unaligned(register as *mut u64, bits);
    write_unaligned((register + 8) as *mut u16, RELAXED_F80);
    mark_fpu_slot(guest.cpu_base, top, empty & !(1 << top));
    Some(u32_at(guest.cpu_base + REG32))
}

unsafe fn performance_counter(guest: Guest, page: u32, frequency: bool) -> Option<u32> {
    let ptr = guest.arg(0)?;
    if ptr == 0 {
        return Some(0);
    }
    if !guest.span(ptr, 8, true) {
        return None;
    }
    let off = if frequency { 0x1c } else { 0x14 };
    let base = (u32_at(page + off) as u64) | ((u32_at(page + off + 4) as u64) << 32);
    let value = if frequency {
        base
    } else {
        base.wrapping_add(delta_us(guest.retired, page) as u64)
    };
    put_u32(ptr, value as u32);
    put_u32(ptr + 4, (value >> 32) as u32);
    Some(1)
}

unsafe fn delta_us(retired: u32, page: u32) -> u32 {
    u32_at(retired)
        .wrapping_sub(u32_at(page + 0x2c))
        .checked_div(u32_at(page + 0x30))
        .unwrap_or(0)
}

#[path = "reused/eagl_apply.rs"]
mod eagl_apply;
#[path = "reused/eagl_token.rs"]
mod eagl_token;

#[inline]
fn ftol_low32(value: f64) -> u32 {
    if !value.is_finite() || value >= 9223372036854775808.0 || value < -9223372036854775808.0 {
        0
    } else {
        (value as i64) as u32
    }
}

/// EAGL shader-constant converter (handler 128 in hypercall_eagl.rs).
/// Preflight all source/destination pages before mutating the guest so a
/// guard miss can fall through to the original conversion.
unsafe fn eagl_shader_constants(guest: Guest) -> Option<u32> {
    let desc = guest.arg(0)?;
    let dst = guest.arg(1)?;
    let src = guest.arg(2)?;
    let count = guest.arg(3)?;
    let mode = guest.read32(desc)?;
    let rows = guest.read32(desc.checked_add(0x14)?)?;
    let cols = guest.read32(desc.checked_add(0x18)?)?;
    if !(1..=3).contains(&mode) {
        return Some(0x8876086c);
    }
    if rows > 16 || cols > 16 || count > 4096 {
        return None;
    }
    let r = rows.min(4);
    let c = cols.min(4);
    if count == 0 || r == 0 || c == 0 {
        return Some(0);
    }
    let dst_stride = rows * cols * 4;
    let src_len = (count - 1) * 64 + (r - 1) * 16 + c * 4;
    let dst_len = (count - 1) * dst_stride + (r - 1) * cols * 4 + c * 4;
    if !guest.span(src, src_len, false) || !guest.span(dst, dst_len, true) {
        return None;
    }
    for i in 0..count {
        for row in 0..r {
            for col in 0..c {
                let bits = u32_at(src + i * 64 + row * 16 + col * 4);
                let value = if mode == 3 {
                    bits
                } else {
                    let truncated = ftol_low32(f32::from_bits(bits) as f64);
                    if mode == 2 {
                        truncated
                    } else {
                        (truncated != 0) as u32
                    }
                };
                put_u32(dst + i * dst_stride + (row * cols + col) * 4, value);
            }
        }
    }
    Some(0)
}

#[no_mangle]
pub unsafe extern "C" fn guest_span_readable(cpu_base: u32, address: u32, len: u32) -> u32 {
    Guest::new(cpu_base, 0).span(address, len, false) as u32
}

unsafe fn handle(guest: Guest, page: u32, id: u8) -> Option<u32> {
    match id {
        3 | 4 => performance_counter(guest, page, id == 4),
        5 => Some(u32_at(page + 0x24)),
        6 => {
            let value = guest.arg(0)?;
            let teb = u32_at(page + 0x28);
            if teb == 0 || !guest.span(teb.checked_add(0x34)?, 4, true) {
                return None;
            }
            put_u32(teb + 0x34, value);
            put_u32(page + 0x24, value);
            Some(0)
        }
        7..=10 => interlocked(guest, id),
        11 | 12 => critical_section(guest, page, id == 11),
        13 => Some(0),
        14 | 15 => {
            let ptr = guest.arg(if id == 14 { 1 } else { 0 })?;
            if !guest.span(ptr, 8, true) {
                return None;
            }
            let (x, y) = if id == 14 {
                (
                    u32_at(ptr).wrapping_sub(u32_at(page + 0x88)),
                    u32_at(ptr + 4).wrapping_sub(u32_at(page + 0x8c)),
                )
            } else {
                (u32_at(page + 0x80), u32_at(page + 0x84))
            };
            put_u32(ptr, x);
            put_u32(ptr + 4, y);
            Some(1)
        }
        16 => {
            let counter = u32_at(page + 0x94);
            if counter >= u32_at(page + 0x98) || u32_at(page + 0x90) != 0 {
                put_u32(page + 0x94, 0);
                return None;
            }
            put_u32(page + 0x94, counter + 1);
            Some(0)
        }
        17 => float_to_integer(guest),
        40 => absolute_double(guest),
        51 | 58 => {
            let start = guest.arg(0)?;
            if start == 0 {
                Some(0)
            } else {
                guest.length(start, if id == 51 { 2 } else { 1 })
            }
        }
        52 | 53 | 60 => string_copy(guest, if id == 60 { 1 } else { 2 }, id == 53),
        54 | 59 | 61 => guest.compare(
            guest.arg(0)?,
            guest.arg(1)?,
            if id == 54 { 2 } else { 1 },
            id != 59,
            u32::MAX,
        ),
        55 => {
            let start = guest.arg(0)?;
            let needle = guest.arg(1)? & 0xffff;
            if start == 0 {
                return Some(0);
            }
            for i in 0..SCAN_LIMIT {
                let at = start.checked_add(i * 2)?;
                let ch = guest.unit(at, 2)?;
                if ch == needle {
                    return Some(at);
                }
                if ch == 0 {
                    return Some(0);
                }
            }
            None
        }
        56 | 57 | 62 | 84 | 85 => {
            let first = guest.arg(0)?;
            let second = guest.arg(1)?;
            let len = guest.arg(2)?;
            if len > 0x0100_0000 {
                return None;
            }
            match id {
                56 | 84 => {
                    if !guest.span(first, len, true) || !guest.span(second, len, false) {
                        return None;
                    }
                    if len != 0 {
                        copy(second as *const u8, first as *mut u8, len as usize);
                    }
                    Some(first)
                }
                57 => {
                    if !guest.span(first, len, true) {
                        return None;
                    }
                    if len != 0 {
                        write_bytes(first as *mut u8, second as u8, len as usize);
                    }
                    Some(first)
                }
                62 => {
                    if !guest.span(first, len, false) || !guest.span(second, len, false) {
                        return None;
                    }
                    for i in 0..len {
                        let diff = byte(first + i) as i32 - byte(second + i) as i32;
                        if diff != 0 {
                            return Some(diff as u32);
                        }
                    }
                    Some(0)
                }
                _ => {
                    if !guest.span(first, len, false) {
                        return None;
                    }
                    for i in 0..len {
                        if byte(first + i) == second as u8 {
                            return Some(first + i);
                        }
                    }
                    Some(0)
                }
            }
        }
        63 => {
            if guest.arg(0)? != 0 {
                return None;
            }
            if u32_at(page + 0x9c) == 0 {
                return Some(0);
            }
            let counter = u32_at(page + 0xa0);
            if counter >= u32_at(page + 0xa4) {
                put_u32(page + 0xa0, 0);
                return None;
            }
            put_u32(page + 0xa0, counter + 1);
            Some(0)
        }
        64 | 86 => tls(guest, page, id == 86),
        65 => {
            let seed = u32_at(page + 0xb0)
                .wrapping_mul(214013)
                .wrapping_add(2531011);
            put_u32(page + 0xb0, seed);
            Some((seed >> 16) & 0x7fff)
        }
        66 | 75 => substring(guest, if id == 66 { 2 } else { 1 }),
        67 | 74 => {
            let count = guest.arg(2)?;
            let limit = if id == 67 && count == 0 {
                SCAN_LIMIT
            } else {
                count
            };
            guest.compare(
                guest.arg(0)?,
                guest.arg(1)?,
                if id == 67 { 2 } else { 1 },
                true,
                limit,
            )
        }
        76 => atoi(guest),
        68 => wcsncpy(guest),
        70 | 71 => heap_slab::dispatch(guest, page, id == 70),
        72 | 80 | 81 => synchronization_mirror(guest, page, id),
        73 => {
            let tid = u32_at(page + 0x34);
            (tid != 0).then_some(tid)
        }
        77 => {
            use rtti::RtDynamicCastResult;
            match rtti::rt_dynamic_cast(
                guest,
                guest.arg(0)?,
                guest.arg(1)? as i32,
                guest.arg(2)?,
                guest.arg(3)?,
                guest.arg(4)? as i32,
            ) {
                RtDynamicCastResult::Success(addr) => Some(addr),
                RtDynamicCastResult::FailNull => Some(0),
                RtDynamicCastResult::FailBadCast => None,
            }
        }
        78 | 79 => {
            let ptr = guest.arg(0)?;
            let size = guest.arg(1)?;
            if size == 0 {
                return Some(0);
            }
            if ptr == 0 || u64::from(ptr) + u64::from(size) > u64::from(guest.size) {
                return Some(1);
            }
            guest.span(ptr, size, false).then_some(0)
        }
        82 => Some(u32_at(page + 0xb4)),
        83 => {
            let handle = guest.arg(0)?;
            for i in 0..32 {
                let entry = page + 0x2800 + 8 * i;
                let candidate = u32_at(entry);
                if candidate == 0 {
                    break;
                }
                if candidate == handle {
                    return (u32_at(entry + 4) == 0).then_some(0);
                }
            }
            None
        }
        128 => eagl_shader_constants(guest),
        129..=131 => eagl_apply::dispatch_apply(guest, id),
        132 => eagl_token::dispatch(guest, page),
        _ => None,
    }
}

#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn supports_handler(id: u32) -> u32 {
    matches!(id, 1 | 3..=17 | 40 | 51..=68 | 70..=86 | 128..=132) as u32
}

#[no_mangle]
pub unsafe extern "C" fn dispatch(
    page: u32,
    store_map: u32,
    cpu_base: u32,
    function_id: u32,
) -> u32 {
    let handler = lookup_handler(page, function_id);
    if handler == 0 {
        return 0;
    }
    if handler == 1 {
        record_success(
            page,
            handler,
            cpu_base + REG32,
            tick_count(page, cpu_base + RETIRED),
        );
        return 1;
    }
    dispatch_handler(Guest::new(cpu_base, store_map), page, handler) as u32
}

/// Called directly from a translated OUT. The host-created config holds offsets
/// for [hypercall page, store map, compatibility state, WWT GPR, WWT retired].
/// Return 0 when this is not an integer hypercall, -1 when it declines, 1 on success.
#[no_mangle]
pub unsafe extern "C" fn dispatch_integer_native(config: u32, wwt_cpu: u32) -> i32 {
    let page = u32_at(config);
    let regs = wwt_cpu + u32_at(config + 12);
    if u32_at(regs + 8) & 0xffff != 0xb077 {
        return 0;
    }
    let handler = lookup_handler(page, u32_at(regs));
    if matches!(handler, 0 | 17..=45) {
        return 0;
    }
    let store_map = u32_at(config + 4);
    let cpu_base = u32_at(config + 8);
    let retired = wwt_cpu + u32_at(config + 16);
    let before = u32_at(retired);
    put_u32(retired, before.wrapping_add(1));
    if handler == 1 {
        record_success(page, handler, regs, tick_count(page, retired));
        return 1;
    }
    let guest = Guest::with_registers(cpu_base, store_map, regs, retired);
    if dispatch_handler(guest, page, handler) {
        1
    } else {
        put_u32(retired, before);
        -1
    }
}

unsafe fn lookup_handler(page: u32, function_id: u32) -> u8 {
    if function_id == 0 || function_id >= 65536 || u32_at(page + 8) == 0 {
        return 0;
    }
    let offset = if function_id < 4096 {
        0x100 + function_id
    } else {
        0x4000 + function_id - 4096
    };
    let handler = byte(page + offset);
    if supports_handler(handler as u32) != 0 {
        handler
    } else {
        0
    }
}

#[inline]
unsafe fn tick_count(page: u32, retired: u32) -> u32 {
    u32_at(page + 0x10).wrapping_add(delta_us(retired, page) / 1000)
}

#[inline]
unsafe fn record_success(page: u32, handler: u8, regs: u32, eax: u32) {
    let counter = page + 0x2000 + 4 * handler as u32;
    put_u32(counter, u32_at(counter).saturating_add(1));
    put_u32(regs, eax);
    put_u32(page + 0xc, u32_at(page + 0xc).wrapping_add(1));
}

unsafe fn dispatch_handler(guest: Guest, page: u32, handler: u8) -> bool {
    if let Some(eax) = handle(guest, page, handler) {
        record_success(page, handler, guest.regs, eax);
        return true;
    }
    let counter = page + 0x2400 + 4 * handler as u32;
    put_u32(counter, u32_at(counter).saturating_add(1));
    false
}
