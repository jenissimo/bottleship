//! PPMd var-H/I decoder for RAR3 (port of unrar's model.cpp,
//! suballoc.cpp, coder.cpp — Shkarin's public-domain PPMd with
//! Subbotin's carry-less range coder).
//!
//! The C++ original works raw pointers into one malloc'd heap; this
//! port uses `u32` byte offsets into a `Vec<u8>` heap. One allocation
//! unit is `UNIT_SIZE` bytes. A context occupies one unit:
//! `num_stats u16 | summ_freq u16 | stats u32 | one_state {symbol u8,
//! freq u8, successor u32} | suffix u32`. A state occupies
//! `STATE_STRIDE = UNIT_SIZE/2` bytes so `stats + i` indexing matches
//! the C++ `RARPPM_STATE*` stride ratio. The free-block header
//! (stamp/nu/next/prev) is 12 bytes. Address arithmetic mirrors the
//! original's FIXED_UNIT_SIZE compensation, so the pText-vs-context
//! pointer comparisons (text successors vs real contexts) behave
//! identically for valid streams.
#![forbid(unsafe_code)]

const MAX_O: usize = 64;
const TOP: u32 = 1 << 24;
const BOT: u32 = 1 << 15;

const PERIOD_BITS: u32 = 7;
const TOT_BITS: u32 = 14;
const BIN_SCALE: u32 = 1 << TOT_BITS;
const INTERVAL: u32 = 1 << 7;
const MAX_FREQ: u32 = 124;

const UNIT_SIZE: usize = 20;
const FIXED_UNIT_SIZE: usize = 12;
const STATE_STRIDE: usize = UNIT_SIZE / 2;

const N1: usize = 4;
const N2: usize = 4;
const N3: usize = 4;
const N4: usize = (128 + 3 - N1 - 2 * N2 - 3 * N3) / 4;
const N_INDEXES: usize = N1 + N2 + N3 + N4;

// Context field offsets within a unit.
const C_NUM_STATS: usize = 0;
const C_SUMM_FREQ: usize = 2;
const C_STATS: usize = 4;
const C_OS: usize = 8; // one_state: symbol u8, freq u8, successor u32
const C_SUFFIX: usize = 14;

// Free-block header fields.
const B_STAMP: usize = 0;
const B_NU: usize = 2;
const B_NEXT: usize = 4;
const B_PREV: usize = 8;

/// The range coder's byte source, mirroring `Unpack::GetChar`.
pub trait ByteSource {
    fn get_char(&mut self) -> u8;
}

// ------------------------------------------------------------------
// Range coder (coder.cpp)

#[derive(Default)]
pub struct SubRange {
    pub low_count: u32,
    pub high_count: u32,
    pub scale: u32,
}

struct RangeCoder {
    low: u32,
    code: u32,
    range: u32,
    sub_range: SubRange,
}

impl RangeCoder {
    fn new() -> Self {
        Self {
            low: 0,
            code: 0,
            range: 0,
            sub_range: SubRange::default(),
        }
    }

    fn init_decoder(&mut self, src: &mut dyn ByteSource) {
        self.low = 0;
        self.code = 0;
        self.range = 0xFFFF_FFFF;
        for _ in 0..4 {
            self.code = (self.code << 8) | u32::from(src.get_char());
        }
    }

    fn get_current_count(&mut self) -> i32 {
        self.range /= self.sub_range.scale;
        (self.code.wrapping_sub(self.low) / self.range) as i32
    }

    fn get_current_shift_count(&mut self, shift: u32) -> u32 {
        self.range >>= shift;
        self.code.wrapping_sub(self.low) / self.range
    }

    fn decode(&mut self) {
        self.low = self
            .low
            .wrapping_add(self.range.wrapping_mul(self.sub_range.low_count));
        self.range = self
            .range
            .wrapping_mul(self.sub_range.high_count - self.sub_range.low_count);
    }

    /// ARI_DEC_NORMALIZE.
    fn dec_normalize(&mut self, src: &mut dyn ByteSource) {
        loop {
            if (self.low ^ self.low.wrapping_add(self.range)) < TOP {
            } else if self.range < BOT {
                self.range = self.low.wrapping_neg() & (BOT - 1);
            } else {
                break;
            }
            self.code = (self.code << 8) | u32::from(src.get_char());
            self.range <<= 8;
            self.low <<= 8;
        }
    }
}

// ------------------------------------------------------------------
// SubAllocator (suballoc.cpp)

struct SubAllocator {
    heap: Vec<u8>,
    sub_allocator_size: usize,
    p_text: usize,
    lo_unit: usize,
    hi_unit: usize,
    units_start: usize,
    fake_units_start: usize,
    heap_end: usize,
    indx2_units: [u8; N_INDEXES],
    units2_indx: [u8; 128],
    glue_count: u8,
    free_list: [u32; N_INDEXES],
}

fn u2b(nu: u8) -> usize {
    UNIT_SIZE * nu as usize
}

impl SubAllocator {
    fn new() -> Self {
        Self {
            heap: Vec::new(),
            sub_allocator_size: 0,
            p_text: 0,
            lo_unit: 0,
            hi_unit: 0,
            units_start: 0,
            fake_units_start: 0,
            heap_end: 0,
            indx2_units: [0; N_INDEXES],
            units2_indx: [0; 128],
            glue_count: 0,
            free_list: [0; N_INDEXES],
        }
    }

    fn stop_sub_allocator(&mut self) {
        if self.sub_allocator_size != 0 {
            self.sub_allocator_size = 0;
            self.heap = Vec::new();
        }
    }

    fn start_sub_allocator(&mut self, sa_size_mb: usize) -> Result<(), ()> {
        let t = sa_size_mb << 20;
        if self.sub_allocator_size == t {
            return Ok(());
        }
        self.stop_sub_allocator();
        let alloc_size = t / FIXED_UNIT_SIZE * UNIT_SIZE + 2 * UNIT_SIZE;
        if alloc_size > 0x7FFF_FFFF {
            return Err(());
        }
        self.heap = vec![0u8; alloc_size];
        self.heap_end = alloc_size - UNIT_SIZE;
        self.sub_allocator_size = t;
        Ok(())
    }

    fn init_sub_allocator(&mut self) {
        self.free_list = [0; N_INDEXES];
        self.p_text = 0;

        let t = self.sub_allocator_size;
        let size2 = FIXED_UNIT_SIZE * (t / 8 / FIXED_UNIT_SIZE * 7);
        let real_size2 = size2 / FIXED_UNIT_SIZE * UNIT_SIZE;
        let size1 = t - size2;
        let real_size1 = size1 / FIXED_UNIT_SIZE * UNIT_SIZE + UNIT_SIZE;

        self.lo_unit = real_size1;
        self.units_start = real_size1;
        self.fake_units_start = size1;
        self.hi_unit = self.lo_unit + real_size2;

        let mut k = 1usize;
        let mut i = 0usize;
        while i < N1 {
            self.indx2_units[i] = k as u8;
            i += 1;
            k += 1;
        }
        k += 1;
        while i < N1 + N2 {
            self.indx2_units[i] = k as u8;
            i += 1;
            k += 2;
        }
        k += 1;
        while i < N1 + N2 + N3 {
            self.indx2_units[i] = k as u8;
            i += 1;
            k += 3;
        }
        k += 1;
        while i < N1 + N2 + N3 + N4 {
            self.indx2_units[i] = k as u8;
            i += 1;
            k += 4;
        }
        self.glue_count = 0;
        let mut i = 0usize;
        let mut k = 0usize;
        while k < 128 {
            i += usize::from((self.indx2_units[i] as usize) < k + 1);
            self.units2_indx[k] = i as u8;
            k += 1;
        }
    }

    fn insert_node(&mut self, p: usize, indx: usize) {
        let next = self.free_list[indx];
        self.blk_set_next(p, next);
        self.free_list[indx] = p as u32;
    }

    fn remove_node(&mut self, indx: usize) -> usize {
        let ret = self.free_list[indx] as usize;
        self.free_list[indx] = self.blk_next(ret);
        ret
    }

    fn rd16(&self, o: usize) -> u16 {
        u16::from_le_bytes([self.heap[o], self.heap[o + 1]])
    }
    fn wr16(&mut self, o: usize, v: u16) {
        self.heap[o..o + 2].copy_from_slice(&v.to_le_bytes());
    }
    fn rd32(&self, o: usize) -> u32 {
        u32::from_le_bytes(self.heap[o..o + 4].try_into().expect("4"))
    }
    fn wr32(&mut self, o: usize, v: u32) {
        self.heap[o..o + 4].copy_from_slice(&v.to_le_bytes());
    }

    fn blk_stamp(&self, o: usize) -> u16 {
        self.rd16(o + B_STAMP)
    }
    fn blk_set_stamp(&mut self, o: usize, v: u16) {
        self.wr16(o + B_STAMP, v);
    }
    fn blk_nu(&self, o: usize) -> u16 {
        self.rd16(o + B_NU)
    }
    fn blk_set_nu(&mut self, o: usize, v: u16) {
        self.wr16(o + B_NU, v);
    }
    fn blk_next(&self, o: usize) -> u32 {
        self.rd32(o + B_NEXT)
    }
    fn blk_set_next(&mut self, o: usize, v: u32) {
        self.wr32(o + B_NEXT, v);
    }
    fn blk_prev(&self, o: usize) -> u32 {
        self.rd32(o + B_PREV)
    }
    fn blk_set_prev(&mut self, o: usize, v: u32) {
        self.wr32(o + B_PREV, v);
    }

    fn mb_ptr(&self, base: usize, items: u16) -> usize {
        base + UNIT_SIZE * items as usize
    }

    fn split_block(&mut self, pv: usize, old_indx: usize, new_indx: usize) {
        let mut u_diff =
            i32::from(self.indx2_units[old_indx]) - i32::from(self.indx2_units[new_indx]);
        let mut p = pv + u2b(self.indx2_units[new_indx]);
        let mut i = self.units2_indx[(u_diff - 1) as usize] as usize;
        if i32::from(self.indx2_units[i]) != u_diff {
            i -= 1;
            self.insert_node(p, i);
            p += u2b(self.indx2_units[i]);
            u_diff -= i32::from(self.indx2_units[i]);
        }
        self.insert_node(p, self.units2_indx[(u_diff - 1) as usize] as usize);
    }

    /// GlueFreeBlocks. The C++ stack sentinel `s0` is represented by
    /// `SENT` offsets; its link words live in locals because the
    /// sentinel is not heap storage. A prev/next word of 0 in a list
    /// member means "points at the sentinel".
    fn glue_free_blocks(&mut self) {
        const SENT: usize = usize::MAX;
        let mut sent_next = SENT;
        if self.lo_unit != self.hi_unit {
            self.heap[self.lo_unit] = 0;
        }
        for i in 0..N_INDEXES {
            while self.free_list[i] != 0 {
                let p = self.remove_node(i);
                // p->insertAt(&s0)
                let old_next = sent_next;
                self.blk_set_prev(p, 0);
                self.blk_set_next(p, old_next as u32);
                match old_next {
                    SENT => {}
                    o => self.blk_set_prev(o, 0),
                }
                sent_next = p;
                self.blk_set_stamp(p, 0xFFFF);
                self.blk_set_nu(p, u16::from(self.indx2_units[i]));
            }
        }
        let next_of = |sa: &Self, p: usize| -> usize {
            let n = sa.blk_next(p);
            if n == 0 {
                SENT
            } else {
                n as usize
            }
        };
        let prev_of = |sa: &Self, p: usize| -> usize {
            let v = sa.blk_prev(p);
            if v == 0 {
                SENT
            } else {
                v as usize
            }
        };
        let mut p = sent_next;
        while p != SENT {
            let p1 = self.mb_ptr(p, self.blk_nu(p));
            while self.blk_stamp(p1) == 0xFFFF
                && i32::from(self.blk_nu(p)) + i32::from(self.blk_nu(p1)) < 0x10000
            {
                // p1->remove()
                let prev = prev_of(self, p1);
                let next = next_of(self, p1);
                match prev {
                    SENT => sent_next = next,
                    o => self.blk_set_next(o, next as u32),
                }
                if next != SENT {
                    self.blk_set_prev(next, prev as u32);
                }
                self.blk_set_nu(p, self.blk_nu(p) + self.blk_nu(p1));
            }
            p = next_of(self, p);
        }
        while sent_next != SENT {
            let p = sent_next;
            let next = next_of(self, p);
            // p->remove()
            sent_next = next;
            if next != SENT {
                self.blk_set_prev(next, 0);
            }
            let mut sz = self.blk_nu(p) as usize;
            let mut q = p;
            while sz > 128 {
                self.insert_node(q, N_INDEXES - 1);
                q = self.mb_ptr(q, 128);
                sz -= 128;
            }
            let mut i = self.units2_indx[sz - 1] as usize;
            if self.indx2_units[i] as usize != sz {
                i -= 1;
                let k = sz - self.indx2_units[i] as usize;
                self.insert_node(self.mb_ptr(q, (sz - k) as u16), k - 1);
            }
            self.insert_node(q, i);
        }
    }

    fn alloc_units_rare(&mut self, indx: usize) -> usize {
        if self.glue_count == 0 {
            self.glue_count = 255;
            self.glue_free_blocks();
            if self.free_list[indx] != 0 {
                return self.remove_node(indx);
            }
        }
        let mut i = indx;
        loop {
            i += 1;
            if i == N_INDEXES {
                self.glue_count -= 1;
                let alloc_bytes = u2b(self.indx2_units[indx]);
                let j = FIXED_UNIT_SIZE * self.indx2_units[indx] as usize;
                if self.fake_units_start.saturating_sub(self.p_text) > j
                    && self.units_start >= alloc_bytes
                {
                    self.fake_units_start -= j;
                    self.units_start -= alloc_bytes;
                    return self.units_start;
                }
                return 0;
            }
            if self.free_list[i] != 0 {
                break;
            }
        }
        let ret = self.remove_node(i);
        self.split_block(ret, i, indx);
        ret
    }

    fn alloc_units(&mut self, nu: usize) -> usize {
        let indx = self.units2_indx[nu - 1] as usize;
        if self.free_list[indx] != 0 {
            return self.remove_node(indx);
        }
        let ret = self.lo_unit;
        self.lo_unit += u2b(self.indx2_units[indx]);
        if self.lo_unit <= self.hi_unit {
            return ret;
        }
        self.lo_unit -= u2b(self.indx2_units[indx]);
        self.alloc_units_rare(indx)
    }

    fn alloc_context(&mut self) -> usize {
        if self.hi_unit != self.lo_unit {
            self.hi_unit -= UNIT_SIZE;
            return self.hi_unit;
        }
        if self.free_list[0] != 0 {
            return self.remove_node(0);
        }
        self.alloc_units_rare(0)
    }

    fn expand_units(&mut self, old_ptr: usize, old_nu: usize) -> usize {
        let i0 = self.units2_indx[old_nu - 1] as usize;
        let i1 = self.units2_indx[old_nu] as usize;
        if i0 == i1 {
            return old_ptr;
        }
        let ptr = self.alloc_units(old_nu + 1);
        if ptr != 0 {
            let bytes = u2b(self.indx2_units[i0]);
            self.heap.copy_within(old_ptr..old_ptr + bytes, ptr);
            self.insert_node(old_ptr, i0);
        }
        ptr
    }

    fn shrink_units(&mut self, old_ptr: usize, old_nu: usize, new_nu: usize) -> usize {
        let i0 = self.units2_indx[old_nu - 1] as usize;
        let i1 = self.units2_indx[new_nu - 1] as usize;
        if i0 == i1 {
            return old_ptr;
        }
        if self.free_list[i1] != 0 {
            let ptr = self.remove_node(i1);
            let bytes = u2b(self.indx2_units[i1]);
            self.heap.copy_within(old_ptr..old_ptr + bytes, ptr);
            self.insert_node(old_ptr, i0);
            ptr
        } else {
            self.split_block(old_ptr, i0, i1);
            old_ptr
        }
    }

    fn free_units(&mut self, ptr: usize, old_nu: usize) {
        self.insert_node(ptr, self.units2_indx[old_nu - 1] as usize);
    }
}

// ------------------------------------------------------------------
// SEE2 contexts and states

#[derive(Clone, Copy, Default)]
struct See2Context {
    summ: u16,
    shift: u8,
    count: u8,
}

impl See2Context {
    fn init(&mut self, init_val: u32) {
        self.shift = PERIOD_BITS as u8 - 4;
        self.summ = (init_val << self.shift) as u16;
        self.count = 4;
    }
    fn get_mean(&mut self) -> u32 {
        let ret_val = (self.summ as i16) >> self.shift;
        self.summ = self.summ.wrapping_sub(ret_val as u16);
        (ret_val as u32) + u32::from(ret_val == 0)
    }
    fn update(&mut self) {
        if self.shift < PERIOD_BITS as u8 {
            self.count -= 1;
            if self.count == 0 {
                self.summ = self.summ.wrapping_add(self.summ);
                self.count = 3 << self.shift;
                self.shift += 1;
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct StateVal {
    symbol: u8,
    freq: u8,
    successor: u32,
}

const EXP_ESCAPE: [u8; 16] = [25, 14, 9, 7, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 2];

fn get_mean(summ: u32, shift: u32, round: u32) -> u32 {
    (summ + (1 << (shift - round))) >> shift
}

// ------------------------------------------------------------------
// ModelPPM (model.cpp)

pub struct ModelPPM {
    min_context: u32,
    max_context: u32,
    found_state: u32,
    num_masked: i32,
    init_esc: i32,
    order_fall: i32,
    max_order: i32,
    run_length: i32,
    init_rl: i32,
    char_mask: [u8; 256],
    ns2_indx: [u8; 256],
    ns2bs_indx: [u8; 256],
    hb2_flag: [u8; 256],
    esc_count: u8,
    prev_success: u8,
    hi_bits_flag: u8,
    bin_summ: [[u16; 64]; 128],
    see2_cont: [[See2Context; 16]; 25],
    dummy_see2_cont: See2Context,
    coder: RangeCoder,
    sub_alloc: SubAllocator,
}

impl Default for ModelPPM {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelPPM {
    pub fn new() -> Self {
        Self {
            min_context: 0,
            max_context: 0,
            found_state: 0,
            num_masked: 0,
            init_esc: 0,
            order_fall: 0,
            max_order: 0,
            run_length: 0,
            init_rl: 0,
            char_mask: [0; 256],
            ns2_indx: [0; 256],
            ns2bs_indx: [0; 256],
            hb2_flag: [0; 256],
            esc_count: 0,
            prev_success: 0,
            hi_bits_flag: 0,
            bin_summ: [[0; 64]; 128],
            see2_cont: [[See2Context::default(); 16]; 25],
            dummy_see2_cont: See2Context::default(),
            coder: RangeCoder::new(),
            sub_alloc: SubAllocator::new(),
        }
    }

    // -- heap field accessors -------------------------------------

    fn ctx_num_stats(&self, o: u32) -> u16 {
        self.sub_alloc.rd16(o as usize + C_NUM_STATS)
    }
    fn ctx_set_num_stats(&mut self, o: u32, v: u16) {
        self.sub_alloc.wr16(o as usize + C_NUM_STATS, v);
    }
    fn ctx_summ_freq(&self, o: u32) -> u16 {
        self.sub_alloc.rd16(o as usize + C_SUMM_FREQ)
    }
    fn ctx_set_summ_freq(&mut self, o: u32, v: u16) {
        self.sub_alloc.wr16(o as usize + C_SUMM_FREQ, v);
    }
    fn ctx_stats(&self, o: u32) -> u32 {
        self.sub_alloc.rd32(o as usize + C_STATS)
    }
    fn ctx_set_stats(&mut self, o: u32, v: u32) {
        self.sub_alloc.wr32(o as usize + C_STATS, v);
    }
    fn ctx_suffix(&self, o: u32) -> u32 {
        self.sub_alloc.rd32(o as usize + C_SUFFIX)
    }
    fn ctx_set_suffix(&mut self, o: u32, v: u32) {
        self.sub_alloc.wr32(o as usize + C_SUFFIX, v);
    }
    fn one_state(&self, ctx: u32) -> u32 {
        ctx + C_OS as u32
    }
    fn state_read(&self, o: u32) -> StateVal {
        StateVal {
            symbol: self.sub_alloc.heap[o as usize],
            freq: self.sub_alloc.heap[o as usize + 1],
            successor: self.sub_alloc.rd32(o as usize + 2),
        }
    }
    fn state_write(&mut self, o: u32, st: &StateVal) {
        self.sub_alloc.heap[o as usize] = st.symbol;
        self.sub_alloc.heap[o as usize + 1] = st.freq;
        self.sub_alloc.wr32(o as usize + 2, st.successor);
    }
    fn state_set_successor(&mut self, o: u32, v: u32) {
        self.sub_alloc.wr32(o as usize + 2, v);
    }
    fn swap_states(&mut self, a: u32) {
        let x = self.state_read(a);
        let y = self.state_read(a - STATE_STRIDE as u32);
        self.state_write(a, &y);
        self.state_write(a - STATE_STRIDE as u32, &x);
    }

    /// Find the state with `symbol` in a multi-stat context; 0 = not
    /// found (corrupt data).
    fn find_state(&self, ctx: u32, symbol: u8) -> u32 {
        let stats = self.ctx_stats(ctx);
        let n = self.ctx_num_stats(ctx) as u32;
        let mut p = stats;
        for _ in 0..n {
            if self.state_read(p).symbol == symbol {
                return p;
            }
            p += STATE_STRIDE as u32;
        }
        0
    }

    // -- model setup ----------------------------------------------

    fn restart_model_rare(&mut self) -> Result<(), ()> {
        self.char_mask = [0; 256];
        self.sub_alloc.init_sub_allocator();
        self.init_rl = -(if self.max_order < 12 {
            self.max_order
        } else {
            12
        }) - 1;
        let ctx = self.sub_alloc.alloc_context() as u32;
        if ctx == 0 {
            return Err(());
        }
        self.min_context = ctx;
        self.max_context = ctx;
        self.ctx_set_suffix(ctx, 0);
        self.order_fall = self.max_order;
        self.ctx_set_num_stats(ctx, 256);
        self.ctx_set_summ_freq(ctx, 257);
        let stats = self.sub_alloc.alloc_units(256 / 2) as u32;
        self.found_state = stats;
        self.ctx_set_stats(ctx, stats);
        if stats == 0 {
            return Err(());
        }
        self.run_length = self.init_rl;
        self.prev_success = 0;
        for i in 0..256u32 {
            self.state_write(
                stats + i * STATE_STRIDE as u32,
                &StateVal {
                    symbol: i as u8,
                    freq: 1,
                    successor: 0,
                },
            );
        }

        const INIT_BIN_ESC: [u16; 8] = [
            0x3CDD, 0x1F3F, 0x59BF, 0x48F3, 0x64A1, 0x5ABC, 0x6632, 0x6051,
        ];
        for (i, row) in self.bin_summ.iter_mut().enumerate() {
            for (k, esc) in INIT_BIN_ESC.iter().enumerate() {
                let mut m = k;
                while m < 64 {
                    row[m] = BIN_SCALE.wrapping_sub(u32::from(*esc) / (i as u32 + 2)) as u16;
                    m += 8;
                }
            }
        }
        for i in 0..25usize {
            for k in 0..16usize {
                self.see2_cont[i][k].init(5 * i as u32 + 10);
            }
        }
        Ok(())
    }

    fn start_model_rare(&mut self, max_order: i32) -> Result<(), ()> {
        self.esc_count = 1;
        self.max_order = max_order;
        self.restart_model_rare()?;
        self.ns2bs_indx[0] = 0;
        self.ns2bs_indx[1] = 2;
        for b in self.ns2bs_indx.iter_mut().take(11).skip(2) {
            *b = 4;
        }
        for b in self.ns2bs_indx.iter_mut().skip(11) {
            *b = 6;
        }
        for (i, v) in self.ns2_indx.iter_mut().enumerate().take(3) {
            *v = i as u8;
        }
        let mut m = 3usize;
        let mut step = 1usize;
        let mut k = step;
        for v in self.ns2_indx.iter_mut().skip(3) {
            *v = m as u8;
            k -= 1;
            if k == 0 {
                step += 1;
                k = step;
                m += 1;
            }
        }
        for b in self.hb2_flag.iter_mut().take(0x40) {
            *b = 0;
        }
        for b in self.hb2_flag.iter_mut().skip(0x40) {
            *b = 0x08;
        }
        self.dummy_see2_cont.shift = PERIOD_BITS as u8;
        Ok(())
    }

    // -- context operations ---------------------------------------

    fn create_child(&mut self, ctx: u32, p_stats: u32, first_state: &StateVal) -> u32 {
        let pc = self.sub_alloc.alloc_context() as u32;
        if pc != 0 {
            self.ctx_set_num_stats(pc, 1);
            self.state_write(self.one_state(pc), first_state);
            self.ctx_set_suffix(pc, ctx);
            self.state_set_successor(p_stats, pc);
        }
        pc
    }

    fn rescale(&mut self, ctx: u32) {
        let old_ns = self.ctx_num_stats(ctx) as i32;
        let mut i = old_ns - 1;
        let stats = self.ctx_stats(ctx);
        // Move the found state to the front.
        let mut p = self.found_state;
        while p != stats {
            self.swap_states(p);
            p -= STATE_STRIDE as u32;
        }
        let mut st = self.state_read(stats);
        st.freq = st.freq.wrapping_add(4);
        self.state_write(stats, &st);
        let mut summ_freq = self.ctx_summ_freq(ctx).wrapping_add(4);
        self.ctx_set_summ_freq(ctx, summ_freq);
        let mut esc_freq = i32::from(summ_freq) - i32::from(st.freq);
        let adder = i32::from(self.order_fall != 0);
        st.freq = ((i32::from(st.freq) + adder) >> 1) as u8;
        summ_freq = u16::from(st.freq);
        self.state_write(stats, &st);
        let mut p = stats;
        loop {
            p += STATE_STRIDE as u32;
            let mut st = self.state_read(p);
            esc_freq -= i32::from(st.freq);
            st.freq = ((i32::from(st.freq) + adder) >> 1) as u8;
            summ_freq = summ_freq.wrapping_add(u16::from(st.freq));
            self.state_write(p, &st);
            if st.freq > self.state_read(p - STATE_STRIDE as u32).freq {
                let tmp = st;
                let mut p1 = p;
                loop {
                    self.state_write(p1, &self.state_read(p1 - STATE_STRIDE as u32));
                    p1 -= STATE_STRIDE as u32;
                    if p1 == stats || tmp.freq <= self.state_read(p1 - STATE_STRIDE as u32).freq {
                        break;
                    }
                }
                self.state_write(p1, &tmp);
            }
            i = i.wrapping_sub(1);
            if i == 0 {
                break;
            }
        }
        if self.state_read(p).freq == 0 {
            loop {
                i += 1;
                p -= STATE_STRIDE as u32;
                if self.state_read(p).freq != 0 || p == stats {
                    break;
                }
            }
            esc_freq += i;
            let new_ns = self.ctx_num_stats(ctx) as i32 - i;
            self.ctx_set_num_stats(ctx, new_ns as u16);
            if new_ns == 1 {
                let mut tmp = self.state_read(stats);
                loop {
                    tmp.freq -= tmp.freq >> 1;
                    esc_freq >>= 1;
                    if esc_freq <= 1 {
                        break;
                    }
                }
                self.sub_alloc
                    .free_units(stats as usize, ((old_ns + 1) >> 1) as usize);
                self.state_write(self.one_state(ctx), &tmp);
                self.found_state = self.one_state(ctx);
                return;
            }
        }
        esc_freq -= esc_freq >> 1;
        summ_freq = summ_freq.wrapping_add(esc_freq as u16);
        self.ctx_set_summ_freq(ctx, summ_freq);
        let n0 = ((old_ns + 1) >> 1) as usize;
        let n1 = ((self.ctx_num_stats(ctx) as i32 + 1) >> 1) as usize;
        if n0 != n1 {
            let new_stats = self.sub_alloc.shrink_units(stats as usize, n0, n1) as u32;
            self.ctx_set_stats(ctx, new_stats);
        }
        self.found_state = self.ctx_stats(ctx);
    }

    fn create_successors(&mut self, skip: bool, p1: u32) -> u32 {
        let mut pc = self.min_context;
        let up_branch = self.state_read(self.found_state).successor;
        let mut ps = [0u32; MAX_O];
        let mut pps = 0usize;
        if !skip {
            ps[pps] = self.found_state;
            pps += 1;
            if self.ctx_suffix(pc) == 0 {
                return self.cs_tail(pc, &ps, pps, up_branch);
            }
        }
        // The p1 entry point starts at suffix(min_context) with p
        // given; every later iteration descends one more suffix and
        // searches for the found symbol there.
        let mut p = 0u32;
        if p1 != 0 {
            pc = self.ctx_suffix(pc);
            p = p1;
        }
        loop {
            if p == 0 {
                pc = self.ctx_suffix(pc);
                p = if self.ctx_num_stats(pc) != 1 {
                    self.find_state(pc, self.state_read(self.found_state).symbol)
                } else {
                    self.one_state(pc)
                };
                if p == 0 {
                    return 0;
                }
            }
            if self.state_read(p).successor != up_branch {
                pc = self.state_read(p).successor;
                break;
            }
            if pps >= MAX_O {
                return 0;
            }
            ps[pps] = p;
            pps += 1;
            p = 0;
            if self.ctx_suffix(pc) == 0 {
                break;
            }
        }
        self.cs_tail(pc, &ps, pps, up_branch)
    }

    fn cs_tail(&mut self, pc: u32, ps: &[u32; MAX_O], pps: usize, up_branch: u32) -> u32 {
        if pps == 0 {
            return pc;
        }
        let mut up_state = StateVal {
            symbol: self.sub_alloc.heap[up_branch as usize],
            freq: 0,
            successor: up_branch + 1,
        };
        if self.ctx_num_stats(pc) != 1 {
            if pc as usize <= self.sub_alloc.p_text {
                return 0;
            }
            let p = match self.find_state(pc, up_state.symbol) {
                0 => return 0,
                p => p,
            };
            let cf = u32::from(self.state_read(p).freq) - 1;
            let s0 = u32::from(self.ctx_summ_freq(pc)) - u32::from(self.ctx_num_stats(pc)) - cf;
            up_state.freq = if 2 * cf <= s0 {
                u8::from(5 * cf > s0)
            } else {
                ((2 * cf + 3 * s0 - 1) / (2 * s0)) as u8
            } + 1;
        } else {
            up_state.freq = self.state_read(self.one_state(pc)).freq;
        }
        let mut pc = pc;
        let mut idx = pps;
        loop {
            idx -= 1;
            pc = self.create_child(pc, ps[idx], &up_state);
            if pc == 0 {
                return 0;
            }
            if idx == 0 {
                break;
            }
        }
        pc
    }

    fn update_model(&mut self) {
        let fs = self.state_read(self.found_state);
        let mut p = 0u32;
        if fs.freq < (MAX_FREQ / 4) as u8 {
            let pc = self.ctx_suffix(self.min_context);
            if pc != 0 {
                if self.ctx_num_stats(pc) != 1 {
                    let stats_pc = self.ctx_stats(pc);
                    if self.state_read(stats_pc).symbol != fs.symbol {
                        p = self.find_state(pc, fs.symbol);
                        if p > stats_pc
                            && self.state_read(p).freq
                                >= self.state_read(p - STATE_STRIDE as u32).freq
                        {
                            self.swap_states(p);
                            p -= STATE_STRIDE as u32;
                        }
                    } else {
                        p = stats_pc;
                    }
                    if p != 0 && self.state_read(p).freq < (MAX_FREQ - 9) as u8 {
                        let mut st = self.state_read(p);
                        st.freq += 2;
                        self.state_write(p, &st);
                        let sf = self.ctx_summ_freq(pc).wrapping_add(2);
                        self.ctx_set_summ_freq(pc, sf);
                    }
                } else {
                    p = self.one_state(pc);
                    let mut st = self.state_read(p);
                    if st.freq < 32 {
                        st.freq += 1;
                    }
                    self.state_write(p, &st);
                }
            }
        }
        let mut fs = fs;
        if self.order_fall == 0 {
            let successor = self.create_successors(true, p);
            self.state_set_successor(self.found_state, successor);
            self.min_context = successor;
            self.max_context = successor;
            if successor == 0 {
                self.restart_model();
            }
            return;
        }
        self.sub_alloc.heap[self.sub_alloc.p_text] = fs.symbol;
        self.sub_alloc.p_text += 1;
        let mut successor = self.sub_alloc.p_text as u32;
        if self.sub_alloc.p_text >= self.sub_alloc.fake_units_start {
            self.restart_model();
            return;
        }
        if fs.successor != 0 {
            if fs.successor as usize <= self.sub_alloc.p_text {
                fs.successor = self.create_successors(false, p);
                if fs.successor == 0 {
                    self.restart_model();
                    return;
                }
            }
            self.order_fall -= 1;
            if self.order_fall == 0 {
                successor = fs.successor;
                self.sub_alloc.p_text -= usize::from(self.max_context != self.min_context);
            }
        } else {
            self.state_set_successor(self.found_state, successor);
            fs.successor = self.min_context;
        }
        let ns = u32::from(self.ctx_num_stats(self.min_context));
        let s0 = u32::from(self.ctx_summ_freq(self.min_context))
            .wrapping_sub(ns)
            .wrapping_sub(u32::from(fs.freq) - 1);
        let mut pc = self.max_context;
        while pc != self.min_context {
            let mut ns1 = u32::from(self.ctx_num_stats(pc));
            if ns1 != 1 {
                if ns1 & 1 == 0 {
                    let expanded = self
                        .sub_alloc
                        .expand_units(self.ctx_stats(pc) as usize, (ns1 >> 1) as usize)
                        as u32;
                    self.ctx_set_stats(pc, expanded);
                    if expanded == 0 {
                        self.restart_model();
                        return;
                    }
                }
                let summ = self.ctx_summ_freq(pc);
                let add = u16::from(2 * ns1 < ns)
                    + 2 * u16::from(4 * ns1 <= ns && summ <= 8 * ns1 as u16);
                self.ctx_set_summ_freq(pc, summ.wrapping_add(add));
            } else {
                let p_new = self.sub_alloc.alloc_units(1) as u32;
                if p_new == 0 {
                    self.restart_model();
                    return;
                }
                let mut st = self.state_read(self.one_state(pc));
                self.state_write(p_new, &st);
                self.ctx_set_stats(pc, p_new);
                if st.freq < (MAX_FREQ / 4 - 1) as u8 {
                    st.freq = st.freq.wrapping_mul(2);
                } else {
                    st.freq = (MAX_FREQ - 4) as u8;
                }
                self.state_write(p_new, &st);
                let summ = u16::from(st.freq) + self.init_esc as u16 + u16::from(ns > 3);
                self.ctx_set_summ_freq(pc, summ);
            }
            let mut cf = 2 * u32::from(fs.freq) * (u32::from(self.ctx_summ_freq(pc)) + 6);
            let sf = s0 + u32::from(self.ctx_summ_freq(pc));
            if cf < 6 * sf {
                cf = 1 + u32::from(cf > sf) + u32::from(cf >= 4 * sf);
                self.ctx_set_summ_freq(pc, self.ctx_summ_freq(pc).wrapping_add(3));
            } else {
                cf = 4
                    + u32::from(cf >= 9 * sf)
                    + u32::from(cf >= 12 * sf)
                    + u32::from(cf >= 15 * sf);
                self.ctx_set_summ_freq(pc, self.ctx_summ_freq(pc).wrapping_add(cf as u16));
            }
            let p_slot = self.ctx_stats(pc) + ns1 * STATE_STRIDE as u32;
            self.state_write(
                p_slot,
                &StateVal {
                    symbol: fs.symbol,
                    freq: cf as u8,
                    successor,
                },
            );
            ns1 += 1;
            self.ctx_set_num_stats(pc, ns1 as u16);
            pc = self.ctx_suffix(pc);
        }
        self.max_context = fs.successor;
        self.min_context = fs.successor;
    }

    fn restart_model(&mut self) {
        let _ = self.restart_model_rare();
        self.esc_count = 0;
    }

    // -- decoding -------------------------------------------------

    fn decode_bin_symbol(&mut self, ctx: u32) {
        let rs = self.one_state(ctx);
        let rs_val = self.state_read(rs);
        self.hi_bits_flag = self.hb2_flag[self.state_read(self.found_state).symbol as usize];
        let col = self.prev_success as usize
            + self.ns2bs_indx[(self.ctx_num_stats(self.ctx_suffix(ctx)) - 1) as usize] as usize
            + self.hi_bits_flag as usize
            + 2 * self.hb2_flag[rs_val.symbol as usize] as usize
            + ((self.run_length >> 26) & 0x20) as usize;
        let row = rs_val.freq as usize - 1;
        let bs = u32::from(self.bin_summ[row][col]);
        if self.coder.get_current_shift_count(TOT_BITS) < bs {
            self.found_state = rs;
            let mut st = rs_val;
            if st.freq < 128 {
                st.freq += 1;
            }
            self.state_write(rs, &st);
            self.coder.sub_range.low_count = 0;
            self.coder.sub_range.high_count = bs;
            self.bin_summ[row][col] =
                bs.wrapping_add(INTERVAL)
                    .wrapping_sub(get_mean(bs, PERIOD_BITS, 2)) as u16;
            self.prev_success = 1;
            self.run_length += 1;
        } else {
            self.coder.sub_range.low_count = bs;
            self.bin_summ[row][col] = bs.wrapping_sub(get_mean(bs, PERIOD_BITS, 2)) as u16;
            self.coder.sub_range.high_count = BIN_SCALE;
            self.init_esc = i32::from(EXP_ESCAPE[(self.bin_summ[row][col] >> 10) as usize]);
            self.num_masked = 1;
            self.char_mask[rs_val.symbol as usize] = self.esc_count;
            self.prev_success = 0;
            self.found_state = 0;
        }
    }

    fn update1(&mut self, ctx: u32, p: u32) {
        self.found_state = p;
        let mut st = self.state_read(p);
        st.freq = st.freq.wrapping_add(4);
        self.state_write(p, &st);
        let sf = self.ctx_summ_freq(ctx).wrapping_add(4);
        self.ctx_set_summ_freq(ctx, sf);
        if st.freq > self.state_read(p - STATE_STRIDE as u32).freq {
            self.swap_states(p);
            let new_p = p - STATE_STRIDE as u32;
            self.found_state = new_p;
            if self.state_read(new_p).freq > MAX_FREQ as u8 {
                self.rescale(ctx);
            }
        }
    }

    fn decode_symbol1(&mut self, ctx: u32) -> bool {
        self.coder.sub_range.scale = u32::from(self.ctx_summ_freq(ctx));
        let stats = self.ctx_stats(ctx);
        let mut p = stats;
        let mut hi_cnt = i32::from(self.state_read(p).freq);
        let count = self.coder.get_current_count();
        if count >= self.coder.sub_range.scale as i32 {
            return false;
        }
        if count < hi_cnt {
            self.coder.sub_range.high_count = hi_cnt as u32;
            self.prev_success = u8::from(2 * hi_cnt > self.coder.sub_range.scale as i32);
            self.run_length += i32::from(self.prev_success != 0);
            let mut st = self.state_read(p);
            hi_cnt = hi_cnt.wrapping_add(4);
            st.freq = hi_cnt as u8;
            self.state_write(p, &st);
            self.found_state = p;
            let sf = self.ctx_summ_freq(ctx).wrapping_add(4);
            self.ctx_set_summ_freq(ctx, sf);
            if hi_cnt > MAX_FREQ as i32 {
                self.rescale(ctx);
            }
            self.coder.sub_range.low_count = 0;
            return true;
        }
        if self.found_state == 0 {
            return false;
        }
        self.prev_success = 0;
        let mut i = self.ctx_num_stats(ctx) as i32 - 1;
        loop {
            p += STATE_STRIDE as u32;
            hi_cnt = hi_cnt.wrapping_add(i32::from(self.state_read(p).freq));
            if hi_cnt > count {
                break;
            }
            i = i.wrapping_sub(1);
            if i == 0 {
                self.hi_bits_flag =
                    self.hb2_flag[self.state_read(self.found_state).symbol as usize];
                self.coder.sub_range.low_count = hi_cnt as u32;
                self.char_mask[self.state_read(p).symbol as usize] = self.esc_count;
                self.num_masked = self.ctx_num_stats(ctx) as i32;
                self.found_state = 0;
                let mut q = p;
                let mut j = self.num_masked - 1;
                while j > 0 {
                    q -= STATE_STRIDE as u32;
                    self.char_mask[self.state_read(q).symbol as usize] = self.esc_count;
                    j -= 1;
                }
                self.coder.sub_range.high_count = self.coder.sub_range.scale;
                return true;
            }
        }
        self.coder.sub_range.high_count = hi_cnt as u32;
        self.coder.sub_range.low_count = hi_cnt as u32 - u32::from(self.state_read(p).freq);
        self.update1(ctx, p);
        true
    }

    fn update2(&mut self, ctx: u32, p: u32) {
        self.found_state = p;
        let mut st = self.state_read(p);
        st.freq = st.freq.wrapping_add(4);
        self.state_write(p, &st);
        let sf = self.ctx_summ_freq(ctx).wrapping_add(4);
        self.ctx_set_summ_freq(ctx, sf);
        if st.freq > MAX_FREQ as u8 {
            self.rescale(ctx);
        }
        self.esc_count = self.esc_count.wrapping_add(1);
        self.run_length = self.init_rl;
    }

    fn decode_symbol2(&mut self, ctx: u32) -> bool {
        let mut i = self.ctx_num_stats(ctx) as i32 - self.num_masked;
        // makeEscFreq2
        let see2_idx;
        let dummy;
        if self.ctx_num_stats(ctx) != 256 {
            let suffix = self.ctx_suffix(ctx);
            let row = self.ns2_indx[(i - 1) as usize] as usize;
            let col =
                usize::from(i < self.ctx_num_stats(suffix) as i32 - self.ctx_num_stats(ctx) as i32)
                    + 2 * usize::from(self.ctx_summ_freq(ctx) < 11 * self.ctx_num_stats(ctx))
                    + 4 * usize::from(self.num_masked > i)
                    + self.hi_bits_flag as usize;
            self.coder.sub_range.scale = self.see2_cont[row][col].get_mean();
            see2_idx = row * 16 + col;
            dummy = false;
        } else {
            self.coder.sub_range.scale = 1;
            see2_idx = 0;
            dummy = true;
        }
        let stats = self.ctx_stats(ctx);
        let mut ps = [0u32; 256];
        let mut pps = 0usize;
        let mut p = stats.wrapping_sub(STATE_STRIDE as u32);
        let mut hi_cnt: i32 = 0;
        loop {
            loop {
                p = p.wrapping_add(STATE_STRIDE as u32);
                if self.char_mask[self.state_read(p).symbol as usize] != self.esc_count {
                    break;
                }
            }
            hi_cnt = hi_cnt.wrapping_add(i32::from(self.state_read(p).freq));
            if pps >= 256 {
                return false;
            }
            ps[pps] = p;
            pps += 1;
            i = i.wrapping_sub(1);
            if i == 0 {
                break;
            }
        }
        self.coder.sub_range.scale += hi_cnt as u32;
        let count = self.coder.get_current_count();
        if count >= self.coder.sub_range.scale as i32 {
            return false;
        }
        let mut pps = 0usize;
        p = ps[0];
        if count < hi_cnt {
            hi_cnt = 0;
            loop {
                hi_cnt = hi_cnt.wrapping_add(i32::from(self.state_read(p).freq));
                if hi_cnt > count {
                    break;
                }
                pps += 1;
                if pps >= 256 {
                    return false;
                }
                p = ps[pps];
            }
            self.coder.sub_range.high_count = hi_cnt as u32;
            self.coder.sub_range.low_count = hi_cnt as u32 - u32::from(self.state_read(p).freq);
            if !dummy {
                self.see2_cont[see2_idx / 16][see2_idx % 16].update();
            }
            self.update2(ctx, p);
        } else {
            self.coder.sub_range.low_count = hi_cnt as u32;
            self.coder.sub_range.high_count = self.coder.sub_range.scale;
            let mut i = self.ctx_num_stats(ctx) as i32 - self.num_masked;
            loop {
                if pps >= 256 {
                    return false;
                }
                self.char_mask[self.state_read(ps[pps]).symbol as usize] = self.esc_count;
                pps += 1;
                i = i.wrapping_sub(1);
                if i == 0 {
                    break;
                }
            }
            if !dummy {
                let v = self.coder.sub_range.scale as u16;
                self.see2_cont[see2_idx / 16][see2_idx % 16].summ = self.see2_cont[see2_idx / 16]
                    [see2_idx % 16]
                    .summ
                    .wrapping_add(v);
            }
            self.num_masked = self.ctx_num_stats(ctx) as i32;
        }
        true
    }

    // -- public API -----------------------------------------------

    /// `ModelPPM::DecodeInit`; false = unusable stream (order 1 or no
    /// prior state).
    pub fn decode_init(&mut self, src: &mut dyn ByteSource, esc_char: &mut u8) -> bool {
        let max_order_byte = src.get_char();
        let reset = max_order_byte & 0x20 != 0;
        let mut max_mb = 0usize;
        if reset {
            max_mb = src.get_char() as usize;
        } else if self.sub_alloc.sub_allocator_size == 0 {
            return false;
        }
        if max_order_byte & 0x40 != 0 {
            *esc_char = src.get_char();
        }
        self.coder.init_decoder(src);
        if reset {
            let mut max_order = i32::from(max_order_byte & 0x1f) + 1;
            if max_order > 16 {
                max_order = 16 + (max_order - 16) * 3;
            }
            if max_order == 1 {
                self.sub_alloc.stop_sub_allocator();
                return false;
            }
            let _ = self.sub_alloc.start_sub_allocator(max_mb + 1);
            let _ = self.start_model_rare(max_order);
        }
        self.min_context != 0
    }

    /// `ModelPPM::DecodeChar`; -1 signals corrupt data.
    pub fn decode_char(&mut self, src: &mut dyn ByteSource) -> i32 {
        let mc = self.min_context;
        if mc as usize <= self.sub_alloc.p_text || mc as usize > self.sub_alloc.heap_end {
            return -1;
        }
        if self.ctx_num_stats(mc) != 1 {
            let stats = self.ctx_stats(mc);
            if stats as usize <= self.sub_alloc.p_text || stats as usize > self.sub_alloc.heap_end {
                return -1;
            }
            if !self.decode_symbol1(mc) {
                return -1;
            }
        } else {
            self.decode_bin_symbol(mc);
        }
        self.coder.decode();
        while self.found_state == 0 {
            self.coder.dec_normalize(src);
            loop {
                self.order_fall = self.order_fall.wrapping_add(1);
                self.min_context = self.ctx_suffix(self.min_context);
                let mc = self.min_context;
                if mc == 0
                    || mc as usize <= self.sub_alloc.p_text
                    || mc as usize > self.sub_alloc.heap_end
                {
                    return -1;
                }
                if self.ctx_num_stats(mc) != self.num_masked as u16 {
                    break;
                }
            }
            if !self.decode_symbol2(self.min_context) {
                return -1;
            }
            self.coder.decode();
        }
        let symbol = self.state_read(self.found_state).symbol;
        if self.order_fall == 0
            && self.state_read(self.found_state).successor as usize > self.sub_alloc.p_text
        {
            let succ = self.state_read(self.found_state).successor;
            self.min_context = succ;
            self.max_context = succ;
        } else {
            self.update_model();
            if self.esc_count == 0 {
                self.esc_count = 1;
                self.char_mask = [0; 256];
            }
        }
        self.coder.dec_normalize(src);
        i32::from(symbol)
    }
}
