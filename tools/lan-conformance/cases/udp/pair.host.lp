# Two-role UDP pair: addresses are published through the role coordinator, so
# the transport works natively (real NIC) and across emulated tabs (virtual
# LAN), while the log stays symbolic (connect/recv take no address literal).
wsastartup 0x202
h = socket AF_INET SOCK_DGRAM 0
bind h 0.0.0.0:23911
publishaddr h host
peeraddr = waitaddr peer t=20000
connect h peeraddr
recv h 16
send h "ack"
ioctlsocket h FIONREAD
closesocket h
wsacleanup
