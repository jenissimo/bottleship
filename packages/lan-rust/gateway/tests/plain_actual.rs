use bottleship_lan_core::{
    GatewayEvent, GatewayInput,
    config::GatewayConfig,
    gateway::{BindingToken, DestinationPolicy},
    routes::{NativeAddress, Target},
    wire::Datagram,
};
use bottleship_lan_gateway::*;
use bytes::Bytes;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::UdpSocket, time::timeout};
fn spawn() -> (GatewayHandle, GatewayEvents, Arc<Mutex<DestinationPolicy>>) {
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let (h, e) = Gateway::spawn(
        1,
        GatewayConfig::default(),
        policy.clone(),
        GatewayOptions::default(),
    )
    .unwrap();
    (h, e, policy)
}
fn send(h: &GatewayHandle, port: u16, native: &str, proto: u8, payload: &[u8]) {
    h.try_submit(GatewayInput::Frame {
        datagram: Datagram {
            proto,
            node: [2, 1, 127, 0, 0, 1],
            src_port: 2000,
            dst_port: port,
            payload: Bytes::copy_from_slice(payload),
        },
        binding: BindingToken {
            proto,
            local_port: 2000,
            generation: Some(1),
        },
        target: Target {
            route_id: 0,
            address: NativeAddress::parse(native).unwrap(),
            port,
            canonical_policy_key: "127.0.0.1".into(),
            raw_mode: None,
        },
    })
    .unwrap();
}
async fn released(events: &mut GatewayEvents) {
    timeout(Duration::from_secs(5), async {
        loop {
            let s = events.status.borrow().clone();
            assert!(!s.closed, "gateway died: {:?}", s.error);
            if s.udp_flows == 0 {
                return;
            }
            events.status.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
}
async fn output(events: &mut GatewayEvents) -> GatewayOutput {
    timeout(Duration::from_secs(5), events.outputs.recv())
        .await
        .unwrap()
        .unwrap()
}
async fn close(h: &GatewayHandle) {
    h.abort();
    timeout(Duration::from_secs(5), h.wait_closed())
        .await
        .unwrap()
        .unwrap();
}
#[tokio::test]
async fn default_two_peers_share_source_and_last_unbind_releases_before_actor_abort() {
    let a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let (h, mut events, policy) = spawn();
    send(&h, a.local_addr().unwrap().port(), "127.0.0.1", 1, b"A");
    send(&h, b.local_addr().unwrap().port(), "127.0.0.1", 1, b"B");
    let mut bytes = [0; 16];
    let (_, source_a) = timeout(Duration::from_secs(5), a.recv_from(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    let (_, source_b) = timeout(Duration::from_secs(5), b.recv_from(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(source_a, source_b);
    a.send_to(b"reply", source_a).await.unwrap();
    let packet = output(&mut events).await;
    assert!(
        matches!(&packet.event,GatewayEvent::Frame{datagram,..}if datagram.payload.as_ref()==b"reply")
    );
    drop(packet);
    h.try_submit(GatewayInput::ReleasePort {
        proto: 1,
        port: 2000,
        generation: 1,
    })
    .unwrap();
    released(&mut events).await;
    let rebound = UdpSocket::bind(source_a).await.unwrap();
    assert_eq!(policy.lock().unwrap().active_leases(), 0);
    drop(rebound);
    assert!(!h.status().closed);
    close(&h).await;
}
#[tokio::test]
async fn empty_datagram_is_delivered_and_exact_native_tuple_filters_unknown_sender() {
    let peer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let stranger = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let (h, mut events, _) = spawn();
    send(&h, peer.local_addr().unwrap().port(), "127.0.0.1", 1, b"");
    let mut bytes = [0; 8];
    let (size, source) = timeout(Duration::from_secs(5), peer.recv_from(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(size, 0);
    stranger.send_to(b"forged", source).await.unwrap();
    peer.send_to(b"", source).await.unwrap();
    let packet = output(&mut events).await;
    assert!(matches!(&packet.event,GatewayEvent::Frame{datagram,..}if datagram.payload.is_empty()));
    close(&h).await;
}
#[tokio::test]
async fn mapped_ipv6_destination_uses_real_dual_stack_socket() {
    let peer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let (h, mut events, _) = spawn();
    send(
        &h,
        peer.local_addr().unwrap().port(),
        "::ffff:127.0.0.1",
        4,
        b"mapped",
    );
    let mut bytes = [0; 16];
    let (n, source) = timeout(Duration::from_secs(5), peer.recv_from(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&bytes[..n], b"mapped");
    peer.send_to(b"answer", source).await.unwrap();
    let packet = output(&mut events).await;
    assert!(
        matches!(&packet.event,GatewayEvent::Frame{datagram,..}if datagram.proto==4&&datagram.payload.as_ref()==b"answer")
    );
    close(&h).await;
}
#[tokio::test]
async fn ordinary_ipv6_loopback_uses_the_configured_numeric_family() {
    let peer = UdpSocket::bind("[::1]:0").await.unwrap();
    let (h, mut events, _) = spawn();
    send(&h, peer.local_addr().unwrap().port(), "::1", 4, b"v6");
    let mut bytes = [0; 16];
    let (n, source) = timeout(Duration::from_secs(5), peer.recv_from(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&bytes[..n], b"v6");
    peer.send_to(b"v6reply", source).await.unwrap();
    let packet = output(&mut events).await;
    assert!(
        matches!(&packet.event,GatewayEvent::Frame{datagram,..}if datagram.payload.as_ref()==b"v6reply")
    );
    close(&h).await;
}
