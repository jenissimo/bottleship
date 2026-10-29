//! TCP listener ownership, isolated by connection, operation and binding generation.
use super::*;
use crate::{config::TcpListenerConfig, wire::{TcpFrame, TcpHostRequest}};

#[derive(Default)]
pub(super) struct TcpHostState {
    last_request: u32,
    next_lease: u32,
    pending: HashMap<u64, PendingTcpHost>,
    active: HashMap<u32, ActiveTcpHost>,
    // false until the gateway confirms native establishment.
    children: HashMap<TcpChildKey, bool>,
    offers: HashMap<TcpOfferKey, ()>,
    last_offer_native_id: u32,
}
struct PendingTcpHost { request_id: u32, binding: BindingToken, config: TcpListenerConfig }
struct ActiveTcpHost { request_id: u32, binding: BindingToken, native_id: u64, config: TcpListenerConfig }
impl TcpHostState {
    pub(super) fn pending_operations(&self) -> Vec<u64> { self.pending.keys().copied().collect() }
    fn owns(&self, binding: BindingToken) -> bool {
        self.pending.values().any(|p| p.binding == binding) ||
        self.active.values().any(|p| p.binding == binding) ||
        self.children.keys().any(|k| k.binding == binding)
    }
}
fn reply(c: ConnId, id: u32, code: u32) -> Effect {
    emit(c, json_event("tcpHostOpened", vec![json!(id),
        json!({"error":{"code":code,"message":"TCP Host listener refused"}})]), true, None)
}
fn close(c: ConnId, lease_id: u64) -> Effect {
    Effect::NativeOperation { connection: c, input: GatewayInput::CloseTcpListener { lease_id } }
}
fn ended(c: ConnId, id: u32, a: &ActiveTcpHost, code: u32) -> Effect {
    emit(c, json_event("tcpHostClosed", vec![json!(a.request_id), json!(id),
        json!({"code":code,"message":"TCP Host listener closed"})]), true, None)
}
fn allowed(config: &TcpListenerConfig, node: Node) -> bool {
    node[0..2] == [2, 1] && config.allowed_hosts.iter().any(|s|
        s.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.octets() == node[2..6]))
}
impl Core {
    fn tcp_host_admit(&mut self, c: ConnId, id: u32, now: u64, effects: &mut Vec<Effect>) -> bool {
        if !self.rate(c, 128, now, effects) { return false; }
        let state = &mut self.participants.get_mut(&c).unwrap().tcp_host;
        if id == 0 || id <= state.last_request {
            self.disconnect(c, now, "TCP Host request identity reused", effects); return false;
        }
        state.last_request = id; true
    }
    pub(super) fn tcp_host_malformed(&mut self, c: ConnId, id: u32, now: u64, effects: &mut Vec<Effect>) {
        if self.tcp_host_admit(c,id,now,effects) { effects.push(reply(c,id,10022)); }
    }
    pub(super) fn tcp_host_open(&mut self, c: ConnId, id: u32, request: TcpHostRequest, now: u64, effects: &mut Vec<Effect>) {
        if !self.tcp_host_admit(c,id,now,effects) { return; }
        let binding = BindingToken { proto: request.proto, local_port: request.local_port, generation: Some(request.binding_generation) };
        let Some(config) = self.routes.config.tcp_listeners.iter().find(|v| v.id == request.listener_id).cloned() else {
            effects.push(reply(c,id,10013)); return;
        };
        if binding.proto != 2 || binding.local_port == 0 || binding.generation == Some(0) {
            effects.push(reply(c,id,10022)); return;
        }
        let p = self.participants.get_mut(&c).unwrap();
        if p.tcp_host.pending.len() >= 16 || p.tcp_host.active.len() + p.tcp_host.pending.len() >= 32 {
            effects.push(reply(c,id,10055)); return;
        }
        if !p.bindings.admit(binding) { effects.push(reply(c,id,10057)); return; }
        self.tcp_host_retire_binding(c, 2, binding.local_port, request.binding_generation, false, effects);
        let state = &self.participants[&c].tcp_host;
        if state.pending.values().any(|p| p.binding == binding) || state.active.values().any(|a| a.binding == binding) {
            effects.push(reply(c,id,10048)); return;
        }
        let Some(op) = self.next_operation.checked_add(1) else { effects.push(reply(c,id,10055)); return; };
        self.next_operation = op;
        self.participants.get_mut(&c).unwrap().tcp_host.pending.insert(op, PendingTcpHost {
            request_id: id, binding, config: config.clone(),
        });
        effects.push(Effect::NativeOperation { connection:c, input: GatewayInput::OpenTcpListener {
            operation_id:op, binding, config,
        }});
    }
    pub(super) fn tcp_host_owned(&self, c: ConnId, binding: BindingToken) -> bool {
        self.participants.get(&c).is_some_and(|p| p.tcp_host.owns(binding))
    }
    pub(super) fn tcp_host_outbound(&mut self, c: ConnId, binding: BindingToken, d: &Datagram, effects: &mut Vec<Effect>) -> bool {
        let state = &self.participants[&c].tcp_host;
        if let Ok(frame) = TcpFrame::decode(d.payload.clone()) {
            let child = state.children.keys().find(|k| k.binding == binding &&
                k.node == d.node && k.remote_port == d.dst_port &&
                k.guest_id == frame.src_id && k.native_id == frame.dst_id);
            if let Some(key) = child {
                if d.proto == 2 && d.src_port == binding.local_port && !matches!(frame.kind,1|2) {
                    effects.push(Effect::NativeOperation { connection:c, input:GatewayInput::TcpChildFrame {
                        key:*key, datagram:d.clone(),
                    }});
                }
                return true;
            }
        }
        if let Some(a) = state.active.values().find(|a| a.binding == binding) {
            let lease_id = a.native_id;
            let frame = TcpFrame::decode(d.payload.clone());
            let valid = d.proto == 2 && d.src_port == binding.local_port && allowed(&a.config,d.node) &&
                frame.as_ref().is_ok_and(|f| f.data.is_empty() && f.dst_id != 0 &&
                    ((f.kind == 2 && f.src_id != 0) || f.kind == 5));
            if valid {
                let f = frame.unwrap();
                let offer = TcpOfferKey { lease_id, binding, node:d.node, remote_port:d.dst_port, native_id:f.dst_id };
                if !state.offers.contains_key(&offer) {
                    self.socket_error(c,binding,d.node,d.dst_port,10013,None,effects);
                    return true;
                }
                let state = &mut self.participants.get_mut(&c).unwrap().tcp_host;
                state.offers.remove(&offer);
                if f.kind == 2 {
                    let key = TcpChildKey { lease_id, binding, node:d.node, remote_port:d.dst_port,
                        native_id:f.dst_id, guest_id:f.src_id };
                    state.children.insert(key,false);
                }
                effects.push(Effect::NativeOperation { connection:c, input:GatewayInput::TcpListenerFrame {
                    lease_id, binding, datagram:d.clone(),
                }});
            } else { self.socket_error(c,binding,d.node,d.dst_port,10013,None,effects); }
            return true;
        }
        if state.pending.values().any(|p| p.binding == binding) {
            self.socket_error(c,binding,d.node,d.dst_port,10057,None,effects); return true;
        }
        if state.children.keys().any(|k| k.binding == binding) {
            self.socket_error(c,binding,d.node,d.dst_port,10013,None,effects); return true;
        }
        false
    }
    pub(super) fn tcp_host_cancel(&mut self, c: ConnId, id: u32, now:u64, effects:&mut Vec<Effect>) {
        if !self.rate(c,16,now,effects) { return; }
        let state = &mut self.participants.get_mut(&c).unwrap().tcp_host;
        let ops: Vec<_> = state.pending.iter().filter_map(|(op,p)| (p.request_id == id).then_some(*op)).collect();
        for op in ops {
            state.pending.remove(&op);
            effects.push(Effect::NativeOperation {connection:c,input:GatewayInput::CancelOperation {operation:op}});
        }
        let ids: Vec<_> = state.active.iter().filter_map(|(lease,a)| (a.request_id == id).then_some(*lease)).collect();
        for lease in ids {
            let a = state.active.remove(&lease).unwrap();
            effects.push(close(c,a.native_id));
        }
    }
    pub(super) fn tcp_host_release(&mut self,c:ConnId,id:u32,now:u64,effects:&mut Vec<Effect>) {
        if !self.rate(c,16,now,effects) { return; }
        let state = &mut self.participants.get_mut(&c).unwrap().tcp_host;
        if let Some(a) = state.active.remove(&id) {
            effects.push(close(c,a.native_id));
        }
    }
    pub(super) fn tcp_host_retire_binding(&mut self,c:ConnId,proto:u8,port:u16,g:u32,inclusive:bool,effects:&mut Vec<Effect>) {
        let Some(p) = self.participants.get_mut(&c) else { return; };
        let matches = |b: BindingToken| b.proto == proto && b.local_port == port &&
            b.generation.is_none_or(|old| if inclusive {old <= g} else {old < g});
        p.tcp_host.offers.retain(|key,_| !matches(key.binding));
        let children:Vec<_> = p.tcp_host.children.keys().filter(|key| matches(key.binding)).copied().collect();
        for key in children {
            p.tcp_host.children.remove(&key);
            effects.push(Effect::NativeOperation {connection:c,input:GatewayInput::CloseTcpChild {key}});
        }
        let ops: Vec<_> = p.tcp_host.pending.iter().filter_map(|(op,h)| matches(h.binding).then_some(*op)).collect();
        for op in ops {
            p.tcp_host.pending.remove(&op);
            effects.push(Effect::NativeOperation {connection:c,input:GatewayInput::CancelOperation {operation:op}});
        }
        let ids:Vec<_> = p.tcp_host.active.iter().filter_map(|(id,h)| matches(h.binding).then_some(*id)).collect();
        for id in ids {
            let a = p.tcp_host.active.remove(&id).unwrap();
            effects.push(ended(c,id,&a,10057)); effects.push(close(c,a.native_id));
        }
    }
    pub(super) fn tcp_host_ready(&mut self,c:ConnId,op:u64,lease:u64,binding:BindingToken,address:std::net::SocketAddrV4,effects:&mut Vec<Effect>) {
        let pending = self.participants.get_mut(&c).and_then(|p| p.tcp_host.pending.remove(&op));
        let Some(pending) = pending else { effects.push(close(c,lease)); return; };
        let p = self.participants.get_mut(&c).unwrap();
        if pending.binding != binding || !p.bindings.is_live(pending.binding) {
            effects.push(close(c,lease)); return;
        }
        if lease == 0 || address.port() == 0 || (pending.config.port != 0 && address.port() != pending.config.port)
            || pending.config.advertised_host.parse::<std::net::Ipv4Addr>().ok() != Some(*address.ip()) {
            effects.push(close(c,lease)); effects.push(reply(c,pending.request_id,10022)); return;
        }
        let Some(id) = p.tcp_host.next_lease.checked_add(1) else {
            effects.push(close(c,lease)); effects.push(reply(c,pending.request_id,10055)); return;
        };
        p.tcp_host.next_lease = id;
        let octets = address.ip().octets();
        let node = [2,1,octets[0],octets[1],octets[2],octets[3]];
        let allowed_nodes:Vec<Node> = pending.config.allowed_hosts.iter().map(|s| {
            let b=s.parse::<std::net::Ipv4Addr>().expect("validated ACL").octets(); [2,1,b[0],b[1],b[2],b[3]]
        }).collect();
        p.tcp_host.active.insert(id,ActiveTcpHost { request_id:pending.request_id,binding,native_id:lease,config:pending.config });
        effects.push(emit(c,json_event("tcpHostOpened",vec![json!(pending.request_id),
            json!({"leaseId":id,"address":{"node":node,"port":address.port()},"allowedNodes":allowed_nodes})]),true,None));
    }
    pub(super) fn tcp_host_failed(&mut self,c:ConnId,op:u64,code:u32,effects:&mut Vec<Effect>) {
        if let Some(p) = self.participants.get_mut(&c) {
            if let Some(pending) = p.tcp_host.pending.remove(&op) {
                if p.bindings.is_live(pending.binding) { effects.push(reply(c,pending.request_id,code)); }
            }
        }
    }
    pub(super) fn tcp_host_closed(&mut self,c:ConnId,lease:u64,code:u32,effects:&mut Vec<Effect>) {
        let Some(p) = self.participants.get_mut(&c) else { return; };
        let Some(id) = p.tcp_host.active.iter().find_map(|(id,a)| (a.native_id == lease).then_some(*id)) else { return; };
        let a = p.tcp_host.active.remove(&id).unwrap();
        if !p.tcp_host.children.keys().any(|key| key.binding == a.binding) &&
            !p.tcp_host.offers.keys().any(|key| key.binding == a.binding) {
            if let Some(g) = a.binding.generation { p.bindings.release(a.binding.proto,a.binding.local_port,g); }
        }
        effects.push(ended(c,id,&a,code));
    }
    pub(super) fn tcp_child_established(&mut self,c:ConnId,key:TcpChildKey,effects:&mut Vec<Effect>) {
        let accepted = self.participants.get_mut(&c).is_some_and(|p| {
            if !p.bindings.is_live(key.binding) { return false; }
            if let Some(confirmed) = p.tcp_host.children.get_mut(&key) {
                *confirmed = true;
                true
            } else { false }
        });
        if !accepted { effects.push(Effect::NativeOperation {connection:c,input:GatewayInput::CloseTcpChild {key}}); }
    }
    pub(super) fn tcp_child_closed(&mut self,c:ConnId,key:TcpChildKey) {
        if let Some(p) = self.participants.get_mut(&c) { p.tcp_host.children.remove(&key); }
    }
    pub(super) fn tcp_child_inbound(&self,c:ConnId,key:TcpChildKey,d:Datagram,effects:&mut Vec<Effect>) {
        let Some(p) = self.participants.get(&c) else { return; };
        if p.tcp_host.children.get(&key) != Some(&true) || !p.bindings.is_live(key.binding) ||
            d.proto != 2 || d.node != key.node || d.src_port != key.remote_port ||
            d.dst_port != key.binding.local_port { return; }
        let Ok(frame) = TcpFrame::decode(d.payload.clone()) else { return; };
        if frame.src_id != key.native_id || frame.dst_id != key.guest_id || matches!(frame.kind,1|2) { return; }
        if let Ok(bytes) = d.encode() {
            effects.push(emit(c,ServerEvent::Frame {bytes,generation:key.binding.generation},true,None));
        }
    }
    pub(super) fn tcp_offer_closed(&mut self,c:ConnId,key:TcpOfferKey) {
        if let Some(p) = self.participants.get_mut(&c) { p.tcp_host.offers.remove(&key); }
    }
    pub(super) fn tcp_host_inbound(&mut self,c:ConnId,lease:u64,binding:BindingToken,d:Datagram,effects:&mut Vec<Effect>) {
        let Some(p) = self.participants.get(&c) else { return; };
        let Ok(frame) = TcpFrame::decode(d.payload.clone()) else { return; };
        if !p.bindings.is_live(binding) || d.proto != 2 || d.dst_port != binding.local_port { return; }
        if frame.kind == 1 {
            let Some(listener) = p.tcp_host.active.values().find(|a| a.native_id == lease &&
                a.binding == binding && allowed(&a.config,d.node)) else { return; };
            if frame.src_id == 0 || frame.dst_id != 0 || !frame.data.is_empty() ||
                d.src_port == 0 || frame.src_id <= p.tcp_host.last_offer_native_id { return; }
            let outstanding = p.tcp_host.offers.keys().filter(|k| k.lease_id == lease).count() +
                p.tcp_host.children.iter().filter(|(k,confirmed)| k.lease_id == lease && !**confirmed).count();
            let limit = listener.config.max_pending;
            let encoded = d.encode();
            let state = &mut self.participants.get_mut(&c).unwrap().tcp_host;
            state.last_offer_native_id = frame.src_id;
            let key = TcpOfferKey {lease_id:lease,binding,node:d.node,remote_port:d.src_port,native_id:frame.src_id};
            if outstanding >= limit || encoded.is_err() {
                effects.push(Effect::NativeOperation {connection:c,input:GatewayInput::CancelTcpOffer {key}});
                return;
            }
            let bytes = encoded.unwrap();
            state.offers.insert(key,());
            effects.push(emit(c,ServerEvent::Frame {bytes,generation:binding.generation},true,None));
            return;
        }
        let offer_reset = frame.kind == 5 && frame.dst_id == 0 && frame.src_id != 0 &&
            frame.data.is_empty() && p.tcp_host.offers.contains_key(&TcpOfferKey {
                lease_id:lease,binding,node:d.node,remote_port:d.src_port,native_id:frame.src_id
            });
        let pending_reset = frame.kind == 5 && frame.data.is_empty() && p.tcp_host.children.iter().any(|(k,confirmed)|
            !*confirmed && k.lease_id == lease && k.binding == binding &&
            k.node == d.node && k.remote_port == d.src_port &&
            k.native_id == frame.src_id && (frame.dst_id == 0 || k.guest_id == frame.dst_id));
        if !pending_reset && !offer_reset { return; }
        if let Ok(bytes) = d.encode() {
            effects.push(emit(c,ServerEvent::Frame {bytes,generation:binding.generation},true,None));
        }
    }
}
