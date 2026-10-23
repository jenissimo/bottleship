use super::*;
use crate::wire::{MULTICAST4_DGRAM_HEADER, Multicast4Datagram};
impl Core {
    pub(super) fn multicast4_input(
        &mut self,
        connection: ConnId,
        mut packet: Multicast4Datagram,
        generation: Option<u32>,
        now_ms: u64,
        effects: &mut Vec<Effect>,
    ) {
        // Structural decode also accepts authenticated inbound LAN sources. The
        // client direction must use the exact, non-address group namespace.
        if !packet.is_outbound() {
            self.disconnect(connection, now_ms, "Invalid multicast direction", effects);
            return;
        }
        if !self.rate(
            connection,
            MULTICAST4_DGRAM_HEADER + packet.datagram.payload.len(),
            now_ms,
            effects,
        ) {
            return;
        }
        let binding = BindingToken {
            proto: 1,
            local_port: packet.datagram.src_port,
            generation,
        };
        let participant = self.participants.get_mut(&connection).unwrap();
        if !participant.multicast_bindings.admit(binding) {
            return;
        }
        // These profiles already delivered locally, and never open native flows.
        if packet.multicast4.interface_index == 1 || packet.multicast4.ttl == 0 {
            return;
        }
        let Some(room) = self.rooms.get(&participant.join.room) else {
            return;
        };
        packet.datagram.node = participant.join.node;
        packet.multicast4.interface_index = 2;
        let recipients: Vec<_> = room
            .values()
            .filter_map(|peer| peer.connection)
            .filter(|to| *to != connection)
            .collect();
        if let Ok(bytes) = packet.encode() {
            for to in recipients {
                effects.push(emit(
                    to,
                    ServerEvent::Frame {
                        bytes: bytes.clone(),
                        generation: None,
                    },
                    false,
                    Some(connection),
                ));
            }
        }
    }
}
