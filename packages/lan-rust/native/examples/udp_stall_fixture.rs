//! Adversarial test process, never a production backend. It owns a real socket,
//! performs BIND/CREDIT/PEER, then permanently stops consuming its stdin pipe.
//! A 20-second independent lifetime bounds a failed parent probe.
use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket},
    time::Duration,
};
fn word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn reply(opcode: u8, id: u32, generation: u32, body: &[u8]) {
    let mut frame = Vec::new();
    frame.extend_from_slice(&((16 + body.len()) as u32).to_le_bytes());
    frame.extend_from_slice(&[1, opcode, 0, 0]);
    frame.extend_from_slice(&id.to_le_bytes());
    frame.extend_from_slice(&generation.to_le_bytes());
    frame.extend_from_slice(body);
    let mut output = std::io::stdout().lock();
    output.write_all(&frame).unwrap();
    output.flush().unwrap();
}
fn main() {
    let killer = std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(20));
        std::process::exit(90);
    });
    drop(killer);
    let mut input = std::io::stdin().lock();
    let mut bound = None;
    loop {
        let mut header = [0; 16];
        input.read_exact(&mut header).unwrap();
        let size = word(&header, 0) as usize;
        assert!((16..=65575).contains(&size));
        let mut body = vec![0; size - 16];
        input.read_exact(&mut body).unwrap();
        let id = word(&header, 8);
        let generation = word(&header, 12);
        match header[5] {
            1 => {
                let ip = if body[0] == 4 {
                    IpAddr::V4(Ipv4Addr::UNSPECIFIED)
                } else {
                    IpAddr::V6(Ipv6Addr::UNSPECIFIED)
                };
                let socket = UdpSocket::bind(SocketAddr::new(ip, 0)).unwrap();
                let address = socket.local_addr().unwrap();
                let mut ready = vec![0; 48];
                ready[0] = body[0];
                ready[2..4].copy_from_slice(&address.port().to_be_bytes());
                for (offset, value) in [
                    (24, 0x3fu32),
                    (28, 256),
                    (32, 262144),
                    (36, 256),
                    (40, 64),
                    (44, 128),
                ] {
                    ready[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
                }
                bound = Some(socket);
                reply(101, id, generation, &ready);
            }
            4 => reply(104, id, generation, &body),
            2 => {
                let mut ready = body[..8].to_vec();
                ready.extend_from_slice(&0u32.to_le_bytes());
                reply(102, id, generation, &ready);
                // Keep the socket and stdin live; parent writes must really block.
                std::hint::black_box(&bound);
                std::thread::sleep(Duration::from_secs(19));
                return;
            }
            _ => panic!("unexpected fixture command"),
        }
    }
}
