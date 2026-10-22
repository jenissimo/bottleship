import { expect, test } from "bun:test";
import { NativeReceiveWindow } from "../../src/worker/modules/dpnet/native-wire/receive-window";
import { DN, type NativeDataFrame } from "../../src/worker/modules/dpnet/native-wire/frame-codec";
const frame = (sequence: number, command = 0x37, bytes: number[] = [sequence], control = 0): NativeDataFrame =>
    ({ kind: "data", sequence, command, control, nextReceive: 0, masks: [], payload: Uint8Array.from(bytes) });
test("native reassembly orders fragments across a sequence wrap and owns caller storage", () => {
    const q = new NativeReceiveWindow(254), middle = frame(255, 7, [2, 0]);
    expect(q.receive(middle).messages).toEqual([]); middle.payload.fill(255);
    expect(q.sack).toEqual([1, 0]);
    expect(q.receive(frame(0, 0x27, [3])).messages).toEqual([]); expect(q.sack).toEqual([3, 0]);
    const complete = q.receive(frame(254, 0x17, [1]));
    expect(complete.messages.length).toBe(1); expect([...complete.messages[0].payload]).toEqual([1, 2, 0, 3]);
    expect(complete.messages[0]).toMatchObject({ firstSequence: 254, lastSequence: 0 }); expect(q.nextReceive).toBe(1);
    expect(q.bufferedBytes).toBe(0); expect(q.bufferedFrames).toBe(0); expect(q.sack).toEqual([0, 0]);
    expect(q.receive(frame(255)).duplicate).toBe(true); expect(q.nextReceive).toBe(1);
});
test("sequential messages wait for gaps while unordered complete messages are delivered once immediately", () => {
    const q = new NativeReceiveWindow();
    expect(q.receive(frame(2, 0x33, [8])).messages.map(m => [...m.payload])).toEqual([[8]]);
    expect(q.bufferedBytes).toBe(0); expect(q.sack).toEqual([2, 0]);
    expect(q.receive(frame(2, 0x33, [8])).duplicate).toBe(true);
    expect(q.receive(frame(1)).messages).toEqual([]);
    expect(q.receive(frame(0)).messages.map(m => [...m.payload])).toEqual([[0], [1]]);
    expect(q.nextReceive).toBe(3); expect(q.bufferedFrames).toBe(0);
});
test("unordered fragmented messages can complete out of order without replay when earlier traffic arrives", () => {
    const q = new NativeReceiveWindow();
    expect(q.receive(frame(3, 0x23, [30])).messages).toEqual([]);
    const ready = q.receive(frame(2, 0x13, [20])); expect(ready.messages.map(m => [...m.payload])).toEqual([[20, 30]]);
    expect(q.bufferedBytes).toBe(0);
    expect(q.receive(frame(0)).messages.length).toBe(1); expect(q.receive(frame(1)).messages.length).toBe(1); expect(q.nextReceive).toBe(4);
});
test("SEND cancellation walks backwards, drops partial unreliable messages and preserves received frames", () => {
    const q = new NativeReceiveWindow();
    expect(q.receive(frame(0, 0x15, [1])).messages).toEqual([]); // unreliable sequential first fragment
    expect(q.receive(frame(2, 0x25, [3])).messages).toEqual([]);
    const dropped = q.cancelSendMask(3, 2, 0); expect(dropped.messages).toEqual([]); expect(q.nextReceive).toBe(3); expect(q.bufferedBytes).toBe(0);
    const other = new NativeReceiveWindow(250);
    expect(other.receive(frame(252)).messages).toEqual([]);
    const finished = other.cancelSendMask(253, 7, 0); // received sequence 252 is retained, missing 250/251 skipped
    expect(finished.messages.map(m => [...m.payload])).toEqual([[252]]); expect(other.nextReceive).toBe(253);
});
test("receive range, SACK high word, corrupted fragment starts and end-stream are bounded", () => {
    const q = new NativeReceiveWindow();
    expect(q.receive(frame(63)).accepted).toBe(false); expect(q.receive(frame(32)).accepted).toBe(true);
    expect(q.receive(frame(33)).accepted).toBe(true); expect(q.sack).toEqual([0x80000000, 1]);
    q.reset(); expect(q.receive(frame(0, 0x17)).messages).toEqual([]);
    expect(q.receive(frame(1, 0x17)).messages).toEqual([]); // invalid second NEW drops the existing message too
    expect(q.receive(frame(2, 0x27)).messages).toEqual([]);
    const end = q.receive(frame(3, 0x37, [], DN.END_STREAM)); expect(end.messages.length).toBe(1); expect(end.messages[0].control & DN.END_STREAM).toBeTruthy();
});
test("message and aggregate memory limits fail explicitly without acknowledging further input", () => {
    const q = new NativeReceiveWindow(0, 4, 5);
    q.receive(frame(1, 7, [2, 3, 4])); q.receive(frame(2, 0x27, [5, 6]));
    expect(q.bufferedBytes).toBe(5); expect(q.receive(frame(0, 0x17, [1])).overflow).toBe(true); expect(q.nextReceive).toBe(0);
    expect(q.receive(frame(0)).accepted).toBe(false); q.reset();
    q.receive(frame(0, 0x17, [1, 2, 3])); const big = q.receive(frame(1, 0x27, [4, 5]));
    expect(big.overflow).toBe(true); expect(big.messages.length).toBe(0);
    const zero = new NativeReceiveWindow(0, 4, 5, 2); zero.receive(frame(0, 0x17, [])); zero.receive(frame(1, 7, []));
    expect(zero.receive(frame(2, 7, [])).overflow).toBe(true); // Zero-byte fragments still have a finite metadata budget.
    expect(() => new NativeReceiveWindow(256)).toThrow(RangeError); expect(() => new NativeReceiveWindow(0, 0)).toThrow(RangeError);
});
