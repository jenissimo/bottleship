# A datagram larger than the receive buffer is truncated to the buffer,
# WSAEMSGSIZE is left in LastError, and the remainder is lost.
wsastartup 0x202
x = socket AF_INET SOCK_DGRAM 0
bind x 127.0.0.1:0
ioctlsocket x FIONBIO u32:1
y = socket AF_INET SOCK_DGRAM 0
bind y 127.0.0.1:0
sendto y x.addr "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789"
sleep 200
ioctlsocket x FIONREAD
recvfrom x 10 peek
ioctlsocket x FIONREAD
recvfrom x 10
recvfrom x 64
ioctlsocket x FIONREAD
wsacleanup
