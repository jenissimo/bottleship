# Native baseline must complete before recording goldens or claiming interop.
# emu-skip host publishes a Windows loopback endpoint; use native host with an explicit gateway
# Native DP8 host role: the adapter below is the measured Windows loopback
# device. Publish that same interface, and confirm receipt through the coordinator.
cominit
h = cocreate CLSID_DirectPlay8Peer IID_IDirectPlay8Peer
initialize h
x = cocreate CLSID_DirectPlay8Address IID_IDirectPlay8Address
setsp x CLSID_DP8SP_TCPIP
addport x 23913
setdevice x adapter
settraversal x 0
host h x session
publiship host 127.0.0.1 23913
cbwait receive 1 t=30000
require_success
signal got-ping
dp8close h
release h
comfree
