use bottleship_lan_core::{
    GatewayEvent, GatewayInput,
    config::*,
    gateway::{BindingToken, DestinationPolicy},
    wire::Datagram,
};
use bottleship_lan_gateway::*;
use bytes::Bytes;
use std::{
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::UdpSocket, time::timeout};
fn binding(g: u32) -> BindingToken {
    BindingToken {
        proto: 1,
        local_port: 2000,
        generation: Some(g),
    }
}
fn listener(max_owners: usize) -> UdpListenerConfig {
    UdpListenerConfig {
        id: "native".into(),
        bind_host: "127.0.0.1".into(),
        advertised_host: "127.0.0.1".into(),
        port: 0,
        allowed_hosts: vec!["127.0.0.1".into()],
        max_owners,
        max_peers: 8,
        idle_timeout_ms: 60000,
    }
}
fn spawn(c: u64, p: Arc<Mutex<DestinationPolicy>>) -> (GatewayHandle, GatewayEvents) {
    Gateway::spawn(c, GatewayConfig::default(), p, GatewayOptions::default()).unwrap()
}
async fn next(e: &mut GatewayEvents) -> GatewayOutput {
    timeout(Duration::from_secs(3), e.outputs.recv())
        .await
        .unwrap()
        .unwrap()
}
async fn open(
    h: &GatewayHandle,
    e: &mut GatewayEvents,
    op: u64,
    g: u32,
    owners: usize,
) -> (u64, SocketAddr) {
    h.try_submit(GatewayInput::OpenUdpHost {
        operation: op,
        binding: binding(g),
        listener: listener(owners),
    })
    .unwrap();
    let out = next(e).await;
    match &out.event {
        GatewayEvent::HostReady {
            operation,
            lease_id,
            node,
            port,
        } => {
            assert_eq!(*operation, op);
            assert_eq!(*node, [2, 1, 127, 0, 0, 1]);
            assert_ne!(*port, 0);
            (
                *lease_id,
                SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, *port)),
            )
        }
        event => panic!("expected HostReady, got {event:?}"),
    }
}
fn send(id: u64, g: u32, port: u16, body: &'static [u8]) -> GatewayInput {
    GatewayInput::HostFrame {
        lease_id: id,
        binding: binding(g),
        datagram: Datagram {
            proto: 1,
            node: [2, 1, 127, 0, 0, 1],
            src_port: 2000,
            dst_port: port,
            payload: Bytes::from_static(body),
        },
    }
}
async fn stopped(h: &GatewayHandle) {
    h.abort();
    timeout(Duration::from_secs(2), h.wait_closed())
        .await
        .unwrap()
        .unwrap();
}
#[tokio::test]
async fn actual_host_ack_no_dummy_exact_tuple_same_source_and_last_release() {
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let (h, mut e) = spawn(1, policy.clone());
    let (id, address) = open(&h, &mut e, 1, 1, 1).await;
    let peer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = peer.local_addr().unwrap().port();
    let mut bytes = [0; 32];
    h.try_submit(send(id, 1, port, b"not-learned")).unwrap();
    assert!(matches!(
        next(&mut e).await.event,
        GatewayEvent::HostSocketError { code: 10013, .. }
    ));
    assert!(
        matches!(peer.try_recv_from(&mut bytes),Err(error)if error.kind()==std::io::ErrorKind::WouldBlock)
    );
    peer.send_to(b"hello", address).await.unwrap();
    let packet = next(&mut e).await;
    assert!(
        matches!(&packet.event,GatewayEvent::HostFrame{lease_id,binding:b,datagram}if *lease_id==id&&*b==binding(1)&&datagram.src_port==port&&datagram.payload==b"hello"[..])
    );
    drop(packet);
    h.try_submit(send(id, 1, port, b"reply")).unwrap();
    let (n, source) = timeout(Duration::from_secs(2), peer.recv_from(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&bytes[..n], b"reply");
    assert_eq!(source, address);
    h.try_submit(GatewayInput::ReleaseUdpHost { lease_id: id })
        .unwrap();
    let mut status = e.status.clone();
    timeout(Duration::from_secs(2), async {
        loop {
            if status.borrow().host_listeners == 0 {
                break;
            }
            status.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    drop(
        UdpSocket::bind(address)
            .await
            .expect("last lease release must physically reclaim port before actorabort"),
    );
    assert_eq!(policy.lock().unwrap().active_leases(), 0);
    stopped(&h).await;
}
#[tokio::test]
async fn shared_owner_cap_is_released_only_after_close_and_new_epoch_survives_stale_release() {
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let (a, mut ae) = spawn(1, policy.clone());
    let (b, mut be) = spawn(2, policy.clone());
    let (first, old) = open(&a, &mut ae, 1, 1, 1).await;
    b.try_submit(GatewayInput::OpenUdpHost {
        operation: 1,
        binding: binding(1),
        listener: listener(1),
    })
    .unwrap();
    assert!(matches!(
        next(&mut be).await.event,
        GatewayEvent::HostFailed {
            operation: 1,
            code: 10048
        }
    ));
    a.try_submit(GatewayInput::ReleasePort {
        proto: 1,
        port: 2000,
        generation: 1,
    })
    .unwrap();
    let (second, new) = open(&a, &mut ae, 2, 2, 1).await;
    assert_ne!(first, second);
    drop(UdpSocket::bind(old).await.unwrap());
    a.try_submit(GatewayInput::ReleaseUdpHost { lease_id: first })
        .unwrap();
    let peer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    peer.send_to(b"fresh", new).await.unwrap();
    assert!(
        matches!(next(&mut ae).await.event,GatewayEvent::HostFrame{lease_id,..}if lease_id==second)
    );
    stopped(&a).await;
    let (_, other) = open(&b, &mut be, 2, 1, 1).await;
    assert_ne!(other.port(), 0);
    stopped(&b).await;
    assert_eq!(policy.lock().unwrap().active_leases(), 0);
}
#[tokio::test]
async fn two_room_owners_keep_distinct_ports_and_abort_reclaims_while_rx_envelopes_held() {
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let (a, mut ae) = spawn(1, policy.clone());
    let (b, mut be) = spawn(2, policy.clone());
    let (ai, aa) = open(&a, &mut ae, 1, 1, 2).await;
    let (bi, ba) = open(&b, &mut be, 1, 1, 2).await;
    assert_ne!(aa, ba);
    let peer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let pp = peer.local_addr().unwrap().port();
    peer.send_to(b"room-a", aa).await.unwrap();
    peer.send_to(b"room-b", ba).await.unwrap();
    let held = next(&mut ae).await;
    let other = next(&mut be).await;
    assert_eq!(held.connection, 1);
    assert_eq!(other.connection, 2);
    assert!(
        matches!(&held.event,GatewayEvent::HostFrame{datagram,..}if datagram.payload==b"room-a"[..])
    );
    assert!(
        matches!(&other.event,GatewayEvent::HostFrame{datagram,..}if datagram.payload==b"room-b"[..])
    );
    a.try_submit(send(ai, 1, pp, b"A")).unwrap();
    b.try_submit(send(bi, 1, pp, b"B")).unwrap();
    let mut got = vec![];
    let mut buffer = [0; 8];
    for _ in 0..2 {
        let (n, from) = timeout(Duration::from_secs(2), peer.recv_from(&mut buffer))
            .await
            .unwrap()
            .unwrap();
        got.push((buffer[..n].to_vec(), from));
    }
    assert!(got.contains(&(b"A".to_vec(), aa)));
    assert!(got.contains(&(b"B".to_vec(), ba)));
    stopped(&a).await;
    drop(UdpSocket::bind(aa).await.unwrap());
    assert!(UdpSocket::bind(ba).await.is_err());
    stopped(&b).await;
    drop(UdpSocket::bind(ba).await.unwrap());
    assert_eq!(policy.lock().unwrap().active_leases(), 0);
    // Already delivered RX ownership can outlive physical socket retirement.
    drop(held);
    drop(other);
}
