//! Aggregate operator counters for GET /stats.
//!
//! Only totals leave this module: no room names, client identities, addresses or
//! hashes. Daily uniqueness keeps truncated HMACs of handshake client IDs under a
//! random in-memory salt that is replaced at each UTC midnight; neither the salt nor
//! the hashes are persisted, logged or rendered. Counters are relaxed atomics so the
//! relay paths pay one increment; only a join takes the daily set lock.
use crate::config::ConfigError;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering::Relaxed},
    },
};

/// Default bound on distinct sessions remembered for the current UTC day.
pub const DEFAULT_UNIQUE_CAPACITY: usize = 100_000;
/// Default environment variable that enables GET /stats.
pub const DEFAULT_STATS_TOKEN_ENV: &str = "BOTTLESHIP_LAN_STATS_TOKEN";
const DAY_MS: u64 = 86_400_000;
const MIN_TOKEN: usize = 16;
const MAX_TOKEN: usize = 512;

/// Produces a fresh 32-byte daily salt, or None when the OS source fails.
pub type SaltSource = Box<dyn FnMut() -> Option<[u8; 32]> + Send>;

/// Bearer token for GET /stats. Only its SHA-256 digest is retained.
pub struct StatsToken {
    digest: [u8; 32],
}
impl std::fmt::Debug for StatsToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StatsToken(..)")
    }
}
fn sha256(data: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(data);
    let mut out = [0u8; 32];
    for (slot, byte) in out.iter_mut().zip(digest.iter()) {
        *slot = *byte;
    }
    out
}
impl StatsToken {
    /// Unset or empty disables the endpoint. A configured token must be 16..512
    /// visible ASCII characters; the error never contains the value.
    pub fn from_value(value: Option<&str>) -> Result<Option<Self>, ConfigError> {
        let Some(value) = value.filter(|v| !v.is_empty()) else {
            return Ok(None);
        };
        if !(MIN_TOKEN..=MAX_TOKEN).contains(&value.len())
            || !value.bytes().all(|b| (0x21..=0x7e).contains(&b))
        {
            return Err(ConfigError(
                "Stats token must contain 16..512 visible ASCII characters".into(),
            ));
        }
        Ok(Some(Self {
            digest: sha256(value.as_bytes()),
        }))
    }
    /// Reads the named environment variable. Non-Unicode values are rejected.
    pub fn from_environment(name: &str) -> Result<Option<Self>, ConfigError> {
        match std::env::var(name) {
            Ok(value) => Self::from_value(Some(&value)),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(std::env::VarError::NotUnicode(_)) => Err(ConfigError(
                "Stats token must contain 16..512 visible ASCII characters".into(),
            )),
        }
    }
    /// Checks a raw Authorization header value (`Bearer <token>`). Both sides are
    /// hashed first, so the comparison is fixed-length and constant-time and does
    /// not reveal the configured token length.
    pub fn verify(&self, header: Option<&[u8]>) -> bool {
        let Some(header) = header else { return false };
        let Some((scheme, rest)) = header.split_at_checked(6) else {
            return false;
        };
        if !scheme.eq_ignore_ascii_case(b"Bearer") || rest.first() != Some(&b' ') {
            return false;
        }
        let presented = rest.trim_ascii();
        let digest = sha256(presented);
        let mut difference = 0u8;
        for (a, b) in digest.iter().zip(self.digest.iter()) {
            difference |= a ^ b;
        }
        std::hint::black_box(difference) == 0
    }
}

struct Daily {
    day: u64,
    salt: [u8; 32],
    today: HashSet<[u8; 16]>,
    today_approximate: bool,
    yesterday: u64,
    yesterday_approximate: bool,
    salt_source: SaltSource,
}
impl Daily {
    fn roll(&mut self, day: u64) {
        // A clock that steps backwards keeps the current day rather than reopening one.
        if day <= self.day {
            return;
        }
        if day == self.day + 1 {
            self.yesterday = self.today.len() as u64;
            self.yesterday_approximate = self.today_approximate;
        } else {
            self.yesterday = 0;
            self.yesterday_approximate = false;
        }
        // Release the old day's hashes rather than keeping their capacity.
        self.today = HashSet::new();
        self.today_approximate = false;
        self.salt = match (self.salt_source)() {
            Some(salt) => salt,
            // The previous salt never left memory; chaining keeps uniqueness keyed
            // by an unknown secret even when the OS source fails at midnight.
            None => {
                let mut mac = hmac(&self.salt);
                mac.update(b"BottleShip LAN stats salt rotation.");
                mac.update(&day.to_le_bytes());
                let mut salt = [0u8; 32];
                for (slot, byte) in salt.iter_mut().zip(mac.finalize().into_bytes().iter()) {
                    *slot = *byte;
                }
                salt
            }
        };
        self.day = day;
    }
}
fn hmac(key: &[u8; 32]) -> Hmac<Sha256> {
    // HMAC accepts keys of every length; a 32-byte key cannot fail.
    match <Hmac<Sha256> as KeyInit>::new_from_slice(key) {
        Ok(mac) => mac,
        Err(_) => unreachable!("HMAC-SHA256 accepts any key length"),
    }
}

/// Point-in-time copy of the counters. Contains no identities.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatsSnapshot {
    pub uptime_seconds: u64,
    pub connections: u64,
    pub peak_connections: u64,
    pub active_rooms: u64,
    pub rooms_with_two_or_more: u64,
    pub peak_active_rooms: u64,
    pub joins: u64,
    pub unique_today: u64,
    pub unique_yesterday: u64,
    pub unique_approximate: bool,
    pub frames_relayed: u64,
    pub bytes_relayed: u64,
}

pub struct ServerStats {
    started_unix_ms: u64,
    capacity: usize,
    connections: AtomicU64,
    peak_connections: AtomicU64,
    active_rooms: AtomicU64,
    rooms_with_two_or_more: AtomicU64,
    peak_active_rooms: AtomicU64,
    joins: AtomicU64,
    frames_relayed: AtomicU64,
    bytes_relayed: AtomicU64,
    daily: Mutex<Daily>,
}
impl std::fmt::Debug for ServerStats {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ServerStats(..)")
    }
}
impl ServerStats {
    /// `capacity` bounds the distinct sessions remembered per UTC day (>= 1).
    pub fn new(
        started_unix_ms: u64,
        capacity: usize,
        mut salt_source: SaltSource,
    ) -> Result<Self, ConfigError> {
        if capacity == 0 {
            return Err(ConfigError("Stats uniqueness capacity must be positive".into()));
        }
        let salt = salt_source()
            .ok_or_else(|| ConfigError("Stats salt source is unavailable".into()))?;
        Ok(Self {
            started_unix_ms,
            capacity,
            connections: AtomicU64::new(0),
            peak_connections: AtomicU64::new(0),
            active_rooms: AtomicU64::new(0),
            rooms_with_two_or_more: AtomicU64::new(0),
            peak_active_rooms: AtomicU64::new(0),
            joins: AtomicU64::new(0),
            frames_relayed: AtomicU64::new(0),
            bytes_relayed: AtomicU64::new(0),
            daily: Mutex::new(Daily {
                day: started_unix_ms / DAY_MS,
                salt,
                today: HashSet::new(),
                today_approximate: false,
                yesterday: 0,
                yesterday_approximate: false,
                salt_source,
            }),
        })
    }
    fn daily(&self) -> std::sync::MutexGuard<'_, Daily> {
        // Counters stay meaningful after a panic elsewhere; never propagate poison.
        self.daily.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    /// Publishes the participant count; the peak never decreases.
    pub fn set_connections(&self, current: usize) {
        let current = current as u64;
        self.connections.store(current, Relaxed);
        self.peak_connections.fetch_max(current, Relaxed);
    }
    /// Publishes room activity; the active-room peak never decreases.
    pub fn set_rooms(&self, active: usize, with_two_or_more: usize) {
        let active = active as u64;
        self.active_rooms.store(active, Relaxed);
        self.rooms_with_two_or_more.store(with_two_or_more as u64, Relaxed);
        self.peak_active_rooms.fetch_max(active, Relaxed);
    }
    /// One accepted room join. The client ID is reduced to a salted digest
    /// immediately and admitted only while the daily set has capacity.
    pub fn joined(&self, client_id: &str, now_unix_ms: u64) {
        self.joins.fetch_add(1, Relaxed);
        let mut daily = self.daily();
        daily.roll(now_unix_ms / DAY_MS);
        let mut mac = hmac(&daily.salt);
        mac.update(b"BottleShip LAN stats session v1.");
        mac.update(client_id.as_bytes());
        let mut key = [0u8; 16];
        for (slot, byte) in key.iter_mut().zip(mac.finalize().into_bytes().iter()) {
            *slot = *byte;
        }
        if daily.today.contains(&key) {
            return;
        }
        // Budget before insertion: a full set stops growing and reports a lower bound.
        if daily.today.len() >= self.capacity {
            daily.today_approximate = true;
            return;
        }
        daily.today.insert(key);
    }
    /// One room frame accepted for delivery to one recipient.
    pub fn relayed(&self, bytes: usize) {
        self.frames_relayed.fetch_add(1, Relaxed);
        self.bytes_relayed.fetch_add(bytes as u64, Relaxed);
    }
    pub fn snapshot(&self, now_unix_ms: u64) -> StatsSnapshot {
        let (unique_today, unique_yesterday, unique_approximate) = {
            let mut daily = self.daily();
            daily.roll(now_unix_ms / DAY_MS);
            (
                daily.today.len() as u64,
                daily.yesterday,
                daily.today_approximate || daily.yesterday_approximate,
            )
        };
        StatsSnapshot {
            uptime_seconds: now_unix_ms.saturating_sub(self.started_unix_ms) / 1000,
            connections: self.connections.load(Relaxed),
            peak_connections: self.peak_connections.load(Relaxed),
            active_rooms: self.active_rooms.load(Relaxed),
            rooms_with_two_or_more: self.rooms_with_two_or_more.load(Relaxed),
            peak_active_rooms: self.peak_active_rooms.load(Relaxed),
            joins: self.joins.load(Relaxed),
            unique_today,
            unique_yesterday,
            unique_approximate,
            frames_relayed: self.frames_relayed.load(Relaxed),
            bytes_relayed: self.bytes_relayed.load(Relaxed),
        }
    }
    /// The JSON body of GET /stats; field names match the TS reference.
    pub fn render(
        &self,
        now_unix_ms: u64,
        max_connections: usize,
        max_rooms: usize,
        version: &str,
    ) -> Vec<u8> {
        let s = self.snapshot(now_unix_ms);
        let body = serde_json::json!({
            "uptimeSeconds": s.uptime_seconds,
            "connections": {"current": s.connections, "peak": s.peak_connections},
            "rooms": {"active": s.active_rooms, "withTwoOrMore": s.rooms_with_two_or_more, "peakActive": s.peak_active_rooms},
            "joins": {"total": s.joins},
            "uniqueSessions": {"today": s.unique_today, "yesterday": s.unique_yesterday, "approximate": s.unique_approximate},
            "traffic": {"framesRelayed": s.frames_relayed, "bytesRelayed": s.bytes_relayed},
            "limits": {"maxConnections": max_connections, "maxRooms": max_rooms},
            "version": version,
        });
        serde_json::to_vec(&body).unwrap_or_default()
    }
}
