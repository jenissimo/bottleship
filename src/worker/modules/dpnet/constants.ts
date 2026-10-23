export const DPN = {
    OK: 0, EQUAL: 0x00158005, NOTEQUAL: 0x0015800a, PENDING: 0x0015800e,
    GENERIC: 0x80004005, INVALIDPARAM: 0x80070057, UNSUPPORTED: 0x80004001,
    NOINTERFACE: 0x80004002, OUTOFMEMORY: 0x8007000e, INVALIDPOINTER: 0x80004003,
    ABORTED: 0x80158030, ALREADYCLOSING: 0x80158050, ALREADYCONNECTED: 0x80158060,
    ALREADYINITIALIZED: 0x80158080, ALREADYREGISTERED: 0x80158090, BUFFERTOOSMALL: 0x80158100, CANNOTCANCEL: 0x80158110,
    CONNECTING: 0x80158150, CONNECTIONLOST: 0x80158160, CONVERSION: 0x80158170,
    DATATOOLARGE: 0x80158175, DOESNOTEXIST: 0x80158180, HOSTING: 0x80158250,
    HOSTREJECTEDCONNECTION: 0x80158260, HOSTTERMINATEDSESSION: 0x80158270,
    INCOMPLETEADDRESS: 0x80158280, INVALIDADDRESSFORMAT: 0x80158290,
    INVALIDAPPLICATION: 0x80158300, INVALIDDEVICEADDRESS: 0x80158320,
    INVALIDFLAGS: 0x80158340, INVALIDGROUP: 0x80158350, INVALIDHANDLE: 0x80158360,
    INVALIDHOSTADDRESS: 0x80158370, INVALIDINSTANCE: 0x80158380, INVALIDINTERFACE: 0x80158390,
    INVALIDOBJECT: 0x80158400, INVALIDPASSWORD: 0x80158410, INVALIDPLAYER: 0x80158420,
    INVALIDPRIORITY: 0x80158430, INVALIDSTRING: 0x80158440, INVALIDURL: 0x80158450, INVALIDVERSION: 0x80158460,
    NOCONNECTION: 0x80158480, NOTALLOWED: 0x80158520, NOTHOST: 0x80158530,
    NOTREADY: 0x80158540, NOTREGISTERED: 0x80158550, PLAYERALREADYINGROUP: 0x80158560, PLAYERNOTINGROUP: 0x80158580,
    SESSIONFULL: 0x80158610, TABLEFULL: 0x80158620, TIMEDOUT: 0x80158630,
    UNINITIALIZED: 0x80158640, USERCANCEL: 0x80158650, NORESPONSE: 0x80158510, CANTCREATEPLAYER: 0x80158130,
} as const;
export const DP8_TCPIP = "ebfe7ba0-628d-11d2-ae0f-006097b01411";
export const DP8_IPX = "53934290-628d-11d2-ae0f-006097b01411";
export const DP8_ADDRESS = "83783300-4063-4c8a-9db3-82830a7feb31";
export const DP8_ADDRESS_IP = "e5a0e990-2bad-430b-87da-a142cf75de58";
export const DP8_PEER = "5102dacf-241b-11d3-aea7-006097b01411";
export const DP8_CLIENT = "5102dacd-241b-11d3-aea7-006097b01411";
export const DP8_SERVER = "5102dace-241b-11d3-aea7-006097b01411";

export const utf16 = (s: string): Uint8Array => {
    const bytes = new Uint8Array(s.length * 2), view = new DataView(bytes.buffer);
    for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
    return bytes;
};
export const fromUtf16 = (bytes: Uint8Array): string => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) { const n = view.getUint16(i, true); if (!n) break; s += String.fromCharCode(n); }
    return s;
};
export const guidBytes = (guid: string): Uint8Array => {
    const s = guid.replace(/[{}-]/g, "");
    const h = s.slice(0, 8).match(/../g)!.reverse().join("") + s.slice(8, 12).match(/../g)!.reverse().join("")
        + s.slice(12, 16).match(/../g)!.reverse().join("") + s.slice(16);
    return Uint8Array.from(h.match(/../g)!, n => parseInt(n, 16));
};
export const guidString = (b: Uint8Array): string => {
    const h = Array.from(b, n => n.toString(16).padStart(2, "0"));
    return h.slice(0, 4).reverse().join("") + "-" + h.slice(4, 6).reverse().join("") + "-" +
        h.slice(6, 8).reverse().join("") + "-" + h.slice(8, 10).join("") + "-" + h.slice(10).join("");
};
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((n, i) => n === b[i]);
