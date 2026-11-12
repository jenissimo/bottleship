use base64::{Engine, engine::general_purpose::STANDARD};
use bottleship_lan_core::{access::*, config::*, routes::Routes, wire::*, *};
use serde_json::{Value, json};

fn vector() -> Value {
    serde_json::from_str(include_str!("../../../lan/test/invite-vector.json")).unwrap()
}
fn policy() -> AccessPolicy {
    let v = vector();
    AccessPolicy::new(
        serde_json::from_value(json!({"rooms":{"lobby":{"visibility":"public"}}})).unwrap(),
        Some(STANDARD.decode(v["keyBase64"].as_str().unwrap()).unwrap()),
    )
    .unwrap()
}
fn auth(room: &str, node: u8, invite: Option<&str>) -> Value {
    let mut v = json!({"version":1,"room":room,"clientId":format!("participant-{node:08}"),"node":[2,0,0,0,0,node]});
    if let Some(token) = invite {
        v["invite"] = json!(token);
    }
    v
}
fn configured() -> Core {
    let gateway:GatewayConfig=serde_json::from_value(json!({
        "routes":[{"id":"quake","host":"127.0.0.1","address":"203.0.113.10","names":["game.test"],"ports":[9000],"protocols":["udp","tcp"]}],
        "udpListeners":[{"id":"host","bindHost":"127.0.0.1","advertisedHost":"127.0.0.1","port":0,"allowedHosts":["127.0.0.1"]}],
        "tcpListeners":[{"id":"tcp-host","bindHost":"127.0.0.1","advertisedHost":"127.0.0.1","port":0,"allowedHosts":["127.0.0.1"]}]
    })).unwrap();
    Core::new(
        Limits::default(),
        Routes::new(gateway).unwrap(),
        policy(),
        1000000,
    )
    .unwrap()
}
fn native(e: &[Effect]) -> bool {
    e.iter()
        .any(|e| matches!(e, Effect::NativeOperation { .. }))
}
#[test]
fn sr01_private_default_and_public_override_are_explicit() {
    assert!(AccessPolicy::new(RoomAccessConfig::default(), None).is_err());
    let mut c = configured();
    assert!(c.join(1, &auth("locked", 1, None), 0).is_err());
    assert!(c.join(2, &auth("lobby", 2, None), 0).is_ok());
    let v = vector();
    assert!(
        c.join(3, &auth("locked", 3, v["token"].as_str()), 0)
            .is_ok()
    );
    assert!(
        c.join(4, &auth("other", 4, v["token"].as_str()), 0)
            .is_err()
    );
}
#[test]
fn shared_golden_vector_rejects_forgery_wrong_audience_room_and_expiry() {
    let v = vector();
    let token = v["token"].as_str().unwrap();
    let gateway: GatewayPermissions =
        serde_json::from_value(v["claims"]["gateway"].clone()).unwrap();
    assert_eq!(
        policy()
            .sign("locked", 1060, gateway.clone(), 1000)
            .unwrap(),
        token
    );
    assert_eq!(
        policy()
            .authorize("locked", Some(&json!(token)), 1000)
            .unwrap()
            .gateway,
        gateway
    );
    assert!(
        policy()
            .authorize("other", Some(&json!(token)), 1000)
            .is_err()
    );
    assert!(
        policy()
            .authorize("locked", Some(&json!(token)), 1060)
            .is_err()
    );
    assert!(
        policy()
            .authorize("locked", Some(&json!(format!("{token}="))), 1000)
            .is_err()
    );
    let other = AccessPolicy::new(
        RoomAccessConfig {
            audience: "other-server".into(),
            ..Default::default()
        },
        Some(STANDARD.decode(v["keyBase64"].as_str().unwrap()).unwrap()),
    )
    .unwrap();
    assert!(
        other
            .authorize("locked", Some(&json!(token)), 1000)
            .is_err()
    );
    let mut changed = token.as_bytes().to_vec();
    changed[8] = if changed[8] == b'a' { b'b' } else { b'a' };
    assert!(
        policy()
            .authorize(
                "locked",
                Some(&json!(String::from_utf8(changed).unwrap())),
                1000
            )
            .is_err()
    );
}
#[test]
fn sr02_public_attacker_cannot_discover_or_use_routes_dns_or_native_listeners() {
    let mut c = configured();
    let effects = c.join(1, &auth("lobby", 1, None), 0).unwrap();
    let ready = effects
        .iter()
        .find_map(|e| {
            if let Effect::Emit {
                event:
                    ServerEvent::Json {
                        name: "ready",
                        args,
                    },
                ..
            } = e
            {
                Some(&args[0])
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(ready["gatewayIpv4"], json!([]));
    assert_eq!(ready["gatewayIpv6"], json!([]));
    assert!(ready.get("udpHostListenV1").is_none());
    assert!(ready.get("tcpHostListenV1").is_none());
    let frame = Datagram {
        proto: 1,
        node: [2, 1, 203, 0, 113, 10],
        src_port: 25000,
        dst_port: 9000,
        payload: bytes::Bytes::from_static(b"attack"),
    };
    let effects = c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::Frame {
            datagram: frame,
            generation: Some(1),
        },
        now_ms: 0,
    });
    assert!(!native(&effects));
    let effects = c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::Resolve {
            id: 1,
            request: ResolveRequest {
                host: "game.test".into(),
                family: 4,
                reverse: None,
            },
        },
        now_ms: 0,
    });
    assert!(
        !effects
            .iter()
            .any(|e| matches!(e, Effect::ResolveRoutes { .. }))
    );
    let effects = c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::OpenUdpHost {
            id: 1,
            request: UdpHostRequest {
                proto: 1,
                local_port: 25001,
                binding_generation: 1,
                listener_id: "host".into(),
            },
        },
        now_ms: 0,
    });
    assert!(!native(&effects));
    let effects = c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::OpenTcpHost {
            id: 1,
            request: TcpHostRequest {
                proto: 2,
                local_port: 25002,
                binding_generation: 1,
                listener_id: "tcp-host".into(),
            },
        },
        now_ms: 0,
    });
    assert!(!native(&effects));
}
#[test]
fn invitation_scopes_authorize_only_listed_operations_and_expire_live_connection() {
    let mut c = configured();
    let v = vector();
    c.join(1, &auth("locked", 1, v["token"].as_str()), 0)
        .unwrap();
    let frame = Datagram {
        proto: 1,
        node: [2, 1, 203, 0, 113, 10],
        src_port: 25000,
        dst_port: 9000,
        payload: bytes::Bytes::from_static(b"allowed"),
    };
    assert!(native(&c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::Frame {
            datagram: frame.clone(),
            generation: Some(1)
        },
        now_ms: 0
    })));
    assert!(native(&c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::OpenUdpHost {
            id: 1,
            request: UdpHostRequest {
                proto: 1,
                local_port: 25001,
                binding_generation: 1,
                listener_id: "host".into()
            }
        },
        now_ms: 0
    })));
    assert!(!native(&c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::OpenTcpHost {
            id: 1,
            request: TcpHostRequest {
                proto: 2,
                local_port: 25002,
                binding_generation: 1,
                listener_id: "tcp-host".into()
            }
        },
        now_ms: 0
    })));
    let expired = c.apply(Command::Input {
        connection: 1,
        event: InboundEvent::Frame {
            datagram: frame,
            generation: Some(1),
        },
        now_ms: 60000,
    });
    assert!(
        expired
            .iter()
            .any(|e| matches!(e, Effect::Disconnect { connection: 1, .. }))
    );
    assert!(!expired.iter().any(|e| matches!(
        e,
        Effect::NativeOperation {
            input: GatewayInput::Frame { .. },
            ..
        }
    )));
    assert_eq!(c.connection_node(1), None);
}
