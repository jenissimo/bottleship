# Peer role: publishes its address, then pings the host and waits for the ack.
wsastartup 0x202
p = socket AF_INET SOCK_DGRAM 0
bind p 0.0.0.0:23912
publishaddr p peer
hostaddr = waitaddr host t=20000
connect p hostaddr
send p "ping"
recv p 16
closesocket p
wsacleanup
