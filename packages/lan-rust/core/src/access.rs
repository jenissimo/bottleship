//! Room admission and capability invitations. Keys are supplied by the caller, never serialized.
use crate::config::{ConfigError, GatewayConfig};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    Public,
    #[default]
    Private,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct GatewayPermissions {
    pub routes: Vec<String>,
    pub udp_listeners: Vec<String>,
    pub tcp_listeners: Vec<String>,
}
pub fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
impl GatewayPermissions {
    pub fn validate(&self) -> Result<(), ConfigError> {
        for (list, max) in [
            (&self.routes, 128),
            (&self.udp_listeners, 32),
            (&self.tcp_listeners, 32),
        ] {
            if list.len() > max
                || list.iter().any(|s| !valid_name(s))
                || list.iter().collect::<HashSet<_>>().len() != list.len()
            {
                return Err(ConfigError("Invalid gateway permissions".into()));
            }
        }
        Ok(())
    }
    fn merge(&self, other: &Self) -> Self {
        fn union(a: &[String], b: &[String]) -> Vec<String> {
            let mut result = a.to_vec();
            for v in b {
                if !result.contains(v) {
                    result.push(v.clone());
                }
            }
            result
        }
        Self {
            routes: union(&self.routes, &other.routes),
            udp_listeners: union(&self.udp_listeners, &other.udp_listeners),
            tcp_listeners: union(&self.tcp_listeners, &other.tcp_listeners),
        }
    }
    pub fn for_gateway(config: &GatewayConfig) -> Self {
        Self {
            routes: config
                .routes
                .iter()
                .enumerate()
                .map(|(i, r)| r.id.clone().unwrap_or_else(|| format!("route-{i}")))
                .collect(),
            udp_listeners: config.udp_listeners.iter().map(|l| l.id.clone()).collect(),
            tcp_listeners: config.tcp_listeners.iter().map(|l| l.id.clone()).collect(),
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct RoomPolicy {
    pub visibility: Option<Visibility>,
    pub gateway: GatewayPermissions,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct RoomAccessConfig {
    pub default_visibility: Visibility,
    pub default_gateway: GatewayPermissions,
    pub rooms: BTreeMap<String, RoomPolicy>,
    pub invite_key_env: String,
    pub audience: String,
    pub max_invite_ttl_seconds: u64,
}
impl Default for RoomAccessConfig {
    fn default() -> Self {
        Self {
            default_visibility: Visibility::Private,
            default_gateway: GatewayPermissions::default(),
            rooms: BTreeMap::new(),
            invite_key_env: "BOTTLESHIP_LAN_INVITE_KEY".into(),
            audience: "bottleship-lan".into(),
            max_invite_ttl_seconds: 86400,
        }
    }
}
impl RoomAccessConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        self.default_gateway.validate()?;
        let env = self.invite_key_env.as_bytes();
        if env.is_empty()
            || env.len() > 128
            || !(env[0].is_ascii_alphabetic() || env[0] == b'_')
            || !env.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
            || self.audience.is_empty()
            || self.audience.len() > 128
            || !self
                .audience
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
            || !(1..=604800).contains(&self.max_invite_ttl_seconds)
            || self.rooms.len() > 1024
        {
            return Err(ConfigError("Invalid room access configuration".into()));
        }
        for (room, policy) in &self.rooms {
            if !valid_name(room) {
                return Err(ConfigError("Invalid room policy".into()));
            }
            policy.gateway.validate()?;
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InviteClaims {
    pub version: u8,
    pub audience: String,
    pub room: String,
    pub expires_at: u64,
    pub gateway: GatewayPermissions,
}
pub struct Admission {
    pub gateway: GatewayPermissions,
    pub expires_at: Option<u64>,
}
pub struct AccessPolicy {
    config: RoomAccessConfig,
    key: Option<Vec<u8>>,
}
fn denied() -> ConfigError {
    ConfigError("LAN access denied".into())
}
impl AccessPolicy {
    pub fn new(config: RoomAccessConfig, key: Option<Vec<u8>>) -> Result<Self, ConfigError> {
        config.validate()?;
        if key.as_ref().is_some_and(|k| !(32..=64).contains(&k.len())) {
            return Err(ConfigError(
                "Invite key must contain 32..64 random bytes".into(),
            ));
        }
        if (config.default_visibility == Visibility::Private
            || config
                .rooms
                .values()
                .any(|p| p.visibility.unwrap_or(config.default_visibility) == Visibility::Private))
            && key.is_none()
        {
            return Err(ConfigError("Private rooms require a base64 invite key in inviteKeyEnv (default BOTTLESHIP_LAN_INVITE_KEY); pass --public-rooms or set roomAccess.defaultVisibility to \"public\" for name-only rooms".into()));
        }
        Ok(Self { config, key })
    }
    pub fn from_environment(config: RoomAccessConfig) -> Result<Self, ConfigError> {
        config.validate()?;
        let key = match std::env::var(&config.invite_key_env) {
            Ok(s) => {
                let key = STANDARD
                    .decode(&s)
                    .map_err(|_| ConfigError("Invite key must be canonical base64".into()))?;
                if STANDARD.encode(&key) != s {
                    return Err(ConfigError("Invite key must be canonical base64".into()));
                }
                Some(key)
            }
            Err(std::env::VarError::NotPresent) => None,
            Err(_) => {
                return Err(ConfigError(
                    "Invite key environment value is invalid".into(),
                ));
            }
        };
        Self::new(config, key)
    }
    pub fn sign(
        &self,
        room: &str,
        expires_at: u64,
        gateway: GatewayPermissions,
        now: u64,
    ) -> Result<String, ConfigError> {
        let key = self
            .key
            .as_ref()
            .ok_or_else(|| ConfigError("Signing an invitation requires the invite key".into()))?;
        gateway.validate()?;
        if !valid_name(room) {
            return Err(ConfigError("Invitation room must use 1-64 letters, digits, '_' or '-'".into()));
        }
        if expires_at > 9007199254740991
            || expires_at <= now
            || expires_at - now > self.config.max_invite_ttl_seconds
        {
            return Err(ConfigError(format!(
                "Invitation TTL must be 1..{} seconds (maxInviteTtlSeconds)",
                self.config.max_invite_ttl_seconds
            )));
        }
        let claims = InviteClaims {
            version: 1,
            audience: self.config.audience.clone(),
            room: room.into(),
            expires_at,
            gateway,
        };
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|_| denied())?);
        if body.len() > 3500 {
            return Err(denied());
        }
        let mut mac = <Hmac<sha2::Sha256> as KeyInit>::new_from_slice(key).map_err(|_| denied())?;
        mac.update(b"BottleShip LAN invite v1.");
        mac.update(body.as_bytes());
        Ok(format!(
            "bs1.{body}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ))
    }
    pub fn authorize(
        &self,
        room: &str,
        invite: Option<&serde_json::Value>,
        now: u64,
    ) -> Result<Admission, ConfigError> {
        let policy = self.config.rooms.get(room);
        let visibility = policy
            .and_then(|p| p.visibility)
            .unwrap_or(self.config.default_visibility);
        let gateway = policy
            .map(|p| &p.gateway)
            .unwrap_or(&self.config.default_gateway);
        if invite.is_none() && visibility == Visibility::Public {
            return Ok(Admission {
                gateway: gateway.clone(),
                expires_at: None,
            });
        }
        let value = invite
            .and_then(serde_json::Value::as_str)
            .ok_or_else(denied)?;
        if value.len() > 4096 {
            return Err(denied());
        }
        let parts: Vec<_> = value.split('.').collect();
        if parts.len() != 3 || parts[0] != "bs1" || parts[1].len() > 3500 {
            return Err(denied());
        }
        let key = self.key.as_ref().ok_or_else(denied)?;
        let signature = URL_SAFE_NO_PAD.decode(parts[2]).map_err(|_| denied())?;
        if signature.len() != 32 || URL_SAFE_NO_PAD.encode(&signature) != parts[2] {
            return Err(denied());
        }
        let mut mac = <Hmac<sha2::Sha256> as KeyInit>::new_from_slice(key).map_err(|_| denied())?;
        mac.update(b"BottleShip LAN invite v1.");
        mac.update(parts[1].as_bytes());
        mac.verify_slice(&signature).map_err(|_| denied())?;
        let payload = URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| denied())?;
        let claims: InviteClaims = serde_json::from_slice(&payload).map_err(|_| denied())?;
        claims.gateway.validate().map_err(|_| denied())?;
        if claims.version != 1
            || claims.audience != self.config.audience
            || claims.room != room
            || claims.expires_at > 9007199254740991
            || claims.expires_at <= now
            || claims.expires_at - now > self.config.max_invite_ttl_seconds
            || URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|_| denied())?)
                != parts[1]
        {
            return Err(denied());
        }
        Ok(Admission {
            gateway: gateway.merge(&claims.gateway),
            expires_at: Some(claims.expires_at),
        })
    }
}
