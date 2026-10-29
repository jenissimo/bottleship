import { expect, test } from 'bun:test';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { Shlwapi } from '../../src/worker/modules/shlwapi';
import { shlwapiModule } from '../../src/worker/api/shlwapi.api';
import { exports as resources } from '../../src/worker/modules/kernel32/resource';

function fixture() {
    const mem = new Uint8Array(0x4000);
    Mem.bind(() => mem);
    const api = new Shlwapi(); api.initialize({} as never);
    const view = new DataView(mem.buffer);
    const write = (p: number, s: string) => { for (let i=0;i<=s.length;i++) view.setUint16(p+i*2, i<s.length?s.charCodeAt(i):0,true); };
    const read = (p: number) => { let s=''; for(let c;(c=view.getUint16(p,true));p+=2) s+=String.fromCharCode(c); return s; };
    const call = (name: string, args: number[]) => (api.exports[name]({} as never,mem,args) as {value:number}).value;
    return {mem,api,view,write,read,call};
}

test('ordinal 66 shares the real wide resource finder and its three argument ABI', () => {
    const {api}=fixture();
    expect(api.exports.ord_66).toBe(resources.FindResourceW);
    const descriptor=shlwapiModule.functions.find(f=>f.ordinal===66)!;
    expect(descriptor.params.length).toBe(3);
});

test('file URLs escape filename delimiters and report the produced character count', () => {
    const f=fixture(); f.write(0x100,'C:/Game/My #file?.xml'); f.view.setUint32(0x80,256,true);
    expect(f.call('UrlCreateFromPathW',[0x100,0x800,0x80,0])).toBe(0);
    expect(f.read(0x800)).toBe('file:///C:/Game/My%20%23file%3F.xml');
    expect(f.view.getUint32(0x80,true)).toBe(f.read(0x800).length);
    expect(f.call('UrlIsW',[0x800,3])).toBe(1);
    f.view.setUint32(0x80,256,true);
    expect(f.call('PathCreateFromUrlW',[0x800,0x1000,0x80,0])).toBe(0);
    expect(f.read(0x1000)).toBe('C:/Game/My #file?.xml'.split('/').join(String.fromCharCode(92)));
    expect(f.call('PathIsURLW',[0x100])).toBe(0);
});

test('bounded wide comparisons stop at the requested length and at NUL', () => {
    const f=fixture(); f.write(0x100,'abc'); f.write(0x200,'abd');
    expect(f.call('StrCmpNW',[0x100,0x200,2])).toBe(0);
    expect(f.call('StrCmpNW',[0x100,0x200,3])).toBeLessThan(0);
    expect(f.call('StrCmpNW',[0x200,0x100,3])).toBeGreaterThan(0);
    expect(f.call('StrCmpNW',[0x100,0x200,0])).toBe(0);
});

test('short URL buffers report required capacity including NUL without truncating', () => {
    const f=fixture(); f.write(0x100,'C:/a.xml'); f.write(0x800,'sentinel'); f.view.setUint32(0x80,2,true);
    expect(f.call('UrlCreateFromPathW',[0x100,0x800,0x80,0])).toBe(0x80004003);
    expect(f.read(0x800)).toBe('sentinel');
    expect(f.view.getUint32(0x80,true)).toBe('file:///C:/a.xml'.length+1);
});
