use bottleship_lan_core::{
    GatewayEvent, GatewayInput, TcpChildKey, TcpOfferKey,
    config::{GatewayConfig, TcpListenerConfig},
    gateway::{BindingToken, DestinationPolicy},
    wire::{Datagram, TcpFrame, TCP_WINDOW},
    routes::{NativeAddress, Target},
};
use bottleship_lan_gateway::{Gateway, GatewayOptions};
use bytes::Bytes;
use std::{sync::{Arc, Mutex}, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, time::timeout};

fn packet(key: TcpChildKey, kind: u32, data: &'static [u8]) -> Datagram {
    Datagram { proto: 2, node: key.node, src_port: key.binding.local_port, dst_port: key.remote_port,
        payload: TcpFrame { kind, src_id: key.guest_id, dst_id: key.native_id, value: 0,
            data: Bytes::from_static(data) }.encode() }
}

#[tokio::test]
async fn accepted_child_survives_listener_close_and_early_data_is_ordered() {
    let listener = TcpListenerConfig { id: "test".into(), bind_host: "127.0.0.1".into(),
        advertised_host: "127.0.0.1".into(), port: 0, allowed_hosts: vec!["127.0.0.1".into()],
        max_owners: 1, max_pending: 4, startup_timeout_ms: 2000 };
    let mut config = GatewayConfig::default();
    config.tcp_listeners.push(listener.clone());
    let binding = BindingToken { proto: 2, local_port: 2310, generation: Some(1) };
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let (gateway, mut events) = Gateway::spawn(7, config, policy.clone(), GatewayOptions::default()).unwrap();
    gateway.try_submit(GatewayInput::OpenTcpListener { operation_id: 1, binding, config: listener }).unwrap();
    let (lease_id, address) = match timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap().event {
        GatewayEvent::TcpListenerReady { operation_id: 1, lease_id, binding: b, address } => {
            assert_eq!(b, binding); (lease_id, address)
        }
        other => panic!("unexpected listener event: {other:?}"),
    };
    let mut native = TcpStream::connect(address).await.unwrap();
    let syn = match timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap().event {
        GatewayEvent::TcpListenerFrame { lease_id: id, binding: b, datagram } => {
            assert_eq!(id, lease_id); assert_eq!(b, binding); datagram
        }
        other => panic!("unexpected SYN event: {other:?}"),
    };
    let frame = TcpFrame::decode(syn.payload.clone()).unwrap();
    assert_eq!(frame.kind, 1);
    let key = TcpChildKey { lease_id, binding, node: syn.node, remote_port: syn.src_port,
        native_id: frame.src_id, guest_id: 123 };
    let mut synack = packet(key, 2, b"");
    synack.payload = TcpFrame { kind: 2, src_id: key.guest_id, dst_id: key.native_id,
        value: TCP_WINDOW, data: Bytes::new() }.encode();
    gateway.try_submit(GatewayInput::TcpListenerFrame { lease_id, binding, datagram: synack }).unwrap();
    // These are deliberately queued before Established is observed.
    gateway.try_submit(GatewayInput::TcpChildFrame { key, datagram: packet(key, 3, b"early") }).unwrap();
    gateway.try_submit(GatewayInput::CloseTcpListener { lease_id }).unwrap();
    gateway.try_submit(GatewayInput::TcpChildFrame { key, datagram: packet(key, 3, b"after-close") }).unwrap();
    let mut bytes = [0; 16];
    timeout(Duration::from_secs(3), native.read_exact(&mut bytes)).await.unwrap().unwrap();
    assert_eq!(&bytes, b"earlyafter-close");
    let first = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    assert!(matches!(&first.event, GatewayEvent::TcpChildEstablished { key: k } if *k == key));
    drop(first);
    native.write_all(b"native-data").await.unwrap();
    native.shutdown().await.unwrap();
    let mut received = Vec::new();
    let mut fin = false;
    timeout(Duration::from_secs(3), async {
        while !fin {
            let out = events.outputs.recv().await.unwrap();
            if let GatewayEvent::TcpChildFrame { key: k, datagram } = &out.event {
                assert_eq!(*k, key);
                let f = TcpFrame::decode(datagram.payload.clone()).unwrap();
                match f.kind { 3 => received.extend_from_slice(&f.data), 4 => fin = true,
                    5 => panic!("unexpected RST {}", f.value), _ => {} }
            }
        }
    }).await.unwrap();
    assert_eq!(received, b"native-data");
    gateway.try_submit(GatewayInput::TcpChildFrame { key, datagram: packet(key, 4, b"") }).unwrap();
    timeout(Duration::from_secs(3), async {
        loop {
            let out = events.outputs.recv().await.unwrap();
            if matches!(out.event, GatewayEvent::TcpChildClosed { key: k } if k == key) { break; }
        }
    }).await.unwrap();
    gateway.try_submit(GatewayInput::ReleasePort { proto: 2, port: 2310, generation: 1 }).unwrap();
    gateway.abort();
    timeout(Duration::from_secs(3), gateway.wait_closed()).await.unwrap().unwrap();
    assert_eq!(policy.lock().unwrap().active_leases(), 0);
}

#[tokio::test]
async fn full_pending_accept_does_not_block_actor_and_reset_frees_outbound_slot() {
    let listener = TcpListenerConfig { id: "test".into(), bind_host: "127.0.0.1".into(),
        advertised_host: "127.0.0.1".into(), port: 0, allowed_hosts: vec!["127.0.0.1".into()],
        max_owners: 1, max_pending: 1, startup_timeout_ms: 2000 };
    let mut config = GatewayConfig::default();
    config.max_tcp_connections = 1;
    config.tcp_listeners.push(listener.clone());
    let binding = BindingToken { proto: 2, local_port: 2310, generation: Some(1) };
    let outbound_binding = BindingToken { proto: 2, local_port: 2311, generation: Some(1) };
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let (gateway, mut events) = Gateway::spawn(7, config, policy, GatewayOptions::default()).unwrap();
    gateway.try_submit(GatewayInput::OpenTcpListener { operation_id: 1, binding, config: listener }).unwrap();
    let (lease_id, address) = match timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap().event {
        GatewayEvent::TcpListenerReady { lease_id, address, .. } => (lease_id, address),
        other => panic!("unexpected ready: {other:?}"),
    };
    let mut inbound = TcpStream::connect(address).await.unwrap();
    let syn = match timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap().event {
        GatewayEvent::TcpListenerFrame { datagram, .. } => datagram,
        other => panic!("unexpected pending: {other:?}"),
    };
    let native_id = TcpFrame::decode(syn.payload.clone()).unwrap().src_id;
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = target.local_addr().unwrap().port();
    let outgoing = |kind, dst_id| GatewayInput::Frame {
        binding: outbound_binding,
        datagram: Datagram { proto: 2, node: [2,1,127,0,0,1], src_port: 2311, dst_port: port,
            payload: TcpFrame { kind, src_id: 77, dst_id, value: TCP_WINDOW, data: Bytes::new() }.encode() },
        target: Target { route_id: 0, address: NativeAddress::parse("127.0.0.1").unwrap(), port,
            canonical_policy_key: "127.0.0.1".into(), raw_mode: None },
    };
    gateway.try_submit(outgoing(1, 0)).unwrap();
    let full = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    match &full.event {
        GatewayEvent::Frame { datagram, .. } => {
            let frame = TcpFrame::decode(datagram.payload.clone()).unwrap();
            assert_eq!((frame.kind, frame.value), (5, 10055));
        }
        other => panic!("unexpected quota response: {other:?}"),
    }
    drop(full);
    let reset = Datagram { proto: 2, node: syn.node, src_port: binding.local_port, dst_port: syn.src_port,
        payload: TcpFrame { kind: 5, src_id: 0, dst_id: native_id, value: 10061, data: Bytes::new() }.encode() };
    gateway.try_submit(GatewayInput::TcpListenerFrame { lease_id, binding, datagram: reset }).unwrap();
    let mut byte = [0; 1];
    assert!(matches!(timeout(Duration::from_secs(3), inbound.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
    gateway.try_submit(outgoing(1, 0)).unwrap();
    let offer_closed = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    assert!(matches!(&offer_closed.event, GatewayEvent::TcpOfferClosed { key } if key.lease_id == lease_id && key.native_id == native_id));
    drop(offer_closed);
    let established = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    let server_id = match &established.event {
        GatewayEvent::Frame { datagram, .. } => {
            let frame = TcpFrame::decode(datagram.payload.clone()).unwrap();
            assert_eq!(frame.kind, 2); frame.src_id
        }
        other => panic!("expected SYNACK after pending reset: {other:?}"),
    };
    drop(established);
    let (mut peer, _) = timeout(Duration::from_secs(3), target.accept()).await.unwrap().unwrap();
    gateway.try_submit(outgoing(5, server_id)).unwrap();
    assert!(matches!(timeout(Duration::from_secs(3), peer.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
    gateway.try_submit(GatewayInput::CloseTcpListener { lease_id }).unwrap();
    gateway.abort();
    timeout(Duration::from_secs(3), gateway.wait_closed()).await.unwrap().unwrap();
}

#[tokio::test]
async fn expired_offer_resets_guest_before_close_and_late_synack_is_rejected() {
    let listener = TcpListenerConfig { id: "test".into(), bind_host: "127.0.0.1".into(),
        advertised_host: "127.0.0.1".into(), port: 0, allowed_hosts: vec!["127.0.0.1".into()],
        max_owners: 1, max_pending: 1, startup_timeout_ms: 2000 };
    let mut config = GatewayConfig::default();
    config.max_tcp_connections = 1;
    config.connect_timeout_ms = 40;
    config.tcp_listeners.push(listener.clone());
    let binding = BindingToken { proto: 2, local_port: 2310, generation: Some(1) };
    let (gateway, mut events) = Gateway::spawn(7, config, Arc::new(Mutex::new(DestinationPolicy::default())), GatewayOptions::default()).unwrap();
    gateway.try_submit(GatewayInput::OpenTcpListener { operation_id: 1, binding, config: listener }).unwrap();
    let (lease_id, address) = match timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap().event {
        GatewayEvent::TcpListenerReady { lease_id, address, .. } => (lease_id, address),
        other => panic!("unexpected ready: {other:?}"),
    };
    let mut peer = TcpStream::connect(address).await.unwrap();
    let syn = match timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap().event {
        GatewayEvent::TcpListenerFrame { datagram, .. } => datagram,
        other => panic!("unexpected SYN: {other:?}"),
    };
    let native_id = TcpFrame::decode(syn.payload.clone()).unwrap().src_id;
    let reset = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    match &reset.event {
        GatewayEvent::TcpListenerFrame { lease_id: id, datagram, .. } => {
            assert_eq!(*id, lease_id);
            assert_eq!(datagram.node, syn.node);
            let frame = TcpFrame::decode(datagram.payload.clone()).unwrap();
            assert_eq!((frame.kind, frame.src_id, frame.dst_id), (5, native_id, 0));
        }
        other => panic!("expected expiration reset: {other:?}"),
    }
    drop(reset);
    let closed = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    assert!(matches!(&closed.event, GatewayEvent::TcpOfferClosed { key } if key.native_id == native_id && key.lease_id == lease_id));
    drop(closed);
    let mut byte = [0; 1];
    assert!(matches!(timeout(Duration::from_secs(3), peer.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
    let key = TcpChildKey { lease_id, binding, node: syn.node, remote_port: syn.src_port, native_id, guest_id: 123 };
    let mut late = packet(key, 2, b"");
    late.payload = TcpFrame { kind: 2, src_id: key.guest_id, dst_id: native_id, value: TCP_WINDOW, data: Bytes::new() }.encode();
    gateway.try_submit(GatewayInput::TcpListenerFrame { lease_id, binding, datagram: late }).unwrap();
    let reject = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    match &reject.event {
        GatewayEvent::TcpListenerFrame { datagram, .. } => {
            let frame = TcpFrame::decode(datagram.payload.clone()).unwrap();
            assert_eq!((frame.kind, frame.src_id, frame.dst_id), (5, native_id, 123));
        }
        other => panic!("expected late SYNACK reset: {other:?}"),
    }
    drop(reject);
    let closed = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    assert!(matches!(&closed.event, GatewayEvent::TcpChildClosed { key: k } if *k == key));
    gateway.abort();
    timeout(Duration::from_secs(3), gateway.wait_closed()).await.unwrap().unwrap();
}

#[tokio::test]
async fn cancel_offer_checks_exact_identity_and_closes_original_socket() {
    let listener = TcpListenerConfig { id: "test".into(), bind_host: "127.0.0.1".into(),
        advertised_host: "127.0.0.1".into(), port: 0, allowed_hosts: vec!["127.0.0.1".into()],
        max_owners: 1, max_pending: 1, startup_timeout_ms: 2000 };
    let mut config = GatewayConfig::default();
    config.max_tcp_connections = 1;
    config.tcp_listeners.push(listener.clone());
    let binding = BindingToken { proto: 2, local_port: 2310, generation: Some(1) };
    let (gateway, mut events) = Gateway::spawn(7, config, Arc::new(Mutex::new(DestinationPolicy::default())), GatewayOptions::default()).unwrap();
    gateway.try_submit(GatewayInput::OpenTcpListener { operation_id: 1, binding, config: listener }).unwrap();
    let (lease_id, address) = match timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap().event {
        GatewayEvent::TcpListenerReady { lease_id, address, .. } => (lease_id, address),
        other => panic!("unexpected ready: {other:?}"),
    };
    let mut peer = TcpStream::connect(address).await.unwrap();
    let syn = match timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap().event {
        GatewayEvent::TcpListenerFrame { datagram, .. } => datagram,
        other => panic!("unexpected SYN: {other:?}"),
    };
    let native_id = TcpFrame::decode(syn.payload.clone()).unwrap().src_id;
    let key = TcpOfferKey { lease_id, binding, node: syn.node, remote_port: syn.src_port, native_id };
    let mut wrong = key; wrong.remote_port ^= 1;
    gateway.try_submit(GatewayInput::CancelTcpOffer { key: wrong }).unwrap();
    gateway.try_submit(GatewayInput::CancelTcpOffer { key }).unwrap();
    let reset = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    match &reset.event {
        GatewayEvent::TcpListenerFrame { datagram, .. } => {
            let f = TcpFrame::decode(datagram.payload.clone()).unwrap();
            assert_eq!((f.kind, f.src_id, f.dst_id), (5, native_id, 0));
        }
        other => panic!("expected reset: {other:?}"),
    }
    drop(reset);
    let closed = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    assert!(matches!(&closed.event, GatewayEvent::TcpOfferClosed { key: got } if *got == key));
    let mut byte = [0; 1];
    assert!(matches!(timeout(Duration::from_secs(3), peer.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
    gateway.abort();
    timeout(Duration::from_secs(3), gateway.wait_closed()).await.unwrap().unwrap();
}
