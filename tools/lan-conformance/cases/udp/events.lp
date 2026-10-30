# emu-skip FD_READ is not signaled under WSAEventSelect (generic fix pending in wsa-network)
# WSA event model: FD_READ/FD_WRITE signaling through WSAEventSelect and
# WSANetworkEvents for a UDP pair.
wsastartup 0x202
e = wsaeventcreate
x = socket AF_INET SOCK_DGRAM 0
bind x 127.0.0.1:0
wsaeventselect x e 0x1
y = socket AF_INET SOCK_DGRAM 0
bind y 127.0.0.1:0
wsaeventselect y e 0x2
wsawait e t=300
sendto y x.addr "ev"
wsawait e t=500
wsaenumnetevents x e
recvfrom x 8
wsaenumnetevents x e
wsaeventclose e
wsacleanup
