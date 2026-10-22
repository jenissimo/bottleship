# Optional native socket backend

Build with a C11 compiler and platform socket headers:

```sh
bun run build:native
```

On Windows the default compiler is MSYS2 MinGW64. Set `BS_LAN_CC` to another C
compiler path; Unix uses `cc`. No third-party C libraries are required.
The Windows build uses Winsock; Unix uses POSIX sockets and pthreads.
Build products stay in the ignored `native/build` directory.

Configure `gateway.nativeHelperPath` with the absolute executable path. Only
configured gateway routes may start a helper. Each native TCP or raw flow owns one
helper process. A raw UDP tuple additionally owns a kernel UDP port reservation;
other flows own one socket. Scoped UDP targets also use the helper. The normal Node TCP backend remains available
without the helper; unsupported native urgent/inline operations return 10045.

The parent validates destinations and passes one of:

- `tcp host port inline`: stream, optional initial SO_OOBINLINE 0/1.
- `udp4 host port` or `udp6 host port`: connected UDP socket, including native IPv6 `%zone`.
- `raw4 host socketProtocol headerIncluded`: native IPv4 raw socket.
- `raw6 host socketProtocol headerIncluded`: native IPv6 raw socket.

The server exposes ICMPv4/ICMPv6 echo NAT and generic raw forwarding with an
exclusive native destination lease, plus UDP source-port NAT. UDP tuple flows
reserve real kernel ports and may coexist with foreign participants and ordinary
sockets. TCP and unknown raw protocols still conflict with foreign participant
flows with Winsock 10048 until a complete NAT or separate addresses provide
multiplexing.
Configured `rawMode: "exclusive"` also routes echo through the generic backend.
Raw receive source addresses and configured IP protocols are filtered explicitly. Native OS permissions are preserved, including 10013 for
denied raw sockets or HDRINCL. Per-packet TTL/TOS/HOPS/TCLASS use native socket
options. HDRINCL source and destination are rewritten to the actual connected
endpoint, keeping included guest headers within the configured route. Generic raw
address translation adjusts TCP/UDP/ICMPv6 pseudoheader checksums with RFC 1624,
preserving the checksum residual of intentionally malformed packets. UDP tuple
NAT uses the same incremental adjustment for source/destination ports, retains a
zero IPv4 UDP checksum and rejects foreign source ports or reserved destinations.
Its reservation socket consumes kernel UDP deliveries while the raw socket is
the packet data path, preventing port reuse and host port-unreachable errors.
Default outgoing raw TTL/hops is 128; explicit guest options override it. Native RAW6
wildcard protocols 0/255 and a differing HDRINCL next header return 10045: this
receive path provides no trustworthy next-header metadata.

Stdin/stdout records have a little-endian u32 kind, little-endian u32 payload
length, then payload. TCP DATA is segmented to 16,384 bytes; raw packet payloads
are at most 65,535 bytes. DATA commands additionally carry a four-byte write id.
Stdout contains only protocol records.

| Command | Kind | Payload |
| --- | --- | --- |
| DATA | 1 | write id u32 + bytes |
| MSG_OOB | 2 | write id u32 + one urgent byte |
| FIN | 3 | empty |
| Read credit | 4 | additional bytes u32 |
| Close | 5 | empty |
| IP options | 7 | TTL/hops int32 + TOS/class u32 |
| Raw guest addresses | 8 | family u32 (4 or 6) + source[16] + destination[16], IPv4 zero padded |
| Reserved UDP tuple | 9 | guest source port u32 + remote port u32; RAW protocol 17 only |
| TCP control | 11 | control id u32 + option u32 (0=OOBINLINE, 1=KEEPALIVE, 2=NODELAY) + enabled u32 (0 or 1) |

| Event | Kind | Payload |
| --- | --- | --- |
| Connected | 10 | empty |
| TCP DATA | 11 | bytes |
| MSG_OOB | 12 | one urgent byte |
| EOF | 13 | empty |
| Error | 14 | Winsock error u32 |
| Native write complete | 15 | write id u32 |
| Closed | 16 | empty |
| Raw/UDP datagram | 17 | complete packet |
| Reserved UDP tuple | 18 | guest source port u32 + remote port u32 + reserved native port u32 |
| Send shutdown complete | 19 | empty; all preceding writes accepted and native shutdown(SEND) succeeded |
| Initial native TCP option value | 20 | option u32 (1 or 2) + actual native getsockopt boolean u32 |
| TCP control applied | 21 | control id u32 + option u32 (0, 1 or 2) + actual native getsockopt boolean u32 |

Read credit and pending native write payloads are each bounded to 256 KiB.
TCP has an ordered lane for 256 DATA/OOB records and one reserved FIN, plus a
separate lane for 64 acknowledged controls. The stdin reader accepts receive
credit independently of a blocked native send. Controls apply before retrying
that send; they do not wait for earlier DATA to drain. Each control retains its
quota until event 21 reports the actual OS getsockopt result. Initial values use
event 20. Command kinds 6 and 10 are superseded by kind 11 for TCP; rebuild the
helper together with the TypeScript server when updating this private protocol.

Native sends preserve DATA/OOB/FIN ordering; write acknowledgements follow actual
OS send acceptance. A graceful binding release waits for event 19 before
destroying its helper, with a bounded drain deadline. POSIX read records preserve
the urgent mark. Windows urgent records use its separate MSG_OOB queue. Initial
and live SO_OOBINLINE use the native socket option, preserving native inline byte
order. KEEPALIVE and NODELAY default to false; the TCP helper accepts optional
initial boolean arguments after the inline flag. Initial options apply before
connect. Disconnect destroys the helper and socket.

The parent preflights the complete segmented write against its payload, record
and input-pipe budgets before accepting any segment. DATA/OOB after FIN is
rejected with WSAESHUTDOWN. Receive credit is debited before publishing a payload,
so an immediate credit return cannot overfill its window. TCP uses native socket
events and an input wake event/pipe; abortive close errors remain observable with
zero receive credit.

`tools/tests/lan-helper-pressure.test.ts` compiles and runs a finite loopback
peer. Its real OS socket tests fill both payload and record limits while the
peer withholds reads, verify live controls and reverse receive credit, reject a
segmented call without accepting a prefix, and check the final byte count and
hash before FIN. Another case aborts the peer with every receive token withheld.
Portable smoke covers urgent/inline delivery, send shutdown and credit-exhausted
reset on Windows/POSIX. The earlier unintegrated pressure draft is retained as
historical material, not conformance evidence.

RAW/UDP still use the separate legacy 64-entry FIFO; TCP control priority and its
event loop do not establish equivalent progress guarantees for that queue.

Exact urgent mark placement for Windows out-of-line reads remains a compatibility
gap: native MSG_PEEK skips a mark at the current read position and SIOCATMARK does
not expose the BSD stream position. Bounding ordinary reads by MSG_PEEK prevents
crossing a visible prefix, but cannot recover that ambiguous position in all
arrival orders. The phased echo oracle proves native inline ordering and separate
urgent delivery; it does not establish full out-of-line MSG_PEEK mark parity.

The build's `--tests` option creates a native UDP tuple oracle (actual kernel port
reservations, tuple isolation, checksum preservation and teardown/rebind), a
native checksum oracle (full IPv4/IPv6
pseudoheaders, address translation round trips and invalid checksum residuals)
and a native MSG_OOB echo oracle. It reads
exactly two prefix bytes, then the urgent byte, then the two suffix bytes; senders
write all three consecutively. This avoids Windows normal recv moving suffix
bytes ahead of the echoed urgent record. Windows
end-to-end tests cover this helper through both browser transports, including
400 KB streams, urgent records, inline toggles, ICMP echo isolation and native
permission failures. Native TCP urgent/inline smoke also passed on Ubuntu through
WSL using `cc -std=c11 -Wall -Wextra -Werror`.

The standalone native smoke accepts helper and oracle executable paths. It also
probes actual raw ICMP echo when allowed and verifies explicit 10013 denial when
host permissions reject creation or send; it never elevates privileges:

```sh
python3 native/smoke.py native/build/socket-helper native/build/test-peer
```
