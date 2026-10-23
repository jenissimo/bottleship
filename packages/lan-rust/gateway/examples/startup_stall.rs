//! Test-only helper: own a real UDP port, announce it out-of-band, then withhold
//! every protocol reply. Its finite watchdog bounds a failed cancellation test.
use std::{io::Write, net::UdpSocket, path::Path, time::Duration};
fn main() {
    let exe = std::env::current_exe().unwrap();
    let stem = Path::new(&exe).file_stem().unwrap().to_str().unwrap();
    let observer: u16 = stem.rsplit('-').next().unwrap().parse().unwrap();
    let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
    socket
        .send_to(&std::process::id().to_le_bytes(), ("127.0.0.1", observer))
        .unwrap();
    if stem.starts_with("admission-") {
        let mut output = std::io::stdout().lock();
        output.write_all(&10u32.to_le_bytes()).unwrap();
        output.write_all(&0u32.to_le_bytes()).unwrap();
        output.flush().unwrap();
    }
    std::hint::black_box(&socket);
    std::thread::sleep(Duration::from_secs(20));
    drop(socket);
}
