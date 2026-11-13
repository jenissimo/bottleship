mod common;
use bottleship_lan_core::{config::*, routes::*, stats::*, *};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};
const DAY: u64 = 86_400_000;
fn auth(node: u8, room: &str, client: &str) -> Value {
    json!({"version":1,"room":room,"clientId":client,"node":[2,0,0,0,0,node]})
}
fn id(n: u32) -> String {
    format!("client-{n:012}")
}
fn counting_salt() -> SaltSource {
    let next = Arc::new(AtomicU8::new(1));
    Box::new(move || Some([next.fetch_add(1, Ordering::Relaxed); 32]))
}
fn stats(start: u64, capacity: usize) -> Arc<ServerStats> {
    Arc::new(ServerStats::new(start, capacity, counting_salt()).unwrap())
}
fn core(stats: &Arc<ServerStats>) -> Core {
    common::core(Limits::default(), Routes::new(GatewayConfig::default()).unwrap())
        .unwrap()
        .with_stats(stats.clone())
}
fn close(core: &mut Core, connection: u64, now_ms: u64) {
    core.apply(Command::Closed { connection, now_ms });
}

#[test]
fn token_requires_exact_bearer_and_hides_its_value() {
    assert!(StatsToken::from_value(None).unwrap().is_none());
    assert!(StatsToken::from_value(Some("")).unwrap().is_none());
    assert!(StatsToken::from_value(Some("short")).is_err());
    assert!(StatsToken::from_value(Some("has a space in the token")).is_err());
    let token = StatsToken::from_value(Some("0123456789abcdef-secret")).unwrap().unwrap();
    assert!(!format!("{token:?}").contains("secret"));
    assert!(token.verify(Some(b"Bearer 0123456789abcdef-secret")));
    assert!(token.verify(Some(b"bearer 0123456789abcdef-secret")));
    assert!(!token.verify(None));
    assert!(!token.verify(Some(b"")));
    assert!(!token.verify(Some(b"Bearer")));
    assert!(!token.verify(Some(b"Bearer ")));
    assert!(!token.verify(Some(b"Basic 0123456789abcdef-secret")));
    assert!(!token.verify(Some(b"Bearer0123456789abcdef-secret")));
    assert!(!token.verify(Some(b"Bearer 0123456789abcdef-secreT")));
    assert!(!token.verify(Some(b"Bearer 0123456789abcdef-secret-and-more")));
    assert!(!token.verify(Some(&[0xff; 64])));
    let missing = StatsToken::from_environment("BOTTLESHIP_LAN_STATS_TOKEN_UNSET_IN_TESTS").unwrap();
    assert!(missing.is_none());
}

#[test]
fn counters_follow_join_and_leave_and_peaks_never_decrease() {
    let s = stats(0, DEFAULT_UNIQUE_CAPACITY);
    let mut c = core(&s);
    let snap = s.snapshot(0);
    assert_eq!((snap.connections, snap.active_rooms, snap.joins), (0, 0, 0));

    c.join(1, &auth(1, "alpha", &id(1)), 0).unwrap();
    let snap = s.snapshot(0);
    assert_eq!((snap.connections, snap.peak_connections), (1, 1));
    assert_eq!((snap.active_rooms, snap.rooms_with_two_or_more, snap.peak_active_rooms), (1, 0, 1));

    c.join(2, &auth(2, "alpha", &id(2)), 0).unwrap();
    c.join(3, &auth(1, "beta", &id(3)), 0).unwrap();
    let snap = s.snapshot(0);
    assert_eq!((snap.connections, snap.peak_connections), (3, 3));
    assert_eq!((snap.active_rooms, snap.rooms_with_two_or_more, snap.peak_active_rooms), (2, 1, 2));
    assert_eq!((snap.joins, snap.unique_today), (3, 3));
    assert_eq!(c.room_activity(), (2, 1));

    // Reconnecting the same participant replaces its connection: no new room
    // liveness, one more join, the same session identity.
    c.join(4, &auth(1, "alpha", &id(1)), 1).unwrap();
    let snap = s.snapshot(1);
    assert_eq!((snap.connections, snap.active_rooms, snap.rooms_with_two_or_more), (3, 2, 1));
    assert_eq!((snap.joins, snap.unique_today), (4, 3));

    close(&mut c, 2, 2);
    let snap = s.snapshot(2);
    assert_eq!((snap.connections, snap.active_rooms, snap.rooms_with_two_or_more), (2, 2, 0));
    close(&mut c, 3, 3);
    close(&mut c, 4, 3);
    // A retired connection closing again changes nothing.
    close(&mut c, 1, 3);
    let snap = s.snapshot(3);
    assert_eq!((snap.connections, snap.active_rooms, snap.rooms_with_two_or_more), (0, 0, 0));
    assert_eq!((snap.peak_connections, snap.peak_active_rooms), (3, 2));
    assert_eq!(c.room_activity(), (0, 0));

    // A rejected join is not counted.
    c.join(5, &auth(1, "alpha", &id(9)), 4).unwrap_err();
    assert_eq!(s.snapshot(4).joins, 4);
}

#[test]
fn relay_counters_are_plain_totals() {
    let s = stats(0, 4);
    s.relayed(100);
    s.relayed(28);
    let snap = s.snapshot(0);
    assert_eq!((snap.frames_relayed, snap.bytes_relayed), (2, 128));
}

#[test]
fn utc_midnight_rotates_days_with_an_injected_clock() {
    let start = 20_000 * DAY + DAY - 10;
    let s = stats(start, DEFAULT_UNIQUE_CAPACITY);
    s.joined(&id(1), start);
    s.joined(&id(2), start + 1);
    s.joined(&id(1), start + 2);
    let snap = s.snapshot(start + 5);
    assert_eq!((snap.unique_today, snap.unique_yesterday, snap.joins), (2, 0, 3));
    // Midnight UTC: today becomes yesterday, and the same client counts again
    // under the new day's salt.
    let next = start + 10;
    let snap = s.snapshot(next);
    assert_eq!((snap.unique_today, snap.unique_yesterday), (0, 2));
    s.joined(&id(1), next + 1);
    assert_eq!(s.snapshot(next + 1).unique_today, 1);
    // A clock step backwards keeps the current day.
    assert_eq!(s.snapshot(start).unique_today, 1);
    // Skipping a whole day leaves no yesterday.
    let snap = s.snapshot(next + 2 * DAY);
    assert_eq!((snap.unique_today, snap.unique_yesterday), (0, 0));
    assert_eq!(snap.uptime_seconds, (10 + 2 * DAY) / 1000);
}

#[test]
fn salt_failure_at_midnight_keeps_counting() {
    let mut first = true;
    let source: SaltSource = Box::new(move || {
        let salt = first.then_some([7u8; 32]);
        first = false;
        salt
    });
    let s = ServerStats::new(0, 8, source).unwrap();
    s.joined(&id(1), DAY + 1);
    s.joined(&id(1), DAY + 2);
    s.joined(&id(2), DAY + 3);
    assert_eq!(s.snapshot(DAY + 4).unique_today, 2);
    assert!(ServerStats::new(0, 8, Box::new(|| None)).is_err());
    assert!(ServerStats::new(0, 0, counting_salt()).is_err());
}

#[test]
fn overflow_stops_growth_and_reports_approximate() {
    let s = stats(0, 3);
    for n in 0..10 {
        s.joined(&id(n), 0);
    }
    // Already-counted sessions still match while full.
    s.joined(&id(0), 0);
    let snap = s.snapshot(0);
    assert_eq!((snap.unique_today, snap.joins, snap.unique_approximate), (3, 11, true));
    // The flag follows the overflowing day into yesterday, then clears.
    let snap = s.snapshot(DAY);
    assert_eq!((snap.unique_today, snap.unique_yesterday, snap.unique_approximate), (0, 3, true));
    let snap = s.snapshot(2 * DAY);
    assert_eq!((snap.unique_yesterday, snap.unique_approximate), (0, false));
}

#[test]
fn rendered_schema_has_only_aggregates() {
    let s = stats(0, 8);
    let mut c = core(&s);
    c.join(1, &auth(1, "secret-room-name", &id(77)), 0).unwrap();
    let body = s.render(61_000, 256, 128, "0.1.0");
    let text = String::from_utf8(body).unwrap();
    assert!(!text.contains("secret-room-name") && !text.contains(&id(77)));
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        v,
        json!({
            "uptimeSeconds": 61,
            "connections": {"current": 1, "peak": 1},
            "rooms": {"active": 1, "withTwoOrMore": 0, "peakActive": 1},
            "joins": {"total": 1},
            "uniqueSessions": {"today": 1, "yesterday": 0, "approximate": false},
            "traffic": {"framesRelayed": 0, "bytesRelayed": 0},
            "limits": {"maxConnections": 256, "maxRooms": 128},
            "version": "0.1.0"
        })
    );
}
