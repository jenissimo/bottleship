//! Optional Host leases have a separate public ID namespace and exact native IDs.
use super::*;
use crate::{config::UdpListenerConfig, wire::UdpHostRequest};
#[derive(Default)]
pub(super) struct HostState {
    last_request: u32,
    next_lease: u64,
    pending: HashMap<u64, PendingHost>,
    active: HashMap<u32, ActiveHost>,
}
struct PendingHost {
    request_id: u32,
    binding: BindingToken,
    listener: UdpListenerConfig,
}
struct ActiveHost {
    request_id: u32,
    binding: BindingToken,
    native_id: u64,
    listener: UdpListenerConfig,
}
impl HostState {
    pub(super) fn pending_operations(&self) -> Vec<u64> {
        self.pending.keys().copied().collect()
    }
    fn owns(&self, binding: BindingToken) -> bool {
        self.pending.values().any(|h| h.binding == binding)
            || self.active.values().any(|h| h.binding == binding)
    }
}
fn reply(connection: ConnId, id: u32, code: u32) -> Effect {
    emit(
        connection,
        json_event(
            "udpHostOpened",
            vec![
                json!(id),
                json!({"error":{"code":code,"message":"UDP Host listener refused"}}),
            ],
        ),
        true,
        None,
    )
}
fn ended(connection: ConnId, id: u32, active: &ActiveHost, code: u32) -> Effect {
    emit(
        connection,
        json_event(
            "udpHostClosed",
            vec![
                json!(active.request_id),
                json!(id),
                json!({"code":code,"message":"UDP Host listener closed"}),
            ],
        ),
        true,
        None,
    )
}
fn native_release(connection: ConnId, id: u64) -> Effect {
    Effect::NativeOperation {
        connection,
        input: GatewayInput::ReleaseUdpHost { lease_id: id },
    }
}
impl Core {
    fn host_admit(
        &mut self,
        connection: ConnId,
        id: u32,
        now: u64,
        effects: &mut Vec<Effect>,
    ) -> bool {
        if !self.rate(connection, 128, now, effects) {
            return false;
        }
        let host = &mut self.participants.get_mut(&connection).unwrap().host;
        if id == 0 || id <= host.last_request {
            self.disconnect(connection, now, "UDP Host request identity reused", effects);
            return false;
        }
        host.last_request = id;
        true
    }
    pub(super) fn host_malformed(
        &mut self,
        c: ConnId,
        id: u32,
        now: u64,
        effects: &mut Vec<Effect>,
    ) {
        if self.host_admit(c, id, now, effects) {
            effects.push(reply(c, id, 10022));
        }
    }
    pub(super) fn host_open(
        &mut self,
        c: ConnId,
        id: u32,
        request: UdpHostRequest,
        now: u64,
        effects: &mut Vec<Effect>,
    ) {
        if !self.host_admit(c, id, now, effects) {
            return;
        }
        let binding = BindingToken {
            proto: request.proto,
            local_port: request.local_port,
            generation: Some(request.binding_generation),
        };
        let Some(listener) = self
            .routes
            .config
            .udp_listeners
            .iter()
            .find(|l| l.id == request.listener_id)
            .cloned()
        else {
            effects.push(reply(c, id, 10013));
            return;
        };
        if binding.proto != 1 || binding.local_port == 0 || binding.generation == Some(0) {
            effects.push(reply(c, id, 10022));
            return;
        }
        let p = self.participants.get_mut(&c).unwrap();
        if p.host.pending.len() >= 16 || p.host.active.len() + p.host.pending.len() >= 32 {
            effects.push(reply(c, id, 10055));
            return;
        }
        if !p.bindings.admit(binding) {
            effects.push(reply(c, id, 10057));
            return;
        }
        p.multicast_bindings.admit(binding);
        self.retire_udp(
            c,
            1,
            binding.local_port,
            request.binding_generation,
            false,
            effects,
        );
        if self.participants[&c].host.owns(binding)
            || self.participants[&c]
                .pending
                .values()
                .any(|p| p.binding == binding)
            || self.participants[&c]
                .active
                .values()
                .any(|p| p.binding == binding)
        {
            effects.push(reply(c, id, 10048));
            return;
        }
        let Some(op) = self.next_operation.checked_add(1) else {
            effects.push(reply(c, id, 10055));
            return;
        };
        self.next_operation = op;
        self.participants.get_mut(&c).unwrap().host.pending.insert(
            op,
            PendingHost {
                request_id: id,
                binding,
                listener: listener.clone(),
            },
        );
        effects.push(Effect::NativeOperation {
            connection: c,
            input: GatewayInput::OpenUdpHost {
                operation: op,
                binding,
                listener,
            },
        });
    }
    pub(super) fn host_binding_owned(&self, c: ConnId, binding: BindingToken) -> bool {
        self.participants
            .get(&c)
            .is_some_and(|p| p.host.owns(binding))
    }
    pub(super) fn host_outbound(
        &self,
        c: ConnId,
        binding: BindingToken,
        d: &Datagram,
        effects: &mut Vec<Effect>,
    ) -> bool {
        let host = &self.participants[&c].host;
        if let Some(active) = host.active.values().find(|a| a.binding == binding) {
            if binding.proto == 1 && active.listener.allowed_nodes().contains(&d.node) {
                effects.push(Effect::NativeOperation {
                    connection: c,
                    input: GatewayInput::HostFrame {
                        lease_id: active.native_id,
                        binding,
                        datagram: d.clone(),
                    },
                });
            } else {
                self.socket_error(c, binding, d.node, d.dst_port, 10013, None, effects);
            }
            return true;
        }
        if host.pending.values().any(|p| p.binding == binding) {
            self.socket_error(c, binding, d.node, d.dst_port, 10057, None, effects);
            return true;
        }
        false
    }
    pub(super) fn host_cancel(&mut self, c: ConnId, id: u32, now: u64, effects: &mut Vec<Effect>) {
        if !self.rate(c, 16, now, effects) {
            return;
        }
        let host = &mut self.participants.get_mut(&c).unwrap().host;
        let pending: Vec<_> = host
            .pending
            .iter()
            .filter(|(_, p)| p.request_id == id)
            .map(|(op, _)| *op)
            .collect();
        for op in pending {
            host.pending.remove(&op);
            effects.push(Effect::NativeOperation {
                connection: c,
                input: GatewayInput::CancelOperation { operation: op },
            });
        }
        let active: Vec<_> = host
            .active
            .iter()
            .filter(|(_, p)| p.request_id == id)
            .map(|(lease, _)| *lease)
            .collect();
        for lease in active {
            let a = host.active.remove(&lease).unwrap();
            effects.push(native_release(c, a.native_id));
        }
    }
    pub(super) fn host_release(&mut self, c: ConnId, id: u32, now: u64, effects: &mut Vec<Effect>) {
        if !self.rate(c, 16, now, effects) {
            return;
        }
        if let Some(a) = self
            .participants
            .get_mut(&c)
            .unwrap()
            .host
            .active
            .remove(&id)
        {
            effects.push(native_release(c, a.native_id));
        }
    }
    pub(super) fn host_retire_binding(
        &mut self,
        c: ConnId,
        proto: u8,
        port: u16,
        g: u32,
        inclusive: bool,
        effects: &mut Vec<Effect>,
    ) {
        let Some(p) = self.participants.get_mut(&c) else {
            return;
        };
        let matches = |b: BindingToken| {
            b.proto == proto
                && b.local_port == port
                && b.generation
                    .is_none_or(|old| if inclusive { old <= g } else { old < g })
        };
        let ops: Vec<_> = p
            .host
            .pending
            .iter()
            .filter(|(_, h)| matches(h.binding))
            .map(|(op, _)| *op)
            .collect();
        for op in ops {
            p.host.pending.remove(&op);
            effects.push(Effect::NativeOperation {
                connection: c,
                input: GatewayInput::CancelOperation { operation: op },
            });
        }
        let ids: Vec<_> = p
            .host
            .active
            .iter()
            .filter(|(_, h)| matches(h.binding))
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            let a = p.host.active.remove(&id).unwrap();
            effects.push(ended(c, id, &a, 10057));
            effects.push(native_release(c, a.native_id));
        }
    }
    pub(super) fn host_ready(
        &mut self,
        c: ConnId,
        op: u64,
        lease: u64,
        node: Node,
        port: u16,
        effects: &mut Vec<Effect>,
    ) {
        let pending = self
            .participants
            .get_mut(&c)
            .and_then(|p| p.host.pending.remove(&op));
        let Some(pending) = pending else {
            effects.push(native_release(c, lease));
            return;
        };
        let p = self.participants.get_mut(&c).unwrap();
        if !p.bindings.is_live(pending.binding) {
            effects.push(native_release(c, lease));
            return;
        }
        if lease == 0
            || node != pending.listener.advertised_node()
            || port == 0
            || (pending.listener.port != 0 && port != pending.listener.port)
        {
            effects.push(native_release(c, lease));
            effects.push(reply(c, pending.request_id, 10022));
            return;
        }
        let id = p.host.next_lease + 1;
        if id > u32::MAX as u64 {
            effects.push(native_release(c, lease));
            effects.push(reply(c, pending.request_id, 10055));
            return;
        }
        p.host.next_lease = id;
        let allowed = pending.listener.allowed_nodes();
        p.host.active.insert(
            id as u32,
            ActiveHost {
                request_id: pending.request_id,
                binding: pending.binding,
                native_id: lease,
                listener: pending.listener,
            },
        );
        effects.push(emit(c,json_event("udpHostOpened",vec![json!(pending.request_id),json!({"leaseId":id,"address":{"node":node,"port":port},"allowedNodes":allowed})]),true,None));
    }
    pub(super) fn host_failed(&mut self, c: ConnId, op: u64, code: u32, effects: &mut Vec<Effect>) {
        if let Some(p) = self.participants.get_mut(&c) {
            if let Some(pending) = p.host.pending.remove(&op) {
                if p.bindings.is_live(pending.binding) {
                    effects.push(reply(c, pending.request_id, code));
                }
            }
        }
    }
    pub(super) fn host_socket_error(
        &self,
        c: ConnId,
        lease: u64,
        binding: BindingToken,
        node: Node,
        remote_port: u16,
        code: u32,
        effects: &mut Vec<Effect>,
    ) {
        if self.participants.get(&c).is_some_and(|p| {
            p.host
                .active
                .values()
                .any(|a| a.native_id == lease && a.binding == binding)
        }) {
            self.socket_error(c, binding, node, remote_port, code, None, effects);
        }
    }
    pub(super) fn host_closed(
        &mut self,
        c: ConnId,
        lease: u64,
        code: u32,
        effects: &mut Vec<Effect>,
    ) {
        let Some(p) = self.participants.get_mut(&c) else {
            return;
        };
        let Some(id) = p
            .host
            .active
            .iter()
            .find_map(|(id, a)| (a.native_id == lease).then_some(*id))
        else {
            return;
        };
        let a = p.host.active.remove(&id).unwrap();
        // A fatal physical binding cannot silently become an ordinary outbound flow.
        if let Some(g) = a.binding.generation {
            p.bindings.release(a.binding.proto, a.binding.local_port, g);
            self.retire_udp(c, a.binding.proto, a.binding.local_port, g, true, effects);
        }
        effects.push(ended(c, id, &a, code));
    }
    pub(super) fn host_inbound(
        &self,
        c: ConnId,
        lease: u64,
        binding: BindingToken,
        d: Datagram,
        effects: &mut Vec<Effect>,
    ) {
        let Some(p) = self.participants.get(&c) else {
            return;
        };
        let Some(active) = p
            .host
            .active
            .values()
            .find(|a| a.native_id == lease && a.binding == binding)
        else {
            return;
        };
        if !p.bindings.is_live(binding)
            || d.proto != 1
            || d.dst_port != binding.local_port
            || !active.listener.allowed_nodes().contains(&d.node)
        {
            return;
        }
        if let Ok(bytes) = d.encode() {
            effects.push(emit(
                c,
                ServerEvent::Frame {
                    bytes,
                    generation: binding.generation,
                },
                false,
                None,
            ));
        }
    }
}
