use bottleship_lan_core::{
    Core,
    access::*,
    config::{ConfigError, Limits},
    routes::Routes,
};

pub fn core(limits: Limits, routes: Routes) -> Result<Core, ConfigError> {
    let access = AccessPolicy::new(
        RoomAccessConfig {
            default_visibility: Visibility::Public,
            default_gateway: GatewayPermissions::for_gateway(&routes.config),
            ..Default::default()
        },
        None,
    )?;
    Core::new(limits, routes, access, 0)
}
