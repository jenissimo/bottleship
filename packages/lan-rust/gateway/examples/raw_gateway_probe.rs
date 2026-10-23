//! Finite actual-OS RAW NAT probe. Permission denial is reported explicitly and
//! never counted as a verified packet datapath. This never builds a C helper.
use bottleship_lan_core::{
    GatewayEvent, GatewayInput,
    config::*,
    gateway::{BindingToken, DestinationPolicy},
    routes::{NativeAddress, Target},
    wire::{Datagram, Node, node_ipv4},
};
use bottleship_lan_gateway::*;
use bytes::Bytes;
use std::{
    error::Error,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::UdpSocket, time::timeout};
type Any = Box<dyn Error>;
fn sum(bytes: &[u8]) -> u16 {
    let mut s = 0u32;
    for p in bytes.chunks(2) {
        s += ((p[0] as u32) << 8) | u32::from(*p.get(1).unwrap_or(&0));
    }
    while s >> 16 != 0 {
        s = (s & 65535) + (s >> 16)
    }
    !(s as u16)
}
fn local6(node: Node) -> [u8; 16] {
    let mut ip = [0; 16];
    ip[..10].copy_from_slice(&[0xfd, 0x42, 0x62, 0x73, 0x6c, 0x61, 0x6e, 0, 0, 0]);
    ip[10..].copy_from_slice(&node);
    ip
}
fn transport_sum(packet: &[u8], source: &[u8], destination: &[u8], protocol: u8) -> u16 {
    let mut b = Vec::new();
    b.extend_from_slice(source);
    b.extend_from_slice(destination);
    b.extend_from_slice(&(packet.len() as u32).to_be_bytes());
    b.extend_from_slice(&[0, 0, 0, protocol]);
    b.extend_from_slice(packet);
    sum(&b)
}
fn addresses(family: u8) -> (IpAddr, IpAddr, Node) {
    if family == 4 {
        (
            Ipv4Addr::LOCALHOST.into(),
            Ipv4Addr::new(192, 0, 2, 1).into(),
            [2, 1, 192, 0, 2, 1],
        )
    } else {
        (
            Ipv6Addr::LOCALHOST.into(),
            "2001:db8::1".parse().unwrap(),
            [2, 2, 0, 0, 0, 1],
        )
    }
}
fn spawn(
    helper: &str,
    family: u8,
    id: u64,
    protocol: u8,
    policy: Arc<Mutex<DestinationPolicy>>,
) -> (GatewayHandle, GatewayEvents) {
    let (host, alias, _) = addresses(family);
    let cfg = GatewayConfig {
        native_helper_path: Some(helper.into()),
        routes: vec![RouteConfig {
            host: host.to_string(),
            address: Some(alias.to_string()),
            scope_id: None,
            names: vec![],
            ports: vec![],
            protocols: vec![RouteProtocol::Raw],
            ip_protocols: vec![protocol],
            raw_mode: None,
        }],
        ..Default::default()
    };
    Gateway::spawn_with_node(
        id,
        [2, 0, 0, 0, 0, id as u8],
        cfg,
        policy,
        GatewayOptions::default(),
    )
    .unwrap()
}
fn input(family: u8, protocol: u8, packet: Vec<u8>) -> GatewayInput {
    let (host, _, node) = addresses(family);
    let proto = if family == 4 { 6 } else { 7 };
    let wire_port = u16::from(protocol) + 1;
    let mut body = vec![protocol, 0];
    body.extend_from_slice(&packet);
    GatewayInput::Frame {
        binding: BindingToken {
            proto,
            local_port: wire_port,
            generation: Some(1),
        },
        datagram: Datagram {
            proto,
            node,
            src_port: wire_port,
            dst_port: wire_port,
            payload: Bytes::from(body),
        },
        target: Target {
            route_id: 0,
            address: NativeAddress {
                ip: host,
                scope_id: 0,
            },
            port: wire_port,
            canonical_policy_key: host.to_string(),
            raw_mode: None,
        },
    }
}
struct Abort(GatewayHandle);
impl Drop for Abort {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn stop(
    handle: &GatewayHandle,
    events: &GatewayEvents,
    family: u8,
    protocol: u8,
) -> Result<(), Any> {
    handle.try_submit(GatewayInput::ReleasePort {
        proto: if family == 4 { 6 } else { 7 },
        port: u16::from(protocol) + 1,
        generation: 1,
    })?;
    let mut status = events.status.clone();
    timeout(Duration::from_secs(3), async {
        loop {
            if status.borrow().raw_flows == 0 {
                return Ok::<_, Any>(());
            }
            status.changed().await?;
        }
    })
    .await??;
    handle.abort();
    timeout(Duration::from_secs(3), handle.wait_closed()).await??;
    Ok(())
}
async fn packet(
    events: &mut GatewayEvents,
    family: u8,
    protocol: u8,
) -> Result<Option<Bytes>, Any> {
    timeout(Duration::from_secs(6), async {
        loop {
            let out = events.outputs.recv().await.ok_or("RAW output ended")?;
            match &out.event {
                GatewayEvent::SocketError { code: 10013, .. } => return Ok(None),
                GatewayEvent::SocketError { code, .. } => {
                    return Err(format!("Unexpected RAW socket error {code}").into());
                }
                GatewayEvent::Frame { datagram, .. } => {
                    if datagram.payload.len() < 2 || datagram.payload[0] != protocol {
                        return Err("Wrong RAW classification".into());
                    }
                    let flags = if family == 4 { 1 } else { 0 };
                    if datagram.payload[1] != flags {
                        return Err("Wrong RAW header flag".into());
                    }
                    return Ok(Some(datagram.payload.slice(2..)));
                }
                _ => {}
            }
        }
    })
    .await?
}
async fn echo(helper: &str, family: u8) -> Result<(), Any> {
    let protocol = if family == 4 { 1 } else { 58 };
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let (h1, mut e1) = spawn(helper, family, 1, protocol, policy.clone());
    let (h2, mut e2) = spawn(helper, family, 2, protocol, policy.clone());
    let _g1 = Abort(h1.clone());
    let _g2 = Abort(h2.clone());
    for (h, id) in [(&h1, 1u8), (&h2, 2u8)] {
        let mut p = vec![
            if family == 4 { 8 } else { 128 },
            0,
            0,
            0,
            0x12,
            0x34,
            0,
            7,
            id,
            11,
            19,
            29,
        ];
        if family == 4 {
            let c = sum(&p);
            p[2..4].copy_from_slice(&c.to_be_bytes());
        }
        h.try_submit(input(family, protocol, p))?;
    }
    let mut verified = 0;
    for (events, id) in [(&mut e1, 1u8), (&mut e2, 2u8)] {
        if let Some(p) = packet(events, family, protocol).await? {
            let o = if family == 4 {
                if p.len() < 28 || p[0] >> 4 != 4 {
                    return Err("Invalid native IPv4 header".into());
                }
                let h = usize::from(p[0] & 15) * 4;
                if sum(&p[..h]) != 0
                    || p[12..16] != [192, 0, 2, 1]
                    || p[16..20] != node_ipv4(&[2, 0, 0, 0, 0, id])
                {
                    return Err("RAW IPv4 address/checksum NAT mismatch".into());
                }
                h
            } else {
                0
            };
            if p[o] != if family == 4 { 0 } else { 129 }
                || p[o + 4..o + 6] != [0x12, 0x34]
                || p[o + 8..] != [id, 11, 19, 29]
            {
                return Err("Cross-participant echo identifier/payload leak".into());
            }
            if family == 4 {
                if sum(&p[o..]) != 0 {
                    return Err("ICMP checksum mismatch".into());
                }
            } else {
                let (_, remote, _) = addresses(family);
                if let IpAddr::V6(remote) = remote {
                    if transport_sum(&p, &remote.octets(), &local6([2, 0, 0, 0, 0, id]), 58) != 0 {
                        return Err("ICMPv6 pseudo checksum mismatch".into());
                    }
                }
            }
            verified += 1;
        }
    }
    stop(&h1, &e1, family, protocol).await?;
    stop(&h2, &e2, family, protocol).await?;
    if policy.lock().unwrap().active_leases() != 0 {
        return Err("RAW echo native policy lease leaked".into());
    }
    println!(
        "RAW_ECHO family={family} verified_participants={verified} denied_participants={} same_original_id=4660 actual_packet_path={}",
        2 - verified,
        verified == 2
    );
    Ok(())
}
async fn udp(helper: &str, family: u8) -> Result<(), Any> {
    let (ip, alias, _) = addresses(family);
    let peer = UdpSocket::bind((ip, 0)).await?;
    let endpoint = peer.local_addr()?;
    let (task, mut received) = tokio::sync::mpsc::channel(2);
    let echo = tokio::spawn(async move {
        let mut b = [0; 65535];
        loop {
            match peer.recv_from(&mut b).await {
                Ok((n, source)) => {
                    if task.send(source).await.is_err() {
                        return;
                    }
                    if peer.send_to(&b[..n], source).await.is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });
    let policy = Arc::new(Mutex::new(DestinationPolicy::default()));
    let (h1, mut e1) = spawn(helper, family, 1, 17, policy.clone());
    let (h2, mut e2) = spawn(helper, family, 2, 17, policy.clone());
    let _g1 = Abort(h1.clone());
    let _g2 = Abort(h2.clone());
    for (h, id) in [(&h1, 1u8), (&h2, 2u8)] {
        let mut p = vec![0x87, 0x07, 0, 0, 0, 12, 0, 0, id, 5, 7, 9];
        p[2..4].copy_from_slice(&endpoint.port().to_be_bytes());
        if family == 6 {
            if let IpAddr::V6(alias) = alias {
                let c = transport_sum(&p, &local6([2, 0, 0, 0, 0, id]), &alias.octets(), 17);
                p[6..8].copy_from_slice(&c.to_be_bytes());
            }
        }
        h.try_submit(input(family, 17, p))?;
    }
    let mut verified = 0;
    for (events, id) in [(&mut e1, 1u8), (&mut e2, 2u8)] {
        if let Some(p) = packet(events, family, 17).await? {
            let o = if family == 4 {
                usize::from(p[0] & 15) * 4
            } else {
                0
            };
            if p.len() < o + 12
                || u16::from_be_bytes([p[o], p[o + 1]]) != endpoint.port()
                || p[o + 2..o + 4] != [0x87, 0x07]
                || p[o + 8..] != [id, 5, 7, 9]
            {
                return Err("RAW UDP tuple or participant NAT mismatch".into());
            }
            if family == 4 {
                if sum(&p[..o]) != 0
                    || p[12..16] != [192, 0, 2, 1]
                    || p[16..20] != node_ipv4(&[2, 0, 0, 0, 0, id])
                {
                    return Err("RAW UDP IPv4 address/header checksum NAT mismatch".into());
                }
            } else if let IpAddr::V6(alias) = alias {
                if transport_sum(&p, &alias.octets(), &local6([2, 0, 0, 0, 0, id]), 17) != 0 {
                    return Err("RAW UDP IPv6 transport checksum mismatch".into());
                }
            }
            verified += 1;
        }
    }
    if verified == 2 {
        let a = timeout(Duration::from_secs(2), received.recv())
            .await?
            .ok_or("Missing native UDP source")?;
        let b = timeout(Duration::from_secs(2), received.recv())
            .await?
            .ok_or("Missing second native UDP source")?;
        if a.port() == b.port() {
            return Err("Independent RAW UDP guests reused one native tuple".into());
        }
    }
    stop(&h1, &e1, family, 17).await?;
    stop(&h2, &e2, family, 17).await?;
    echo.abort();
    let _ = echo.await;
    if policy.lock().unwrap().active_leases() != 0 {
        return Err("RAW UDP native policy lease leaked".into());
    }
    println!(
        "RAW_UDP family={family} verified_participants={verified} denied_participants={} actual_packet_path={}",
        2 - verified,
        verified == 2
    );
    Ok(())
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Any> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: raw_gateway_probe measured-native-helper")?;
    timeout(Duration::from_secs(35), async {
        echo(&path, 4).await?;
        echo(&path, 6).await?;
        udp(&path, 4).await?;
        udp(&path, 6).await?;
        Ok::<_, Any>(())
    })
    .await??;
    Ok(())
}
