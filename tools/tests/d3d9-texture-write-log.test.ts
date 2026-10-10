import { afterEach, expect, test } from 'bun:test';
import { textureWriteLog as log } from '../../src/worker/modules/d3d9/texture-write-log';

afterEach(() => log.configure({ arm: false }));
const description = { width: 4, height: 2, levels: 1, format: 21, usage: 0, pool: 1 };

test('texture write evidence distinguishes absent writes from zero and populated transfers', () => {
    log.configure({ arm: true, width: 4 });
    log.create(1, description);
    log.create(2, { ...description, width: 8 });
    log.record(1, 'unlock', { level: 0 }, Uint8Array.of(0, 3, 8, 0, 2, 0, 9, 255));
    const events = log.configure().events as any[];
    expect(events).toHaveLength(2);
    expect(events[0].pixels).toBeNull();
    expect(events[1].pixels).toEqual({ bytes: 8, nonzero: [1, 1, 2, 1], maximum: [2, 3, 9, 255], firstBytes: [0, 3, 8, 0, 2, 0, 9, 255] });
    expect(log.selected(2)).toBeFalse();
});

test('bounded transfer history exposes drops and rearming clears old ownership', () => {
    log.configure({ arm: true, limit: 2 });
    log.create(1, description);
    log.record(1, 'lock', {});
    log.record(1, 'unlock', {}, new Uint8Array(4));
    expect(log.configure().dropped).toBe(1);
    expect((log.configure().events as any[]).map(e => e.op)).toEqual(['lock', 'unlock']);
    log.configure({ arm: false });
    log.record(1, 'lock', {});
    expect((log.configure().events as any[])).toHaveLength(2);
    log.configure({ arm: true });
    expect(log.selected(1)).toBeFalse();
    expect(log.configure().events).toEqual([]);
});
