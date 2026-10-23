use bottleship_lan_core::{config::*, routes::*};
#[test]
fn raw_default_matches_the_three_ts_raw_backends() {
    assert_eq!(GatewayConfig::default().max_raw_flows, 64);
}
#[test]
fn numeric_policy_aliases_are_canonical() {
    assert_eq!(
        NativeAddress::parse("0.0.0.0")
            .unwrap()
            .canonical_policy_key(),
        "127.0.0.1"
    );
    assert_eq!(
        NativeAddress::parse("::").unwrap().canonical_policy_key(),
        "::1"
    );
    assert_eq!(
        NativeAddress::parse("::ffff:127.0.0.1")
            .unwrap()
            .canonical_policy_key(),
        "127.0.0.1"
    );
}
#[test]
fn gateway_denies_missing_tcp_udp_ports_and_raw_protocols() {
    for routes in [
        serde_json::json!([{"host":"127.0.0.1","protocols":["udp"]}]),
        serde_json::json!([{"host":"127.0.0.1","protocols":["raw"]}]),
    ] {
        let cfg: GatewayConfig =
            serde_json::from_value(serde_json::json!({"routes":routes})).unwrap();
        assert!(cfg.validate().is_err());
    }
}
#[test]
fn pinned_dns_deduplicates_before_applying_32_address_cap() {
    let cfg: GatewayConfig = serde_json::from_value(
        serde_json::json!({"routes":[{"host":"dns.test","ports":[1],"protocols":["udp"]}]}),
    )
    .unwrap();
    let mut r = Routes::new(cfg).unwrap();
    let mut addresses = vec![NativeAddress::parse("127.0.0.1").unwrap(); 32];
    addresses.push(NativeAddress::parse("127.0.0.2").unwrap());
    r.pin(0, Ok(addresses)).unwrap();
    assert_eq!(r.advertised_ipv4().len(), 2);
}
