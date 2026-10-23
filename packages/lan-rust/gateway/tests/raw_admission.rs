//! Deterministic IPC admission pressure, not an assertion of native RAW packet delivery.
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
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::UdpSocket, time::timeout};
#[tokio::test]
async fn refused_65th_packet_keeps_64_admitted_writes_and_flow_alive() {
    let fixture = PathBuf::from(
        std::env::var_os("BOTTLESHIP_RUST_STARTUP_FIXTURE")
            .expect("Build startup_stall example and set its path explicitly"),
    );
    let observer = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let dir = std::env::temp_dir().join(format!("bottleship-raw-admission-{}", std::process::id()));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join(format!(
        "admission-{}{}",
        observer.local_addr().unwrap().port(),
        std::env::consts::EXE_SUFFIX
    ));
    std::fs::copy(fixture, &path).unwrap();
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let cfg = GatewayConfig {
        native_helper_path: Some(path.to_string_lossy().into_owned()),
        connect_timeout_ms: 120000,
        ..Default::default()
    };
    let (h, mut events) = Gateway::spawn_with_node(
        1,
        [2, 0, 0, 0, 0, 1],
        cfg,
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
    let guard = Abort(h.clone());
    let input = || GatewayInput::Frame {
        binding: BindingToken {
            proto: 6,
            local_port: 2,
            generation: Some(1),
        },
        datagram: Datagram {
            proto: 6,
            node: [2, 1, 127, 0, 0, 1],
            src_port: 2,
            dst_port: 2,
            payload: Bytes::from_static(&[1, 0, 8, 0, 0, 0, 0, 1, 0, 0]),
        },
        target: Target {
            route_id: 0,
            address: NativeAddress::parse("127.0.0.1").unwrap(),
            port: 2,
            canonical_policy_key: "127.0.0.1".into(),
            raw_mode: None,
        },
    };
    for _ in 0..65 {
        h.try_submit(input()).unwrap();
    }
    let mut pid = [0; 4];
    let (_, native) = timeout(Duration::from_secs(4), observer.recv_from(&mut pid))
        .await
        .unwrap()
        .unwrap();
    let output = timeout(Duration::from_secs(4), events.outputs.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        output.event,
        GatewayEvent::SocketError { code: 10055, .. }
    ));
    drop(output);
    // The rejected packet did not revoke earlier whole-call admissions.
    let mut status = events.status.clone();
    timeout(Duration::from_secs(1), async {
        loop {
            if status.borrow().raw_flows == 1 {
                break;
            }
            status.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(policy.lock().unwrap().active_leases(), 1);
    assert!(UdpSocket::bind(native).await.is_err());
    h.abort();
    timeout(Duration::from_secs(2), h.wait_closed())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(policy.lock().unwrap().active_leases(), 0);
    drop(UdpSocket::bind(native).await.unwrap());
    drop(guard);
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(dir).unwrap();
}
