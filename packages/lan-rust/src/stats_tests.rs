use super::*;
use bottleship_lan_core::wire::Datagram;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "stats-test-token-0123456789";

fn public_config() -> ServerConfig {
    ServerConfig {
        port: 0,
        room_access: bottleship_lan_core::access::RoomAccessConfig {
            default_visibility: bottleship_lan_core::access::Visibility::Public,
            ..Default::default()
        },
        ..Default::default()
    }
}
async fn http(address: SocketAddr, method: &str, path: &str, headers: &str, body: &str) -> (u16, String, String) {
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n{headers}Content-Type: text/plain\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(5), socket.read_to_end(&mut bytes)).await.unwrap().unwrap();
    let all = String::from_utf8(bytes).unwrap();
    let (head, body) = all.split_once("\r\n\r\n").unwrap();
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, head.to_ascii_lowercase(), body.to_owned())
}
async fn stats(address: SocketAddr) -> Value {
    let (status, _, body) = http(address, "GET", "/stats", &format!("Authorization: Bearer {TOKEN}\r\n"), "").await;
    assert_eq!(status, 200);
    serde_json::from_str(&body).unwrap()
}
/// Polls /stats until `ready` holds; the core lane applies joins asynchronously.
async fn stats_until(address: SocketAddr, ready: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let value = stats(address).await;
        if ready(&value) {
            return value;
        }
        assert!(Instant::now() < deadline, "stats did not converge: {value}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}
/// A polling participant: open, authenticate and drain the connect ACK.
async fn join(address: SocketAddr, room: &str, host: u8, client: &str) -> String {
    let (status, _, open) = http(address, "GET", "/socket.io/?EIO=4&transport=polling", "", "").await;
    assert_eq!(status, 200);
    let open: Value = serde_json::from_str(&open[1..]).unwrap();
    let path = format!("/socket.io/?EIO=4&transport=polling&sid={}", open["sid"].as_str().unwrap());
    let auth = json!({"version":1,"room":room,"clientId":client,"node":[2,0,0,0,0,host]});
    assert_eq!(http(address, "POST", &path, "", &format!("40{auth}")).await.0, 200);
    let (status, _, ack) = http(address, "GET", &path, "", "").await;
    assert_eq!(status, 200);
    assert!(ack.split('\u{1e}').any(|p| p.starts_with("40{")), "{ack}");
    path
}

#[tokio::test]
async fn stats_endpoint_is_absent_without_the_environment_variable() {
    let mut config = public_config();
    config.stats_token_env = "BOTTLESHIP_LAN_STATS_TOKEN_UNSET_IN_SERVER_TESTS".into();
    let server = LanServer::bind(config).await.unwrap();
    let (status, _, _) = http(server.address, "GET", "/stats", &format!("Authorization: Bearer {TOKEN}\r\n"), "").await;
    assert_eq!(status, 404);
    assert_eq!(http(server.address, "GET", "/health", "", "").await.0, 200);
    server.shutdown().await.unwrap();
}

#[tokio::test]
async fn stats_requires_the_bearer_token_and_reports_aggregates_only() {
    let token = StatsToken::from_value(Some(TOKEN)).unwrap();
    let server = LanServer::bind_configured(public_config(), resolve_sync, token).await.unwrap();
    let address = server.address;
    for headers in ["", "Authorization: Bearer wrong-token-0123456789\r\n", "Authorization: Basic c3RhdHM=\r\n"] {
        let (status, head, body) = http(address, "GET", "/stats", headers, "").await;
        assert_eq!(status, 401, "{headers}");
        assert!(body.is_empty() && head.contains("cache-control: no-store"));
    }
    let (status, head, _) = http(address, "GET", "/stats", &format!("Origin: https://site.example\r\nAuthorization: Bearer {TOKEN}\r\n"), "").await;
    assert_eq!(status, 200);
    assert!(head.contains("cache-control: no-store") && !head.contains("access-control-"));

    let initial = stats(address).await;
    assert_eq!(initial["connections"], json!({"current":0,"peak":0}));
    assert_eq!(initial["limits"], json!({"maxConnections":256,"maxRooms":128}));
    assert_eq!(initial["version"], env!("CARGO_PKG_VERSION"));

    let a = join(address, "secret-room", 1, "stats-client-aaaaaaaa").await;
    let _b = join(address, "secret-room", 2, "stats-client-bbbbbbbb").await;
    let joined = stats_until(address, |v| v["connections"]["current"] == 2).await;
    assert_eq!(joined["rooms"], json!({"active":1,"withTwoOrMore":1,"peakActive":1}));
    assert_eq!(joined["joins"], json!({"total":2}));
    assert_eq!(joined["uniqueSessions"], json!({"today":2,"yesterday":0,"approximate":false}));

    // One relayed UDP frame from a to b.
    let frame = Datagram { proto: 1, node: [2, 0, 0, 0, 0, 2], dst_port: 4000, src_port: 5000, payload: bytes::Bytes::from_static(b"hello") }
        .encode()
        .unwrap();
    let body = format!("451-[\"frame\",{{\"_placeholder\":true,\"num\":0}}]\u{1e}b{}", base64(&frame));
    assert_eq!(http(address, "POST", &a, "", &body).await.0, 200);
    let relayed = stats_until(address, |v| v["traffic"]["framesRelayed"] == 1).await;
    assert_eq!(relayed["traffic"]["bytesRelayed"], frame.len());

    // a leaves: current drops, peaks stay.
    assert_eq!(http(address, "POST", &a, "", "1").await.0, 200);
    let left = stats_until(address, |v| v["connections"]["current"] == 1).await;
    assert_eq!(left["connections"]["peak"], 2);
    assert_eq!(left["rooms"], json!({"active":1,"withTwoOrMore":0,"peakActive":1}));
    let text = left.to_string();
    assert!(!text.contains("secret-room") && !text.contains("stats-client"));
    let mut keys: Vec<_> = left.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["connections", "joins", "limits", "rooms", "traffic", "uniqueSessions", "uptimeSeconds", "version"]);
    server.shutdown().await.unwrap();
}
