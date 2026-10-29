# DirectPlay 8 COM lifecycle: creation before initialization, negotiation,
# address components, a wrong-IID query, and teardown — no network involved.
early = cocreate CLSID_DirectPlay8Peer IID_IDirectPlay8Peer
cominit
a = cocreate CLSID_DirectPlay8Peer IID_IDirectPlay8Peer
initialize a
initialize a
x = cocreate CLSID_DirectPlay8Address IID_IDirectPlay8Address
setsp x CLSID_DP8SP_TCPIP
addport x 23913
lob = cocreate CLSID_DirectPlay8Peer IID_IDirectPlay8Address
release x
dp8close a
release a
comfree
