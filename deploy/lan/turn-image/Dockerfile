# The upstream binary carries a low-port file capability. Remove it so the
# high-port service can run with an empty container capability bounding set.
FROM coturn/coturn:4.19.1-r0@sha256:81f69dc7cb672eb73ab3414afbb199637c37ab8069919d1c6caaed96ff16fb88
USER root
RUN turnserver="$(command -v turnserver)" \
    && cp "$turnserver" "$turnserver.no-capabilities" \
    && chmod 0755 "$turnserver.no-capabilities" \
    && mv -f "$turnserver.no-capabilities" "$turnserver"
USER 65534:65534
