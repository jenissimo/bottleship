//! Memory cost of one port slot, the unit of maxBindingsPerPeer/maxBindingEntries.
//! docs/multiplayer-security.md quotes these numbers for the default budget.
mod common;
use bottleship_lan_core::{*,config::*,gateway::BindingRegistry,routes::Routes,wire::InboundEvent};
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicIsize, Ordering};

struct Counting;
static LIVE: AtomicIsize = AtomicIsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { LIVE.fetch_add(l.size() as isize, Ordering::SeqCst); unsafe { System.alloc(l) } }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { LIVE.fetch_sub(l.size() as isize, Ordering::SeqCst); unsafe { System.dealloc(p, l) } }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        LIVE.fetch_add(n as isize - l.size() as isize, Ordering::SeqCst); unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static A: Counting = Counting;

#[test]
fn a_full_per_peer_slot_budget_costs_under_128_bytes_per_slot_in_core_and_gateway() {
    // One test in this binary, so the global counter sees only this thread's work.
    let n = 1024usize;
    let mut c = common::core(Limits{max_bindings_per_peer:n,..Default::default()},Routes::new(GatewayConfig::default()).unwrap()).unwrap();
    c.join(1,&json!({"version":1,"room":"r","clientId":"participant-00000001","node":[2,0,0,0,0,1]}),0).unwrap();
    let before = LIVE.load(Ordering::SeqCst);
    for i in 0..n {
        // Proto 1 also fills the multicast registry: the most expensive slot kind.
        let effects = c.apply(Command::Input{connection:1,event:InboundEvent::ReleasePort{proto:1,port:i as u16 + 1,generation:1},now_ms:0});
        drop(effects);
    }
    let core = LIVE.load(Ordering::SeqCst) - before;
    let before = LIVE.load(Ordering::SeqCst);
    let mut gateway = BindingRegistry::default();
    for i in 0..n { gateway.release(1, i as u16 + 1, 1); }
    let registry = LIVE.load(Ordering::SeqCst) - before;
    let per_slot = (core + registry) as f64 / n as f64;
    println!("core {core} B, gateway registry {registry} B, {per_slot:.1} B/slot");
    assert_eq!(c.binding_entry_count(), n);
    assert!(per_slot < 128.0, "{per_slot} B/slot");
    drop(gateway);
}
