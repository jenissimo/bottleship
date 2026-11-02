/**
 * FILE_APPEND_DATA regression from the immutable native COM oracle:
 * reopening an append-only handle must preserve existing bytes. NT5 iomgr/write.c
 * 352–367 substitutes EOF per write only when WRITE_DATA is absent; IopFileMapping
 * maps GENERIC_WRITE/GENERIC_ALL to WRITE_DATA. These tests use public VFS methods
 * and the real overlay, with only the unavailable browser OPFS storage replaced.
 */
import {afterAll, describe, expect, test} from "bun:test";
import {VirtualFileSystem, type VfsFileHandle} from "../../src/worker/runtime/filesystem/vfs";
import type {ZipArchive} from "@bottleship/formats/zip";
import {findFakeByName, installFakeOpfs, type FakeDirHandle} from "./fixtures/fake-opfs";

const GENERIC_READ=0x80000000, GENERIC_WRITE=0x40000000, GENERIC_ALL=0x10000000;
const FILE_WRITE_DATA=2, FILE_APPEND_DATA=4, CREATE_NEW=1, OPEN_EXISTING=3;
const originalNavigator=(globalThis as unknown as {navigator:unknown}).navigator;
afterAll(()=>{(globalThis as unknown as {navigator:unknown}).navigator=originalNavigator;});
let sequence=0;
type Mode="sync"|"async";
const bytes=(s:string)=>new TextEncoder().encode(s);
const concat=(...parts:Uint8Array[])=>new Uint8Array(parts.flatMap(p=>Array.from(p)));

async function fixture(run:(vfs:VirtualFileSystem,root:FakeDirHandle)=>Promise<void>){
 const root=installFakeOpfs(),vfs=new VirtualFileSystem();
 vfs.mountRom(null as unknown as ZipArchive,"rom",new Map());
 await vfs.initOverlay("test:append-data-"+(++sequence));
 try{await run(vfs,root);}finally{await vfs.flushAll();}
}
async function opened(vfs:VirtualFileSystem,access:number,mode:Mode){
 const h=mode==="sync"?vfs.openSync("C:\\append.bin",access,OPEN_EXISTING):await vfs.open("C:\\append.bin",access,OPEN_EXISTING);
 expect(h).not.toBeNull();return h!;
}
async function written(vfs:VirtualFileSystem,h:VfsFileHandle,data:Uint8Array,mode:Mode){
 expect(mode==="sync"?vfs.writeSync(h,data):await vfs.write(h,data)).toBe(data.length);
}
async function seeded(vfs:VirtualFileSystem,data:Uint8Array){
 const h=vfs.openSync("C:\\append.bin",GENERIC_WRITE,CREATE_NEW);
 expect(h).not.toBeNull();expect(vfs.writeSync(h!,data)).toBe(data.length);
 await vfs.flushAll();
}
async function persisted(vfs:VirtualFileSystem,root:FakeDirHandle,expected:Uint8Array){
 expect(vfs.getFileSize("C:\\append.bin")).toBe(expected.length);
 const h=vfs.openSync("C:\\append.bin",GENERIC_READ,OPEN_EXISTING)!;
 expect(Array.from(await vfs.read(h,expected.length+1))).toEqual(Array.from(expected));
 await vfs.flushAll();
 expect(Array.from(findFakeByName(root,"append.bin")!.data)).toEqual(Array.from(expected));
}

describe("FILE_APPEND_DATA per-write EOF",()=>{
 for(const mode of ["sync","async"] as const){
  test(mode+" reopened FILE_APPEND_DATA preserves a durable prefix and all appended records",async()=>{
   await fixture(async(vfs,root)=>{
    const prefix=Uint8Array.from({length:32},(_,i)=>0xa0+i);
    const chunks=[Uint8Array.from({length:64},(_,i)=>i+1),bytes("second record"),bytes("third independently reopened record")];
    await seeded(vfs,prefix);
    for(const chunk of chunks){
     const h=await opened(vfs,FILE_APPEND_DATA,mode);
     // No seek-to-end request: FILE_APPEND_DATA is the only append contract.
     await written(vfs,h,chunk,mode);
     await vfs.flushAll();
    }
    await persisted(vfs,root,concat(prefix,...chunks));
   });
  });
  test(mode+" preopened append handles and an intervening seek use the latest EOF",async()=>{
   await fixture(async(vfs,root)=>{
    const prefix=bytes("prefix/");
    await seeded(vfs,prefix);
    const a=await opened(vfs,FILE_APPEND_DATA,mode),b=await opened(vfs,FILE_APPEND_DATA,mode);
    await written(vfs,a,bytes("A"),mode);
    await written(vfs,b,bytes("BB"),mode);
    vfs.setPosition(a,0,0);
    await written(vfs,a,bytes("CCC"),mode);
    expect(vfs.tell(a)).toBe(prefix.length+6);
    expect(vfs.tell(b)).toBe(prefix.length+3);
    await persisted(vfs,root,bytes("prefix/ABBCCC"));
   });
  });
 }
 test("async append admissions in one VFS preserve both writes before either Promise is awaited",async()=>{
  await fixture(async(vfs,root)=>{
   await seeded(vfs,bytes("start/"));
   const a=await opened(vfs,FILE_APPEND_DATA,"async"),b=await opened(vfs,FILE_APPEND_DATA,"async");
   const first=vfs.write(a,bytes("A")),second=vfs.write(b,bytes("B"));
   expect(await first).toBe(1);expect(await second).toBe(1);
   await persisted(vfs,root,bytes("start/AB"));
  });
 });

 for(const [label,access,append] of [
  ["append plus read-data",FILE_APPEND_DATA|1,true],
  ["append plus read-attributes",FILE_APPEND_DATA|0x80,true],
  ["append plus generic-read",FILE_APPEND_DATA|GENERIC_READ,true],
  ["write-data without append",FILE_WRITE_DATA,false],
  ["append plus write-data",FILE_APPEND_DATA|FILE_WRITE_DATA,false],
  ["generic-write",GENERIC_WRITE,false],
  ["append plus generic-write",FILE_APPEND_DATA|GENERIC_WRITE,false],
  ["append plus generic-all",FILE_APPEND_DATA|GENERIC_ALL,false],
  ["already mapped FILE_GENERIC_WRITE",0x120116,false],
 ] as const){
  test(label+" retains its native append-vs-position distinction",async()=>{
   await fixture(async(vfs,root)=>{
    await seeded(vfs,bytes("ABCD"));
    const h=await opened(vfs,access,"sync");
    vfs.setPosition(h,1,0);
    await written(vfs,h,bytes("x"),"sync");
    await persisted(vfs,root,bytes(append?"ABCDx":"AxCD"));
   });
  });
 }
});
