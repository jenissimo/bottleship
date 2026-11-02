"""Finite production bound-UDP protocol regression; original prototype is immutable."""
import argparse
import hashlib
import json
import os
import queue
import socket
import struct
import subprocess
import sys
import threading
import time
import traceback

HEADER = struct.Struct("<IBBHII")
BIND, PEER, SEND, CREDIT, RETIRE, CLOSE, STATUS = range(1, 8)
READY, PEER_READY, SEND_RESULT, CREDIT_APPLIED, RETIRED, CLOSED, RX, ERROR, DROPPED, FAIL, SNAPSHOT = range(101, 112)
GEN = 17

def address(family, port):
    host = "127.0.0.1" if family == 4 else "::1"
    raw = socket.inet_pton(socket.AF_INET if family == 4 else socket.AF_INET6, host)
    return bytes([family, 0]) + struct.pack(">H", port) + struct.pack("<I", 0) + raw + bytes(16-len(raw))

def port_of(raw):
    return struct.unpack_from(">H", raw, 2)[0]

def local_peer(family, requested_port=0):
    s = socket.socket(socket.AF_INET if family == 4 else socket.AF_INET6, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 262144)
    if family == 6:
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    s.bind(("127.0.0.1" if family == 4 else "::1", requested_port))
    s.settimeout(2)
    return s

def native_addr(family, port):
    return ("127.0.0.1" if family == 4 else "::1", port)

class Helper:
    def __init__(self, executable, family):
        self.process = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        self.family = family
        self.events = []
        self.failure = None
        self.condition = threading.Condition()
        self.next_id = 1
        self.read_gate = threading.Event()
        self.read_gate.set()
        self.paused = threading.Event()
        self.pause_requested = False
        self.reader = threading.Thread(target=self.read_loop, daemon=True)
        self.reader.start()
        ident = self.command(BIND, address(family, 0))
        ready = self.wait(READY, ident)["body"]
        assert len(ready) == 48 and struct.unpack_from("<IIIIII", ready, 24) == (0x3f,256,262144,256,64,128)
        self.bound = ready[:24]
        self.port = port_of(self.bound)
        assert self.bound == address(family, self.port) and self.port > 0
        self.done = False

    def exact(self, count):
        pieces = []
        remaining = count
        while remaining:
            part = self.process.stdout.read(remaining)
            if not part:
                raise EOFError("helper stdout closed")
            pieces.append(part)
            remaining -= len(part)
        return b"".join(pieces)

    def read_loop(self):
        try:
            while True:
                header = self.exact(16)
                total, version, op, flags, ident, generation = HEADER.unpack(header)
                assert version == 1 and not flags and generation == GEN and 16 <= total <= 65700
                body = self.exact(total-16)
                with self.condition:
                    self.events.append({"op": op, "id": ident, "body": body})
                    self.condition.notify_all()
                if self.pause_requested:
                    self.paused.set()
                    self.read_gate.wait()
                    self.paused.clear()
        except BaseException as exc:
            with self.condition:
                self.failure = repr(exc)
                self.condition.notify_all()

    def packet(self, op, body=b"", ident=None, generation=GEN):
        if ident is None:
            ident = self.next_id
            self.next_id += 1
        return ident, HEADER.pack(16+len(body), 1, op, 0, ident, generation)+body

    def command(self, op, body=b"", ident=None, generation=GEN):
        ident, packet = self.packet(op, body, ident, generation)
        self.process.stdin.write(packet)
        self.process.stdin.flush()
        return ident

    def wait(self, op, ident=None, predicate=None, start=0, timeout=3):
        end = time.monotonic() + timeout
        with self.condition:
            while True:
                for event in self.events[start:]:
                    if event["op"] == FAIL:
                        raise AssertionError("helper FAIL " + event["body"].hex())
                    if event["op"] == op and (ident is None or event["id"] == ident) and (predicate is None or predicate(event)):
                        return event
                remaining = end-time.monotonic()
                if remaining <= 0 or self.failure:
                    raise AssertionError(f"event timeout op={op} id={ident} failure={self.failure} events={[(e['op'],e['id'],e['body'][:16].hex()) for e in self.events[-16:]]}")
                self.condition.wait(remaining)

    def peer(self, ident, epoch, port, expected=0):
        req = self.command(PEER, struct.pack("<II", ident, epoch)+address(self.family, port))
        result = struct.unpack("<III", self.wait(PEER_READY, req)["body"])
        assert result == (ident, epoch, expected), result
        return req

    def send(self, peer, epoch, payload, expected=0, wait=True):
        ident = self.command(SEND, struct.pack("<II", peer, epoch)+payload)
        if not wait:
            return ident
        result = self.sent(ident)
        assert result[2] == (0 if not expected else 1), result
        assert result[3] == expected, result
        return ident

    def sent(self, ident):
        result = struct.unpack("<IIIIII", self.wait(SEND_RESULT, ident)["body"])
        return result

    def credit(self, byte_count, packet_count):
        ident = self.command(CREDIT, struct.pack("<II", byte_count, packet_count))
        return struct.unpack("<II", self.wait(CREDIT_APPLIED, ident)["body"])

    def snapshot(self):
        ident = self.command(STATUS)
        return struct.unpack("<IIIIIIQQ", self.wait(SNAPSHOT, ident)["body"][:40])

    def wait_rx_count(self, count):
        deadline = time.monotonic()+2
        while time.monotonic() < deadline:
            status = self.snapshot()
            if status[2] >= count:
                return status
        raise AssertionError(f"RX escrow did not reach {count}: {status}")

    def close(self):
        if self.done:
            return
        ident = self.command(CLOSE)
        self.process.stdin.close()
        event = self.wait(CLOSED, ident, timeout=4)
        result = self.process.wait(timeout=3)
        assert result == 0, (result, self.process.stderr.read().decode(errors="replace"))
        self.reader.join(timeout=1)
        assert not self.reader.is_alive()
        self.done = True
        totals = struct.unpack("<QQQQQ", event["body"][:40])
        assert len(event["body"]) == 88 and event["body"][40:64] == self.bound and struct.unpack_from("<I",event["body"],84)[0] == 0
        return totals

    def pause_stdout(self):
        self.pause_requested = True
        self.read_gate.clear()
        ident = self.command(STATUS)
        self.wait(SNAPSHOT, ident)
        assert self.paused.wait(2), "stdout reader did not pause"

    def resume_stdout(self):
        self.pause_requested = False
        self.read_gate.set()

    def cleanup(self):
        self.resume_stdout()
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=3)
        for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
            if pipe and not pipe.closed:
                pipe.close()
        self.reader.join(timeout=1)

    def ledger(self):
        return [{"op": e["op"], "id": e["id"], "bytes": len(e["body"]), "bodyHex": e["body"].hex() if len(e["body"]) <= 128 else None, "sha256": hashlib.sha256(e["body"]).hexdigest()} for e in self.events]

def assert_received(peer, payload, helper_port):
    data, source = peer.recvfrom(65536)
    assert data == payload and source[1] == helper_port, (data, source, payload, helper_port)
    return source

def two_peer_error(executable, family):
    h = Helper(executable, family)
    a, b = local_peer(family), local_peer(family)
    try:
        h.peer(101, 1, a.getsockname()[1])
        h.peer(102, 1, b.getsockname()[1])
        h.send(101, 1, b"a")
        assert_received(a, b"a", h.port)
        h.send(102, 1, b"b")
        assert_received(b, b"b", h.port)
        b.sendto(b"escrow", native_addr(family, h.port))
        status = h.wait_rx_count(1)
        assert status[4:6] == (0, 0), status
        closed_port = a.getsockname()[1]
        a.close()
        tx_a = h.send(101, 1, b"x", wait=False)
        tx_b = h.send(102, 1, b"Y", wait=False)
        assert h.sent(tx_a)[2:4] == (0, 0)
        assert h.sent(tx_b)[2:4] == (0, 0)
        assert_received(b, b"Y", h.port)
        error = h.wait(ERROR, predicate=lambda e: struct.unpack_from("<I", e["body"])[0] == 101)
        pid, epoch = struct.unpack_from("<II", error["body"])
        endpoint = error["body"][8:32]
        mapped, native, origin, kind, code, occurrences = struct.unpack_from("<IIIIII", error["body"], 32)
        assert (pid, epoch, endpoint, mapped) == (101, 1, address(family, closed_port), 10054)
        assert occurrences >= 1 and h.snapshot()[4:6] == (0, 0)
        if sys.platform != "win32":
            assert (native, origin, kind, code) == ((111, 2, 3, 3) if family == 4 else (111, 3, 1, 4))
        h.credit(6, 1)
        got = h.wait(RX)
        assert got["body"][:8] == struct.pack("<II", 102, 1) and got["body"][32:] == b"escrow"
        assert got["body"][8:32] == address(family, b.getsockname()[1])
        b.sendto(b"R", native_addr(family, h.port))
        h.credit(1, 1)
        h.wait(RX, predicate=lambda e: e["body"][32:] == b"R")
        b.settimeout(0.15)
        try:
            extra = b.recvfrom(65536)
            raise AssertionError("duplicate successful SEND " + repr(extra))
        except socket.timeout:
            pass
        port = h.port
        totals = h.close()
        assert totals[0] == 4 and totals[1] == 0, totals
        rebound = local_peer(family, port)
        rebound.close()
        return {"case": "two-peer-error-credit-zero-close", "family": family, "helperPort": port, "errorTuplePort": closed_port, "nativeError": native, "events": h.ledger()}
    finally:
        a.close()
        b.close()
        h.cleanup()

def empty_credit(executable, family):
    h = Helper(executable, family)
    peer = local_peer(family)
    try:
        h.peer(201, 1, peer.getsockname()[1])
        peer.sendto(b"", native_addr(family, h.port))
        peer.sendto(b"", native_addr(family, h.port))
        h.wait_rx_count(2)
        h.credit(0, 1)
        first = h.wait(RX)
        assert len(first["body"]) == 32
        status = h.snapshot()
        assert status[2:6] == (1, 0, 0, 0), status
        start = len(h.events)
        h.credit(0, 1)
        second = h.wait(RX, start=start)
        assert len(second["body"]) == 32
        peer.sendto(b"z", native_addr(family, h.port))
        h.wait_rx_count(1)
        assert h.credit(0, 1) == (0, 1)
        assert h.snapshot()[2:6] == (1, 1, 0, 1)
        start = len(h.events)
        h.credit(1, 0)
        assert h.wait(RX, start=start)["body"][32:] == b"z"
        h.send(201, 1, b"")
        assert_received(peer, b"", h.port)
        totals = h.close()
        assert totals[:3] == (1, 0, 3), totals
        return {"case": "empty-packet-and-independent-byte-credit", "family": family, "events": h.ledger()}
    finally:
        peer.close()
        h.cleanup()

def identity_fence(executable, family):
    h = Helper(executable, family)
    peer = local_peer(family)
    try:
        p = peer.getsockname()[1]
        h.send(301, 1, b"unready", expected=10013)
        h.peer(301, 1, p)
        peer.sendto(b"old-captured", native_addr(family, h.port))
        h.wait_rx_count(1)
        req = h.command(RETIRE, struct.pack("<II", 301, 1))
        assert struct.unpack("<III", h.wait(RETIRED, req)["body"]) == (301, 1, 0)
        h.peer(302, 1, p, expected=10048)
        h.send(301, 1, b"retired", expected=10013)
        h.peer(301, 2, p)
        h.send(301, 1, b"stale", expected=10013)
        h.send(301, 2, b"new")
        assert_received(peer, b"new", h.port)
        h.credit(64, 4)
        peer.sendto(b"fresh", native_addr(family, h.port))
        event = h.wait(RX)
        assert event["body"][:8] == struct.pack("<II", 301, 2) and event["body"][32:] == b"fresh"
        with h.condition:
            assert not any(e["op"] == RX and e["body"][32:] == b"old-captured" for e in h.events)
        totals = h.close()
        assert totals[:2] == (1, 3), totals
        return {"case": "peer-ready-retired-tuple-captured-epoch-fence", "family": family, "events": h.ledger()}
    finally:
        peer.close()
        h.cleanup()

def wait_until(predicate, description, timeout=3):
    deadline = time.monotonic()+timeout
    waiter = threading.Event()
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        waiter.wait(0.001)  # Test-only polling an observed native state, not product scheduling.
    raise AssertionError("deadline: "+description)

def pipe_available(h):
    if sys.platform == "win32":
        import ctypes
        import msvcrt
        count = ctypes.c_ulong()
        handle = msvcrt.get_osfhandle(h.process.stdout.fileno())
        ok = ctypes.windll.kernel32.PeekNamedPipe(ctypes.c_void_p(handle), None, 0, None, ctypes.byref(count), None)
        assert ok, ctypes.get_last_error()
        return count.value
    import fcntl
    import termios
    return struct.unpack("<I", fcntl.ioctl(h.process.stdout.fileno(), termios.FIONREAD, struct.pack("<I", 0)))[0]

def wait_port_released(family, port):
    held = [None]
    def attempt():
        try:
            held[0] = local_peer(family, port)
            return True
        except OSError as exc:
            if exc.errno not in (98, 10048):
                raise
            return False
    wait_until(attempt, "actual native port released before stdout resumes")
    held[0].close()

def full_ack_close(executable, family):
    h = Helper(executable, family)
    peer, third = local_peer(family), local_peer(family)
    try:
        h.peer(401, 1, peer.getsockname()[1])
        h.credit((65507 if family == 4 else 65527), 1)
        h.pause_stdout()
        peer.sendto(b"f"*(65507 if family == 4 else 65527), native_addr(family, h.port))
        available = wait_until(lambda: pipe_available(h) or False, "stdout actual native pipe holds blocked large RX")
        assert 0 < available < (65507 if family == 4 else 65527)+48, available
        controls = []
        for _ in range(62):
            controls.append((SNAPSHOT, h.command(STATUS)))
        controls.append((CREDIT_APPLIED, h.command(CREDIT, struct.pack("<II", 0, 0))))
        controls.append((PEER_READY, h.command(PEER, struct.pack("<II", 402, 1)+address(family, third.getsockname()[1]))))
        tx_ids = [h.send(401, 1, b"", wait=False) for _ in range(256)]
        declined = h.send(401, 1, b"", wait=False)
        # No stdout bytes are consumed, including none of the 256 SEND_RESULTs.
        for _ in range(256):
            assert_received(peer, b"", h.port)
        close_id = h.command(CLOSE)
        # Leave stdin deliberately OPEN: native CLOSE must not depend on reader EOF.
        wait_port_released(family, h.port)
        assert h.paused.is_set()
        assert not any(e["op"] == SEND_RESULT and e["id"] in tx_ids for e in h.events)
        h.resume_stdout()
        for op, ident in controls:
            h.wait(op, ident)
        for ident in tx_ids:
            assert h.sent(ident)[2:4] == (0, 0)
        assert h.sent(declined)[2:4] == (1, 10055)
        close_event = h.wait(CLOSED, close_id)
        assert struct.unpack_from("<Q", close_event["body"])[0] == 256
        assert h.process.wait(timeout=3) == 0
        h.done = True
        for ident in tx_ids:
            assert sum(e["op"] == SEND_RESULT and e["id"] == ident for e in h.events) == 1
        peer.settimeout(0.1)
        try:
            raise AssertionError("duplicate native empty datagram "+repr(peer.recvfrom(32)))
        except socket.timeout:
            pass
        return {"case": "stalled-output-64-control-256-send-close-stdin-open", "family": family, "pipeBytesObserved": available, "nativePackets": 256, "events": h.ledger()}
    finally:
        peer.close()
        third.close()
        h.cleanup()

def stalled_error(executable, family):
    h = Helper(executable, family)
    a, b = local_peer(family), local_peer(family)
    try:
        h.peer(501, 1, a.getsockname()[1])
        h.peer(502, 1, b.getsockname()[1])
        h.credit((65507 if family == 4 else 65527), 1)
        h.pause_stdout()
        b.sendto(b"b"*(65507 if family == 4 else 65527), native_addr(family, h.port))
        wait_until(lambda: pipe_available(h) or False, "native stdout blocked")
        a_port = a.getsockname()[1]
        a.close()
        trigger = h.send(501, 1, b"icmp", wait=False)
        # Ordered snapshots are native-work fences. A subsequent B datagram is
        # externally observable despite the blocked stdout/control/result lanes.
        fence = h.command(9)
        marker = h.send(502, 1, b"marker", wait=False)
        assert_received(b, b"marker", h.port)
        # At this point marker SEND has passed the ordered fence without reading
        # a byte from stdout. A second fence records pending async-error escrow.
        second_fence = h.command(9)
        marker2 = h.send(502, 1, b"marker2", wait=False)
        assert_received(b, b"marker2", h.port)
        h.resume_stdout()
        status = h.wait(SNAPSHOT, second_fence)
        queued_errors, _, _, _ = struct.unpack_from("<IIII", status["body"], 40)
        assert queued_errors >= 1, status["body"].hex()
        first = h.wait(SNAPSHOT, fence)
        assert struct.unpack_from("<II", first["body"], 16) == (0, 0)
        error = h.wait(ERROR)
        assert error["body"][:8] == struct.pack("<II", 501, 1)
        assert error["body"][8:32] == address(family, a_port)
        assert struct.unpack_from("<I", error["body"], 32)[0] == 10054
        for ident in (trigger, marker, marker2):
            assert h.sent(ident)[2:4] == (0, 0)
        totals = h.close()
        assert totals[0] == 3
        return {"case": "stalled-output-error-at-zero-credit-native-fenced", "family": family, "events": h.ledger()}
    finally:
        a.close()
        b.close()
        h.cleanup()

def injected_race(executable, family):
    h = Helper(executable, family)
    a, b = local_peer(family), local_peer(family)
    try:
        h.peer(601, 1, a.getsockname()[1])
        h.peer(602, 1, b.getsockname()[1])
        port_a = a.getsockname()[1]
        a.close()
        ident = h.command(8, struct.pack("<III", 601, 1, 602))
        h.wait(112, ident)
        sent = h.send(602, 1, b"race", wait=False)
        proof = struct.unpack("<IIIII", h.wait(113, sent)["body"])
        result = h.sent(sent)
        assert proof == (602, 1, 8, 0xffffffff, 111), proof
        assert result[2:6] == (0, 0, 0, 2), result
        assert_received(b, b"race", h.port)
        error = h.wait(ERROR)
        assert error["body"][:8] == struct.pack("<II", 601, 1)
        assert error["body"][8:32] == address(family, port_a)
        assert struct.unpack_from("<I", error["body"], 32)[0] == 10054
        b.settimeout(0.15)
        try:
            raise AssertionError("successful retry duplicated "+repr(b.recvfrom(32)))
        except socket.timeout:
            pass
        h.close()
        return {"case": "real-icmp-after-predrain-failed-B-drain-same-packet-retry-once", "family": family, "proof": proof, "events": h.ledger()}
    finally:
        a.close()
        b.close()
        h.cleanup()

def byte_budget(executable, family):
    h = Helper(executable, family)
    peer = local_peer(family)
    try:
        h.peer(701, 1, peer.getsockname()[1])
        h.credit((65507 if family == 4 else 65527), 1)
        h.pause_stdout()
        peer.sendto(b"f"*(65507 if family == 4 else 65527), native_addr(family, h.port))
        wait_until(lambda: pipe_available(h) or False, "native stdout blocked before byte admission")
        length = 65507 if family == 4 else 65527
        packets = [bytes([index])*length for index in range(4)]
        ids = []
        for packet in packets:
            ids.append(h.send(701, 1, packet, wait=False))
            assert_received(peer, packet, h.port)
        declined = h.send(701, 1, b"overflow"*(200//8), wait=False)
        zero = h.send(701, 1, b"", wait=False)
        assert_received(peer, b"", h.port)
        close_id = h.command(CLOSE)
        wait_port_released(family, h.port)
        h.resume_stdout()
        for ident in ids+[zero]:
            assert h.sent(ident)[2:4] == (0, 0)
        assert h.sent(declined)[2:4] == (1, 10055)
        closed = h.wait(CLOSED, close_id)
        assert struct.unpack_from("<QQ", closed["body"]) == (5, 1)
        assert h.process.wait(timeout=3) == 0
        h.done = True
        peer.settimeout(0.1)
        try:
            raise AssertionError("partial rejected datagram "+repr(peer.recvfrom(65536)))
        except socket.timeout:
            pass
        return {"case": "whole-datagram-byte-window-rejection-no-partial-send", "family": family, "liveBytes": length*4, "events": h.ledger()}
    finally:
        peer.close()
        h.cleanup()

def rx_overflow_error(executable, family):
    h = Helper(executable, family)
    a, b = local_peer(family), local_peer(family)
    try:
        h.peer(801, 1, a.getsockname()[1])
        h.peer(802, 1, b.getsockname()[1])
        for _ in range(512):
            b.sendto(b"", native_addr(family, h.port))
        dropped = h.wait(DROPPED)
        assert struct.unpack_from("<Q", dropped["body"])[0] > 0
        snapshot = h.snapshot()
        assert snapshot[2:6] == (256, 0, 0, 0), snapshot
        closed_a = a.getsockname()[1]
        a.close()
        h.send(801, 1, b"x")
        error = h.wait(ERROR)
        assert error["body"][8:32] == address(family, closed_a)
        assert struct.unpack_from("<I", error["body"], 32)[0] == 10054
        h.credit(0, 1)
        assert len(h.wait(RX)["body"]) == 32
        assert h.snapshot()[2] == 255
        h.close()
        return {"case": "bounded-zero-payload-rx-overflow-does-not-block-icmp", "family": family, "events": h.ledger()}
    finally:
        a.close()
        b.close()
        h.cleanup()

def control_overflow(executable, family):
    h = Helper(executable, family)
    peer = local_peer(family)
    try:
        h.peer(901, 1, peer.getsockname()[1])
        h.credit((65507 if family == 4 else 65527), 1)
        h.pause_stdout()
        peer.sendto(b"f"*(65507 if family == 4 else 65527), native_addr(family, h.port))
        wait_until(lambda: pipe_available(h) or False, "native stdout blocked before control overflow")
        for _ in range(65):
            h.command(STATUS)
        wait_port_released(family, h.port)
        h.resume_stdout()
        assert h.process.wait(timeout=3) == 1
        h.reader.join(timeout=1)
        fail = [e for e in h.events if e["op"] == FAIL]
        assert fail and any(struct.unpack("<I", e["body"])[0] == 10055 for e in fail)
        h.done = True
        return {"case": "control-cap-explicit-failure-closes-with-stalled-output", "family": family, "events": h.ledger()}
    finally:
        peer.close()
        h.cleanup()

def duplicate_bind(executable, family):
    child = subprocess.Popen([executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        first = HEADER.pack(40, 1, BIND, 0, 1, GEN)+address(family, 0)
        second = HEADER.pack(40, 1, BIND, 0, 2, GEN+1)+address(family, 0)
        stdout, stderr = child.communicate(first+second, timeout=3)
        assert child.returncode == 1, (child.returncode, stderr)
        records = []
        at = 0
        while at < len(stdout):
            total, version, op, flags, ident, gen = HEADER.unpack_from(stdout, at)
            assert version == 1 and flags == 0 and gen == GEN
            body = stdout[at+16:at+total]
            records.append((op, ident, body.hex()))
            if op == READY:
                assert ident == 1
            at += total
        assert at == len(stdout)
        assert any(op == FAIL and body == struct.pack("<I", 10022).hex() for op, _, body in records)
        return {"case": "first-bind-reserves-generation-duplicate-cannot-overwrite", "family": family, "records": records}
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=2)

def retire_pipeline(executable, family):
    h = Helper(executable, family)
    peer = local_peer(family)
    try:
        h.peer(1001, 1, peer.getsockname()[1])
        before = h.send(1001, 1, b"prior", wait=False)
        retired = h.command(RETIRE, struct.pack("<II", 1001, 1))
        after = h.send(1001, 1, b"later", wait=False)
        assert h.sent(before)[2:4] == (0, 0)
        assert_received(peer, b"prior", h.port)
        assert struct.unpack("<III", h.wait(RETIRED, retired)["body"]) == (1001, 1, 0)
        assert h.sent(after)[2:4] == (1, 10013)
        peer.settimeout(0.1)
        try:
            raise AssertionError("SEND after RETIRE was emitted "+repr(peer.recvfrom(64)))
        except socket.timeout:
            pass
        h.close()
        return {"case": "pipelined-retire-fences-only-later-send", "family": family, "events": h.ledger()}
    finally:
        peer.close()
        h.cleanup()


def clock_lifetime(executable, family):
    h = Helper(executable, family)
    peer = local_peer(family)
    try:
        h.peer(1101, 1, peer.getsockname()[1])
        ident = h.command(250, struct.pack("<I", 60000))
        assert h.wait(251, ident)["body"] == struct.pack("<I",60000)
        h.send(1101,1,b"after-sixty-seconds")
        assert_received(peer,b"after-sixty-seconds",h.port)
        h.credit(1,1)
        peer.sendto(b"R",native_addr(family,h.port))
        assert h.wait(RX)["body"][32:] == b"R"
        h.close()
        return {"case":"no-global-binding-TTL-controlled-clock","family":family,"events":h.ledger()}
    finally:
        peer.close()
        h.cleanup()

def abort_priority(executable, family):
    h = Helper(executable,family)
    peer = local_peer(family)
    try:
        h.peer(1201,1,peer.getsockname()[1])
        h.credit((65507 if family == 4 else 65527),1)
        h.pause_stdout()
        peer.sendto(b"x"*(65507 if family==4 else 65527),native_addr(family,h.port))
        wait_until(lambda:pipe_available(h) or False,"blocked RX pipe before ABORT")
        # Fill all control result escrows; none may hold the socket owner.
        controls=[h.command(STATUS) for _ in range(64)]
        packets=[h.send(1201,1,b"",wait=False) for _ in range(256)]
        close_id=h.command(10)
        wait_port_released(family,h.port)
        h.resume_stdout()
        h.wait(CLOSED,close_id,timeout=5)
        results=[h.sent(ident) for ident in packets]
        assert all(r[2:4] in ((0,0),(2,10004)) for r in results),results
        accepted=sum(r[2]==0 for r in results)
        peer.settimeout(0.1)
        seen=0
        try:
            while True:
                data,remote=peer.recvfrom(64)
                assert data==b"" and remote[1]==h.port
                seen+=1
        except socket.timeout:
            pass
        assert seen==accepted,(seen,accepted)
        cancelled=[e for e in h.events if e["op"]==114]
        completed=[e for e in h.events if e["op"]==SNAPSHOT and e["id"] in controls]
        assert len(cancelled)+len(completed)==64
        h.process.stdin.close()
        assert h.process.wait(timeout=3)==0
        h.done=True
        return {"case":"reserved-abort-closes-with-full-control-and-TX-escrows","family":family,"accepted":accepted,"cancelled":256-accepted,"events":h.ledger()}
    finally:
        peer.close()
        h.cleanup()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("executable")
    parser.add_argument("--output", required=True)
    parser.add_argument("--stage", default="base")
    args = parser.parse_args()
    results = []
    failed = None
    started = time.monotonic()
    try:
        for family in (4, 6):
            for test in ((clock_lifetime,) if args.stage == "clock" else (abort_priority,) if args.stage == "abort" else (injected_race,) if args.stage == "race" else
                         (two_peer_error, empty_credit, identity_fence, full_ack_close, stalled_error, byte_budget, rx_overflow_error, control_overflow, duplicate_bind, retire_pipeline) if args.stage == "adversarial" else
                         (two_peer_error, empty_credit, identity_fence)):
                result = test(os.path.abspath(args.executable), family)
                results.append(result)
                print(json.dumps({"pass": result["case"], "family": family}), flush=True)
    except BaseException:
        failed = traceback.format_exc()
        print(failed, file=sys.stderr, flush=True)
    report = {"platform": sys.platform, "python": sys.version, "stage": args.stage, "elapsedSeconds": time.monotonic()-started, "passed": len(results), "failed": failed, "cases": results}
    with open(args.output, "w", encoding="utf8") as stream:
        json.dump(report, stream, indent=2)
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
