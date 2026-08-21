/**
 * Winsock 1.1 (WSOCK32) API descriptor.
 *
 * Ordinal layout MUST match real wsock32.dll (distinct from ws2_32 ordinals for a few
 * slots — e.g. ord_10/ord_12 swap ioctlsocket/inet_addr, and ord_151 here is __WSAFDIsSet
 * where ws2_32's ord_151 is WSASocketA). Every ordinal is also exported by name on the
 * real DLL, so each function below has both an `ord_N` descriptor (ordinal imports) and
 * a plain-name descriptor (name imports) — listed explicitly rather than derived, so the
 * signature validator's static ordinal-array reader can check both.
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    ...overrides,
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

/** Winsock 1.1 ordinal -> (name, argc). PE often imports by ordinal. */
const WSOCK_ORDINALS: Array<{ name: string; ordinal: number; argCount: number }> = [
    { name: "ord_1", ordinal: 1, argCount: 3 },   // accept
    { name: "ord_2", ordinal: 2, argCount: 3 },   // bind
    { name: "ord_3", ordinal: 3, argCount: 1 },   // closesocket
    { name: "ord_4", ordinal: 4, argCount: 3 },   // connect
    { name: "ord_5", ordinal: 5, argCount: 3 },   // getpeername
    { name: "ord_6", ordinal: 6, argCount: 3 },   // getsockname
    { name: "ord_7", ordinal: 7, argCount: 5 },   // getsockopt
    { name: "ord_8", ordinal: 8, argCount: 1 },   // htonl
    { name: "ord_9", ordinal: 9, argCount: 1 },   // htons
    { name: "ord_10", ordinal: 10, argCount: 1 }, // inet_addr
    { name: "ord_11", ordinal: 11, argCount: 1 }, // inet_ntoa
    { name: "ord_12", ordinal: 12, argCount: 3 }, // ioctlsocket
    { name: "ord_13", ordinal: 13, argCount: 2 }, // listen
    { name: "ord_14", ordinal: 14, argCount: 1 }, // ntohl
    { name: "ord_15", ordinal: 15, argCount: 1 }, // ntohs
    { name: "ord_16", ordinal: 16, argCount: 4 }, // recv
    { name: "ord_17", ordinal: 17, argCount: 6 }, // recvfrom
    { name: "ord_18", ordinal: 18, argCount: 5 }, // select
    { name: "ord_19", ordinal: 19, argCount: 4 }, // send
    { name: "ord_20", ordinal: 20, argCount: 6 }, // sendto
    { name: "ord_21", ordinal: 21, argCount: 5 }, // setsockopt
    { name: "ord_22", ordinal: 22, argCount: 2 }, // shutdown
    { name: "ord_23", ordinal: 23, argCount: 3 }, // socket
    { name: "ord_51", ordinal: 51, argCount: 3 }, // gethostbyaddr
    { name: "ord_52", ordinal: 52, argCount: 1 }, // gethostbyname
    { name: "ord_53", ordinal: 53, argCount: 1 }, // getprotobyname
    { name: "ord_54", ordinal: 54, argCount: 1 }, // getprotobynumber
    { name: "ord_55", ordinal: 55, argCount: 2 }, // getservbyname
    { name: "ord_56", ordinal: 56, argCount: 2 }, // getservbyport
    { name: "ord_57", ordinal: 57, argCount: 2 }, // gethostname
    { name: "ord_101", ordinal: 101, argCount: 4 }, // WSAAsyncSelect
    { name: "ord_102", ordinal: 102, argCount: 7 }, // WSAAsyncGetHostByAddr
    { name: "ord_103", ordinal: 103, argCount: 5 }, // WSAAsyncGetHostByName
    { name: "ord_104", ordinal: 104, argCount: 5 }, // WSAAsyncGetProtoByNumber
    { name: "ord_105", ordinal: 105, argCount: 5 }, // WSAAsyncGetProtoByName
    { name: "ord_106", ordinal: 106, argCount: 6 }, // WSAAsyncGetServByPort
    { name: "ord_107", ordinal: 107, argCount: 6 }, // WSAAsyncGetServByName
    { name: "ord_108", ordinal: 108, argCount: 1 }, // WSACancelAsyncRequest
    { name: "ord_109", ordinal: 109, argCount: 1 }, // WSASetBlockingHook
    { name: "ord_110", ordinal: 110, argCount: 0 }, // WSAUnhookBlockingHook
    { name: "ord_111", ordinal: 111, argCount: 0 }, // WSAGetLastError
    { name: "ord_112", ordinal: 112, argCount: 1 }, // WSASetLastError
    { name: "ord_113", ordinal: 113, argCount: 0 }, // WSACancelBlockingCall
    { name: "ord_114", ordinal: 114, argCount: 0 }, // WSAIsBlocking
    { name: "ord_115", ordinal: 115, argCount: 2 }, // WSAStartup
    { name: "ord_116", ordinal: 116, argCount: 0 }, // WSACleanup
    { name: "ord_151", ordinal: 151, argCount: 2 }, // __WSAFDIsSet
];

export const wsock32Module: ModuleDescriptor = {
    name: "wsock32",
    functions: [
        makeFunc("WSAStartup", 2),
        makeFunc("WSACleanup", 0),
        makeFunc("socket", 3, { onUnimplemented: "invalidHandle" }),
        makeFunc("closesocket", 1, { onUnimplemented: "minusOne" }),
        makeFunc("send", 4, { onUnimplemented: "minusOne" }),
        makeFunc("recv", 4, { onUnimplemented: "minusOne" }),
        makeFunc("connect", 3, { onUnimplemented: "minusOne" }),
        makeFunc("bind", 3, { onUnimplemented: "minusOne" }),
        makeFunc("listen", 2, { onUnimplemented: "minusOne" }),
        makeFunc("accept", 3, { onUnimplemented: "invalidHandle" }),
        makeFunc("gethostname", 2),
        makeFunc("gethostbyname", 1),
        makeFunc("gethostbyaddr", 3),
        makeFunc("getprotobyname", 1),
        makeFunc("getprotobynumber", 1),
        makeFunc("getservbyname", 2),
        makeFunc("getservbyport", 2),
        makeFunc("inet_addr", 1),
        makeFunc("inet_ntoa", 1),
        makeFunc("htons", 1),
        makeFunc("htonl", 1),
        makeFunc("ntohs", 1),
        makeFunc("ntohl", 1),
        makeFunc("getpeername", 3, { onUnimplemented: "minusOne" }),
        makeFunc("getsockname", 3, { onUnimplemented: "minusOne" }),
        makeFunc("select", 5, { onUnimplemented: "minusOne" }),
        makeFunc("sendto", 6, { onUnimplemented: "minusOne" }),
        makeFunc("recvfrom", 6, { onUnimplemented: "minusOne" }),
        makeFunc("shutdown", 2, { onUnimplemented: "minusOne" }),
        makeFunc("ioctlsocket", 3, { onUnimplemented: "minusOne" }),
        makeFunc("setsockopt", 5, { onUnimplemented: "minusOne" }),
        makeFunc("getsockopt", 5, { onUnimplemented: "minusOne" }),
        makeFunc("__WSAFDIsSet", 2),
        makeFunc("WSAAsyncSelect", 4),
        makeFunc("WSAAsyncGetHostByAddr", 7),
        makeFunc("WSAAsyncGetHostByName", 5),
        makeFunc("WSAAsyncGetProtoByNumber", 5),
        makeFunc("WSAAsyncGetProtoByName", 5),
        makeFunc("WSAAsyncGetServByPort", 6),
        makeFunc("WSAAsyncGetServByName", 6),
        makeFunc("WSACancelAsyncRequest", 1),
        makeFunc("WSASetBlockingHook", 1),
        makeFunc("WSAUnhookBlockingHook", 0),
        makeFunc("WSAGetLastError", 0),
        makeFunc("WSASetLastError", 1),
        makeFunc("WSACancelBlockingCall", 0),
        makeFunc("WSAIsBlocking", 0),
        ...WSOCK_ORDINALS.map(({ name, ordinal, argCount }) => ({ ...makeFunc(name, argCount), ordinal })),
    ],
};
