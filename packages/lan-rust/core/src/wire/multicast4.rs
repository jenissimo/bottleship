//! Virtual IPv4 UDP multicast envelope. Ordinary type2 bytes stay unchanged.
use super::{Datagram, MAX_FRAME_SIZE, Node, WireError, lan_node};
use bytes::Bytes;
pub const WIRE_DGRAM_MULTICAST4: u8 = 3;
pub const MULTICAST4_DGRAM_HEADER: usize = 20;
pub fn ipv4_multicast(group: &[u8; 4]) -> bool {
    (224..=239).contains(&group[0])
}
pub fn multicast4_node(group: &[u8; 4]) -> Node {
    [2, 3, group[0], group[1], group[2], group[3]]
}
pub fn is_multicast4_node(node: &Node) -> bool {
    node[..2] == [2, 3] && (224..=239).contains(&node[2])
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Multicast4Header {
    pub group: [u8; 4],
    pub interface_index: u8,
    pub ttl: u8,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Multicast4Datagram {
    pub datagram: Datagram,
    pub multicast4: Multicast4Header,
}
impl Multicast4Datagram {
    pub fn decode(bytes: Bytes) -> Result<Self, WireError> {
        let invalid = || WireError("Invalid multicast4 datagram");
        if bytes.len() < MULTICAST4_DGRAM_HEADER
            || bytes.len() > MAX_FRAME_SIZE
            || bytes.len() - MULTICAST4_DGRAM_HEADER > 65507
            || bytes[0] != WIRE_DGRAM_MULTICAST4
            || bytes[1] != 1
            || bytes[18] != 0
            || bytes[19] != 0
            || !matches!(bytes[16], 1 | 2)
        {
            return Err(invalid());
        }
        let group = [bytes[12], bytes[13], bytes[14], bytes[15]];
        let mut node = [0; 6];
        node.copy_from_slice(&bytes[2..8]);
        if !ipv4_multicast(&group) || (!lan_node(&node) && node != multicast4_node(&group)) {
            return Err(invalid());
        }
        let dst_port = u16::from_be_bytes([bytes[8], bytes[9]]);
        let src_port = u16::from_be_bytes([bytes[10], bytes[11]]);
        if dst_port == 0 || src_port == 0 {
            return Err(invalid());
        }
        Ok(Self {
            datagram: Datagram {
                proto: 1,
                node,
                dst_port,
                src_port,
                payload: bytes.slice(MULTICAST4_DGRAM_HEADER..),
            },
            multicast4: Multicast4Header {
                group,
                interface_index: bytes[16],
                ttl: bytes[17],
            },
        })
    }
    pub fn is_outbound(&self) -> bool {
        self.datagram.node == multicast4_node(&self.multicast4.group)
    }
    pub fn encode(&self) -> Result<Bytes, WireError> {
        if self.datagram.proto != 1 || self.datagram.payload.len() > 65507 {
            return Err(WireError("Invalid multicast4 datagram"));
        }
        let mut bytes = Vec::with_capacity(MULTICAST4_DGRAM_HEADER + self.datagram.payload.len());
        bytes.extend_from_slice(&[WIRE_DGRAM_MULTICAST4, 1]);
        bytes.extend_from_slice(&self.datagram.node);
        bytes.extend_from_slice(&self.datagram.dst_port.to_be_bytes());
        bytes.extend_from_slice(&self.datagram.src_port.to_be_bytes());
        bytes.extend_from_slice(&self.multicast4.group);
        bytes.extend_from_slice(&[self.multicast4.interface_index, self.multicast4.ttl, 0, 0]);
        bytes.extend_from_slice(&self.datagram.payload);
        let bytes = Bytes::from(bytes);
        Self::decode(bytes.clone())?;
        Ok(bytes)
    }
}
