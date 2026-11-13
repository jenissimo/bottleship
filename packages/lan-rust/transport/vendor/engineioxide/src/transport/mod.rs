//! All transports modules available in engineioxide

use engineioxide_core::{OpenPacket, Packet, PacketParseError, ProtocolVersion, Sid, Str, TransportType};

use crate::config::EngineIoConfig;

pub mod polling;
pub mod ws;

/// engineioxide-core 0.2.2 `Packet::parse` evaluates `&value[1..6]` for every six-byte
/// packet before it checks the packet type, which panics when the first character is
/// multi-byte (for example `"\u{e9}abcd"`). Engine.IO packet types are ASCII, so anything
/// else is rejected before the upstream parser sees it.
pub(crate) fn parse_packet(protocol: ProtocolVersion, value: Str) -> Result<Packet, PacketParseError> {
    match value.as_bytes().first() {
        Some(kind) if kind.is_ascii() => Packet::parse(protocol, value),
        kind => Err(PacketParseError::InvalidPacketType(kind.map(|b| char::from(*b)))),
    }
}

/// The polling payload decoder calls `Packet::parse` internally; reject a body whose
/// packet (record-separated by 0x1e) starts with a non-ASCII byte before decoding it.
pub(crate) fn payload_packet_types_are_ascii(body: &[u8]) -> bool {
    body.split(|b| *b == 0x1e).all(|packet| packet.first().is_none_or(u8::is_ascii))
}

// Regression: transport/tests/transport.rs
// sr07_multibyte_engine_packet_type_is_rejected_without_panic_on_both_transports.

fn make_open_packet(transport: TransportType, id: Sid, config: &EngineIoConfig) -> OpenPacket {
    let upgrades = if transport == TransportType::Polling && config.allowed_transport(TransportType::Websocket) {
        smallvec::smallvec![TransportType::Websocket]
    } else {
        smallvec::smallvec![]
    };
    OpenPacket {
        sid: id,
        upgrades,
        ping_timeout: config.ping_timeout,
        ping_interval: config.ping_interval,
        max_payload: config.max_payload,
    }
}
