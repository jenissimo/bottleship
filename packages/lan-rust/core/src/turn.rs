//! coturn REST credentials for admitted voice memberships.
use crate::config::ConfigError;
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use std::net::Ipv6Addr;

const URLS: &str = "BS_LAN_TURN_URLS";
const SECRET: &str = "BS_LAN_TURN_SECRET";
const TTL: &str = "BS_LAN_TURN_TTL_SECONDS";
const ALLOW_PUBLIC: &str = "BS_LAN_TURN_ALLOW_PUBLIC";

pub struct TurnConfig {
    urls: Vec<String>,
    secret: String,
    ttl_seconds: u64,
    allow_public: bool,
}

impl TurnConfig {
    pub fn from_environment() -> Result<Option<Self>, ConfigError> {
        fn read(name: &str) -> Result<Option<String>, ConfigError> {
            match std::env::var(name) {
                Ok(value) => Ok(Some(value)),
                Err(std::env::VarError::NotPresent) => Ok(None),
                Err(std::env::VarError::NotUnicode(_)) => {
                    Err(ConfigError(format!("{name} must be valid UTF-8")))
                }
            }
        }
        Self::parse(read(URLS)?, read(SECRET)?, read(TTL)?, read(ALLOW_PUBLIC)?)
    }

    fn parse(
        urls: Option<String>,
        secret: Option<String>,
        ttl: Option<String>,
        allow_public: Option<String>,
    ) -> Result<Option<Self>, ConfigError> {
        if urls.is_none() && secret.is_none() && ttl.is_none() && allow_public.is_none() {
            return Ok(None);
        }
        let mut validated_urls = Vec::new();
        if let Some(urls) = urls {
            for url in urls.split(',').map(|s| s.trim_matches([' ', '\t'])) {
                if validated_urls.len() == 4
                    || !valid_url(url)
                    || validated_urls.iter().any(|prior| prior == url)
                {
                    return Err(ConfigError(
                        "BS_LAN_TURN_URLS must contain 1–4 distinct TURN URLs".into(),
                    ));
                }
                validated_urls.push(url.to_owned());
            }
        }
        if validated_urls.is_empty() {
            return Err(ConfigError(
                "BS_LAN_TURN_URLS must contain 1–4 distinct TURN URLs".into(),
            ));
        }
        let secret = secret
            .filter(|s| (32..=512).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_graphic()))
            .ok_or_else(|| {
                ConfigError(
                    "BS_LAN_TURN_SECRET must contain 32–512 visible ASCII characters".into(),
                )
            })?;
        let ttl_seconds = match ttl {
            Some(value) => value
                .bytes()
                .all(|b| b.is_ascii_digit())
                .then(|| value.parse::<u64>().ok())
                .flatten()
                .filter(|seconds| (60..=86400).contains(seconds))
                .ok_or_else(|| {
                    ConfigError(
                        "BS_LAN_TURN_TTL_SECONDS must be an integer from 60 through 86400".into(),
                    )
                })?,
            None => 3600,
        };
        let allow_public = match allow_public.as_deref() {
            None | Some("false") => false,
            Some("true") => true,
            _ => {
                return Err(ConfigError(
                    "BS_LAN_TURN_ALLOW_PUBLIC must be true or false".into(),
                ));
            }
        };
        Ok(Some(Self {
            urls: validated_urls,
            secret,
            ttl_seconds,
            allow_public,
        }))
    }
}

fn valid_url(url: &str) -> bool {
    if url.len() > 320 {
        return false;
    }
    let Some((scheme, target)) = url.split_once(':') else {
        return false;
    };
    if !matches!(scheme, "turn" | "turns") {
        return false;
    }
    let authority = match target.split_once('?') {
        None => target,
        Some((authority, "transport=tcp")) => authority,
        Some((authority, "transport=udp")) if scheme == "turn" => authority,
        _ => return false,
    };
    let (host_ok, port) = if let Some(address) = authority.strip_prefix('[') {
        let Some((ip, suffix)) = address.split_once(']') else {
            return false;
        };
        let port = if suffix.is_empty() {
            None
        } else if let Some(port) = suffix.strip_prefix(':') {
            Some(port)
        } else {
            return false;
        };
        (ip.parse::<Ipv6Addr>().is_ok(), port)
    } else {
        let (host, port) = authority
            .split_once(':')
            .map_or((authority, None), |(h, p)| (h, Some(p)));
        let host_ok = host.len() <= 253
            && host
                .strip_suffix('.')
                .unwrap_or(host)
                .split('.')
                .all(|label| {
                    let bytes = label.as_bytes();
                    (1..=63).contains(&bytes.len())
                        && bytes[0].is_ascii_alphanumeric()
                        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
                        && bytes
                            .iter()
                            .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
                });
        (host_ok, port)
    };
    host_ok
        && port.is_none_or(|p| {
            p.len() <= 5
                && p.bytes().all(|b| b.is_ascii_digit())
                && p.parse::<u16>().is_ok_and(|n| n != 0)
        })
}

pub(crate) struct TurnIssuer {
    config: TurnConfig,
    subject_namespace: String,
}

pub(crate) struct TurnTicket {
    username: String,
    credential: String,
    expires_at: u64,
}

impl TurnIssuer {
    pub(crate) fn new(config: TurnConfig, subject_namespace: [u8; 16]) -> Self {
        Self {
            config,
            subject_namespace: URL_SAFE_NO_PAD.encode(subject_namespace),
        }
    }

    pub(crate) fn refresh(
        &self,
        now: u64,
        invite_expires_at: Option<u64>,
        voice_id: &str,
        ticket: &mut Option<TurnTicket>,
    ) {
        if invite_expires_at.is_none() && !self.config.allow_public {
            return;
        }
        let cutoff = (now / 1000)
            .saturating_add(self.config.ttl_seconds)
            .min(invite_expires_at.unwrap_or(u64::MAX) / 1000);
        let expires_at = cutoff * 1000;
        if expires_at <= now {
            *ticket = None;
            return;
        }
        let refresh_lead = (self.config.ttl_seconds * 250).min(60_000);
        if ticket.as_ref().is_some_and(|prior| {
            prior.expires_at.saturating_sub(now) > refresh_lead || expires_at <= prior.expires_at
        }) {
            return;
        }
        let username = format!("{cutoff}:{}-{voice_id}", self.subject_namespace);
        let mut mac = <Hmac<sha1::Sha1> as KeyInit>::new_from_slice(self.config.secret.as_bytes())
            .expect("HMAC accepts keys of any length");
        mac.update(username.as_bytes());
        let credential = STANDARD.encode(mac.finalize().into_bytes());
        *ticket = Some(TurnTicket {
            username,
            credential,
            expires_at,
        });
    }

    pub(crate) fn payload(&self, ticket: &TurnTicket, now: u64) -> Option<Value> {
        (ticket.expires_at > now).then(|| {
            json!({"urls":self.config.urls,"username":ticket.username,
                "credential":ticket.credential,"expiresAt":ticket.expires_at})
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_URLS: &str =
        "turn:[::1]:3478?transport=udp, turns:turn.example.test:5349?transport=tcp";
    const FIXTURE_SECRET: &str = "fixture-turn-secret-only-for-local-tests";
    const NOW: u64 = 2_000_000_000_000;

    fn config(allow_public: Option<&str>) -> TurnConfig {
        TurnConfig::parse(
            Some(FIXTURE_URLS.into()),
            Some(FIXTURE_SECRET.into()),
            Some("60".into()),
            allow_public.map(str::to_owned),
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn validates_operator_input_without_disclosing_values() {
        assert!(TurnConfig::parse(None, None, None, None).unwrap().is_none());
        let bad_url = "turn:fixture-url-user:fixture-url-password@turn.example.test";
        let bad_secret = "short-fixture-key";
        let invalid = [
            (bad_url, FIXTURE_SECRET, "60", "true", URLS, bad_url),
            (FIXTURE_URLS, bad_secret, "60", "true", SECRET, bad_secret),
            (FIXTURE_URLS, FIXTURE_SECRET, "59", "true", TTL, "59"),
            (
                FIXTURE_URLS,
                FIXTURE_SECRET,
                "60",
                "yes",
                ALLOW_PUBLIC,
                "yes",
            ),
        ];
        for (urls, key, ttl, allow_public, field, value) in invalid {
            let error = TurnConfig::parse(
                Some(urls.into()),
                Some(key.into()),
                Some(ttl.into()),
                Some(allow_public.into()),
            )
            .err()
            .expect("invalid TURN config must fail startup")
            .to_string();
            assert!(error.contains(field));
            assert!(!error.contains(value));
        }
        assert!(!valid_url("turn:turn.example.test:0"));
        assert!(!valid_url("turns:turn.example.test?transport=udp"));
        assert!(!valid_url("turn:[invalid]"));
        assert!(valid_url("turns:turn.example.test"));
        assert_eq!(config(None).urls.len(), 2);
    }

    #[test]
    fn signs_and_renews_before_expiry_with_stable_subject() {
        let issuer = TurnIssuer::new(config(None), [0; 16]);
        let mut ticket = None;
        issuer.refresh(NOW, None, "23", &mut ticket);
        assert!(ticket.is_none());
        issuer.refresh(NOW, Some(NOW + 180_000), "23", &mut ticket);
        let first = issuer.payload(ticket.as_ref().unwrap(), NOW).unwrap();
        assert_eq!(first["username"], "2000000060:AAAAAAAAAAAAAAAAAAAAAA-23");
        assert_eq!(first["credential"], "zXAyTuC5Y40L2uaDJ1hkzlrh5lQ=");
        assert_eq!(first["expiresAt"], NOW + 60_000);
        issuer.refresh(NOW + 40_000, Some(NOW + 180_000), "23", &mut ticket);
        assert_eq!(
            issuer.payload(ticket.as_ref().unwrap(), NOW + 40_000),
            Some(first)
        );
        issuer.refresh(NOW + 45_000, Some(NOW + 180_000), "23", &mut ticket);
        let refreshed = issuer
            .payload(ticket.as_ref().unwrap(), NOW + 45_000)
            .unwrap();
        assert_eq!(
            refreshed["username"],
            "2000000105:AAAAAAAAAAAAAAAAAAAAAA-23"
        );
        assert_eq!(refreshed["expiresAt"], NOW + 105_000);

        let public = TurnIssuer::new(config(Some("true")), [1; 16]);
        let mut anonymous = None;
        public.refresh(NOW, None, "23", &mut anonymous);
        let anonymous = public.payload(anonymous.as_ref().unwrap(), NOW).unwrap();
        assert_eq!(anonymous["expiresAt"], NOW + 60_000);
        assert_ne!(
            anonymous["username"],
            "2000000060:AAAAAAAAAAAAAAAAAAAAAA-23"
        );
    }

    #[test]
    fn signed_invite_is_the_hard_ticket_cutoff() {
        let issuer = TurnIssuer::new(config(None), [0; 16]);
        let expiry = NOW + 45_000;
        let mut ticket = None;
        issuer.refresh(NOW + 500, Some(expiry), "23", &mut ticket);
        assert_eq!(ticket.as_ref().unwrap().expires_at, expiry);
        issuer.refresh(expiry - 1, Some(expiry), "23", &mut ticket);
        assert_eq!(ticket.as_ref().unwrap().expires_at, expiry);
        assert!(issuer.payload(ticket.as_ref().unwrap(), expiry).is_none());
        issuer.refresh(expiry, Some(expiry), "23", &mut ticket);
        assert!(ticket.is_none());
    }
}
