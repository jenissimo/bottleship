use bottleship_lan_core::{
    GatewayEvent, GatewayInput,
    config::*,
    gateway::{BindingToken, DestinationPolicy},
    routes::{NativeAddress, Target},
    wire::{Datagram, TcpFrame},
};
use bottleship_lan_gateway::*;
use bytes::Bytes;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::timeout,
};
fn frame(port: u16, packet: TcpFrame) -> GatewayInput {
    GatewayInput::Frame {
        datagram: Datagram {
            proto: 2,
            node: [2, 1, 127, 0, 0, 1],
            src_port: 2000,
            dst_port: port,
            payload: packet.encode(),
        },
        binding: BindingToken {
            proto: 2,
            local_port: 2000,
            generation: Some(1),
        },
        target: Target {
            route_id: 0,
            address: NativeAddress::parse("127.0.0.1").unwrap(),
            port,
            canonical_policy_key: "127.0.0.1".into(),
            raw_mode: None,
        },
    }
}
#[tokio::test]
async fn native_eof_with_uncredited_tail_drains_all_400k_then_reclaims_flow() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let expected: Vec<u8> = (0..400 * 1024).map(|n| (n * 17 + 11) as u8).collect();
    let sent = expected.clone();
    let peer = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut prefix = vec![];
        stream.read_to_end(&mut prefix).await.unwrap();
        assert!(prefix.is_empty());
        stream.write_all(&sent).await.unwrap();
        stream.shutdown().await.unwrap();
    });
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let (h, mut events) = Gateway::spawn(
        1,
        GatewayConfig::default(),
        policy.clone(),
        GatewayOptions::default(),
    )
    .unwrap();
    struct Abort(GatewayHandle);
    impl Drop for Abort {
        fn drop(&mut self) {
            self.0.abort()
        }
    }
    let cleanup = Abort(h.clone());
    h.try_submit(frame(
        port,
        TcpFrame {
            kind: 1,
            src_id: 99,
            dst_id: 0,
            value: 8192,
            data: Bytes::new(),
        },
    ))
    .unwrap();
    let out = timeout(Duration::from_secs(4), events.outputs.recv())
        .await
        .unwrap()
        .unwrap();
    let server = match &out.event {
        GatewayEvent::Frame { datagram, .. } => {
            let p = TcpFrame::decode(datagram.payload.clone()).unwrap();
            assert_eq!(p.kind, 2);
            p.src_id
        }
        _ => panic!("expected SYNACK"),
    };
    drop(out);
    h.try_submit(frame(
        port,
        TcpFrame {
            kind: 4,
            src_id: 99,
            dst_id: server,
            value: 0,
            data: Bytes::new(),
        },
    ))
    .unwrap();
    let mut received = vec![];
    let mut fin = false;
    timeout(Duration::from_secs(8), async {
        while !fin {
            let out = events.outputs.recv().await.expect("gateway output closed");
            match &out.event {
                GatewayEvent::Frame { datagram, .. } => {
                    let p = TcpFrame::decode(datagram.payload.clone()).unwrap();
                    match p.kind {
                        3 => {
                            received.extend_from_slice(&p.data);
                            h.try_submit(frame(
                                port,
                                TcpFrame {
                                    kind: 6,
                                    src_id: 99,
                                    dst_id: server,
                                    value: p.data.len() as u32,
                                    data: Bytes::new(),
                                },
                            ))
                            .unwrap();
                        }
                        4 => fin = true,
                        5 => panic!("unexpected RESET {}", p.value),
                        _ => {}
                    }
                }
                GatewayEvent::SocketError { code, .. } => panic!("unexpected socket error {code}"),
                _ => {}
            }
            drop(out);
        }
    })
    .await
    .unwrap();
    assert_eq!(received, expected);
    timeout(Duration::from_secs(2), peer)
        .await
        .unwrap()
        .unwrap();
    let mut status = events.status.clone();
    let reclaimed = timeout(Duration::from_secs(1), async {
        loop {
            if status.borrow().tcp_flows == 0 {
                break;
            }
            status.changed().await.unwrap();
        }
    })
    .await
    .is_ok();
    h.abort();
    timeout(Duration::from_secs(2), h.wait_closed())
        .await
        .unwrap()
        .unwrap();
    drop(cleanup);
    assert!(
        reclaimed,
        "native closed state plus delivered final FIN must reclaim the TCP actor without unrelated ReleasePort"
    );
    assert_eq!(policy.lock().unwrap().active_leases(), 0);
}
