/**
 * GetTokenInformation layouts for the process token of an ordinary, non-elevated user at
 * medium integrity, which is what a game started from the desktop runs under.
 *
 * Every class below is answered the way Windows answers it: a buffer that is too small
 * (including the usual NULL/0 size query) fails with ERROR_INSUFFICIENT_BUFFER and reports
 * the required size, and structures that hold a PSID point into the caller's own buffer,
 * right after the fixed part, where the SID itself is written.
 */

export const TokenUser = 1;
export const TokenGroups = 2;
export const TokenPrivileges = 3;
export const TokenOwner = 4;
export const TokenPrimaryGroup = 5;
export const TokenType = 8;
export const TokenSessionId = 12;
export const TokenElevationType = 18;
export const TokenElevation = 20;
export const TokenIntegrityLevel = 25;
export const TokenIsAppContainer = 29;

const SE_GROUP_INTEGRITY = 0x20;
const TOKEN_PRIMARY = 1;
const TOKEN_ELEVATION_TYPE_DEFAULT = 1;
const SECURITY_MANDATORY_MEDIUM_RID = 0x2000;

/** S-1-5-21-<machine>-1000: the interactive user. */
const USER_SID = { authority: 5, sub: [21, 0x2f6a3c51, 0x6bd1e4a2, 0x1c7f09b3, 1000] };
/** S-1-5-21-<machine>-513: Domain Users / None, a local account's primary group. */
const PRIMARY_GROUP_SID = { authority: 5, sub: [21, 0x2f6a3c51, 0x6bd1e4a2, 0x1c7f09b3, 513] };
/** S-1-16-8192: Mandatory Label\Medium Mandatory Level. */
const MEDIUM_INTEGRITY_SID = { authority: 16, sub: [SECURITY_MANDATORY_MEDIUM_RID] };

type Sid = { authority: number; sub: number[] };

const sidLength = (sid: Sid) => 8 + sid.sub.length * 4;

function writeSid(view: DataView, at: number, sid: Sid): void {
    view.setUint8(at, 1);
    view.setUint8(at + 1, sid.sub.length);
    for (let i = 0; i < 5; i++) view.setUint8(at + 2 + i, 0);
    view.setUint8(at + 7, sid.authority);
    sid.sub.forEach((v, i) => view.setUint32(at + 8 + i * 4, v >>> 0, true));
}

interface Layout {
    size: number;
    write(view: DataView, at: number): void;
}

const dword = (value: number): Layout => ({ size: 4, write: (v, at) => v.setUint32(at, value >>> 0, true) });

/** SID_AND_ATTRIBUTES (TOKEN_USER, TOKEN_MANDATORY_LABEL) followed by the SID. */
const sidAndAttributes = (sid: Sid, attributes: number): Layout => ({
    size: 8 + sidLength(sid),
    write: (v, at) => {
        v.setUint32(at, (at + 8) >>> 0, true);
        v.setUint32(at + 4, attributes >>> 0, true);
        writeSid(v, at + 8, sid);
    },
});

/** A lone PSID (TOKEN_OWNER, TOKEN_PRIMARY_GROUP) followed by the SID. */
const sidPointer = (sid: Sid): Layout => ({
    size: 4 + sidLength(sid),
    write: (v, at) => {
        v.setUint32(at, (at + 4) >>> 0, true);
        writeSid(v, at + 4, sid);
    },
});

/** The layout for a token information class, or undefined for a class not modelled here. */
export function tokenInformationLayout(cls: number): Layout | undefined {
    switch (cls) {
        case TokenUser: return sidAndAttributes(USER_SID, 0);
        case TokenGroups: return dword(0);
        case TokenPrivileges: return dword(0);
        case TokenOwner: return sidPointer(USER_SID);
        case TokenPrimaryGroup: return sidPointer(PRIMARY_GROUP_SID);
        case TokenType: return dword(TOKEN_PRIMARY);
        case TokenSessionId: return dword(1);
        case TokenElevationType: return dword(TOKEN_ELEVATION_TYPE_DEFAULT);
        case TokenElevation: return dword(0);
        case TokenIntegrityLevel: return sidAndAttributes(MEDIUM_INTEGRITY_SID, SE_GROUP_INTEGRITY);
        case TokenIsAppContainer: return dword(0);
        default: return undefined;
    }
}
