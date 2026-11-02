//! Real optional helper datagram IPC proof; no raw privilege is needed for Udp mode.
use bottleship_lan_native::raw::{NativeRaw, RawMode, RawOptions};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::Path,
    time::Duration,
};
use tokio::{net::UdpSocket, time::timeout};
async fn case(path: &Path, family: u8) -> Result<(), Box<dyn std::error::Error>> {
    let ip = if family == 4 {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        IpAddr::V6(Ipv6Addr::LOCALHOST)
    };
    let echo = UdpSocket::bind(SocketAddr::new(ip, 0)).await?;
    let address = echo.local_addr()?;
    let (task_sender, mut incoming) = tokio::sync::mpsc::channel(1);
    let echo_task = tokio::spawn(async move {
        let mut bytes = vec![0; 65535];
        while let Ok((size, peer)) = echo.recv_from(&mut bytes).await {
            let _ = task_sender.send(peer).await;
            if echo.send_to(&bytes[..size], peer).await.is_err() {
                return;
            }
        }
    });
    let (handle, mut events) =
        NativeRaw::start(path, address, RawMode::Udp, RawOptions::default())?;
    let pid = handle.status().pid;
    println!("RAW_IPC family={family} phase=start pid={pid:?}");
    let mut actual = None;
    let result = timeout(Duration::from_secs(12), async {
        handle.when_connected().await?;
        handle.set_ip_options(64, 0)?;
        for size in [0, 1, 512, if family == 4 { 65507 } else { 65527 }] {
            let bytes: Vec<u8> = (0..size).map(|n| (n * 17 + 5) as u8).collect();
            handle.try_send(&bytes)?.completion().await?;
            let peer = incoming.recv().await.ok_or("Echo receiver ended")?;
            if let Some(expected) = actual {
                assert_eq!(peer, expected)
            } else {
                actual = Some(peer)
            }
            let packet = events.packets.recv().await.ok_or("Raw IPC ended")?;
            assert_eq!(&packet.bytes[..], &bytes[..]);
            drop(packet);
        }
        // Completion escrow includes ACKed, unconsumed tickets, including empty packets.
        let mut tickets = Vec::new();
        for _ in 0..64 {
            tickets.push(handle.try_send(&[])?);
        }
        assert_eq!(handle.try_send(&[]).err().map(|e| e.code), Some(10055));
        for ticket in tickets {
            ticket.completion().await?;
        }
        // Echo fixture itself is bounded; its unread reflection may stop and is
        // irrelevant to TX completion. Abort is independent of those queues.
        Ok::<_, Box<dyn std::error::Error>>(())
    })
    .await;
    handle.abort();
    let retired = timeout(Duration::from_secs(4), handle.wait_closed()).await;
    echo_task.abort();
    let _ = echo_task.await;
    result??;
    retired??;
    let actual = actual.ok_or("No native source tuple observed")?;
    let rebound = UdpSocket::bind(actual).await?;
    drop(rebound);
    println!("RAW_IPC family={family} PASS pid={pid:?} escrow=64 physical_port_reused={actual}");
    Ok(())
}
async fn stalled(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let (handle, mut events) = NativeRaw::start(
        path,
        "127.0.0.1:9".parse()?,
        RawMode::Udp,
        RawOptions::default(),
    )?;
    handle.when_connected().await?;
    let announcement = timeout(Duration::from_secs(3), events.packets.recv())
        .await?
        .ok_or("No fixture port")?;
    assert_eq!(announcement.bytes.len(), 2);
    let port = u16::from_le_bytes(announcement.bytes[..].try_into()?);
    drop(announcement);
    let pid = handle.status().pid;
    let bytes = vec![3; 65535];
    let mut tickets = Vec::new();
    for _ in 0..4 {
        tickets.push(handle.try_send(&bytes)?);
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    handle.abort();
    timeout(Duration::from_secs(2), handle.wait_closed()).await??;
    for ticket in tickets {
        assert_eq!(ticket.completion().await.err().map(|e| e.code), Some(10004));
    }
    let rebound = UdpSocket::bind((Ipv4Addr::LOCALHOST, port)).await?;
    drop(rebound);
    println!("RAW_IPC permanently_stalled_pipe PASS pid={pid:?} actual_port_reused={port}");
    Ok(())
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if !(2..=3).contains(&args.len()) {
        return Err("Usage: raw_helper_probe measured-socket-helper [stalled-fixture]".into());
    }
    case(Path::new(&args[1]), 4).await?;
    case(Path::new(&args[1]), 6).await?;
    if let Some(path) = args.get(2) {
        stalled(Path::new(path)).await?;
    }
    Ok(())
}
