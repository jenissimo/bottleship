//! Pure, synchronous LAN state machine. The caller serializes commands; no I/O or tasks live here.
pub mod config;
pub mod gateway;
pub mod routes;
mod server;
pub mod wire;
pub use server::{Command, Core, CoreError, Effect, GatewayEvent, GatewayInput};
pub use wire::{Arg, InboundEvent, ServerEvent};
pub type ConnId = u64;
