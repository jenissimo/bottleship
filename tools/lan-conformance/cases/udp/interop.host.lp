# Native-side interop role: waits on a REAL socket for the other role's
# datagram and confirms receipt through the coordinator. The golden is the
# same whether the peer is native or emulated.
wsastartup 0x202
h = socket AF_INET SOCK_DGRAM 0
bind h 0.0.0.0:23911
publishaddr h host
recv h 16
signal got-ping
closesocket h
wsacleanup
