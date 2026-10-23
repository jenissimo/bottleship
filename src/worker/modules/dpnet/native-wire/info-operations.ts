import{NATIVE_CORE_MAX_MESSAGE}from"./core-connect-codec";
import{nativeCoreWide,nativeCoreWords}from"./core-operations";
export interface NativeInfoRequest {id:number;handle:number;mask:number;name:string|null;data:Uint8Array;}
/** D6 request handle precedes a 24-byte body; its packed extents are body-relative. */
export function decodeNativeInfoRequest(bytes:Uint8Array):NativeInfoRequest|null{
 if(bytes.length<32||bytes.length>NATIVE_CORE_MAX_MESSAGE)return null;
 try{
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);if(view.getUint32(0,true)!==0xd6)return null;
  const body=bytes.subarray(8),v=new DataView(body.buffer,body.byteOffset,body.length),id=v.getUint32(0,true),mask=v.getUint32(4,true);
  if(!id||mask&~3)return null;
  const blob=(field:number)=>{const p=v.getUint32(field,true),n=v.getUint32(field+4,true);if(!n){if(p)throw Error();return new Uint8Array();}if(p<24||n>body.length||p>body.length-n)throw Error();return body.slice(p,p+n);};
  const nameBytes=blob(8),data=blob(16);if(!(mask&1)&&nameBytes.length||!(mask&2)&&data.length||data.length>60000||nameBytes.length>2050)return null;
  let name:string|null=null;
  if(nameBytes.length){if(nameBytes.length<2||nameBytes.length&1||nameBytes.at(-1)||nameBytes.at(-2))return null;name="";const text=new DataView(nameBytes.buffer);for(let i=0;i<nameBytes.length-2;i+=2){const ch=text.getUint16(i,true);if(!ch)return null;name+=String.fromCharCode(ch);}}
  return{id,handle:view.getUint32(4,true),mask,name,data};
 }catch{return null;}
}
/** DB authority update, packed in the same name-then-data CPackedBuffer order as native. */
export function encodeNativeInfoUpdate(info:NativeInfoRequest&{version:number;requesting:number}):Uint8Array{
 const name=info.mask&1?nativeCoreWide(info.name):new Uint8Array(),data=info.mask&2?info.data:new Uint8Array();
 if(info.mask&~3||name.length>2050||data.length>60000||!info.id||!info.version)throw RangeError("Invalid native info update");
 const out=new Uint8Array(44+name.length+data.length);
 out.set(nativeCoreWords(0xdb,info.id,info.version,0,info.mask, name.length?40+data.length:0,name.length,data.length?40:0,data.length,info.requesting,info.handle));
 out.set(data,44);out.set(name,44+data.length);return out;
}
