use bottleship_lan_core::{
    GatewayInput,
    config::*,
    gateway::{BindingToken, DestinationPolicy},
    routes::{NativeAddress, Target},
    wire::Datagram,
};
use bottleship_lan_gateway::*;
use bytes::Bytes;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{net::UdpSocket, time::timeout};
static NEXT: AtomicU64 = AtomicU64::new(0);
async fn cancelled_startup(proto: u8) {
    let fixture = PathBuf::from(std::env::var_os("BOTTLESHIP_RUST_STARTUP_FIXTURE").expect(
        "Build gateway example startup_stall, then set BOTTLESHIP_RUST_STARTUP_FIXTURE explicitly",
    ));
    assert!(fixture.exists());
    let observer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let dir = std::env::temp_dir().join(format!(
        "bottleship-gateway-startup-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join(format!(
        "startup-{}{}",
        observer.local_addr().unwrap().port(),
        std::env::consts::EXE_SUFFIX
    ));
    std::fs::copy(&fixture, &path).unwrap();
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let mut cfg = GatewayConfig {
        connect_timeout_ms: 120000,
        ..Default::default()
    };
    if proto == 1 {
        cfg.native_udp_helper_path = Some(path.to_string_lossy().into_owned())
    } else {
        cfg.native_helper_path = Some(path.to_string_lossy().into_owned())
    }
    let (handle, _events) = Gateway::spawn_with_node(
        7,
        [2, 0, 0, 0, 0, 7],
        cfg,
        policy.clone(),
        GatewayOptions::default(),
    )
    .unwrap();
    let local = if proto == 1 { 2000 } else { 18 };
    let packet = if proto == 1 {
        Bytes::from_static(b"pending")
    } else {
        Bytes::from_static(&[17, 0, 0x12, 0x34, 0x56, 0x78, 0, 8, 0, 0])
    };
    handle
        .try_submit(GatewayInput::Frame {
            binding: BindingToken {
                proto,
                local_port: local,
                generation: Some(1),
            },
            datagram: Datagram {
                proto,
                node: [2, 1, 127, 0, 0, 1],
                src_port: local,
                dst_port: if proto == 1 { 9000 } else { 18 },
                payload: packet,
            },
            target: Target {
                route_id: 0,
                address: NativeAddress::parse("127.0.0.1").unwrap(),
                port: if proto == 1 { 9000 } else { 18 },
                canonical_policy_key: "127.0.0.1".into(),
                raw_mode: None,
            },
        })
        .unwrap();
    let outcome = async {
        let mut pid = [0; 4];
        let (n, native) = timeout(Duration::from_secs(4), observer.recv_from(&mut pid))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(n, 4);
        assert_ne!(u32::from_le_bytes(pid), 0);
        assert!(
            UdpSocket::bind(native).await.is_err(),
            "fixture must genuinely own its native port before abort"
        );
        assert_eq!(policy.lock().unwrap().active_leases(), 1);
        handle.abort();
        timeout(Duration::from_secs(2), handle.wait_closed())
            .await
            .expect("abort must not wait for the configured 120s startup deadline")
            .unwrap();
        let rebound = UdpSocket::bind(native)
            .await
            .expect("closed status must follow actual native port retirement");
        drop(rebound);
        assert_eq!(policy.lock().unwrap().active_leases(), 0);
    };
    // Test failures still abort; the fixture watchdog is an independent final bound.
    // The drop guard owns abort during assertion unwinding.
    struct Abort(GatewayHandle);
    impl Drop for Abort {
        fn drop(&mut self) {
            self.0.abort()
        }
    }
    let cleanup = Abort(handle.clone());
    outcome.await;
    drop(cleanup);
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_dir(&dir).unwrap();
}
#[tokio::test]
async fn raw_startup_abort_reclaims_actual_port_before_long_deadline() {
    cancelled_startup(6).await
}
#[tokio::test]
async fn udp_startup_abort_reclaims_actual_port_before_long_deadline() {
    cancelled_startup(1).await
}
