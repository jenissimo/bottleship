# SIO_UDP_CONNRESET: with the flag set, a datagram to a closed port surfaces
# WSAECONNRESET on the next receive; without it the ICMP error is swallowed.
# Migrated from the winsock-udp-connreset fixture (prepare/dead/live arms).
wsastartup 0x202
c = socket AF_INET SOCK_DGRAM 0
bind c 127.0.0.1:0
r = socket AF_INET SOCK_DGRAM 0
bind r 127.0.0.1:0
dead = udp_open_port
ioctlsocket c FIONBIO u32:1
# prime the pair with one exchange before closing it
sendto c dead.addr "w"
select t=500 r=dead
recvfrom dead 8
closesocket dead
ioctlsocket c FIONREAD
# reset disabled: the ICMP error is swallowed
wsaioctl c SIO_UDP_CONNRESET in=u8:0
sendto c dead.addr "x"
sleep 400
recvfrom c 8
# control: a live peer still receives
sendto c r.addr "B"
sleep 100
recvfrom r 8
# reset enabled: the next datagram to the dead port surfaces as an error
wsaioctl c SIO_UDP_CONNRESET in=u8:1
sendto c dead.addr "x"
sleep 400
recvfrom c 8
# the error state is consumed by that receive
recvfrom c 8
# and the socket still works afterwards
sendto c r.addr "C"
sleep 100
recvfrom r 8
wsacleanup
