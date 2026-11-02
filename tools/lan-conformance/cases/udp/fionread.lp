# FIONREAD counts queued datagram bytes before and after receives,
# including the datagram-partial-read discard. Migrated from the
# winsock FIONREAD fixture.
wsastartup 0x202
x = socket AF_INET SOCK_DGRAM 0
bind x 127.0.0.1:0
ioctlsocket x FIONBIO u32:1
y = socket AF_INET SOCK_DGRAM 0
bind y 127.0.0.1:0
connect y x.addr
ioctlsocket x FIONREAD
send y "hello"
sleep 200
ioctlsocket x FIONREAD
recvfrom x 64
ioctlsocket x FIONREAD
sendto y x.addr "abcdef"
sleep 200
ioctlsocket x FIONREAD
recvfrom x 3
ioctlsocket x FIONREAD
recvfrom x 64
wsacleanup
