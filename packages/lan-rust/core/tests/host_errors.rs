use bottleship_lan_core::{config::*, gateway::*, routes::*, wire::*, *};
use serde_json::json;
fn setup() -> (Core, u64, BindingToken) {
    let cfg:GatewayConfig=serde_json::from_value(json!({"udpListeners":[{"id":"host","bindHost":"127.0.0.1","advertisedHost":"127.0.0.1","port":0,"allowedHosts":["127.0.0.1"]}]})).unwrap();
    let mut c = Core::new(Limits::default(), Routes::new(cfg).unwrap()).unwrap();
    c.join(
        1,
        &json!({"version":1,"room":"room","clientId":"error-participant-01","node":[2,0,0,0,0,1]}),
        0,
    )
    .unwrap();
    let e = c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::OpenUdpHost {
            id: 1,
            request: UdpHostRequest {
                proto: 1,
                local_port: 2000,
                binding_generation: 1,
                listener_id: "host".into(),
            },
        },
        now_ms: 0,
    });
    let (op, b) = e
        .into_iter()
        .find_map(|e| match e {
            Effect::NativeOperation {
                input:
                    GatewayInput::OpenUdpHost {
                        operation, binding, ..
                    },
                ..
            } => Some((operation, binding)),
            _ => None,
        })
        .unwrap();
    (c, op, b)
}
fn callback(c: &mut Core, event: GatewayEvent) -> Vec<Effect> {
    c.apply(Command::GatewayEvent {
        connection: 1,
        event,
    })
}
#[test]
fn old_host_send_error_cannot_cross_same_binding_reopen() {
    let (mut c, op, b) = setup();
    callback(
        &mut c,
        GatewayEvent::HostReady {
            operation: op,
            lease_id: 70,
            node: [2, 1, 127, 0, 0, 1],
            port: 40000,
        },
    );
    c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::ReleaseUdpHost { id: 1 },
        now_ms: 0,
    });
    let e = c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::OpenUdpHost {
            id: 2,
            request: UdpHostRequest {
                proto: 1,
                local_port: 2000,
                binding_generation: 1,
                listener_id: "host".into(),
            },
        },
        now_ms: 0,
    });
    let op = e
        .into_iter()
        .find_map(|e| match e {
            Effect::NativeOperation {
                input: GatewayInput::OpenUdpHost { operation, .. },
                ..
            } => Some(operation),
            _ => None,
        })
        .unwrap();
    callback(
        &mut c,
        GatewayEvent::HostReady {
            operation: op,
            lease_id: 71,
            node: [2, 1, 127, 0, 0, 1],
            port: 40001,
        },
    );
    let error = |lease_id| GatewayEvent::HostSocketError {
        lease_id,
        binding: b,
        node: [2, 1, 127, 0, 0, 1],
        remote_port: 6073,
        code: 10054,
    };
    assert!(callback(&mut c, error(70)).is_empty());
    assert!(callback(&mut c, error(71)).iter().any(|e| matches!(
        e,
        Effect::Emit {
            event: ServerEvent::Json {
                name: "socketError",
                ..
            },
            ..
        }
    )));
}
#[test]
fn queued_ordinary_udp_error_cannot_poison_pending_or_active_host() {
    let (mut c, op, b) = setup();
    let old = || GatewayEvent::SocketError {
        binding: b,
        node: [2, 1, 127, 0, 0, 1],
        remote_port: 6073,
        code: 10054,
        wire_id: None,
    };
    assert!(
        callback(&mut c, old()).is_empty(),
        "pending Host owns the native binding; ordinary flow has retired"
    );
    callback(
        &mut c,
        GatewayEvent::HostReady {
            operation: op,
            lease_id: 70,
            node: [2, 1, 127, 0, 0, 1],
            port: 40000,
        },
    );
    assert!(
        callback(&mut c, old()).is_empty(),
        "active Host cannot inherit an old ordinary flow error"
    );
}
