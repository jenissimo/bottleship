# Peer role of the UDP pair: speaks first after the gate, then waits for the ack.
wsastartup 0x202
p = socket AF_INET SOCK_DGRAM 0
bind p 127.0.0.1:23912
gate meet
sendto p 127.0.0.1:23911 "ping"
recvfrom p 16
closesocket p
wsacleanup
