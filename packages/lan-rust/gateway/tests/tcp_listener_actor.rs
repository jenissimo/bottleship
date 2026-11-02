use bottleship_lan_core::{
    GatewayEvent, GatewayInput, TcpChildKey, TcpOfferKey,
    config::{GatewayConfig, TcpListenerConfig, UdpListenerConfig},
    gateway::{BindingToken, DestinationPolicy},
    wire::{Datagram, TcpFrame, TCP_WINDOW},
    routes::{NativeAddress, Target},
};
use bottleship_lan_gateway::{Gateway, GatewayOptions};
use bytes::Bytes;
use std::{sync::{Arc, Mutex}, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream, UdpSocket}, time::timeout};

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
async fn tcp_output_backpressure_resumes_and_abort_interrupts_wait() {
    let listener = TcpListenerConfig { id: "pressure".into(), bind_host: "127.0.0.1".into(),
        advertised_host: "127.0.0.1".into(), port: 0, allowed_hosts: vec!["127.0.0.1".into()],
        max_owners: 1, max_pending: 4, startup_timeout_ms: 2000 };
    let mut config = GatewayConfig::default();config.tcp_listeners.push(listener.clone());
    let binding = BindingToken { proto: 2, local_port: 2310, generation: Some(1) };
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let options = GatewayOptions { output_records: 2, ..GatewayOptions::default() };
    let (gateway, mut events) = Gateway::spawn(7, config, policy.clone(), options).unwrap();
    gateway.try_submit(GatewayInput::OpenTcpListener { operation_id: 1, binding, config: listener }).unwrap();
    let opened = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    let (lease_id, address) = match &opened.event { GatewayEvent::TcpListenerReady { lease_id, address, .. } => (*lease_id, *address), other => panic!("unexpected: {other:?}") };drop(opened);
    let mut native = TcpStream::connect(address).await.unwrap();
    let offered = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    let syn = match &offered.event { GatewayEvent::TcpListenerFrame { datagram, .. } => datagram.clone(), other => panic!("unexpected: {other:?}") };drop(offered);
    let frame = TcpFrame::decode(syn.payload.clone()).unwrap();
    let key = TcpChildKey { lease_id, binding, node: syn.node, remote_port: syn.src_port, native_id: frame.src_id, guest_id: 123 };
    let mut synack = packet(key, 2, b"");synack.payload = TcpFrame { kind: 2, src_id: key.guest_id, dst_id: key.native_id, value: TCP_WINDOW, data: Bytes::new() }.encode();
    gateway.try_submit(GatewayInput::TcpListenerFrame { lease_id, binding, datagram: synack }).unwrap();
    let established = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    assert!(matches!(&established.event, GatewayEvent::TcpChildEstablished { key: k } if *k == key));drop(established);
    let offer_closed = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    assert!(matches!(&offer_closed.event, GatewayEvent::TcpOfferClosed { .. }));drop(offer_closed);
    native.write_all(b"first").await.unwrap();
    let first = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    native.write_all(b"second").await.unwrap();
    let second = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    native.write_all(b"third").await.unwrap();
    assert!(timeout(Duration::from_millis(50), events.outputs.recv()).await.is_err());
    assert!(!events.status.borrow().closed);
    drop(first);
    let third = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    let f = match &third.event { GatewayEvent::TcpChildFrame { datagram, .. } => TcpFrame::decode(datagram.payload.clone()).unwrap(), other => panic!("unexpected: {other:?}") };
    assert_eq!(&f.data[..], b"third");
    native.write_all(b"fourth").await.unwrap();
    assert!(timeout(Duration::from_millis(50), events.outputs.recv()).await.is_err());
    let stale = TcpChildKey { native_id: key.native_id.wrapping_add(1), ..key };
    gateway.try_submit(GatewayInput::CloseTcpChild { key: stale }).unwrap();
    let stale_lease = TcpChildKey { lease_id: key.lease_id.wrapping_add(1), ..key };
    gateway.try_submit(GatewayInput::CloseTcpChild { key: stale_lease }).unwrap();
    gateway.try_submit(GatewayInput::TcpChildFrame { key: stale_lease, datagram: packet(key, 5, b"") }).unwrap();
    let mut probe = [0u8; 1];
    assert!(timeout(Duration::from_millis(50), native.read(&mut probe)).await.is_err());
    gateway.try_submit(GatewayInput::CloseTcpChild { key }).unwrap();
    // Free output immediately after admission, before relying on actor progress.
    drop(second);
    assert_eq!(timeout(Duration::from_secs(2), native.read(&mut probe)).await.unwrap().unwrap(), 0);
    let closed = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    assert!(matches!(&closed.event, GatewayEvent::TcpChildClosed { key: k } if *k == key), "queued TCP data must not escape after child close");
    drop(closed);drop(third);
    gateway.abort();
    timeout(Duration::from_secs(3), gateway.wait_closed()).await.unwrap().unwrap();
    assert_eq!(policy.lock().unwrap().active_leases(), 0);
}

#[tokio::test]
async fn tcp_listener_control_messages_wait_for_a_single_output_slot() {
    let listener = TcpListenerConfig { id: "one-slot".into(), bind_host: "127.0.0.1".into(),
        advertised_host: "127.0.0.1".into(), port: 0, allowed_hosts: vec!["127.0.0.1".into()],
        max_owners: 1, max_pending: 4, startup_timeout_ms: 2000 };
    let reserved=TcpListener::bind("127.0.0.1:0").await.unwrap();let second_port=reserved.local_addr().unwrap().port();drop(reserved);
    let second_listener=TcpListenerConfig {id:"cancel-wait".into(),port:second_port,..listener.clone()};
    let mut config = GatewayConfig::default();config.tcp_listeners.push(listener.clone());config.tcp_listeners.push(second_listener.clone());
    let binding = BindingToken { proto: 2, local_port: 2310, generation: Some(1) };
    let options = GatewayOptions { output_records: 1, ..GatewayOptions::default() };
    let (gateway, mut events) = Gateway::spawn(7, config, Arc::new(Mutex::new(DestinationPolicy::default())), options).unwrap();
    gateway.try_submit(GatewayInput::OpenTcpListener { operation_id: 1, binding, config: listener }).unwrap();
    let ready=timeout(Duration::from_secs(3),events.outputs.recv()).await.unwrap().unwrap();
    let (lease_id,address)=match &ready.event {GatewayEvent::TcpListenerReady{lease_id,address,..}=>(*lease_id,*address),other=>panic!("unexpected: {other:?}")};drop(ready);
    let mut native=TcpStream::connect(address).await.unwrap();
    let offered=timeout(Duration::from_secs(3),events.outputs.recv()).await.unwrap().unwrap();
    let syn=match &offered.event {GatewayEvent::TcpListenerFrame {datagram,..}=>datagram.clone(),other=>panic!("unexpected: {other:?}")};drop(offered);
    let frame=TcpFrame::decode(syn.payload.clone()).unwrap();
    let key=TcpChildKey {lease_id,binding,node:syn.node,remote_port:syn.src_port,native_id:frame.src_id,guest_id:123};
    let mut synack=packet(key,2,b"");synack.payload=TcpFrame {kind:2,src_id:key.guest_id,dst_id:key.native_id,value:TCP_WINDOW,data:Bytes::new()}.encode();
    gateway.try_submit(GatewayInput::TcpListenerFrame {lease_id,binding,datagram:synack}).unwrap();
    let established=timeout(Duration::from_secs(3),events.outputs.recv()).await.unwrap().unwrap();
    assert!(matches!(&established.event,GatewayEvent::TcpChildEstablished {key:k} if *k==key));
    assert!(timeout(Duration::from_millis(75),events.outputs.recv()).await.is_err());
    assert!(!events.status.borrow().closed);
    drop(established);
    let closed=timeout(Duration::from_secs(3),events.outputs.recv()).await.unwrap().unwrap();
    assert!(matches!(&closed.event,GatewayEvent::TcpOfferClosed {..}));drop(closed);
    native.write_all(b"held").await.unwrap();
    let held=timeout(Duration::from_secs(3),events.outputs.recv()).await.unwrap().unwrap();
    let binding2=BindingToken {proto:2,local_port:2311,generation:Some(1)};
    gateway.try_submit(GatewayInput::OpenTcpListener {operation_id:2,binding:binding2,config:second_listener}).unwrap();
    let second_address=std::net::SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST,second_port);
    timeout(Duration::from_secs(3),async {loop {if TcpListener::bind(second_address).await.is_err(){break} tokio::time::sleep(Duration::from_millis(10)).await;}}).await.unwrap();
    gateway.try_submit(GatewayInput::CancelOperation {operation:2}).unwrap();
    let reclaimed=timeout(Duration::from_secs(3),async {loop {if let Ok(socket)=TcpListener::bind(second_address).await{break socket} tokio::time::sleep(Duration::from_millis(10)).await;}}).await.unwrap();drop(reclaimed);
    drop(held);
    assert!(timeout(Duration::from_millis(100),events.outputs.recv()).await.is_err(),"cancelled open must not publish READY or FAIL");
    gateway.abort();timeout(Duration::from_secs(3),gateway.wait_closed()).await.unwrap().unwrap();
}

#[tokio::test]
async fn one_full_tcp_output_does_not_block_another_child_write() {
    let listener = TcpListenerConfig { id: "pressure".into(), bind_host: "127.0.0.1".into(),
        advertised_host: "127.0.0.1".into(), port: 0, allowed_hosts: vec!["127.0.0.1".into()],
        max_owners: 1, max_pending: 4, startup_timeout_ms: 2000 };
    let mut config = GatewayConfig::default(); config.tcp_listeners.push(listener.clone());
    let binding = BindingToken { proto: 2, local_port: 2310, generation: Some(1) };
    let options = GatewayOptions { output_records: 2, ..GatewayOptions::default() };
    let (gateway, mut events) = Gateway::spawn(7, config, Arc::new(Mutex::new(DestinationPolicy::default())), options).unwrap();
    gateway.try_submit(GatewayInput::OpenTcpListener { operation_id: 1, binding, config: listener }).unwrap();
    let opened = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    let (lease_id, address) = match &opened.event { GatewayEvent::TcpListenerReady { lease_id, address, .. } => (*lease_id, *address), other => panic!("unexpected: {other:?}") }; drop(opened);
    async fn child(gateway: &bottleship_lan_gateway::GatewayHandle, events: &mut bottleship_lan_gateway::GatewayEvents, address: std::net::SocketAddrV4, binding: BindingToken, lease_id: u64, guest_id: u32) -> (TcpStream, TcpChildKey) {
        let native = TcpStream::connect(address).await.unwrap();
        let offered = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
        let syn = match &offered.event { GatewayEvent::TcpListenerFrame { datagram, .. } => datagram.clone(), other => panic!("unexpected: {other:?}") }; drop(offered);
        let frame = TcpFrame::decode(syn.payload.clone()).unwrap();
        let key = TcpChildKey { lease_id, binding, node: syn.node, remote_port: syn.src_port, native_id: frame.src_id, guest_id };
        let mut synack = packet(key, 2, b""); synack.payload = TcpFrame { kind: 2, src_id: guest_id, dst_id: key.native_id, value: TCP_WINDOW, data: Bytes::new() }.encode();
        gateway.try_submit(GatewayInput::TcpListenerFrame { lease_id, binding, datagram: synack }).unwrap();
        let established = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
        assert!(matches!(&established.event, GatewayEvent::TcpChildEstablished { key: k } if *k == key)); drop(established);
        let offer_closed = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
        assert!(matches!(&offer_closed.event, GatewayEvent::TcpOfferClosed { .. })); drop(offer_closed);
        (native, key)
    }
    let (mut first, first_key) = child(&gateway, &mut events, address, binding, lease_id, 123).await;
    let (mut second, second_key) = child(&gateway, &mut events, address, binding, lease_id, 124).await;
    let udp_binding = BindingToken { proto: 1, local_port: 2312, generation: Some(1) };
    let udp_listener = UdpListenerConfig { id: "independent-udp".into(), bind_host: "127.0.0.1".into(), advertised_host: "127.0.0.1".into(), port: 0, allowed_hosts: vec!["127.0.0.1".into()], max_owners: 1, max_peers: 8, idle_timeout_ms: 60000 };
    gateway.try_submit(GatewayInput::OpenUdpHost { operation: 2, binding: udp_binding, listener: udp_listener }).unwrap();
    let ready = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    let udp_port = match &ready.event { GatewayEvent::HostReady { port, .. } => *port, other => panic!("unexpected UDP listener event: {other:?}") }; drop(ready);
    let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    first.write_all(b"first").await.unwrap();
    let held1 = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    first.write_all(b"second").await.unwrap();
    let held2 = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    first.write_all(b"third").await.unwrap();
    assert!(timeout(Duration::from_millis(75), events.outputs.recv()).await.is_err());
    let mut status = events.status.clone();
    let dropped = status.borrow().dropped_udp_packets;
    udp.send_to(b"independent-udp", ("127.0.0.1", udp_port)).await.unwrap();
    timeout(Duration::from_secs(2), async {
        loop {
            if status.borrow().dropped_udp_packets > dropped { break; }
            status.changed().await.unwrap();
        }
    }).await.expect("UDP packet was not processed under TCP output pressure");
    gateway.try_submit(GatewayInput::TcpChildFrame { key: second_key, datagram: packet(second_key, 3, b"independent") }).unwrap();
    let mut bytes = [0u8; 11];
    let delivered = timeout(Duration::from_secs(2), second.read_exact(&mut bytes)).await;
    assert!(delivered.is_ok(), "blocked first child prevented the second child write");
    assert_eq!(&bytes, b"independent");
    gateway.try_submit(GatewayInput::CloseTcpChild { key: second_key }).unwrap();
    let mut eof=[0u8;1];
    assert_eq!(timeout(Duration::from_secs(3), second.read(&mut eof)).await.unwrap().unwrap(),0);
    drop(held1);
    let third = timeout(Duration::from_secs(3), events.outputs.recv()).await.unwrap().unwrap();
    let f = match &third.event { GatewayEvent::TcpChildFrame { key,datagram } if *key==first_key => TcpFrame::decode(datagram.payload.clone()).unwrap(), other => panic!("unexpected delayed output: {other:?}") };
    assert_eq!(&f.data[..], b"third");
    drop(held2);drop(third);
    let closed = timeout(Duration::from_secs(3), async {
        loop {
            let out=events.outputs.recv().await.expect("gateway closed while retiring another child");
            if matches!(&out.event,GatewayEvent::TcpChildClosed {key} if *key==second_key) { break out; }
        }
    }).await.unwrap();
    drop(closed);
    udp.send_to(b"after-pressure", ("127.0.0.1", udp_port)).await.unwrap();
    timeout(Duration::from_secs(3), async {
        loop {
            let out = events.outputs.recv().await.expect("gateway closed before UDP resumed");
            if let GatewayEvent::HostFrame { binding, datagram, .. } = &out.event {
                assert_eq!(*binding, udp_binding);
                assert_eq!(&datagram.payload[..], b"after-pressure");
                break;
            }
        }
    }).await.expect("UDP did not resume after output pressure");
    assert!(!events.status.borrow().closed);
    gateway.abort();
    timeout(Duration::from_secs(3), gateway.wait_closed()).await.unwrap().unwrap();
    assert_ne!(first_key, second_key);
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
