use bottleship_lan_core::{
    GatewayEvent, GatewayInput,
    config::*,
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
use tokio::time::timeout;
async fn rejected(node: Option<[u8; 6]>, proto: u8, src_port: u16, payload: Bytes) -> u32 {
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let cfg = GatewayConfig::default();
    let options = GatewayOptions::default();
    let (h, mut events) = match node {
        Some(node) => Gateway::spawn_with_node(1, node, cfg, policy.clone(), options),
        None => Gateway::spawn(1, cfg, policy.clone(), options),
    }
    .unwrap();
    h.try_submit(GatewayInput::Frame {
        datagram: Datagram {
            proto,
            node: [2, 1, 127, 0, 0, 1],
            src_port,
            dst_port: u16::from(payload[0]) + 1,
            payload,
        },
        binding: BindingToken {
            proto,
            local_port: src_port,
            generation: Some(1),
        },
        target: Target {
            route_id: 0,
            address: NativeAddress::parse("127.0.0.1").unwrap(),
            port: 2,
            canonical_policy_key: "127.0.0.1".into(),
            raw_mode: None,
        },
    })
    .unwrap();
    let out = timeout(Duration::from_secs(2), events.outputs.recv())
        .await
        .unwrap()
        .unwrap();
    let code = match &out.event {
        GatewayEvent::SocketError { code, .. } => *code,
        _ => panic!("expected explicit rejection"),
    };
    drop(out);
    h.abort();
    timeout(Duration::from_secs(2), h.wait_closed())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(policy.lock().unwrap().active_leases(), 0);
    code
}
#[tokio::test]
async fn raw_requires_authenticated_node_instead_of_fabricated_source() {
    assert_eq!(
        rejected(
            None,
            6,
            2,
            Bytes::from_static(&[1, 0, 8, 0, 0, 0, 0, 1, 0, 0])
        )
        .await,
        10049
    );
    assert_eq!(
        rejected(
            Some([2, 0, 0, 0, 0, 7]),
            6,
            2,
            Bytes::from_static(&[1, 0, 8, 0, 0, 0, 0, 1, 0, 0])
        )
        .await,
        10045
    );
}
#[tokio::test]
async fn raw6_unknown_receive_protocol_is_explicitly_unavailable() {
    assert_eq!(
        rejected(
            Some([2, 0, 0, 0, 0, 7]),
            7,
            256,
            Bytes::from_static(&[58, 1])
        )
        .await,
        10045
    );
}
