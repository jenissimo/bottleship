/**
 * The render worker's queue walk: the shipped split-D3D9 queue is parsed with the same entry
 * format as the dispatcher's drain (wbuf-format.ts). Every handler must see `ptr` one word past
 * the entry id, the strides of the sentinel kinds must match what the front wrote, and a
 * truncated or unknown-stride entry must stop the walk rather than misparse everything after it.
 */

import { describe, expect, it } from 'bun:test';
import { walkSplitQueue, type QueueHandler } from '../../src/worker/render/split-queue-walk';
import { WBUF_ARG_PAYLOAD, WBUF_ARG_SHADER_CONSTANT, WBUF_ARG_UP_DRAW } from '../../src/worker/core/thunking/wbuf-format';

const PLAIN = 40, CONST = 41, UP = 42, NOHANDLER = 43, SPLIT = 0xffff;

function argCountTable(): Int32Array {
    const t = new Int32Array(SPLIT + 1);
    t[PLAIN] = 2;
    t[CONST] = WBUF_ARG_SHADER_CONSTANT;
    t[UP] = WBUF_ARG_UP_DRAW;
    t[NOHANDLER] = 1;
    t[SPLIT] = WBUF_ARG_PAYLOAD;
    return t;
}

/** [PLAIN a b][CONST this start vec4=2 + 8 floats][UP this type count stride bytes=12 + 3 words]
 *  [SPLIT h0..h3 len=5 + 2 words][NOHANDLER x] */
function buildQueue(): { u8: Uint8Array; u32: Uint32Array; end: number; offsets: number[] } {
    const words: number[] = [];
    const offsets: number[] = [];
    const at = () => offsets.push(words.length * 4);
    at(); words.push(PLAIN, 0x11, 0x22);
    at(); words.push(CONST, 0x5f000000, 4, 2, ...Array.from({ length: 8 }, (_, i) => i));
    at(); words.push(UP, 0x5f000000, 4, 1, 12, 12, 0xa, 0xb, 0xc);
    at(); words.push(SPLIT, 7, 0, 0, 0, 5, 0x01020304, 0x05);
    at(); words.push(NOHANDLER, 0x99);
    const u32 = new Uint32Array(words.map((w) => w >>> 0));
    return { u8: new Uint8Array(u32.buffer), u32, end: words.length * 4, offsets };
}

describe('split queue walk', () => {
    it('dispatches every entry in order with ptr past the id', () => {
        const q = buildQueue();
        const seen: Array<[string, number, number]> = [];
        const h = (tag: string): QueueHandler => (_m8, m32, ptr) => seen.push([tag, ptr, m32[ptr >> 2]! >>> 0]);
        const handlers: Array<QueueHandler | null> = [];
        handlers[PLAIN] = h('plain');
        handlers[CONST] = h('const');
        handlers[UP] = h('up');
        const result = walkSplitQueue(q.u8, q.u32, q.end, handlers, argCountTable(), SPLIT, h('record'));
        expect(seen).toEqual([
            ['plain', q.offsets[0]! + 4, 0x11],
            ['const', q.offsets[1]! + 4, 0x5f000000],
            ['up', q.offsets[2]! + 4, 0x5f000000],
            ['record', q.offsets[3]! + 4, 7],
        ]);
        expect(result).toMatchObject({ entries: 5, records: 1, unknown: 1, malformedAt: -1, handlerThrows: 0 });
    });

    it('stops at an entry whose stride runs past the batch', () => {
        const q = buildQueue();
        const cut = q.offsets[2]! + 8; // the UP entry claims more bytes than were shipped
        const result = walkSplitQueue(q.u8, q.u32, cut, [], argCountTable(), SPLIT, () => {});
        expect(result.malformedAt).toBe(q.offsets[2]);
        expect(result.entries).toBe(2);
    });

    it('stops at an id with no known stride instead of guessing one', () => {
        const q = buildQueue();
        q.u32[q.offsets[1]! >> 2] = 77; // not in the table
        const result = walkSplitQueue(q.u8, q.u32, q.end, [], argCountTable(), SPLIT, () => {});
        expect(result.malformedAt).toBe(q.offsets[1]);
        expect(result.entries).toBe(1);
    });

    it('keeps going past a handler that throws, and names the first one', () => {
        const q = buildQueue();
        const handlers: Array<QueueHandler | null> = [];
        handlers[PLAIN] = () => { throw new Error('boom'); };
        const result = walkSplitQueue(q.u8, q.u32, q.end, handlers, argCountTable(), SPLIT, () => {});
        expect(result.handlerThrows).toBe(1);
        expect(result.firstThrow).toContain('boom');
        expect(result.entries).toBe(5);
    });
});
