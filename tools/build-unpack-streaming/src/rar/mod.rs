mod ppmd;
use ppmd::{ByteSource, ModelPPM};

struct Input<'a> { data: &'a [u8], pos: usize, truncated: bool }
impl ByteSource for Input<'_> {
    fn get_char(&mut self) -> u8 {
        if self.pos >= self.data.len() { self.truncated = true; return 0; }
        let byte = self.data[self.pos]; self.pos += 1; byte
    }
}

pub struct Session { input: Vec<u8>, model: ModelPPM, escape: u8, position: usize, written: usize }

#[no_mangle]
pub unsafe extern "C" fn rar_ppm_new(input: *const u8, len: usize) -> *mut Session {
    Box::into_raw(Box::new(Session { input: std::slice::from_raw_parts(input, len).to_vec(),
        model: ModelPPM::new(), escape: 2, position: 0, written: 0 }))
}

/// Resume a PPM block over the same unfiltered dictionary as the LZ decoder.
/// Return 0 for EOF, 1 for a new coding table, or a negative decoding error.
#[no_mangle]
pub unsafe extern "C" fn rar_ppm_block(session: *mut Session, offset: usize, output: *mut u8, base: usize, capacity: usize) -> i32 {
    let s = &mut *session;
    if offset >= s.input.len() || base > capacity || capacity > 512 * 1024 * 1024 { return -6; }
    let flags = s.input[offset];
    if flags & 0x80 == 0 || (flags & 0x20 != 0 && s.input.get(offset + 1).copied().unwrap_or(255) >= 64) { return -6; }
    let mut source = Input { data: &s.input, pos: offset, truncated: false };
    if !s.model.decode_init(&mut source, &mut s.escape) || source.truncated { return -3; }
    let out = std::slice::from_raw_parts_mut(output, capacity);
    let mut pos = base;
    loop {
        let ch = s.model.decode_char(&mut source);
        if ch < 0 || source.truncated { return -3; }
        if ch == s.escape as i32 {
            let command = s.model.decode_char(&mut source);
            if source.truncated { return -3; }
            match command {
                0 | 2 => { s.position = source.pos; s.written = pos; return if command == 0 { 1 } else { 0 }; }
                3 => return -8,
                4 | 5 => {
                    let mut distance = 1usize;
                    if command == 4 {
                        distance = 0;
                        for _ in 0..3 {
                            let v = s.model.decode_char(&mut source);
                            if v < 0 { return -3; }
                            distance = (distance << 8) | v as usize;
                        }
                        distance += 2;
                    }
                    let v = s.model.decode_char(&mut source);
                    if v < 0 || source.truncated { return -3; }
                    let length = v as usize + if command == 4 { 32 } else { 4 };
                    if distance > pos || pos + length > capacity { return -3; }
                    for _ in 0..length { out[pos] = out[pos - distance]; pos += 1; }
                    continue;
                }
                -1 => return -3,
                _ => {} // Other escape codes encode the escape byte literally.
            }
        }
        if pos >= capacity { return -3; }
        out[pos] = ch as u8; pos += 1;
    }
}

#[no_mangle]
pub unsafe extern "C" fn rar_ppm_position(s: *const Session) -> usize { (*s).position }
#[no_mangle]
pub unsafe extern "C" fn rar_ppm_written(s: *const Session) -> usize { (*s).written }
#[no_mangle]
pub unsafe extern "C" fn rar_ppm_free(s: *mut Session) { drop(Box::from_raw(s)); }
