# emu-skip live-worker delivery diverges only when an event mask is active
# WSA event model on UDP: FD_WRITE latches at selection (shared event wakes
# immediately); the datagram latches FD_READ on the second event, WSANetwork
# Events reports it, and the receive drains it.
wsastartup 0x202
e = wsaeventcreate
e2 = wsaeventcreate
x = socket AF_INET SOCK_DGRAM 0
bind x 127.0.0.1:0
wsaeventselect x e 0x1
wsaeventselect x e2 0x1
y = socket AF_INET SOCK_DGRAM 0
bind y 127.0.0.1:0
wsaeventselect y e 0x2
wsawait e t=300
sendto y x.addr "ev"
wsawait e2 t=5000
wsaenumnetevents x e2
recvfrom x 8
wsaenumnetevents x e2
wsaeventclose e
wsaeventclose e2
wsacleanup
