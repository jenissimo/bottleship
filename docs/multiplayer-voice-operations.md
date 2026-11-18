# Operating BottleShip room voice

Browser microphones need a secure origin and explicit player permission. Voice
uses WebRTC with direct UDP where reachable. TURN forwards encrypted media when
the selected route needs a relay. The LAN HTTPS server carries room admission,
text chat, voice signaling and guest game traffic. Setting up TURN does not
change the guest transport. The client can use a separate STUN service to discover
direct routes through NAT.

A voice session can have up to six participants. The media connections form a
mesh. Each player can send one audio stream per other participant, and a fully
relayed room consumes bandwidth in both directions at the TURN server. Size the
service for concurrent voice participants and observe its egress under load.

## Set up a Linux TURN host

The [Compose overlay](../deploy/lan/docker-compose.turn.yml) adds coturn to the
existing [LAN relay deployment](../deploy/lan/README.md) on Linux. Run TURN on a
dedicated public IPv4 interface or host. A deployment can also use a separate
coturn host and set only the LAN service's TURN environment variables. The
Compose overlay uses Linux host networking so coturn can bind the selected
interface and own its media port range.

1. Point a DNS A record for a dedicated name, for example `turn.example.org`, at
   the public address. Use direct DNS resolution. An ordinary HTTP reverse proxy
   cannot forward TURN. Keep the HTTPS reverse proxy for the LAN service.
2. In `deploy/lan`, copy `turnserver.network.example.conf` to
   `turnserver.network.conf`. Set the `realm` to the TURN hostname and use the
   interface's local IPv4 for both `listening-ip` and `relay-ip`. On hosts behind
   one-to-one NAT, configure `external-ip=public-ip/local-ip` and forward relay
   ports without changing the port numbers. The network must support access to
   its own public relay address if both allocations are on the same NATed host.
3. On the firewall and any cloud security group, allow inbound UDP 3478, TCP
   5349, and UDP 49160–49415 to the TURN address. Allow the relay UDP range to
   reach ordinary public peers and return their packets. Block access from the
   TURN process to local networks, metadata services and other control-plane
   addresses at the host or network layer as well. The base config supplies
   IPv4 peer denies including loopback, link-local, private and multicast ranges.
   The example is IPv4-only. Add an explicit IPv6 relay and matching egress
   restrictions before advertising an AAAA record.
4. Obtain a browser-trusted TLS certificate for the TURN hostname. Set
   `BS_TURN_TLS_DIR` to an absolute directory containing `fullchain.pem` and
   `privkey.pem`. Export actual files from your certificate manager. The container
   maps that directory read-only and UID/GID 65534 must be able to read the
   certificate and key. Restrict access to the TLS private key.
5. Inject `BS_LAN_TURN_SECRET` through your deployment secret store into both
   the LAN server and coturn. Use a fresh 32-byte random value expressed as hex.
   The coturn entrypoint accepts 32–512 letters, digits, underscores or
   hyphens. Use the same exact string on both services. Do not put it in a
   tracked file, a client build, URLs or shell history. Treat resolved Compose
   configuration and container environment inspection as privileged data.
6. Set `BS_LAN_TURN_URLS=turn:turn.example.org:3478?transport=udp,turns:turn.example.org:5349?transport=tcp`
   for the LAN service. Quote the value if your shell interprets `?`. These are
   comma-separated browser-facing URLs. The second URL provides a TLS-over-TCP
   route for clients whose networks block UDP. The relay-to-peer leg still uses
   UDP. Keep both hosts synchronized by NTP for the time-limited credentials.

Run the overlay from `deploy/lan` once those settings are in place.

```sh
docker compose -f docker-compose.yml -f docker-compose.turn.yml up -d --build
```

## Admission and limits

- `BS_LAN_TURN_TTL_SECONDS` defaults to `3600`. The LAN server issues temporary
  HMAC credentials to admitted voice clients. An invitation may limit that
  lifetime. TURN and LAN share the REST secret while browsers receive only
  their own short-lived credentials. [Multiplayer access and security](multiplayer-security.md)
- `BS_LAN_TURN_ALLOW_PUBLIC` defaults to `false`. Keep this default when rooms
  are protected by invitations. Enabling it gives admitted users of public
  name-only rooms access to relay allocations. Budget for abuse and supervise
  allocation and egress limits if you opt in.
- The example caps each TURN user at 12 allocations and the instance at 240.
  It caps bandwidth at 128,000 bytes/s per allocation per direction and
  16,000,000 bytes/s per direction overall. Size those limits and the UDP port
  range together. Restrict access to the TURN logs since they can contain
  connection metadata. The LAN server remains behind its HTTPS proxy with its
  existing request and connection limits.

## Verify before announcing voice availability

1. From two independent networks, join the same room with a signed invitation
   and exchange text. Join voice and speak from each end. Check bidirectional audio, mute,
   leave, and another join. Inspect the room's connection indicator and
   `chrome://webrtc-internals` or equivalent when diagnosing the route.
2. Repeat with a client on a restrictive network and confirm a selected ICE
   candidate with type `relay` and increasing inbound audio RTP counters on
   both sides. Exercise TURN over UDP 3478 and TLS-over-TCP 5349 separately
   where possible. Check the browser's TLS trust and the server's allocation
   counters for each case. Where the restrictive network allows TLS only on
   TCP 443, a dedicated TURN address on TCP 443 is an additional deployment
   option. It needs a corresponding listener, permitted port binding, firewall
   rule and TURN URL.
3. Exercise a connection loss and recovery. Confirm that an intentionally
   muted microphone stays muted throughout. Confirm that text continues to
   work when a TURN service is unavailable and that public rooms lack TURN
   credentials under the default policy. Keep test credentials and
   candidate addresses out of public reports.

For a repeatable development check with a synthetic microphone, see the
[loopback smoke](../deploy/lan/README.md#local-turn-smoke). Use a real certificate,
route and firewall for the independent-network release check.

Renew the certificate through your certificate manager and restart coturn
to pick up the updated files. Rotate a leaked TURN secret on both services and
recreate both containers together. A TURN restart or secret rotation can drop
in-progress allocations. Track allocation errors, active sessions, network
egress and certificate expiry.

For rollback, stop coturn using the overlay while its settings are still
injected. Recreate the LAN container with the standard Compose file to clear
its TURN configuration. The LAN and direct voice paths operate without TURN.

```sh
docker compose -f docker-compose.yml -f docker-compose.turn.yml stop coturn
docker compose -f docker-compose.yml up -d --force-recreate bottleship-lan
```
