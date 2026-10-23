//! Adversarial IPC fixture: own a real UDP socket and never consume stdin.
//! The sole RAW_DATA record announces its physical port to the cancellation test.
use std::{
    io::{self, Write},
    net::UdpSocket,
    time::Duration,
};
fn emit(kind: u32, body: &[u8]) {
    let mut out = io::stdout().lock();
    out.write_all(&kind.to_le_bytes()).unwrap();
    out.write_all(&(body.len() as u32).to_le_bytes()).unwrap();
    out.write_all(body).unwrap();
    out.flush().unwrap();
}
fn main() {
    let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    emit(10, &[]);
    emit(17, &port.to_le_bytes());
    std::thread::sleep(Duration::from_secs(20));
    drop(socket);
}
