/**
 * DirectPlay 4 wire constants, named and grouped as in the Microsoft Open
 * Specification [MC-DPL4CS] "DirectPlay 4 Protocol: Core and Service Providers"
 * (https://learn.microsoft.com/openspecs/windows_protocols/mc-dpl4cs).
 * Section numbers below refer to that document.
 */

/** 2.2.6 DPSP_MSG_HEADER: Signature, ASCII 'play' little-endian. */
export const DPSP_SIGNATURE = 0x79616c70;
/** 2.2.6 token (high 12 bits of the size DWORD): received from a remote DirectPlay machine. */
export const DPSP_TOKEN_REMOTE = 0xfab;
/** 2.2.6 size (low 20 bits of the size DWORD). */
export const DPSP_SIZE_MASK = 0xfffff;
/** 2.2.6: size/token DWORD (4) + SockAddr (16). The 'play' signature starts here. */
export const DPSP_PROVIDER_HEADER_BYTES = 20;

/** 2.2.6 Command Value. Only the values this engine reads or writes are listed. */
export const DPSP_MSG = {
    ENUMSESSIONSREPLY: 0x01,
    ENUMSESSIONS: 0x02,
    ENUMPLAYERSREPLY: 0x03,
    REQUESTPLAYERID: 0x05,
    REQUESTGROUPID: 0x06,
    REQUESTPLAYERREPLY: 0x07,
    CREATEPLAYER: 0x08,
    CREATEGROUP: 0x09,
    PLAYERMESSAGE: 0x0a,
    DELETEPLAYER: 0x0b,
    DELETEGROUP: 0x0c,
    ADDPLAYERTOGROUP: 0x0d,
    DELETEPLAYERFROMGROUP: 0x0e,
    PLAYERDATACHANGED: 0x0f,
    PLAYERNAMECHANGED: 0x10,
    GROUPDATACHANGED: 0x11,
    GROUPNAMECHANGED: 0x12,
    ADDFORWARDREQUEST: 0x13,
    PACKET: 0x15,
    PING: 0x16,
    PINGREPLY: 0x17,
    YOUAREDEAD: 0x18,
    PLAYERWRAPPER: 0x19,
    SESSIONDESCCHANGED: 0x1a,
    CHALLENGE: 0x1c,
    ACCESSGRANTED: 0x1d,
    LOGONDENIED: 0x1e,
    AUTHERROR: 0x1f,
    NEGOTIATE: 0x20,
    CHALLENGERESPONSE: 0x21,
    SIGNED: 0x22,
    ADDFORWARDREPLY: 0x24,
    ASK4MULTICAST: 0x25,
    ASK4MULTICASTGUARANTEED: 0x26,
    ADDSHORTCUTTOGROUP: 0x27,
    DELETEGROUPFROMGROUP: 0x28,
    SUPERENUMPLAYERSREPLY: 0x29,
    KEYEXCHANGE: 0x2b,
    KEYEXCHANGEREPLY: 0x2c,
    CHAT: 0x2d,
    ADDFORWARD: 0x2e,
    ADDFORWARDACK: 0x2f,
    PACKET2_DATA: 0x30,
    PACKET2_ACK: 0x31,
    IAMNAMESERVER: 0x35,
    VOICE: 0x36,
    MULTICASTDELIVERY: 0x37,
    CREATEPLAYERVERIFY: 0x38,
} as const;

/** 2.2.3 VersionOrSystemPlayerID: protocol dialect versions. */
export const DPSP_VERSION = { DX6: 9, DX61: 10, DX61A: 11, DX71: 12, DX8: 13, DX9: 14 } as const;

/** 2.2.2 / 2.2.3 player Flags. Every other bit SHOULD be zero when sent and MUST be ignored on receipt. */
export const DPLAYI_PLAYER = { SYSPLAYER: 0x1, NAMESRVR: 0x2, PLAYERINGROUP: 0x4, PLAYERLOCAL: 0x8 } as const;
export const DPLAYI_PLAYER_DEFINED_FLAGS = 0xf;

/** 2.1 Transport: enumeration requests are sent to the host on this TCP/UDP port. */
export const DPSP_SERVER_PORT = 47624;
