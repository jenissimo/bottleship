//! Packet helpers ported from the Apache-2.0 TS reference (icmp-nat/raw-udp).
use bottleship_lan_native::NativeError;
pub(crate) const LAN_PREFIX: [u8; 10] = [0xfd, 0x42, 0x62, 0x73, 0x6c, 0x61, 0x6e, 0, 0, 0];
pub(crate) fn checksum(bytes: &[u8]) -> u16 {
    let mut sum = 0u32;
    for p in bytes.chunks(2) {
        sum += ((p[0] as u32) << 8) | u32::from(*p.get(1).unwrap_or(&0));
    }
    while sum >> 16 != 0 {
        sum = (sum & 65535) + (sum >> 16);
    }
    !(sum as u16)
}
pub(crate) fn icmp_offset(packet: &[u8], family: u8, included: bool) -> Option<usize> {
    if !included {
        return (packet.len() >= 8).then_some(0);
    }
    if family == 4 {
        let header = usize::from(*packet.first()? & 15) * 4;
        (packet[0] >> 4 == 4 && header >= 20 && packet.len() >= header + 8 && packet[9] == 1)
            .then_some(header)
    } else {
        (packet.len() >= 48 && packet[0] >> 4 == 6 && packet[6] == 58).then_some(40)
    }
}
pub(crate) fn echo_id(packet: &[u8], family: u8, included: bool, reply: bool) -> Option<u16> {
    let o = icmp_offset(packet, family, included)?;
    let kind = match (family, reply) {
        (4, false) => 8,
        (4, true) => 0,
        (_, false) => 128,
        (_, true) => 129,
    };
    (packet[o] == kind && packet[o + 1] == 0)
        .then(|| u16::from_be_bytes([packet[o + 4], packet[o + 5]]))
}
pub(crate) fn translate_echo(
    packet: &[u8],
    family: u8,
    included: bool,
    id: u16,
) -> Option<Vec<u8>> {
    let o = icmp_offset(packet, family, included)?;
    let mut out = packet.to_vec();
    out[o + 4..o + 6].copy_from_slice(&id.to_be_bytes());
    if family == 4 {
        out[o + 2..o + 4].fill(0);
        let c = checksum(&out[o..]);
        out[o + 2..o + 4].copy_from_slice(&c.to_be_bytes());
    }
    Some(out)
}
pub(crate) fn rewrite_ipv4(packet: &mut [u8], source: &[u8], destination: &[u8]) -> bool {
    if packet.len() < 20 || packet[0] >> 4 != 4 || source.len() != 4 || destination.len() != 4 {
        return false;
    }
    let h = usize::from(packet[0] & 15) * 4;
    if h < 20 || h > packet.len() {
        return false;
    }
    packet[12..16].copy_from_slice(source);
    packet[16..20].copy_from_slice(destination);
    packet[10..12].fill(0);
    let c = checksum(&packet[..h]);
    packet[10..12].copy_from_slice(&c.to_be_bytes());
    true
}
pub(crate) fn checksum_v6(packet: &mut [u8], source: &[u8], destination: &[u8]) -> bool {
    if packet.len() < 8 || source.len() != 16 || destination.len() != 16 {
        return false;
    }
    packet[2..4].fill(0);
    let mut pseudo = Vec::with_capacity(40 + packet.len());
    pseudo.extend_from_slice(source);
    pseudo.extend_from_slice(destination);
    pseudo.extend_from_slice(&(packet.len() as u32).to_be_bytes());
    pseudo.extend_from_slice(&[0, 0, 0, 58]);
    pseudo.extend_from_slice(packet);
    let c = checksum(&pseudo);
    packet[2..4].copy_from_slice(&c.to_be_bytes());
    true
}
pub(crate) fn udp_ports(
    packet: &[u8],
    family: u8,
    included: bool,
) -> Result<(u16, u16), NativeError> {
    let mut offset = 0;
    let invalid = || NativeError::new(10022, "invalid raw UDP packet");
    if included {
        if family == 4 {
            if packet.len() < 20 || packet[0] >> 4 != 4 {
                return Err(invalid());
            }
            offset = usize::from(packet[0] & 15) * 4;
            if offset < 20 || offset > packet.len() || packet[9] != 17 {
                return Err(invalid());
            }
            if u16::from_be_bytes([packet[6], packet[7]]) & 0x3fff != 0 {
                return Err(NativeError::new(
                    10045,
                    "fragmented raw UDP cannot be translated",
                ));
            }
        } else {
            if packet.len() < 40 || packet[0] >> 4 != 6 {
                return Err(invalid());
            }
            if packet[6] != 17 {
                return Err(NativeError::new(
                    10045,
                    "raw UDP IPv6 extension chain is not classified",
                ));
            }
            offset = 40;
        }
    }
    if packet.len() - offset < 8 {
        return Err(invalid());
    }
    Ok((
        u16::from_be_bytes([packet[offset], packet[offset + 1]]),
        u16::from_be_bytes([packet[offset + 2], packet[offset + 3]]),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn echo_translation_preserves_payload_and_valid_checksum() {
        let packet = [8, 0, 0, 0, 0x12, 0x34, 0, 3, 1, 2, 3];
        let nat = translate_echo(&packet, 4, false, 0x4567).unwrap();
        assert_eq!(echo_id(&nat, 4, false, false), Some(0x4567));
        assert_eq!(checksum(&nat), 0);
        let restored = translate_echo(&nat, 4, false, 0x1234).unwrap();
        assert_eq!(&restored[4..], &packet[4..]);
        assert_eq!(checksum(&restored), 0);
    }
    #[test]
    fn raw_udp_rejects_fragments_and_unknown_extensions() {
        let mut v4 = vec![0; 28];
        v4[0] = 0x45;
        v4[9] = 17;
        v4[20..24].copy_from_slice(&[0x12, 0x34, 0x56, 0x78]);
        assert_eq!(udp_ports(&v4, 4, true).unwrap(), (0x1234, 0x5678));
        v4[6] = 0x20;
        assert_eq!(udp_ports(&v4, 4, true).unwrap_err().code, 10045);
        let mut v6 = vec![0; 48];
        v6[0] = 0x60;
        v6[6] = 0;
        assert_eq!(udp_ports(&v6, 6, true).unwrap_err().code, 10045);
        assert_eq!(udp_ports(&[], 4, false).unwrap_err().code, 10022);
    }
    #[test]
    fn ipv4_alias_rewrite_changes_only_addresses_and_header_checksum() {
        let mut p = vec![0; 28];
        p[0] = 0x45;
        p[2..4].copy_from_slice(&28u16.to_be_bytes());
        p[8] = 64;
        p[9] = 1;
        p[20..].copy_from_slice(&[0, 0, 0, 0, 1, 2, 3, 4]);
        assert!(rewrite_ipv4(&mut p, &[192, 0, 2, 1], &[10, 0, 0, 7]));
        assert_eq!(checksum(&p[..20]), 0);
        assert_eq!(&p[20..], &[0, 0, 0, 0, 1, 2, 3, 4]);
        assert_eq!(&p[16..20], &[10, 0, 0, 7]);
    }
}
