use bottleship_lan_core::wire::*;
use bytes::Bytes;
use serde_json::{Value, json};
#[test]
fn ts_reference_generated_frame_vectors() {
    let fixtures: Value = serde_json::from_str(include_str!("wire-vectors.json")).unwrap();
    for v in fixtures["frames"].as_array().unwrap() {
        let len = v["length"].as_u64().unwrap() as usize;
        let mut b = vec![v["fill"].as_u64().unwrap() as u8; len];
        for (i, byte) in v["prefix"].as_array().unwrap().iter().take(len).enumerate() {
            b[i] = byte.as_u64().unwrap() as u8;
        }
        let decoded = Datagram::decode(Bytes::from(b));
        let actual = match decoded {
            Err(_) => Value::Null,
            Ok(d) => {
                json!({"proto":d.proto,"node":d.node,"dstPort":d.dst_port,"srcPort":d.src_port,"payloadLength":d.payload.len()})
            }
        };
        assert_eq!(actual, v["expected"], "{}", v["name"]);
    }
}
#[test]
fn generation_absence_is_not_explicit_null() {
    let fixtures: Value = serde_json::from_str(include_str!("wire-vectors.json")).unwrap();
    let d = Datagram {
        proto: 1,
        node: [2, 0, 0, 0, 0, 1],
        src_port: 1,
        dst_port: 2,
        payload: Bytes::new(),
    }
    .encode()
    .unwrap();
    assert!(matches!(
        decode_event("frame", &[Arg::Binary(d.clone())]),
        Ok(InboundEvent::Frame {
            generation: None,
            ..
        })
    ));
    for v in fixtures["generations"].as_array().unwrap() {
        let actual = decode_event(
            "frame",
            &[Arg::Binary(d.clone()), Arg::Json(v["value"].clone())],
        )
        .is_ok();
        assert_eq!(actual, v["valid"].as_bool().unwrap(), "{v}");
    }
}
