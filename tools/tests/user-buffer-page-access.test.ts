import {describe,it,expect} from "bun:test";
import {PageTableManager} from "../../src/worker/core/memory/page-table-manager";
import {MEM_PAGETABLE_BASE} from "../../src/worker/core/cpu/emulator-config";
import {AddressSpace} from "../../src/worker/core/memory/address-space";
import {System} from "../../src/worker/core/system";
import {isValidUserAddress} from "../../src/worker/core/memory/address-guard";

describe("Win32 user buffer probes include actual page state",()=>{
 it("rejects decommitted and read-only PTEs over a region that remains writable",()=>{
  const mem=new Uint8Array(MEM_PAGETABLE_BASE+0x500000),base=0x400000;
  const space=new AddressSpace(()=>mem),ptm=new PageTableManager(()=>mem,()=>null);
  space.registerRegion({base,size:0x2000,perms:"rw",kind:"BORROWED",owner:"page-access-test"});
  ptm.commitPages(base,0x2000);ptm.enablePaging({cr:[0,0,0,0]});
  const system=System.getInstance(),saved=system.process;
  system.process={addressSpace:space,pageTableManager:ptm,getCurrentMemory:()=>mem} as any;
  try{
   expect(isValidUserAddress(mem,base,0x2000,"rw")).toBe(true);
   ptm.setProtection(base+0x1000,0x1000,2);
   expect(space.validateRange(base,0x2000,"rw")).toBe(true);
   expect(isValidUserAddress(mem,base+0xffe,4,"rw")).toBe(false);
   expect(isValidUserAddress(base+0xffe,4,"rw")).toBe(false);
   expect(isValidUserAddress(mem,base+0xffe,4,"r")).toBe(true);
   ptm.decommitPages(base+0x1000,0x1000);
   expect(isValidUserAddress(mem,base+0xffe,4,"r")).toBe(false);
   expect(isValidUserAddress(base+0xffe,4,"r")).toBe(false);
   expect(isValidUserAddress(mem,base,0x1000,"rw")).toBe(true);
   ptm.ensurePagesCommitted(base+0x1000,0x1000);
   expect(isValidUserAddress(mem,base,0x2000,"rw")).toBe(true);
   expect(isValidUserAddress(mem,base+0x1000,0,"rw")).toBe(true);
  }finally{system.process=saved;}
 });
});
