#[path = "reused/arena.rs"]
mod arena;
#[path = "reused/guest_mem.rs"]
mod guest_mem;

#[link(wasm_import_module = "env")]
extern "C" {
    fn read_guest(address: u32, destination: u32, length: u32) -> u32;
}

fn read_block(address: i32, destination: *mut u8, length: u32) -> bool {
    unsafe { read_guest(address as u32, destination as u32, length) != 0 }
}

#[no_mangle]
pub extern "C" fn initialize_guest_reader() {
    guest_mem::set_guest_mem(guest_mem::GuestMem { read_block });
}
