use bottleship_lan_core::{config::*, routes::*, wire::*, *};
use bytes::Bytes;
use serde_json::{Value, json};
const G: [u8; 4] = [239, 255, 42, 17];
const H: [u8; 4] = [239, 255, 42, 18];
fn auth(id: u8, room: &str) -> Value {
    json!({"version":1,"room":room,"clientId":format!("multicast-participant-{id:08}"),"node":[2,0,0,1,0,id]})
}
fn core() -> Core {
    Core::new(
        Limits::default(),
        Routes::new(GatewayConfig::default()).unwrap(),
    )
    .unwrap()
}
/** The expected wire is constructed independently of the production encoder. */
fn raw(group: [u8; 4], interface: u8, ttl: u8, payload: &[u8]) -> Bytes {
    let mut bytes = vec![3, 1, 2, 3];
    bytes.extend(group);
    bytes.extend_from_slice(&4000u16.to_be_bytes());
    bytes.extend_from_slice(&5000u16.to_be_bytes());
    bytes.extend(group);
    bytes.extend([interface, ttl, 0, 0]);
    bytes.extend(payload);
    Bytes::from(bytes)
}
fn input(c: &mut Core, connection: u64, bytes: Bytes, generation: Option<u32>) -> Vec<Effect> {
    let mut args = vec![Arg::Binary(bytes)];
    if let Some(generation) = generation {
        args.push(Arg::Json(json!(generation)));
    }
    c.apply(Command::Wire {
        connection,
        name: "frame".into(),
        args,
        now_ms: 0,
    })
}
fn frames(effects: &[Effect]) -> Vec<(u64, Multicast4Datagram, Option<u32>)> {
    effects
        .iter()
        .filter_map(|effect| {
            if let Effect::Emit {
                to,
                event: ServerEvent::Frame { bytes, generation },
                ..
            } = effect
            {
                Some((
                    *to,
                    Multicast4Datagram::decode(bytes.clone()).unwrap(),
                    *generation,
                ))
            } else {
                None
            }
        })
        .collect()
}
fn release(c: &mut Core, generation: u32) {
    c.apply(Command::Input {
        connection: 1,
        now_ms: 0,
        event: InboundEvent::ReleasePort {
            proto: 1,
            port: 5000,
            generation,
        },
    });
}
#[test]
fn independent_wire_empty_and_maximum_roundtrip_without_changing_type2() {
    for length in [0, 1, 65507] {
        let payload = vec![0x57; length];
        let bytes = raw(G, 2, 255, &payload);
        let packet = Multicast4Datagram::decode(bytes.clone()).unwrap();
        assert_eq!(packet.datagram.payload.as_ref(), payload);
        assert_eq!(packet.multicast4.group, G);
        assert!(packet.is_outbound());
        assert_eq!(packet.encode().unwrap(), bytes);
        assert!(matches!(
            decode_event("frame", &[Arg::Binary(bytes)]),
            Ok(InboundEvent::Multicast4 {
                generation: None,
                ..
            })
        ));
    }
    let mut ordinary = vec![2, 1, 2, 3];
    ordinary.extend(G);
    ordinary.extend_from_slice(&4000u16.to_be_bytes());
    ordinary.extend_from_slice(&5000u16.to_be_bytes());
    assert!(Datagram::decode(Bytes::from(ordinary)).is_err());
    let ordinary = Datagram {
        proto: 1,
        node: [2, 0, 0, 1, 0, 2],
        dst_port: 4000,
        src_port: 5000,
        payload: Bytes::from_static(b"plain"),
    };
    assert_eq!(ordinary.encode().unwrap()[0], 2);
    assert_eq!(
        Datagram::decode(ordinary.encode().unwrap()).unwrap(),
        ordinary
    );
}
#[test]
fn malformed_headers_group_and_direction_namespaces_are_not_accepted() {
    for (index, value) in [
        (0, 4),
        (1, 4),
        (3, 1),
        (7, 99),
        (12, 127),
        (16, 0),
        (16, 3),
        (18, 1),
        (19, 1),
    ] {
        let mut bytes = raw(G, 2, 1, b"x").to_vec();
        bytes[index] = value;
        assert!(
            Multicast4Datagram::decode(Bytes::from(bytes)).is_err(),
            "offset {index}"
        );
    }
    for source in [[255; 6], [2, 1, 127, 0, 0, 1], [2, 2, 0, 0, 0, 1], [0; 6]] {
        let mut bytes = raw(G, 2, 1, b"x").to_vec();
        bytes[2..8].copy_from_slice(&source);
        assert!(Multicast4Datagram::decode(Bytes::from(bytes)).is_err());
    }
    assert!(Multicast4Datagram::decode(raw(G, 2, 1, b"x").slice(..19)).is_err());
    assert!(Multicast4Datagram::decode(raw(G, 2, 1, &vec![0; 65508])).is_err());
    let mut c = core();
    c.join(1, &auth(1, "room"), 0).unwrap();
    let mut bytes = raw(G, 2, 1, b"x").to_vec();
    bytes[2..8].copy_from_slice(&[2, 0, 0, 1, 0, 9]);
    assert!(Multicast4Datagram::decode(Bytes::from(bytes.clone())).is_ok()); // Valid server-to-client form.
    let effects = input(&mut c, 1, Bytes::from(bytes), Some(1));
    assert!(
        effects
            .iter()
            .any(|effect| matches!(effect, Effect::Disconnect { connection: 1, .. }))
    );
}
#[test]
fn room_fanout_preserves_exact_group_and_rewrites_authenticated_source_only() {
    let mut c = core();
    for (id, room) in [(1, "a"), (2, "a"), (3, "a"), (4, "b")] {
        let effects = c.join(id, &auth(id as u8, room), 0).unwrap();
        assert!(effects.iter().any(|effect| matches!(effect, Effect::Emit {event: ServerEvent::Json {name:"ready",args},..} if args[0]["udpMulticast4V1"]==true)));
    }
    c.apply(Command::Closed {
        connection: 3,
        now_ms: 0,
    });
    for group in [G, H] {
        let effects = input(&mut c, 1, raw(group, 2, 17, b"payload"), Some(99));
        let delivered = frames(&effects);
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].0, 2);
        assert_eq!(delivered[0].1.datagram.node, [2, 0, 0, 1, 0, 1]);
        assert_eq!(
            delivered[0].1.multicast4,
            Multicast4Header {
                group,
                interface_index: 2,
                ttl: 17
            }
        );
        assert_eq!(delivered[0].1.datagram.payload.as_ref(), b"payload");
        assert_eq!(delivered[0].2, None);
        assert!(matches!(
            effects.as_slice(),
            [Effect::Emit {
                reliable: false,
                source: Some(1),
                retained_bytes: 27,
                ..
            }]
        ));
    }
}
#[test]
fn loopback_and_zero_ttl_do_not_create_remote_or_native_effects() {
    let mut c = core();
    c.join(1, &auth(1, "a"), 0).unwrap();
    c.join(2, &auth(2, "a"), 0).unwrap();
    for (interface, ttl) in [(1, 1), (1, 255), (2, 0)] {
        assert!(input(&mut c, 1, raw(G, interface, ttl, b"local"), Some(1)).is_empty());
    }
    assert_eq!(c.participant_count(), 2);
}
#[test]
fn generation_tombstones_rebind_and_replaced_connections_fence_late_packets() {
    let mut c = core();
    c.join(1, &auth(1, "a"), 0).unwrap();
    c.join(2, &auth(2, "a"), 0).unwrap();
    assert_eq!(
        frames(&input(&mut c, 1, raw(G, 2, 1, b"one"), Some(1))).len(),
        1
    );
    release(&mut c, 1);
    assert!(input(&mut c, 1, raw(G, 2, 1, b"late"), Some(1)).is_empty());
    assert!(input(&mut c, 1, raw(G, 2, 1, b"untracked"), None).is_empty());
    assert_eq!(
        frames(&input(&mut c, 1, raw(G, 2, 1, b"two"), Some(2))).len(),
        1
    );
    release(&mut c, 1);
    assert_eq!(
        frames(&input(&mut c, 1, raw(G, 2, 1, b"alive"), Some(2))).len(),
        1
    );
    // Ordinary UDP cannot regress the epoch seen by subsequent multicast.
    let plain = Datagram {
        proto: 1,
        node: [2, 0, 0, 1, 0, 2],
        dst_port: 4000,
        src_port: 5000,
        payload: Bytes::new(),
    };
    input(&mut c, 1, plain.encode().unwrap(), Some(3));
    assert!(input(&mut c, 1, raw(G, 2, 1, b"stale-two"), Some(2)).is_empty());
    c.join(3, &auth(1, "a"), 1).unwrap();
    assert!(input(&mut c, 1, raw(G, 2, 1, b"old-connection"), Some(4)).is_empty());
    assert_eq!(
        frames(&input(&mut c, 3, raw(G, 2, 1, b"new-connection"), Some(1))).len(),
        1
    );
}
#[test]
fn optional_generation_arity_stays_strict_and_udp_rejection_is_nonfatal() {
    let bytes = raw(G, 2, 1, b"x");
    assert!(decode_event("frame", &[Arg::Binary(bytes.clone())]).is_ok());
    for value in [
        Value::Null,
        json!(0),
        json!(-1),
        json!(1.25),
        json!(4294967296u64),
    ] {
        assert!(decode_event("frame", &[Arg::Binary(bytes.clone()), Arg::Json(value)]).is_err());
    }
    assert!(
        decode_event(
            "frame",
            &[
                Arg::Binary(bytes),
                Arg::Json(json!(1)),
                Arg::Json(json!({}))
            ]
        )
        .is_err()
    );
    let mut c = core();
    c.join(1, &auth(1, "a"), 0).unwrap();
    c.join(2, &auth(2, "a"), 0).unwrap();
    assert!(
        c.apply(Command::DeliveryRejected {
            to: 2,
            source: Some(1),
            reliable: false,
            now_ms: 0
        })
        .is_empty()
    );
    assert_eq!(c.participant_count(), 2);
}
#[test]
fn multicast_does_not_claim_native_legacy_bindings_but_observes_peer_rebind() {
    let config: GatewayConfig = serde_json::from_value(
        json!({"routes":[{"host":"127.0.0.1","ports":[9000],"protocols":["udp"]}]}),
    )
    .unwrap();
    let mut c = Core::new(Limits::default(), Routes::new(config).unwrap()).unwrap();
    c.join(1, &auth(1, "a"), 0).unwrap();
    c.join(2, &auth(2, "a"), 0).unwrap();
    assert_eq!(
        frames(&input(&mut c, 1, raw(G, 2, 1, b"multicast"), Some(5))).len(),
        1
    );
    let native = Datagram {
        proto: 1,
        node: [2, 1, 127, 0, 0, 1],
        dst_port: 9000,
        src_port: 5000,
        payload: Bytes::from_static(b"native"),
    };
    let effects = input(&mut c, 1, native.encode().unwrap(), None);
    assert!(matches!(
        effects.as_slice(),
        [Effect::NativeOperation {
            input: GatewayInput::Frame { .. },
            ..
        }]
    ));
    c.apply(Command::Input {
        connection: 1,
        now_ms: 0,
        event: InboundEvent::LeaseUdpPeer {
            id: 1,
            request: UdpLeaseRequest {
                proto: 1,
                local_port: 5000,
                binding_generation: 6,
                node: [2, 1, 127, 0, 0, 1],
                remote_port: 9000,
            },
        },
    });
    assert!(input(&mut c, 1, raw(G, 2, 1, b"old-binding"), Some(5)).is_empty());
}
#[test]
fn rate_budget_counts_the_full_twenty_byte_envelope() {
    let mut c = core();
    c.limits.max_bytes_per_second = 27;
    c.join(1, &auth(1, "a"), 0).unwrap();
    c.join(2, &auth(2, "a"), 0).unwrap();
    assert_eq!(
        frames(&input(&mut c, 1, raw(G, 2, 1, b"1234567"), Some(1))).len(),
        1
    );
    let effects = input(&mut c, 1, raw(G, 2, 1, b""), Some(1));
    assert!(
        effects
            .iter()
            .any(|effect| matches!(effect, Effect::Disconnect { connection: 1, .. }))
    );
}
