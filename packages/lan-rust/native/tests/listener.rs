use bottleship_lan_native::listener::*;
use bytes::Bytes;
use std::{
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    time::Duration,
};
use tokio::{
    net::UdpSocket,
    time::{sleep, timeout},
};

async fn packet(events: &mut ListenerEvents) -> ListenerDatagram {
    timeout(Duration::from_secs(2), events.datagrams.recv())
        .await
        .unwrap()
        .unwrap()
}
async fn peer() -> UdpSocket {
    UdpSocket::bind("127.0.0.1:0").await.unwrap()
}
async fn receive(socket: &UdpSocket) -> (Vec<u8>, SocketAddr) {
    let mut bytes = vec![0; 65536];
    let (size, address) = timeout(Duration::from_secs(2), socket.recv_from(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    bytes.truncate(size);
    (bytes, address)
}
async fn until(mut test: impl FnMut() -> bool) {
    timeout(Duration::from_secs(2), async {
        while !test() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn actual_bound_port_no_dummy_and_bidirectional_exact_tuple() {
    let config = ListenerConfig {
        advertised_ip: Ipv4Addr::new(203, 0, 113, 99),
        ..ListenerConfig::default()
    };
    let (listener, mut events) = NativeUdpListener::start(config).unwrap();
    let ready = listener.when_ready().await.unwrap();
    assert_ne!(ready.bound.port(), 0);
    assert_eq!(*ready.bound.ip(), Ipv4Addr::LOCALHOST);
    assert_eq!(
        ready.advertised,
        SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 99), ready.bound.port())
    );
    let remote = peer().await;
    let endpoint = match remote.local_addr().unwrap() {
        SocketAddr::V4(v) => v,
        _ => unreachable!(),
    };
    let unknown = ListenerPeer {
        id: 1,
        epoch: 1,
        endpoint,
    };
    assert_eq!(
        listener
            .try_send(unknown, b"not-received")
            .err()
            .unwrap()
            .code,
        10013
    );
    let mut scratch = [0; 64];
    assert!(
        timeout(Duration::from_millis(30), remote.recv_from(&mut scratch))
            .await
            .is_err(),
        "listener sent a dummy packet"
    );
    for size in [0, 3, 65507] {
        let data: Vec<u8> = (0..size).map(|n| (n % 251) as u8).collect();
        remote.send_to(&data, ready.bound).await.unwrap();
        let incoming = packet(&mut events).await;
        assert_eq!(incoming.peer.endpoint, endpoint);
        assert_eq!(incoming.bytes.as_ref(), data.as_slice());
        listener
            .try_send(incoming.peer, &data)
            .unwrap()
            .completion()
            .await
            .unwrap();
        let (reply, source) = receive(&remote).await;
        assert_eq!(reply, data);
        assert_eq!(
            source,
            SocketAddr::V4(ready.bound),
            "TX did not use the physical listening socket"
        );
        drop(incoming);
    }
    listener.close().await.unwrap();
    assert_eq!(listener.metrics().tx.records, 0);
    assert_eq!(listener.metrics().rx.records, 0);
    let rebound = UdpSocket::bind(ready.bound).await.unwrap();
    assert_eq!(rebound.local_addr().unwrap(), SocketAddr::V4(ready.bound));
}

#[tokio::test]
async fn source_ip_acl_drops_without_peer_admission() {
    let config = ListenerConfig {
        allowed_hosts: vec![Ipv4Addr::new(192, 0, 2, 1)],
        ..ListenerConfig::default()
    };
    let (listener, mut events) = NativeUdpListener::start(config).unwrap();
    let ready = listener.when_ready().await.unwrap();
    let remote = peer().await;
    remote.send_to(b"forbidden", ready.bound).await.unwrap();
    until(|| events.losses.borrow().unauthorized_packets == 1).await;
    assert_eq!(listener.metrics().peers, 0);
    assert!(events.datagrams.try_recv().is_err());
    listener.close().await.unwrap();
}

#[tokio::test]
async fn dynamic_peers_are_bounded_expire_and_do_not_resurrect_old_tokens() {
    let config = ListenerConfig {
        max_peers: 1,
        idle_timeout: Duration::from_millis(40),
        ..ListenerConfig::default()
    };
    let (listener, mut events) = NativeUdpListener::start(config).unwrap();
    let ready = listener.when_ready().await.unwrap();
    let first = peer().await;
    let second = peer().await;
    first.send_to(b"first", ready.bound).await.unwrap();
    let old = packet(&mut events).await.peer;
    second.send_to(b"too-many", ready.bound).await.unwrap();
    until(|| events.losses.borrow().peer_limit_packets == 1).await;
    assert_eq!(listener.metrics().peers, 1);
    sleep(Duration::from_millis(75)).await;
    until(|| listener.metrics().peers == 0).await;
    assert!(listener.try_send(old, b"stale").is_err());
    first.send_to(b"new-admission", ready.bound).await.unwrap();
    let new = packet(&mut events).await.peer;
    assert_eq!(new.endpoint, old.endpoint);
    assert_ne!(new.id, old.id);
    assert_eq!(new.epoch, old.epoch);
    assert!(listener.try_send(old, b"stale-id").is_err());
    listener
        .try_send(new, b"valid")
        .unwrap()
        .completion()
        .await
        .unwrap();
    assert_eq!(receive(&first).await.0, b"valid");
    listener.close().await.unwrap();

    let config = ListenerConfig {
        bind: ready.bound,
        ..ListenerConfig::default()
    };
    let (replacement, mut next_events) = NativeUdpListener::start(config).unwrap();
    replacement.when_ready().await.unwrap();
    first.send_to(b"replacement", ready.bound).await.unwrap();
    let next = packet(&mut next_events).await.peer;
    assert_ne!(next.epoch, old.epoch);
    assert!(replacement.try_send(new, b"old-lifetime").is_err());
    replacement.close().await.unwrap();
}

#[tokio::test]
async fn receive_credits_follow_consumer_empty_packets_still_take_records() {
    let config = ListenerConfig {
        rx_records: 1,
        rx_bytes: 4,
        ..ListenerConfig::default()
    };
    let (listener, mut events) = NativeUdpListener::start(config).unwrap();
    let ready = listener.when_ready().await.unwrap();
    let remote = peer().await;
    remote.send_to(b"1234", ready.bound).await.unwrap();
    let held = packet(&mut events).await;
    assert_eq!(listener.metrics().rx.records, 1);
    assert_eq!(listener.metrics().rx.bytes, 4);
    remote.send_to(b"", ready.bound).await.unwrap();
    until(|| events.losses.borrow().rx_packets == 1).await;
    assert_eq!(events.losses.borrow().rx_bytes, 0);
    drop(held);
    assert_eq!(listener.metrics().rx.records, 0);
    remote.send_to(b"12345", ready.bound).await.unwrap();
    until(|| events.losses.borrow().rx_packets == 2).await;
    assert_eq!(events.losses.borrow().rx_bytes, 5);
    remote.send_to(b"", ready.bound).await.unwrap();
    let empty = packet(&mut events).await;
    assert_eq!(listener.metrics().rx.records, 1);
    assert_eq!(listener.metrics().rx.bytes, 0);
    listener.close().await.unwrap();
    // Physical close is independent of an application retaining already received bytes.
    assert_eq!(listener.metrics().rx.records, 1);
    let _rebound = UdpSocket::bind(ready.bound).await.unwrap();
    drop(empty);
    assert_eq!(listener.metrics().rx.records, 0);
}

#[tokio::test]
async fn transmit_byte_and_record_limits_precede_copy_and_no_accepted_retry() {
    let config = ListenerConfig {
        tx_records: 3,
        tx_bytes: 4,
        ..ListenerConfig::default()
    };
    let (listener, mut events) = NativeUdpListener::start(config).unwrap();
    let ready = listener.when_ready().await.unwrap();
    let remote = peer().await;
    remote.send_to(b"admit", ready.bound).await.unwrap();
    let token = packet(&mut events).await.peer;
    let data = listener.try_send(token, b"1234").unwrap();
    assert_eq!(listener.try_send(token, b"x").err().unwrap().code, 10055);
    let empty1 = listener.try_send(token, b"").unwrap();
    let empty2 = listener.try_send(token, b"").unwrap();
    assert_eq!(listener.try_send(token, b"").err().unwrap().code, 10055);
    let used = listener.metrics().tx;
    assert_eq!(used.records, 3);
    assert_eq!(used.bytes, 4);
    data.completion().await.unwrap();
    empty1.completion().await.unwrap();
    empty2.completion().await.unwrap();
    assert_eq!(receive(&remote).await.0, b"1234");
    assert_eq!(receive(&remote).await.0, b"");
    assert_eq!(receive(&remote).await.0, b"");
    let mut scratch = [0; 8];
    assert!(
        timeout(Duration::from_millis(30), remote.recv_from(&mut scratch))
            .await
            .is_err(),
        "accepted datagram was retried"
    );
    assert_eq!(listener.metrics().tx.records, 0);
    assert_eq!(listener.metrics().tx.bytes, 0);
    listener.close().await.unwrap();
}

#[tokio::test]
async fn startup_abort_and_queued_writes_retire_without_waiting_for_configured_deadline() {
    let temporary = peer().await;
    let address = match temporary.local_addr().unwrap() {
        SocketAddr::V4(v) => v,
        _ => unreachable!(),
    };
    drop(temporary);
    let config = ListenerConfig {
        bind: address,
        startup_timeout: Duration::from_secs(120),
        ..ListenerConfig::default()
    };
    let (listener, _events) = NativeUdpListener::start(config).unwrap();
    listener.abort();
    timeout(Duration::from_secs(2), listener.wait_closed())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(listener.when_ready().await.err().unwrap().code, 995);
    let _free = UdpSocket::bind(address).await.unwrap();
    drop(_free);

    let (listener, mut events) = NativeUdpListener::start(ListenerConfig::default()).unwrap();
    let ready = listener.when_ready().await.unwrap();
    let remote = peer().await;
    remote.send_to(b"admit", ready.bound).await.unwrap();
    let token = packet(&mut events).await.peer;
    let first = listener.try_send(token, b"must-cancel").unwrap();
    let second = listener.try_send(token, b"must-cancel-too").unwrap();
    listener.abort();
    listener.wait_closed().await.unwrap();
    assert_eq!(first.completion().await.err().unwrap().code, 995);
    assert_eq!(second.completion().await.err().unwrap().code, 995);
    assert_eq!(listener.metrics().tx.records, 0);
    assert_eq!(
        listener.try_send(token, b"after-close").err().unwrap().code,
        10058
    );
    let _free = UdpSocket::bind(ready.bound).await.unwrap();
}

#[tokio::test]
async fn bind_conflict_never_publishes_ready_and_last_handle_drop_releases_socket() {
    let occupied = peer().await;
    let bind = match occupied.local_addr().unwrap() {
        SocketAddr::V4(v) => v,
        _ => unreachable!(),
    };
    let (listener, events) = NativeUdpListener::start(ListenerConfig {
        bind,
        ..ListenerConfig::default()
    })
    .unwrap();
    assert_eq!(listener.when_ready().await.err().unwrap().code, 10048);
    assert!(events.status.borrow().ready.is_none());
    assert_eq!(listener.wait_closed().await.err().unwrap().code, 10048);

    let (listener, mut events) = NativeUdpListener::start(ListenerConfig::default()).unwrap();
    let ready = listener.when_ready().await.unwrap();
    let remaining = listener.clone();
    drop(listener);
    assert!(!events.status.borrow().closed);
    drop(remaining);
    timeout(Duration::from_secs(2), async {
        while !events.status.borrow_and_update().closed {
            events.status.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    let _free = UdpSocket::bind(ready.bound).await.unwrap();
}

#[tokio::test]
async fn disconnected_consumer_retires_physical_listener_and_policy_is_validated() {
    for config in [
        ListenerConfig {
            allowed_hosts: vec![],
            ..ListenerConfig::default()
        },
        ListenerConfig {
            advertised_ip: Ipv4Addr::UNSPECIFIED,
            ..ListenerConfig::default()
        },
        ListenerConfig {
            advertised_ip: Ipv4Addr::new(239, 1, 2, 3),
            ..ListenerConfig::default()
        },
        ListenerConfig {
            max_peers: 129,
            ..ListenerConfig::default()
        },
    ] {
        assert_eq!(
            NativeUdpListener::start(config).err().map(|e| e.code),
            Some(10022)
        );
    }
    let (listener, events) = NativeUdpListener::start(ListenerConfig::default()).unwrap();
    let ready = listener.when_ready().await.unwrap();
    drop(events.datagrams);
    timeout(Duration::from_secs(2), listener.wait_closed())
        .await
        .unwrap()
        .unwrap();
    let _free = UdpSocket::bind(ready.bound).await.unwrap();
}

#[tokio::test]
async fn concurrent_listener_tokens_cannot_cross_physical_owners() {
    let (first, mut first_events) = NativeUdpListener::start(ListenerConfig::default()).unwrap();
    let (second, mut second_events) = NativeUdpListener::start(ListenerConfig::default()).unwrap();
    let a = first.when_ready().await.unwrap();
    let b = second.when_ready().await.unwrap();
    assert_ne!(a.bound.port(), b.bound.port());
    let remote = peer().await;
    remote.send_to(b"a", a.bound).await.unwrap();
    let token_a = packet(&mut first_events).await.peer;
    assert!(second.try_send(token_a, b"foreign-unadmitted").is_err());
    remote.send_to(b"b", b.bound).await.unwrap();
    let token_b = packet(&mut second_events).await.peer;
    assert_eq!(token_a.endpoint, token_b.endpoint);
    assert_eq!(token_a.id, token_b.id);
    assert_ne!(token_a.epoch, token_b.epoch);
    assert_eq!(
        second
            .try_send(token_a, b"foreign-epoch")
            .err()
            .unwrap()
            .code,
        10057
    );
    assert_eq!(
        first
            .try_send(token_b, b"foreign-epoch")
            .err()
            .unwrap()
            .code,
        10057
    );
    second
        .try_send(token_b, b"b-reply")
        .unwrap()
        .completion()
        .await
        .unwrap();
    assert_eq!(
        receive(&remote).await,
        (b"b-reply".to_vec(), SocketAddr::V4(b.bound))
    );
    first.close().await.unwrap();
    second.close().await.unwrap();
}

#[tokio::test]
async fn endpoint_lookup_never_synthesizes_or_refreshes_a_peer() {
    let config = ListenerConfig {
        idle_timeout: Duration::from_secs(1),
        ..ListenerConfig::default()
    };
    let (listener, mut events) = NativeUdpListener::start(config).unwrap();
    let ready = listener.when_ready().await.unwrap();
    let remote = peer().await;
    let endpoint = match remote.local_addr().unwrap() {
        SocketAddr::V4(v) => v,
        _ => unreachable!(),
    };
    assert!(listener.peer_for_endpoint(endpoint).is_none());
    remote.send_to(b"real", ready.bound).await.unwrap();
    let token = packet(&mut events).await.peer;
    assert_eq!(listener.peer_for_endpoint(endpoint), Some(token));
    tokio::time::pause();
    tokio::time::advance(Duration::from_millis(600)).await;
    assert_eq!(listener.peer_for_endpoint(endpoint), Some(token));
    tokio::time::advance(Duration::from_millis(500)).await;
    assert!(
        listener.peer_for_endpoint(endpoint).is_none(),
        "query refreshed the idle deadline"
    );
    tokio::time::resume();
    listener.close().await.unwrap();
    assert!(listener.peer_for_endpoint(endpoint).is_none());
}

#[tokio::test]
async fn aborted_ready_handle_cannot_republish_a_stale_ready_before_driver_runs() {
    let (listener, _events) = NativeUdpListener::start(ListenerConfig::default()).unwrap();
    listener.when_ready().await.unwrap();
    listener.abort();
    // No yield to the driver between the abort fence and the READY query.
    assert_eq!(listener.when_ready().await.err().map(|e| e.code), Some(995));
    listener.wait_closed().await.unwrap();
}

#[test]
fn runtime_destroyed_before_first_driver_poll_also_retires_admission() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (listener, events) = {
        let _entered = runtime.enter();
        NativeUdpListener::start(ListenerConfig::default()).unwrap()
    };
    drop(runtime);
    assert!(
        events.status.borrow().closed,
        "unpolled driver left admission live"
    );
    assert_eq!(
        events.status.borrow().error.as_ref().map(|e| e.code),
        Some(10050)
    );
    let token = ListenerPeer {
        id: 1,
        epoch: 1,
        endpoint: "127.0.0.1:42".parse().unwrap(),
    };
    assert_eq!(
        listener.try_send(token, b"not-ready").err().unwrap().code,
        10058
    );
}

#[test]
fn destroyed_runtime_invalidates_the_driver_epoch_before_status_is_observed() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (listener, events, ready) = runtime.block_on(async {
        let (listener, events) = NativeUdpListener::start(ListenerConfig::default()).unwrap();
        let ready = listener.when_ready().await.unwrap();
        (listener, events, ready)
    });
    drop(runtime);
    assert!(
        events.status.borrow().closed,
        "cancelled driver left a stale READY epoch"
    );
    assert_eq!(
        events.status.borrow().error.as_ref().map(|e| e.code),
        Some(10050)
    );
    let _free = std::net::UdpSocket::bind(ready.bound).unwrap();
    let token = ListenerPeer {
        id: 1,
        epoch: 1,
        endpoint: ready.bound,
    };
    assert_eq!(
        listener
            .try_send(token, b"after-driver-death")
            .err()
            .unwrap()
            .code,
        10058
    );
}

// Keep a compile-time assertion that received bytes can be moved to a bounded
// gateway queue without requiring a guest-memory or actor reference.
fn _owned_packet(_bytes: Bytes) {}
