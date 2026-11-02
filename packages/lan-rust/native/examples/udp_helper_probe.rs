//! Finite integration probe: real helper/socket, empty packet credits, completion
//! escrow, original-tuple ICMP and actual port retirement. Not a benchmark.
use bottleship_lan_native::{
    NativeError,
    udp::{BoundUdp, UdpOptions},
};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};
use tokio::{net::UdpSocket, time::timeout};

async fn echo(
    family: u8,
) -> Result<(SocketAddr, tokio::task::JoinHandle<()>), Box<dyn std::error::Error>> {
    let ip = if family == 4 {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        IpAddr::V6(Ipv6Addr::LOCALHOST)
    };
    let socket = UdpSocket::bind(SocketAddr::new(ip, 0)).await?;
    let endpoint = socket.local_addr()?;
    let task = tokio::spawn(async move {
        let mut bytes = vec![0; 65535];
        while let Ok((length, peer)) = socket.recv_from(&mut bytes).await {
            if socket.send_to(&bytes[..length], peer).await.is_err() {
                break;
            }
        }
    });
    Ok((endpoint, task))
}
async fn receive(
    events: &mut bottleship_lan_native::udp::UdpEvents,
    expected: &[u8],
) -> Result<bottleship_lan_native::udp::UdpDatagram, Box<dyn std::error::Error>> {
    let packet = timeout(Duration::from_secs(4), events.datagrams.recv())
        .await?
        .ok_or("UDP events ended")?;
    assert_eq!(&packet.bytes[..], expected);
    Ok(packet)
}
async fn ordinary(path: &str, family: u8) -> Result<(), Box<dyn std::error::Error>> {
    let (a, echo_a) = echo(family).await?;
    let (b, echo_b) = echo(family).await?;
    let (port, mut events) = BoundUdp::bind(path, family, UdpOptions::default()).await?;
    let actual = port.status().bound.unwrap();
    let pid = port.status().pid;
    println!("UDP family={family} phase=bound pid={pid} address={actual}");
    port.register_peer(1, 1, a).await?;
    port.register_peer(2, 1, b).await?;
    let maximum = if family == 4 { 65507 } else { 65527 };
    for size in [0, 1, 512, maximum] {
        let bytes: Vec<u8> = (0..size).map(|i| (i * 29 + 11) as u8).collect();
        port.try_send(1, 1, &bytes)?.completion().await?;
        let packet = receive(&mut events, &bytes).await?;
        assert_eq!(packet.peer_id, 1);
        assert_eq!(packet.epoch, 1);
        assert_eq!(packet.endpoint, a);
        drop(packet);
    }
    println!("UDP family={family} phase=basic_echo_complete");
    // The caller may retain completed tickets without polling them. Such records
    // still occupy the finite result escrow, even after all native ACKs arrive.
    let mut tickets = Vec::new();
    for _ in 0..256 {
        tickets.push(port.try_send(1, 1, &[])?);
    }
    assert_eq!(port.try_send(1, 1, &[]).err().map(|e| e.code), Some(10055));
    assert_eq!(port.snapshot().pending_tx_records, 256);
    for ticket in tickets {
        ticket.completion().await?;
    }
    assert_eq!(port.snapshot().pending_tx_records, 0);
    println!("UDP family={family} phase=escrow_complete");
    // Retire this socket; use a fresh binding so an intentionally lossy UDP burst
    // cannot contaminate the exact zero-credit receive sequence.
    port.close().await?;
    assert!(port.status().closed);
    let rebound = UdpSocket::bind(actual).await?;
    drop(rebound);
    let (port, mut events) = BoundUdp::bind(path, family, UdpOptions::default()).await?;
    let actual = port.status().bound.unwrap();
    port.register_peer(1, 1, a).await?;
    port.register_peer(2, 1, b).await?;
    let mut held = Vec::new();
    for _ in 0..256 {
        port.try_send(1, 1, &[])?.completion().await?;
        held.push(receive(&mut events, &[]).await?);
    }
    println!("UDP family={family} phase=rx_credits_held count=256");
    // Neither payload credit nor a second data consumer is needed to deliver an
    // ICMP record. Its original endpoint is peer3, never the healthy peer2.
    let absent = UdpSocket::bind(SocketAddr::new(a.ip(), 0))
        .await?
        .local_addr()?;
    port.register_peer(3, 1, absent).await?;
    port.try_send(3, 1, b"icmp")?.completion().await?;
    let error = timeout(Duration::from_secs(4), events.errors.recv())
        .await?
        .ok_or("UDP error stream ended")?;
    assert_eq!(error.peer_id, 3);
    assert_eq!(error.epoch, 1);
    assert_eq!(error.endpoint, absent);
    assert_eq!(error.code, 10054);
    assert!(!port.status().closing);
    drop(held);
    port.try_send(2, 1, b"healthy-after-other-peer-error")?
        .completion()
        .await?;
    let packet = receive(&mut events, b"healthy-after-other-peer-error").await?;
    assert_eq!(packet.peer_id, 2);
    drop(packet);
    port.retire_peer(1, 1).await?;
    port.register_peer(1, 2, a).await?;
    let alias = port.register_peer(4, 1, a).await;
    assert_eq!(alias.err().map(|e| e.code), Some(10048));
    port.close().await?;
    let rebound = UdpSocket::bind(actual).await?;
    drop(rebound);
    echo_a.abort();
    echo_b.abort();
    let _ = echo_a.await;
    let _ = echo_b.await;
    println!(
        "UDP family={family} PASS first_pid={pid} escrow=256 zero_credit_packets=256 original_tuple=true port_reused=true"
    );
    Ok(())
}
async fn stalled(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let options = UdpOptions {
        operation_timeout: Duration::from_secs(5),
        close_timeout: Duration::from_secs(2),
    };
    let (port, _events) = BoundUdp::bind(path, 4, options).await?;
    let actual = port.status().bound.unwrap();
    let pid = port.status().pid;
    port.register_peer(1, 1, "127.0.0.1:9".parse()?).await?;
    let bytes = vec![7; 65507];
    let mut tickets = Vec::new();
    for _ in 0..4 {
        tickets.push(port.try_send(1, 1, &bytes)?);
    }
    let close_port = port.clone();
    let closing = tokio::spawn(async move { close_port.close().await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    port.abort();
    timeout(Duration::from_secs(2), port.wait_closed()).await??;
    closing.await??;
    for ticket in tickets {
        let error: NativeError = ticket
            .completion()
            .await
            .expect_err("stalled input was never accepted by the helper");
        assert_eq!(error.code, 10004);
    }
    let rebound = UdpSocket::bind(actual).await?;
    drop(rebound);
    assert_eq!(port.snapshot().pending_tx_records, 0);
    println!("UDP permanently_stalled_pipe PASS pid={pid} actual_port_reused=true");
    Ok(())
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        return Err("usage: udp_helper_probe measured-helper [stalled-fixture]".into());
    }
    timeout(Duration::from_secs(40), async {
        ordinary(&args[1], 4).await?;
        ordinary(&args[1], 6).await?;
        if let Some(path) = args.get(2) {
            stalled(path).await?;
        }
        Ok::<_, Box<dyn std::error::Error>>(())
    })
    .await??;
    Ok(())
}
