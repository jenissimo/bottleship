"""Portable native helper/oracle composition; no third-party Python packages."""
import json
import queue
import socket
import struct
import subprocess
import sys
import threading

helper_path, peer_path = sys.argv[1:3]

def exact(stream, length):
    data = bytearray()
    while len(data) < length:
        chunk = stream.read(length - len(data))
        if not chunk:
            raise EOFError("Native helper pipe closed")
        data.extend(chunk)
    return bytes(data)

def records(stream, events):
    try:
        while True:
            kind, length = struct.unpack("<II", exact(stream, 8))
            if length > 65535:
                raise ValueError("Invalid helper record length")
            events.put((kind, exact(stream, length)))
    except BaseException as error:
        events.put(error)

def lines(stream, events):
    for line in iter(stream.readline, b""):
        events.put(line)

def command(process, kind, payload=b""):
    process.stdin.write(struct.pack("<II", kind, len(payload)) + payload)
    process.stdin.flush()

def connected(events):
    options = {}
    while True:
        event = events.get(timeout=5)
        if isinstance(event, BaseException):
            raise event
        if event[0] != 20:
            assert event == (10, b""), event
            break
        assert len(event[1]) == 8, event
        option, enabled = struct.unpack("<II", event[1])
        assert option in (1, 2) and option not in options and enabled == 0, event
        options[option] = enabled
    assert options == {1: 0, 2: 0}, options

for inline in (False, True):
    peer = subprocess.Popen([peer_path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    process = None
    try:
        peer_lines = queue.Queue()
        threading.Thread(target=lines, args=(peer.stdout, peer_lines), daemon=True).start()
        port = int(peer_lines.get(timeout=5))
        process = subprocess.Popen([helper_path, "tcp", "127.0.0.1", str(port), str(int(inline))],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        events = queue.Queue()
        threading.Thread(target=records, args=(process.stdout, events), daemon=True).start()
        command(process, 4, struct.pack("<I", 262144))
        connected(events)
        command(process, 1, struct.pack("<I", 1) + b"ab")
        command(process, 2, struct.pack("<I", 2) + b"U")
        command(process, 1, struct.pack("<I", 3) + b"cd")
        normal, urgent, acknowledgements = bytearray(), bytearray(), set()
        target = 5 if inline else 4
        while len(normal) < target or (not inline and not urgent) or len(acknowledgements) < 3:
            event = events.get(timeout=5)
            if isinstance(event, BaseException):
                raise event
            kind, payload = event
            if kind == 11:
                normal.extend(payload)
            elif kind == 12:
                urgent.extend(payload)
            elif kind == 15:
                acknowledgements.add(struct.unpack("<I", payload)[0])
            else:
                raise AssertionError(event)
        assert normal == (b"abUcd" if inline else b"abcd"), normal
        assert urgent == (b"" if inline else b"U"), urgent
        command(process, 3)
        finished = False
        while True:
            event = events.get(timeout=5)
            if isinstance(event, BaseException):
                raise event
            if event[0] == 16:
                assert finished, "Closed before native send shutdown acknowledgement"
                break
            if event == (19, b""):
                assert not finished, "Duplicate send shutdown acknowledgement"
                finished = True
            else:
                assert event == (13, b""), event
        assert process.wait(timeout=5) == 0
        assert peer.wait(timeout=5) == 0
        assert json.loads(peer_lines.get(timeout=5)) == {"normal": 4, "urgent": 1, "byte": ord("U")}
        print("native helper inline=" + str(inline) + ": PASS", flush=True)
    finally:
        for child in (process, peer):
            if child is not None:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=5)

# Exhaust receive credit without returning any token, then abort the real peer.
# A native reset must wake the helper even with no outbound command to retry.
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(5)
    process = subprocess.Popen([helper_path, "tcp", "127.0.0.1", str(listener.getsockname()[1]), "0"],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    peer = None
    try:
        events = queue.Queue()
        threading.Thread(target=records, args=(process.stdout, events), daemon=True).start()
        command(process, 4, struct.pack("<I", 262144))
        peer, _ = listener.accept()
        peer.settimeout(5)
        connected(events)
        peer.sendall(b"m" * 262144)
        received = 0
        while received < 262144:
            event = events.get(timeout=5)
            if isinstance(event, BaseException):
                raise event
            assert event[0] == 11 and event[1] == b"m" * len(event[1]), event
            received += len(event[1])
        assert received == 262144, received
        peer.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER,
                        struct.pack("HH" if sys.platform == "win32" else "ii", 1, 0))
        peer.close()
        peer = None
        event = events.get(timeout=5)
        assert isinstance(event, tuple) and event[0] == 14, event
        # Preserve the native abort/reset distinction, including Windows 10053.
        error = struct.unpack("<I", event[1])[0]
        assert error in (10053, 10054), event
        assert process.wait(timeout=5) == 1
        print("native helper reset with exhausted credit: PASS error=" + str(error), flush=True)
    finally:
        if peer is not None:
            peer.close()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)

# Preserve host capability policy. No privilege elevation or raw-socket install.
def checksum(data):
    if len(data) % 2:
        data += b"\x00"
    total = sum(struct.unpack("!" + "H" * (len(data) // 2), data))
    while total >> 16:
        total = (total & 65535) + (total >> 16)
    return (~total) & 65535

for family, host, protocol, kind in ((4, "127.0.0.1", 1, 8), (6, "::1", 58, 128)):
    process = subprocess.Popen([helper_path, "raw" + str(family), host, str(protocol), "0"],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    events = queue.Queue()
    threading.Thread(target=records, args=(process.stdout, events), daemon=True).start()
    try:
        command(process, 4, struct.pack("<I", 262144))
        event = events.get(timeout=5)
        if event[0] == 14:
            assert struct.unpack("<I", event[1])[0] == 10013, event
            print("native RAW" + str(family) + ": explicit permission denial 10013", flush=True)
            continue
        assert event == (10, b""), event
        packet = struct.pack("!BBHHH4s", kind, 0, 0, 0x6789, 1, b"test")
        packet = packet[:2] + struct.pack("!H", checksum(packet)) + packet[4:]
        command(process, 1, struct.pack("<I", 1) + packet)
        acknowledged, replied = False, False
        while not acknowledged or not replied:
            event = events.get(timeout=5)
            if isinstance(event, BaseException):
                raise event
            event_kind, data = event
            if event_kind == 14:
                assert struct.unpack("<I", data)[0] == 10013, event
                print("native RAW" + str(family) + ": explicit send denial 10013", flush=True)
                break
            if event_kind == 15:
                acknowledged = struct.unpack("<I", data)[0] == 1
            elif event_kind == 17:
                offset = (data[0] & 15) * 4 if family == 4 else 0
                if data[offset] == (0 if family == 4 else 129):
                    assert data[offset + 4:offset + 8] == packet[4:8], data
                    assert data[offset + 8:] == b"test", data
                    replied = True
            else:
                raise AssertionError(event)
        if acknowledged and replied:
            print("native RAW" + str(family) + ": actual echo PASS", flush=True)
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
