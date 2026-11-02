# Emulated-side interop role: sends to the native role's published address
# (through the relay gateway when this tab is emulated) and waits for the
# native side's coordinator confirmation.
wsastartup 0x202
p = socket AF_INET SOCK_DGRAM 0
bind p 0.0.0.0:23912
publishaddr p peer
hostaddr = waitaddr host t=20000
connect p hostaddr
send p "ping"
gate got-ping t=20000
closesocket p
wsacleanup
