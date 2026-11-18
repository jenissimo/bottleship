use super::{ConnId, Core, Effect, emit, json_event};
use crate::{turn::TurnTicket, wire::node_ipv4};
use serde_json::{Value, json};

const CHAT_BYTES: usize = 512;
const SIGNAL_BYTES: usize = 8192;
const VOICE_LIMIT: usize = 6;
const VOICE_LEASE_MS: u64 = 20_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomCommsRequest {
    Chat(String),
    VoiceJoin,
    VoiceLeave,
    Signal { to: String, payload: String },
}

impl RoomCommsRequest {
    pub fn decode(value: &Value) -> Option<Self> {
        match value["kind"].as_str()? {
            "chat" => {
                let raw = value["text"].as_str()?;
                let text = raw.trim();
                (!text.is_empty() && raw.len() <= CHAT_BYTES && !raw.chars().any(char::is_control))
                    .then(|| Self::Chat(text.into()))
            }
            "voiceJoin" => Some(Self::VoiceJoin),
            "voiceLeave" => Some(Self::VoiceLeave),
            "signal" => {
                let to = value["to"].as_str()?;
                let payload = value["payload"].as_str()?;
                (!to.is_empty()
                    && to.len() <= 64
                    && to
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    && !payload.is_empty()
                    && payload.len() <= SIGNAL_BYTES)
                    .then(|| Self::Signal {
                        to: to.into(),
                        payload: payload.into(),
                    })
            }
            _ => None,
        }
    }

    pub fn rate_size(&self) -> usize {
        128 + match self {
            Self::Chat(text) => text.len(),
            Self::Signal { to, payload } => to.len() + payload.len(),
            _ => 0,
        }
    }
}

#[derive(Default)]
pub(super) struct RoomComms {
    pub(super) enabled: bool,
    window_start: u64,
    chats: u8,
    signals: u8,
    joins: u8,
    voice: Option<Voice>,
}

impl RoomComms {
    pub(super) fn new(enabled: bool) -> Self {
        Self {
            enabled,
            ..Self::default()
        }
    }
}

struct Voice {
    id: String,
    expires: u64,
    ice: Option<TurnTicket>,
}

fn notice(connection: ConnId, value: Value) -> Effect {
    // Social traffic can be dropped under backpressure without retiring a game session.
    // Voice clients periodically refresh their roster and expire stale voice sessions.
    emit(
        connection,
        json_event("roomComms", vec![value]),
        false,
        None,
    )
}

impl Core {
    fn voice_peers(&self, room: &str, now: u64) -> Vec<(ConnId, &Voice)> {
        self.rooms
            .get(room)
            .into_iter()
            .flat_map(|room| room.values())
            .filter_map(|peer| {
                let connection = peer.connection?;
                let voice = self.participants.get(&connection)?.comms.voice.as_ref()?;
                (voice.expires > now).then_some((connection, voice))
            })
            .collect()
    }

    fn voice_roster(&self, room: &str, now: u64, only: Option<ConnId>, out: &mut Vec<Effect>) {
        let members = self.voice_peers(room, now);
        let unix_now = self.epoch_unix_ms.saturating_add(now);
        for (connection, voice) in &members {
            if only.is_some_and(|target| target != *connection) {
                continue;
            }
            let peers: Vec<_> = members
                .iter()
                .filter(|(other, _)| other != connection)
                .map(|(_, other)| &other.id)
                .collect();
            let mut roster = json!({"kind":"voice","self":voice.id,"peers":peers});
            if let Some(turn) = &self.turn
                && let Some(ticket) = &voice.ice
                && let Some(ice) = turn.payload(ticket, unix_now)
            {
                roster["ice"] = ice;
            }
            out.push(notice(*connection, roster));
        }
    }

    pub(super) fn room_comms(
        &mut self,
        connection: ConnId,
        request: RoomCommsRequest,
        now: u64,
        out: &mut Vec<Effect>,
    ) {
        let p = self
            .participants
            .get_mut(&connection)
            .expect("admitted room member");
        let state = &mut p.comms;
        if !state.enabled {
            return;
        }
        if now.saturating_sub(state.window_start) >= 1000 {
            state.window_start = now;
            state.chats = 0;
            state.signals = 0;
            state.joins = 0;
        }
        let room = p.join.room.clone();
        match request {
            RoomCommsRequest::Chat(text) => {
                if state.chats >= 4 {
                    if state.chats == 4 {
                        state.chats += 1;
                        out.push(notice(
                            connection,
                            json!({"kind":"error","code":"chatRate"}),
                        ));
                    }
                    return;
                }
                state.chats += 1;
                let sender = node_ipv4(&p.join.node).map(|n| n.to_string()).join(".");
                for recipient in self.rooms[&room]
                    .values()
                    .filter_map(|peer| peer.connection)
                {
                    if self
                        .participants
                        .get(&recipient)
                        .is_some_and(|p| p.comms.enabled)
                    {
                        out.push(notice(
                            recipient,
                            json!({"kind":"chat","sender":sender,"text":text}),
                        ));
                    }
                }
            }
            RoomCommsRequest::VoiceJoin => {
                if state.joins >= 4 {
                    return;
                }
                state.joins += 1;
                let expires = now.saturating_add(VOICE_LEASE_MS);
                let unix_now = self.epoch_unix_ms.saturating_add(now);
                let invite_expiry = (p.access_expires_at != u64::MAX)
                    .then(|| self.epoch_unix_ms.saturating_add(p.access_expires_at));
                if let Some(voice) = state.voice.as_mut().filter(|v| v.expires > now) {
                    voice.expires = expires;
                    if let Some(turn) = &self.turn {
                        turn.refresh(unix_now, invite_expiry, &voice.id, &mut voice.ice);
                    }
                    self.voice_roster(&room, now, Some(connection), out);
                    return;
                }
                if self.voice_peers(&room, now).len() >= VOICE_LIMIT {
                    out.push(notice(
                        connection,
                        json!({"kind":"error","code":"voiceFull"}),
                    ));
                    return;
                }
                let Some(operation) = self.next_operation.checked_add(1) else {
                    return;
                };
                self.next_operation = operation;
                let mut voice = Voice {
                    id: operation.to_string(),
                    expires,
                    ice: None,
                };
                if let Some(turn) = &self.turn {
                    turn.refresh(unix_now, invite_expiry, &voice.id, &mut voice.ice);
                }
                self.participants.get_mut(&connection).unwrap().comms.voice = Some(voice);
                self.voice_roster(&room, now, None, out);
            }
            RoomCommsRequest::VoiceLeave => {
                if state.voice.take().is_some() {
                    self.voice_roster(&room, now, None, out);
                }
            }
            RoomCommsRequest::Signal { to, payload } => {
                if state.signals >= 64 {
                    return;
                }
                state.signals += 1;
                let Some(from) = state
                    .voice
                    .as_ref()
                    .filter(|v| v.expires > now)
                    .map(|v| v.id.clone())
                else {
                    return;
                };
                if let Some((target, _)) = self
                    .voice_peers(&room, now)
                    .into_iter()
                    .find(|(id, peer)| *id != connection && peer.id == to)
                {
                    out.push(notice(
                        target,
                        json!({"kind":"signal","to":to,"from":from,"payload":payload}),
                    ));
                }
            }
        }
    }

    pub(super) fn room_comms_retired(
        &self,
        state: &RoomComms,
        room: &str,
        now: u64,
        out: &mut Vec<Effect>,
    ) {
        if state.voice.is_some() {
            self.voice_roster(room, now, None, out);
        }
    }
}
