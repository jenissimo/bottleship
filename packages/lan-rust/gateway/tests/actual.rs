use bottleship_lan_core::{
    GatewayEvent, GatewayInput,
    config::*,
    gateway::{BindingToken, DestinationPolicy},
    routes::{NativeAddress, Target},
    wire::{Datagram, TCP_WINDOW, TcpFrame},
};
use bottleship_lan_gateway::*;
use bytes::Bytes;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UdpSocket},
    time::timeout,
};
fn helper() -> String {
    let path = PathBuf::from(std::env::var_os("BOTTLESHIP_RUST_UDP_HELPER").expect(
        "Set BOTTLESHIP_RUST_UDP_HELPER to an explicitly measured existing ordinary UDP helper",
    ));
    assert!(
        path.exists(),
        "explicit UDP helper is required; this test never builds it"
    );
    path.to_string_lossy().into_owned()
}
fn binding(proto: u8, g: u32) -> BindingToken {
    BindingToken {
        proto,
        local_port: 2000,
        generation: Some(g),
    }
}
fn target(port: u16) -> Target {
    Target {
        route_id: 0,
        address: NativeAddress::parse("127.0.0.1").unwrap(),
        port,
        canonical_policy_key: "127.0.0.1".into(),
        raw_mode: None,
    }
}
fn frame(proto: u8, g: u32, port: u16, payload: Bytes) -> GatewayInput {
    GatewayInput::Frame {
        datagram: Datagram {
            proto,
            node: [2, 1, 127, 0, 0, 1],
            src_port: 2000,
            dst_port: port,
            payload,
        },
        binding: binding(proto, g),
        target: target(port),
    }
}
fn spawn() -> (GatewayHandle, GatewayEvents, Arc<Mutex<DestinationPolicy>>) {
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let config = GatewayConfig {
        native_udp_helper_path: Some(helper()),
        ..Default::default()
    };
    let (handle, events) =
        Gateway::spawn(1, config, policy.clone(), GatewayOptions::default()).unwrap();
    (handle, events, policy)
}
async fn next(events: &mut GatewayEvents) -> GatewayOutput {
    timeout(Duration::from_secs(8), events.outputs.recv())
        .await
        .expect("gateway event timeout")
        .expect("gateway output closed")
}
async fn stopped(h: &GatewayHandle) {
    h.abort();
    timeout(Duration::from_secs(8), h.wait_closed())
        .await
        .unwrap()
        .unwrap();
}
#[tokio::test]
async fn native_udp_two_destinations_share_one_source_port_and_last_release_reclaims_it() {
    let a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let (h, mut events, policy) = spawn();
    h.try_submit(frame(
        1,
        1,
        a.local_addr().unwrap().port(),
        Bytes::from_static(b"A"),
    ))
    .unwrap();
    h.try_submit(frame(
        1,
        1,
        b.local_addr().unwrap().port(),
        Bytes::from_static(b"B"),
    ))
    .unwrap();
    let mut buf = [0; 8];
    let (na, source_a) = timeout(Duration::from_secs(5), a.recv_from(&mut buf))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&buf[..na], b"A");
    let (nb, source_b) = timeout(Duration::from_secs(5), b.recv_from(&mut buf))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&buf[..nb], b"B");
    assert_eq!(source_a, source_b);
    a.send_to(b"replyA", source_a).await.unwrap();
    b.send_to(b"replyB", source_b).await.unwrap();
    let mut replies = vec![];
    for _ in 0..2 {
        let output = next(&mut events).await;
        if let GatewayEvent::Frame { datagram, .. } = &output.event {
            replies.push(datagram.payload.to_vec());
        } else {
            panic!("unexpected event")
        }
    }
    replies.sort();
    assert_eq!(replies, [b"replyA".to_vec(), b"replyB".to_vec()]);
    h.try_submit(GatewayInput::ReleasePort {
        proto: 1,
        port: 2000,
        generation: 1,
    })
    .unwrap();
    stopped(&h).await;
    let rebound = UdpSocket::bind(source_a).await.unwrap();
    drop(rebound);
    assert_eq!(policy.lock().unwrap().active_leases(), 0);
}
#[tokio::test]
async fn native_peer_permission_has_ready_ack_without_dummy_payload_and_refcounts() {
    let peer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = peer.local_addr().unwrap().port();
    let (h, mut events, policy) = spawn();
    let request = bottleship_lan_core::wire::UdpLeaseRequest {
        proto: 1,
        local_port: 2000,
        binding_generation: 1,
        node: [2, 1, 127, 0, 0, 1],
        remote_port: port,
    };
    for operation in [1, 2] {
        h.try_submit(GatewayInput::LeaseUdpPeer {
            request_id: operation as u32,
            operation,
            request: request.clone(),
            binding: binding(1, 1),
            target: target(port),
        })
        .unwrap();
    }
    let mut leases = vec![];
    for _ in 0..2 {
        let e = next(&mut events).await;
        if let GatewayEvent::LeaseReady { lease_id, .. } = e.event {
            leases.push(lease_id)
        } else {
            panic!("expected ready")
        }
    }
    let mut b = [0; 16];
    assert!(matches!(peer.try_recv_from(&mut b),Err(e)if e.kind()==std::io::ErrorKind::WouldBlock));
    h.try_submit(GatewayInput::ReleaseUdpPeer {
        lease_id: leases[0],
    })
    .unwrap();
    h.try_submit(frame(1, 1, port, Bytes::from_static(b"still-alive")))
        .unwrap();
    let (n, source) = timeout(Duration::from_secs(5), peer.recv_from(&mut b))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&b[..n], b"still-alive");
    h.try_submit(GatewayInput::ReleaseUdpPeer {
        lease_id: leases[1],
    })
    .unwrap();
    stopped(&h).await;
    drop(UdpSocket::bind(source).await.unwrap());
    assert_eq!(policy.lock().unwrap().active_leases(), 0);
}
#[tokio::test]
async fn late_old_generation_cannot_reopen_released_udp_owner() {
    let peer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = peer.local_addr().unwrap().port();
    let (h, _events, policy) = spawn();
    h.try_submit(frame(1, 1, port, Bytes::from_static(b"old")))
        .unwrap();
    let mut b = [0; 16];
    timeout(Duration::from_secs(5), peer.recv_from(&mut b))
        .await
        .unwrap()
        .unwrap();
    h.try_submit(GatewayInput::ReleasePort {
        proto: 1,
        port: 2000,
        generation: 1,
    })
    .unwrap();
    h.try_submit(frame(1, 1, port, Bytes::from_static(b"stale")))
        .unwrap();
    h.try_submit(frame(1, 2, port, Bytes::from_static(b"new")))
        .unwrap();
    let (n, _) = timeout(Duration::from_secs(5), peer.recv_from(&mut b))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&b[..n], b"new");
    stopped(&h).await;
    assert_eq!(policy.lock().unwrap().active_leases(), 0);
}
#[tokio::test]
async fn native_tcp_data_and_fin_prefix_survive_immediate_port_release() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = vec![];
        stream.read_to_end(&mut bytes).await.unwrap();
        bytes
    });
    let (h, mut events, policy) = spawn();
    let syn = TcpFrame {
        kind: 1,
        src_id: 41,
        dst_id: 0,
        value: TCP_WINDOW,
        data: Bytes::new(),
    };
    h.try_submit(frame(2, 1, port, syn.encode())).unwrap();
    let first = next(&mut events).await;
    let server = match &first.event {
        GatewayEvent::Frame { datagram, .. } => {
            let packet = TcpFrame::decode(datagram.payload.clone()).unwrap();
            assert_eq!(packet.kind, 2);
            packet.src_id
        }
        _ => panic!("expected SYNACK"),
    };
    drop(first);
    let expected = vec![37u8; 240 * 1024];
    for chunk in expected.chunks(16384) {
        h.try_submit(frame(
            2,
            1,
            port,
            TcpFrame {
                kind: 3,
                src_id: 41,
                dst_id: server,
                value: 0,
                data: Bytes::copy_from_slice(chunk),
            }
            .encode(),
        ))
        .unwrap();
    }
    h.try_submit(frame(
        2,
        1,
        port,
        TcpFrame {
            kind: 4,
            src_id: 41,
            dst_id: server,
            value: 0,
            data: Bytes::new(),
        }
        .encode(),
    ))
    .unwrap();
    h.try_submit(GatewayInput::ReleasePort {
        proto: 2,
        port: 2000,
        generation: 1,
    })
    .unwrap();
    assert_eq!(
        timeout(Duration::from_secs(8), peer)
            .await
            .unwrap()
            .unwrap(),
        expected
    );
    stopped(&h).await;
    assert_eq!(policy.lock().unwrap().active_leases(), 0);
}
#[tokio::test]
async fn native_tcp_echo_credit_and_ordered_remote_fin() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 4];
        stream.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"data");
        stream.write_all(b"echo").await.unwrap();
        stream.shutdown().await.unwrap();
        let mut tail = vec![];
        stream.read_to_end(&mut tail).await.unwrap();
    });
    let (h, mut events, _) = spawn();
    h.try_submit(frame(
        2,
        1,
        port,
        TcpFrame {
            kind: 1,
            src_id: 42,
            dst_id: 0,
            value: TCP_WINDOW,
            data: Bytes::new(),
        }
        .encode(),
    ))
    .unwrap();
    let first = next(&mut events).await;
    let server = match &first.event {
        GatewayEvent::Frame { datagram, .. } => {
            TcpFrame::decode(datagram.payload.clone()).unwrap().src_id
        }
        _ => panic!(),
    };
    drop(first);
    h.try_submit(frame(
        2,
        1,
        port,
        TcpFrame {
            kind: 3,
            src_id: 42,
            dst_id: server,
            value: 0,
            data: Bytes::from_static(b"data"),
        }
        .encode(),
    ))
    .unwrap();
    let mut bytes = vec![];
    let mut credit = 0;
    let mut fin = false;
    while !fin || credit < 4 {
        let output = next(&mut events).await;
        if let GatewayEvent::Frame { datagram, .. } = &output.event {
            let p = TcpFrame::decode(datagram.payload.clone()).unwrap();
            match p.kind {
                3 => bytes.extend_from_slice(&p.data),
                6 => credit += p.value,
                4 => fin = true,
                5 => panic!("RST {}", p.value),
                _ => {}
            }
        }
    }
    assert_eq!(bytes, b"echo");
    assert_eq!(credit, 4);
    h.try_submit(frame(
        2,
        1,
        port,
        TcpFrame {
            kind: 4,
            src_id: 42,
            dst_id: server,
            value: 0,
            data: Bytes::new(),
        }
        .encode(),
    ))
    .unwrap();
    timeout(Duration::from_secs(5), peer)
        .await
        .unwrap()
        .unwrap();
    stopped(&h).await;
}
