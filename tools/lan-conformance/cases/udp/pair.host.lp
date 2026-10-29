# Two-role UDP pair over fixed rendezvous ports (host = 23911, peer = 23912).
# Blocking receives make the transcript deterministic without extra gates.
# emu-skip cross-tab roles need role-address publishing (guest loopback is per-process-local)
wsastartup 0x202
h = socket AF_INET SOCK_DGRAM 0
bind h 127.0.0.1:23911
gate meet
recvfrom h 16
sendto h 127.0.0.1:23912 "ack"
sleep 100
ioctlsocket h FIONREAD
closesocket h
wsacleanup
