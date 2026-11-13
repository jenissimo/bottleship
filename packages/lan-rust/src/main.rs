use bottleship_lan::{
    LanServer,
    config::{Origins, ServerConfig},
};
fn value(args: &[String], flag: &str) -> Result<Option<String>, String> {
    let Some(index) = args.iter().position(|arg| arg == flag) else {
        return Ok(None);
    };
    let Some(value) = args.get(index + 1).filter(|value| !value.starts_with("--")) else {
        return Err(format!("Missing value for {flag}"));
    };
    Ok(Some(value.clone()))
}
#[tokio::main(worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help") {
        println!(
            "bottleship-lan [--config server.json] [--host 127.0.0.1] [--port 9001] [--origin https://bottleship.example] [--public-rooms] [--invite ROOM --ttl 3600 --gateway-routes ID,ID --udp-listeners ID --tcp-listeners ID]"
        );
        return Ok(());
    }
    let mut config = if let Some(path) = value(&args, "--config")? {
        let bytes = std::fs::read(path)?;
        serde_json::from_slice::<ServerConfig>(&bytes)?
    } else {
        ServerConfig::default()
    };
    if let Some(host) = value(&args, "--host")? {
        config.host = host;
    }
    if let Some(port) = value(&args, "--port")? {
        config.port = port.parse()?;
    }
    if let Some(origin) = value(&args, "--origin")? {
        config.allowed_origins = if origin == "*" {
            Origins::Any(origin)
        } else {
            Origins::List(origin.split(',').map(str::to_owned).collect())
        };
    }
    if args.iter().any(|arg| arg == "--public-rooms") {
        config.room_access.default_visibility = bottleship_lan_core::access::Visibility::Public;
    }
    if let Some(room) = value(&args, "--invite")? {
        config.validate().map_err(std::io::Error::other)?;
        let ttl: u64 = value(&args, "--ttl")?.unwrap_or_else(|| "3600".into()).parse()?;
        let list = |flag: &str| -> Result<Vec<String>, String> {
            Ok(value(&args, flag)?.filter(|s| !s.is_empty()).map(|s|s.split(',').map(str::to_owned).collect()).unwrap_or_default())
        };
        let gateway = bottleship_lan_core::access::GatewayPermissions {
            routes:list("--gateway-routes")?, udp_listeners:list("--udp-listeners")?, tcp_listeners:list("--tcp-listeners")?,
        };
        let access = bottleship_lan_core::access::AccessPolicy::from_environment(config.room_access)?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
        println!("{}", access.sign(&room, now.checked_add(ttl).ok_or("Invalid invitation TTL")?, gateway, now)?);
        return Ok(());
    }
    let server = LanServer::bind(config).await?;
    println!(
        "bottleship-lan listening on http://{} (WebSocket + HTTP long-polling)",
        server.address
    );
    println!(
        "{}",
        serde_json::json!({"service":"bottleship-lan","address":server.address.to_string(),"port":server.address.port(),"version":1})
    );
    tokio::signal::ctrl_c().await?;
    server.shutdown().await
}
