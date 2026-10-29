//! Native socket adapters. The optional helper backend preserves the measured
//! Windows/Linux wire contract while direct platform adapters are developed.
mod budget;
pub mod listener;
pub mod raw;
pub mod tcp;
pub mod tcp_listener;
pub mod tcp_quota;
pub mod udp;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeError {
    pub code: u32,
    pub native_code: u32,
    pub message: &'static str,
}
impl NativeError {
    pub const fn new(code: u32, message: &'static str) -> Self {
        Self {
            code,
            native_code: 0,
            message,
        }
    }
    pub fn io(error: std::io::Error, message: &'static str) -> Self {
        let raw = error.raw_os_error().unwrap_or(0);
        let code = if (10000..=12000).contains(&raw) {
            raw as u32
        } else {
            use std::io::ErrorKind::*;
            match error.kind() {
                ConnectionRefused => 10061,
                TimedOut => 10060,
                HostUnreachable => 10065,
                NetworkUnreachable => 10051,
                AddrNotAvailable => 10049,
                AddrInUse => 10048,
                PermissionDenied => 10013,
                OutOfMemory => 10055,
                ConnectionReset => 10054,
                BrokenPipe | NotConnected => 10057,
                ConnectionAborted => 10053,
                _ if raw == 90 => 10040,
                _ if raw == 105 => 10055,
                _ => 10050,
            }
        };
        Self {
            code,
            native_code: raw as u32,
            message,
        }
    }
}
impl std::fmt::Display for NativeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} ({}, native {})",
            self.message, self.code, self.native_code
        )
    }
}
impl std::error::Error for NativeError {}
