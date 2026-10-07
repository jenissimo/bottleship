import {expect, test} from 'bun:test';
import {Mem} from '../../src/worker/core/memory/mem-accessor';
import {createTextureExports} from '../../src/worker/modules/opengl32/texture';
import {createStateExports} from '../../src/worker/modules/opengl32/state';
import {createTextureUnit, type OpenGLContext} from '../../src/worker/modules/opengl32/context';
import {
    GL_TEXTURE_2D, GL_RGBA, GL_RGB, GL_BGRA, GL_UNSIGNED_BYTE,
    GL_INVALID_ENUM, GL_INVALID_VALUE, GL_PACK_ALIGNMENT, GL_PACK_ROW_LENGTH,
    GL_PACK_SKIP_ROWS, GL_PACK_SKIP_PIXELS,
} from '../../src/worker/modules/opengl32/constants';

function fixture() {
    const mem = new Uint8Array(0x8000);
    Mem.bind(() => mem);
    const ctx = {
        process: {getCurrentMemory: () => mem}, textures: new Map(),
        textureUnits: [createTextureUnit(), createTextureUnit()], activeTextureUnit: 0,
        unpackAlignment: 4, unpackRowLength: 0, unpackSkipPixels: 0, unpackSkipRows: 0,
        packAlignment: 4, packRowLength: 0, packSkipPixels: 0, packSkipRows: 0,
        frameSnapshot: {texUploads: 0}, error: 0,
    } as unknown as OpenGLContext;
    const exports = {...createStateExports(ctx), ...createTextureExports(ctx)};
    const call = (name: string, ...args: number[]) => exports[name](null as never, mem, args);
    const upload = (id: number, width: number, height: number, pixels: number[]) => {
        mem.set(pixels, 0x1000);
        call('glBindTexture', GL_TEXTURE_2D, id);
        call('glTexImage2D', GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, 0x1000);
    };
    const read = (format = GL_RGBA, dst = 0x2000, level = 0, type = GL_UNSIGNED_BYTE) =>
        call('glGetTexImage', GL_TEXTURE_2D, level, format, type, dst);
    return {ctx, mem, call, upload, read};
}

test('atlas read-modify-upload preserves every unmodified texel and reads active/default binding', () => {
    const {ctx, mem, call, upload, read} = fixture();
    const original = [10,20,30,40, 50,60,70,80, 90,100,110,120, 130,140,150,160];
    upload(1, 2, 2, original);
    read();
    expect(Array.from(mem.subarray(0x2000, 0x2010))).toEqual(original);
    mem.set([1,2,3,4], 0x2004);
    call('glTexImage2D', GL_TEXTURE_2D, 0, GL_RGBA, 2, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, 0x2000);
    read(GL_RGBA, 0x3000);
    expect(Array.from(mem.subarray(0x3000, 0x3010))).toEqual([10,20,30,40, 1,2,3,4, 90,100,110,120, 130,140,150,160]);
    ctx.activeTextureUnit = 1;
    upload(0, 1, 1, [5,6,7,8]);
    read();
    expect(Array.from(mem.subarray(0x2000, 0x2004))).toEqual([5,6,7,8]);
    ctx.activeTextureUnit = 0;
    read();
    expect(Array.from(mem.subarray(0x2000, 0x2004))).toEqual([10,20,30,40]);
});

test('RGB/BGRA pack rows retain padding and obey row length and skips', () => {
    const {mem, call, upload, read} = fixture();
    upload(1, 1, 2, [10,20,30,40, 50,60,70,80]);
    mem.fill(0xa5, 0x2000, 0x2100);
    read(GL_RGB);
    expect(Array.from(mem.subarray(0x2000, 0x2008))).toEqual([10,20,30,0xa5, 50,60,70,0xa5]);
    call('glPixelStorei', GL_PACK_ROW_LENGTH, 3);
    call('glPixelStorei', GL_PACK_SKIP_ROWS, 1);
    call('glPixelStorei', GL_PACK_SKIP_PIXELS, 1);
    mem.fill(0xa5, 0x2000, 0x2100);
    read(GL_BGRA);
    expect(Array.from(mem.subarray(0x2010, 0x2014))).toEqual([30,20,10,40]);
    expect(Array.from(mem.subarray(0x201c, 0x2020))).toEqual([70,60,50,80]);
    expect(mem[0x200f]).toBe(0xa5);
    expect(mem[0x2014]).toBe(0xa5);
    expect(mem[0x2020]).toBe(0xa5);
});

test('invalid arguments and undefined mip levels leave destination unchanged', () => {
    const {ctx, mem, call, upload, read} = fixture();
    upload(1, 1, 1, [10,20,30,40]);
    mem.fill(0xa5, 0x2000, 0x2010);
    read(GL_RGBA, 0x2000, -1);
    expect(ctx.error).toBe(GL_INVALID_VALUE);
    read(GL_RGBA, 0x2000, 0, 0xffff);
    expect(ctx.error).toBe(GL_INVALID_ENUM);
    read(GL_RGBA, 0x2000, 1);
    expect(Array.from(mem.subarray(0x2000, 0x2010))).toEqual(new Array(16).fill(0xa5));
    call('glPixelStorei', GL_PACK_ALIGNMENT, 3);
    expect(ctx.error).toBe(GL_INVALID_VALUE);
    expect(ctx.packAlignment).toBe(4);
    call('glPixelStorei', GL_PACK_SKIP_ROWS, -1);
    expect(ctx.packSkipRows).toBe(0);
});
