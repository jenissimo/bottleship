use bottleship_lan_native::{
    tcp::{NativeTcp, TcpOptions},
    tcp_listener::{NativeTcpListener, TcpListenerConfig, TcpListenerStatus},
    tcp_quota::TcpQuota,
};
use std::{net::{Ipv4Addr, SocketAddr}, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    time::timeout,
};

async fn ready(listener: &NativeTcpListener) -> std::net::SocketAddrV4 {
    timeout(Duration::from_secs(3), listener.when_ready()).await.unwrap().unwrap().bound
}
async fn wait_status(mut status: watch::Receiver<TcpListenerStatus>, test: impl Fn(&TcpListenerStatus) -> bool) {
    timeout(Duration::from_secs(3), async {
        loop {
            if test(&status.borrow_and_update()) { return; }
            status.changed().await.unwrap();
        }
    }).await.unwrap();
}
async fn connect(address: std::net::SocketAddrV4) -> TcpStream {
    timeout(Duration::from_secs(3), TcpStream::connect(SocketAddr::V4(address))).await.unwrap().unwrap()
}

#[tokio::test]
async fn shared_quota_ignores_idle_listeners_and_follows_accepted_socket() {
    let quota = TcpQuota::new(1);
    let first = NativeTcpListener::start_with_quota(TcpListenerConfig::default(), quota.clone()).unwrap();
    let second = NativeTcpListener::start_with_quota(TcpListenerConfig::default(), quota.clone()).unwrap();
    let a = ready(&first).await;
    let b = ready(&second).await;
    // Idle poll_accept must not hold the sole slot, even with multiple listeners.
    for _ in 0..100 {
        let permit = quota.try_acquire().expect("idle listener reserved quota");
        drop(permit);
        tokio::task::yield_now().await;
    }
    let mut peer_a = connect(a).await;
    let accepted_a = timeout(Duration::from_secs(3), first.accept()).await.unwrap().unwrap();
    assert_eq!(quota.available(), 0);
    let peer_b = connect(b).await;
    assert!(timeout(Duration::from_millis(100), second.accept()).await.is_err());
    drop(accepted_a);
    let mut byte = [0; 1];
    assert!(matches!(timeout(Duration::from_secs(3), peer_a.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
    let accepted_b = timeout(Duration::from_secs(3), second.accept()).await.unwrap().unwrap();
    assert_eq!(quota.available(), 0);
    drop(accepted_b);
    drop(peer_b);
    first.abort(); second.abort();
    timeout(Duration::from_secs(3), first.wait_closed()).await.unwrap().unwrap();
    timeout(Duration::from_secs(3), second.wait_closed()).await.unwrap().unwrap();
    assert_eq!(quota.available(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_ready_and_idle_listeners_progress_with_shared_socket_limit() {
    let quota = TcpQuota::new(2);
    let first = NativeTcpListener::start_with_quota(TcpListenerConfig::default(), quota.clone()).unwrap();
    let second = NativeTcpListener::start_with_quota(TcpListenerConfig::default(), quota.clone()).unwrap();
    let idle = NativeTcpListener::start_with_quota(TcpListenerConfig::default(), quota.clone()).unwrap();
    let first_addr = ready(&first).await;
    let second_addr = ready(&second).await;
    ready(&idle).await;
    let pressure_quota = quota.clone();
    let pressure = tokio::spawn(async move {
        for _ in 0..500 {
            loop {
                if let Some(permit) = pressure_quota.try_acquire() {
                    tokio::task::yield_now().await;
                    drop(permit);
                    break;
                }
                tokio::task::yield_now().await;
            }
        }
    });
    timeout(Duration::from_secs(10), async {
        for _ in 0..20 {
            let (mut a, mut b) = tokio::join!(connect(first_addr), connect(second_addr));
            let (owned_a, owned_b) = tokio::join!(first.accept(), second.accept());
            let owned_a = owned_a.unwrap();
            let owned_b = owned_b.unwrap();
            assert_eq!(quota.available(), 0);
            drop(owned_a); drop(owned_b);
            let mut byte = [0; 1];
            assert!(matches!(a.read(&mut byte).await, Ok(0) | Err(_)));
            assert!(matches!(b.read(&mut byte).await, Ok(0) | Err(_)));
        }
        pressure.await.unwrap();
    }).await.unwrap();
    first.abort(); second.abort(); idle.abort();
    timeout(Duration::from_secs(3), first.wait_closed()).await.unwrap().unwrap();
    timeout(Duration::from_secs(3), second.wait_closed()).await.unwrap().unwrap();
    timeout(Duration::from_secs(3), idle.wait_closed()).await.unwrap().unwrap();
    assert_eq!(quota.available(), 2);
}

#[tokio::test]
async fn quota_listener_abort_closes_queued_socket_and_pending_accept() {
    let quota = TcpQuota::new(1);
    let idle = NativeTcpListener::start_with_quota(TcpListenerConfig::default(), quota.clone()).unwrap();
    ready(&idle).await;
    idle.abort();
    timeout(Duration::from_secs(3), idle.wait_closed()).await.unwrap().unwrap();
    assert_eq!(quota.available(), 1);

    let listener = NativeTcpListener::start_with_quota(TcpListenerConfig::default(), quota.clone()).unwrap();
    let addr = ready(&listener).await;
    let mut peer = connect(addr).await;
    wait_status(listener.subscribe(), |s| s.pending == 1).await;
    assert_eq!(quota.available(), 0);
    listener.abort();
    timeout(Duration::from_secs(3), listener.wait_closed()).await.unwrap().unwrap();
    let mut byte = [0; 1];
    assert!(matches!(timeout(Duration::from_secs(3), peer.read(&mut byte)).await.unwrap(), Ok(0) | Err(_)));
    assert_eq!(quota.available(), 1);
}

#[tokio::test]
async fn real_listener_transfers_accepted_stream_into_existing_tcp_actor() {
    let listener = NativeTcpListener::start(TcpListenerConfig::default()).unwrap();
    let addr = ready(&listener).await;
    let mut peer = connect(addr).await;
    let accepted = timeout(Duration::from_secs(3), listener.accept()).await.unwrap().unwrap();
    assert_eq!(*accepted.peer.ip(), Ipv4Addr::LOCALHOST);
    assert!(accepted.epoch > 0 && accepted.id > 0);
    let (actor, mut events) = NativeTcp::from_accepted(accepted.stream, TcpOptions::default()).unwrap();
    listener.abort();
    timeout(Duration::from_secs(3), listener.wait_closed()).await.unwrap().unwrap();

    peer.write_all(b"abc").await.unwrap();
    let mut bytes = Vec::new();
    while bytes.len() < 3 {
        let packet = timeout(Duration::from_secs(3), events.reads.recv()).await.unwrap().unwrap();
        bytes.extend_from_slice(packet.data().unwrap());
    }
    assert_eq!(bytes, b"abc");
    timeout(Duration::from_secs(3), actor.try_write(b"reply").unwrap().completion()).await.unwrap().unwrap();
    let mut reply = [0; 5];
    timeout(Duration::from_secs(3), peer.read_exact(&mut reply)).await.unwrap().unwrap();
    assert_eq!(&reply, b"reply");
    actor.abort();
    timeout(Duration::from_secs(3), actor.wait_closed()).await.unwrap().unwrap();
}

#[tokio::test]
async fn unauthorized_source_is_closed_and_never_delivered() {
    let listener = NativeTcpListener::start(TcpListenerConfig {
        allowed_hosts: vec![Ipv4Addr::new(127, 0, 0, 2)],
        ..TcpListenerConfig::default()
    }).unwrap();
    let mut peer = connect(ready(&listener).await).await;
    wait_status(listener.subscribe(), |s| s.refused_acl == 1).await;
    assert_eq!(listener.status().pending, 0);
    let mut byte = [0; 1];
    let outcome = timeout(Duration::from_secs(3), peer.read(&mut byte)).await.unwrap();
    assert!(matches!(outcome, Ok(0) | Err(_)));
    listener.abort();
    timeout(Duration::from_secs(3), listener.wait_closed()).await.unwrap().unwrap();
}

#[tokio::test]
async fn full_pending_queue_refuses_later_socket_and_abort_drops_queued_one() {
    let listener = NativeTcpListener::start(TcpListenerConfig { max_pending: 1, ..TcpListenerConfig::default() }).unwrap();
    let addr = ready(&listener).await;
    let mut first = connect(addr).await;
    wait_status(listener.subscribe(), |s| s.pending == 1).await;
    let mut second = connect(addr).await;
    wait_status(listener.subscribe(), |s| s.refused_full == 1).await;
    assert_eq!(listener.status().pending, 1);
    listener.abort();
    timeout(Duration::from_secs(3), listener.wait_closed()).await.unwrap().unwrap();
    assert_eq!(listener.status().pending, 0);
    for peer in [&mut first, &mut second] {
        let mut byte = [0; 1];
        let outcome = timeout(Duration::from_secs(3), peer.read(&mut byte)).await.unwrap();
        assert!(matches!(outcome, Ok(0) | Err(_)));
    }
    assert!(listener.accept().await.is_err());
}

#[tokio::test]
async fn closed_reports_physical_retirement_and_port_can_be_rebound() {
    let listener = NativeTcpListener::start(TcpListenerConfig::default()).unwrap();
    let addr = ready(&listener).await;
    listener.abort();
    timeout(Duration::from_secs(3), listener.wait_closed()).await.unwrap().unwrap();
    assert!(listener.status().closed);
    let replacement = timeout(Duration::from_secs(3), TcpListener::bind(SocketAddr::V4(addr))).await.unwrap().unwrap();
    drop(replacement);
}

#[tokio::test]
async fn abort_wakes_all_pending_accepts_and_retires_listener() {
    let listener = NativeTcpListener::start(TcpListenerConfig::default()).unwrap();
    let _addr = ready(&listener).await;
    let first = listener.clone();
    let second = listener.clone();
    let (a, b, ()) = timeout(Duration::from_secs(3), async {
        tokio::join!(first.accept(), second.accept(), async {
            tokio::task::yield_now().await;
            listener.abort();
        })
    }).await.unwrap();
    assert!(a.is_err());
    assert!(b.is_err());
    timeout(Duration::from_secs(3), listener.wait_closed()).await.unwrap().unwrap();
}

#[tokio::test]
async fn last_handle_drop_retires_listener_and_queued_streams() {
    let listener = NativeTcpListener::start(TcpListenerConfig::default()).unwrap();
    let addr = ready(&listener).await;
    let mut peer = connect(addr).await;
    wait_status(listener.subscribe(), |s| s.pending == 1).await;
    let mut status = listener.subscribe();
    let clone = listener.clone();
    drop(listener);
    assert!(!status.borrow().closed);
    drop(clone);
    timeout(Duration::from_secs(3), async {
        loop {
            if status.borrow_and_update().closed { break; }
            status.changed().await.unwrap();
        }
    }).await.unwrap();
    let mut byte = [0; 1];
    let outcome = timeout(Duration::from_secs(3), peer.read(&mut byte)).await.unwrap();
    assert!(matches!(outcome, Ok(0) | Err(_)));
    let replacement = timeout(Duration::from_secs(3), TcpListener::bind(SocketAddr::V4(addr))).await.unwrap().unwrap();
    drop(replacement);
}

#[tokio::test]
async fn cancelled_start_and_bind_conflict_retire_with_terminal_status() {
    let cancelled = NativeTcpListener::start(TcpListenerConfig::default()).unwrap();
    cancelled.abort();
    assert!(timeout(Duration::from_secs(3), cancelled.when_ready()).await.unwrap().is_err());
    timeout(Duration::from_secs(3), cancelled.wait_closed()).await.unwrap().unwrap();
    assert!(cancelled.status().closed);

    let held = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bind = match held.local_addr().unwrap() {
        SocketAddr::V4(value) => value,
        _ => panic!("loopback bind is not IPv4"),
    };
    let conflict = NativeTcpListener::start(TcpListenerConfig { bind, ..TcpListenerConfig::default() }).unwrap();
    let error = match timeout(Duration::from_secs(3), conflict.when_ready()).await.unwrap() {
        Err(error) => error,
        Ok(_) => panic!("conflicting bind unexpectedly succeeded"),
    };
    assert_eq!(error.code, 10048);
    assert!(timeout(Duration::from_secs(3), conflict.wait_closed()).await.unwrap().is_err());
    assert!(conflict.status().closed);
}
