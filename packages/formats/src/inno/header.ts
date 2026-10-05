/** Setup global header — ported from innoextract setup/header.cpp */

import type { BinaryReader, WindowsVersionRange } from "./binary-reader";
import type { InnoVersion } from "./version";
import { INNO_VERSION_EXT } from "./version";

/** stream/chunk.hpp — compression_method enum (Stored=0 … LZMA2=4) */
export const CompressionMethod = {
    Stored: 0,
    Zlib: 1,
    BZip2: 2,
    LZMA1: 3,
    LZMA2: 4,
    Unknown: 5,
} as const;

export interface InnoHeader {
    appName: string;
    appVersionedName: string;
    appId: string;
    appCopyright: string;
    appPublisher: string;
    appPublisherUrl: string;
    appSupportPhone: string;
    appSupportUrl: string;
    appUpdatesUrl: string;
    appVersion: string;
    defaultDirName: string;
    defaultGroupName: string;
    baseFilename: string;
    uninstallFilesDir: string;
    uninstallName: string;
    uninstallIcon: string;
    appMutex: string;
    defaultUserName: string;
    defaultUserOrganisation: string;
    defaultSerial: string;
    appReadmeFile: string;
    appContact: string;
    appComments: string;
    appModifyPath: string;
    createUninstallRegistryKey: string;
    uninstallable: string;
    closeApplicationsFilter: string;
    setupMutex: string;
    changesEnvironment: string;
    changesAssociations: string;
    architecturesAllowedExpr: string;
    architecturesInstalledIn64BitModeExpr: string;
    compiledCode: string;
    languageCount: number;
    messageCount: number;
    permissionCount: number;
    typeCount: number;
    componentCount: number;
    taskCount: number;
    directoryCount: number;
    fileCount: number;
    dataEntryCount: number;
    iconCount: number;
    iniEntryCount: number;
    registryEntryCount: number;
    deleteEntryCount: number;
    uninstallDeleteEntryCount: number;
    runEntryCount: number;
    uninstallRunEntryCount: number;
    winver: WindowsVersionRange;
    compression: number;
    options: number;
    licenseText: string;
    infoBefore: string;
    infoAfter: string;
    passwordType: string;
    passwordHash: Uint8Array;
    passwordSalt: Uint8Array;
    extraDiskSpaceRequired: bigint;
    slicesPerDisk: number;
    uninstallDisplaySize: bigint;
}

function loadFlags(r: BinaryReader, version: InnoVersion): number {
    const fr = r.storedFlagReader(version.bits());
    let options = 0;
    const add = (cond = true, flag = 0) => {
        if (cond) fr.add(flag);
    };
    const before = (a: number, b: number, c: number, d = 0) =>
        version.value < INNO_VERSION_EXT(a, b, c, d);

    add();
    add(before(5, 3, 10));
    add();
    add(before(5, 3, 3));
    add(before(1, 3, 6));
    add(before(5, 3, 3));
    add();
    add(before(3, 0, 0) || version.atLeast(3, 0, 3));
    add(before(1, 3, 3));
    add();
    if (version.value < INNO_VERSION_EXT(6, 4, 0, 1)) {
        add(); add(); add(); add();
    }
    add();
    add(before(4, 1, 2));
    add();
    add(version.atLeast(1, 2, 6));
    add(version.atLeast(1, 2, 14));
    if (version.bits() !== 16) {
        add(before(3, 0, 4));
        add(before(3, 0, 0));
        add(before(1, 3, 6));
        add(before(5, 6, 1));
    }
    add(version.atLeast(1, 3, 0) && before(5, 3, 8));
    add(version.atLeast(1, 3, 1));
    add(version.atLeast(1, 3, 3) && before(6, 4, 0, 1));
    add(version.atLeast(1, 3, 10));
    add(version.atLeast(1, 3, 20));
    add(version.atLeast(2, 0, 0) || (version.isIsx() && version.atLeast(1, 3, 10)));
    if (version.atLeast(2, 0, 0)) for (let i = 0; i < 6; i++) add();
    if (version.atLeast(2, 0, 7)) {
        add(); add();
    }
    add(version.atLeast(2, 0, 17) && before(4, 1, 5));
    add(version.atLeast(2, 0, 18));
    if (version.atLeast(3, 0, 0)) {
        add(); add();
    }
    add(version.atLeast(3, 0, 1));
    add(version.atLeast(3, 0, 3));
    add(version.atLeast(4, 0, 0) || (version.isIsx() && version.atLeast(3, 0, 3)));
    add(version.atLeast(4, 0, 0) && before(4, 0, 10));
    add(version.atLeast(4, 0, 1) && before(4, 0, 10));
    add(version.atLeast(4, 0, 9));
    add(version.atLeast(4, 1, 3));
    if (version.atLeast(4, 1, 8)) {
        add(); add();
    }
    add(version.atLeast(4, 2, 2), 1 << 5);
    add(version.atLeast(5, 0, 4) && before(5, 6, 1));
    add(version.atLeast(5, 1, 7) && !version.isUnicode());
    add(version.atLeast(5, 1, 13));
    add(version.atLeast(5, 2, 1));
    add(version.atLeast(5, 3, 8));
    add(version.atLeast(5, 3, 9));
    if (version.atLeast(5, 5, 0)) {
        add(); add(); add();
    }
    add(version.atLeast(5, 5, 7));
    if (version.atLeast(6, 0, 0)) {
        add(); add(); add();
    }
    add(version.atLeast(6, 3, 0));
    options |= fr.finalize();
    return options;
}

export function loadHeader(r: BinaryReader, version: InnoVersion, codepage: number): InnoHeader {
    const bits = version.bits();
    const cp = codepage;
    const appName = r.encodedString(cp);
    const appVersionedName = r.encodedString(cp);
    const appId = version.atLeast(1, 3, 0) ? r.encodedString(cp) : "";
    const appCopyright = r.encodedString(cp);
    const appPublisher = version.atLeast(1, 3, 0) ? r.encodedString(cp) : "";
    const appPublisherUrl = version.atLeast(1, 3, 0) ? r.encodedString(cp) : "";
    const appSupportPhone = version.atLeast(5, 1, 13) ? r.encodedString(cp) : "";
    const appSupportUrl = version.atLeast(1, 3, 0) ? r.encodedString(cp) : "";
    const appUpdatesUrl = version.atLeast(1, 3, 0) ? r.encodedString(cp) : "";
    const appVersion = version.atLeast(1, 3, 0) ? r.encodedString(cp) : "";
    const defaultDirName = r.encodedString(cp);
    const defaultGroupName = r.encodedString(cp);
    if (version.value < INNO_VERSION_EXT(3, 0, 0, 0)) r.ansiString();
    const baseFilename = r.encodedString(cp);
    if (version.atLeast(1, 3, 0) && version.value < INNO_VERSION_EXT(5, 2, 5, 0)) {
        r.ansiString();
        r.ansiString();
        r.ansiString();
    }
    const uninstallFilesDir = version.atLeast(1, 3, 3) ? r.encodedString(cp) : "";
    const uninstallName = version.atLeast(1, 3, 6) ? r.encodedString(cp) : "";
    const uninstallIcon = version.atLeast(1, 3, 6) ? r.encodedString(cp) : "";
    const appMutex = version.atLeast(1, 3, 14) ? r.encodedString(cp) : "";
    const defaultUserName = version.atLeast(3, 0, 0) ? r.encodedString(cp) : "";
    const defaultUserOrganisation = version.atLeast(3, 0, 0) ? r.encodedString(cp) : "";
    const defaultSerial =
        version.atLeast(4, 0, 0) || (version.isIsx() && version.atLeast(3, 0, 6, 1)) ? r.encodedString(cp) : "";
    let compiledCode = "";
    if (
        (version.atLeast(4, 0, 0) && version.value < INNO_VERSION_EXT(5, 2, 5, 0)) ||
        (version.isIsx() && version.atLeast(1, 3, 24))
    ) {
        compiledCode = r.encodedString(cp);
    }
    const appReadmeFile = version.atLeast(4, 2, 4) ? r.encodedString(cp) : "";
    const appContact = version.atLeast(4, 2, 4) ? r.encodedString(cp) : "";
    const appComments = version.atLeast(4, 2, 4) ? r.encodedString(cp) : "";
    const appModifyPath = version.atLeast(4, 2, 4) ? r.encodedString(cp) : "";
    const createUninstallRegistryKey = version.atLeast(5, 3, 8) ? r.encodedString(cp) : "";
    const uninstallable = version.atLeast(5, 3, 10) ? r.encodedString(cp) : "";
    const closeApplicationsFilter = version.atLeast(5, 5, 0) ? r.encodedString(cp) : "";
    const setupMutex = version.atLeast(5, 5, 6) ? r.encodedString(cp) : "";
    const changesEnvironment = version.atLeast(5, 6, 1) ? r.encodedString(cp) : "";
    const changesAssociations = version.atLeast(5, 6, 1) ? r.encodedString(cp) : "";
    const architecturesAllowedExpr = version.atLeast(6, 3, 0) ? r.encodedString(cp) : "";
    const architecturesInstalledIn64BitModeExpr = version.atLeast(6, 3, 0) ? r.encodedString(cp) : "";
    let licenseText = "";
    let infoBefore = "";
    let infoAfter = "";
    if (version.atLeast(5, 2, 5)) {
        licenseText = r.ansiString();
        infoBefore = r.ansiString();
        infoAfter = r.ansiString();
    }
    if (version.atLeast(5, 2, 1) && version.value < INNO_VERSION_EXT(5, 3, 10, 0)) r.encodedString(cp);
    if (version.atLeast(5, 2, 5)) compiledCode = r.encodedString(cp);
    if (version.atLeast(2, 0, 6) && !version.isUnicode()) {
        r.readBytes(32);
    }
    const languageCount = version.atLeast(4, 0, 0) ? r.u32() : version.atLeast(2, 0, 1) ? 1 : 0;
    const messageCount = version.atLeast(4, 2, 1) ? r.u32() : 0;
    const permissionCount = version.atLeast(4, 1, 0) ? r.u32() : 0;
    const typeCount = version.atLeast(2, 0, 0) || version.isIsx() ? r.u32() : 0;
    const componentCount = version.atLeast(2, 0, 0) || version.isIsx() ? r.u32() : 0;
    const taskCount =
        version.atLeast(2, 0, 0) || (version.isIsx() && version.atLeast(1, 3, 17)) ? r.u32() : 0;
    const directoryCount = r.loadU32(bits);
    const fileCount = r.loadU32(bits);
    const dataEntryCount = r.loadU32(bits);
    const iconCount = r.loadU32(bits);
    const iniEntryCount = r.loadU32(bits);
    const registryEntryCount = r.loadU32(bits);
    const deleteEntryCount = r.loadU32(bits);
    const uninstallDeleteEntryCount = r.loadU32(bits);
    const runEntryCount = r.loadU32(bits);
    const uninstallRunEntryCount = r.loadU32(bits);
    const winver = r.loadWindowsVersionRange(version.atLeast(1, 3, 19));
    if (version.value < INNO_VERSION_EXT(6, 4, 0, 1)) r.u32();
    if (version.atLeast(1, 3, 3) && version.value < INNO_VERSION_EXT(6, 4, 0, 1)) r.u32();
    if (version.value < INNO_VERSION_EXT(5, 5, 7, 0)) r.u32();
    if ((version.atLeast(2, 0, 0) && version.value < INNO_VERSION_EXT(5, 0, 4, 0)) || version.isIsx()) r.u32();
    if (version.atLeast(6, 0, 0)) {
        r.storedEnum([0, 1], 0);
        r.u32();
        r.u32();
    }
    if (version.atLeast(5, 5, 7)) r.storedEnum([0, 1, 2], 0);
    let passwordType = "crc32";
    let passwordHash: Uint8Array = new Uint8Array(4);
    let passwordSalt: Uint8Array = new Uint8Array(0);
    if (version.atLeast(6, 4, 0)) {
        passwordHash = r.readBytes(4);
        passwordType = "pbkdf2";
        passwordSalt = r.readBytes(44);
    } else if (version.atLeast(5, 3, 9)) {
        passwordHash = r.readBytes(20);
        passwordType = "sha1";
    } else if (version.atLeast(4, 2, 0)) {
        passwordHash = r.readBytes(16);
        passwordType = "md5";
    } else {
        passwordHash = new Uint8Array(4);
        new DataView(passwordHash.buffer).setUint32(0, r.u32(), true);
    }
    if (version.atLeast(4, 2, 2) && version.value < INNO_VERSION_EXT(6, 4, 0, 0)) passwordSalt = r.readBytes(8);
    const extraDiskSpaceRequired = version.atLeast(4, 0, 0) ? r.i64() : BigInt(r.i32());
    const slicesPerDisk = version.atLeast(4, 0, 0) ? r.u32() : 1;
    if ((version.atLeast(2, 0, 0) && version.value < INNO_VERSION_EXT(5, 0, 0, 0)) || version.isIsx())
        r.storedEnum([0, 1, 2], 0);
    if (version.atLeast(1, 3, 0)) r.storedEnum([0, 1, 2], 0);
    if (version.atLeast(5, 0, 0)) {
        /* ModernStyle */
    } else if (version.atLeast(2, 0, 0) || (version.isIsx() && version.atLeast(1, 3, 13))) r.storedEnum([0, 1], 0);
    if (version.atLeast(1, 3, 6)) r.storedEnum([0, 1, 2], 0);
    if (version.atLeast(5, 3, 7)) r.storedEnum([0, 1, 2, 3], 0);
    else if (version.atLeast(3, 0, 4) || (version.isIsx() && version.atLeast(3, 0, 3))) r.storedEnum([0, 1, 2], 0);
    if (version.atLeast(5, 7, 0)) r.storedFlags([1, 2], 32);
    if (version.atLeast(4, 0, 10)) {
        r.storedEnum([0, 1, 2], 0);
        r.storedEnum([0, 1, 2], 0);
    }
    let compression: number = CompressionMethod.LZMA2;
    if (version.atLeast(5, 3, 9)) compression = r.storedEnum([0, 1, 2, 3, 4, 5], 0);
    else if (version.atLeast(4, 2, 6)) compression = r.storedEnum([0, 1, 2, 3, 4], 0);
    else if (version.atLeast(4, 2, 5)) compression = r.storedEnum([0, 1, 2, 3], 0);
    else if (version.atLeast(4, 1, 5)) compression = r.storedEnum([0, 1, 2, 3], 0);
    if (version.atLeast(6, 3, 0)) {
        /* expr */
    } else if (version.atLeast(5, 6, 0)) {
        r.storedFlags([1, 2, 4, 8, 16], 32);
        r.storedFlags([1, 2, 4, 8, 16], 32);
    } else if (version.atLeast(5, 1, 0)) {
        r.storedFlags([1, 2, 4, 8], 32);
        r.storedFlags([1, 2, 4, 8], 32);
    }
    if (version.atLeast(5, 2, 1) && version.value < INNO_VERSION_EXT(5, 3, 10, 0)) {
        r.u32();
        r.u32();
    }
    if (version.atLeast(5, 3, 3)) {
        r.storedEnum([0, 1, 2], 0);
        r.storedEnum([0, 1, 2], 0);
    }
    let uninstallDisplaySize = 0n;
    if (version.atLeast(5, 5, 0)) uninstallDisplaySize = r.u64();
    else if (version.atLeast(5, 3, 6)) uninstallDisplaySize = BigInt(r.u32());
    const options = loadFlags(r, version);
    return {
        appName,
        appVersionedName,
        appId,
        appCopyright,
        appPublisher,
        appPublisherUrl,
        appSupportPhone,
        appSupportUrl,
        appUpdatesUrl,
        appVersion,
        defaultDirName,
        defaultGroupName,
        baseFilename,
        uninstallFilesDir,
        uninstallName,
        uninstallIcon,
        appMutex,
        defaultUserName,
        defaultUserOrganisation,
        defaultSerial,
        appReadmeFile,
        appContact,
        appComments,
        appModifyPath,
        createUninstallRegistryKey,
        uninstallable,
        closeApplicationsFilter,
        setupMutex,
        changesEnvironment,
        changesAssociations,
        architecturesAllowedExpr,
        architecturesInstalledIn64BitModeExpr,
        compiledCode,
        languageCount,
        messageCount,
        permissionCount,
        typeCount,
        componentCount,
        taskCount,
        directoryCount,
        fileCount,
        dataEntryCount,
        iconCount,
        iniEntryCount,
        registryEntryCount,
        deleteEntryCount,
        uninstallDeleteEntryCount,
        runEntryCount,
        uninstallRunEntryCount,
        winver,
        compression,
        options,
        licenseText,
        infoBefore,
        infoAfter,
        passwordType,
        passwordHash,
        passwordSalt,
        extraDiskSpaceRequired,
        slicesPerDisk,
        uninstallDisplaySize,
    };
}

export function encryptionUsed(options: number): boolean {
    return (options & (1 << 37)) !== 0; // header.hpp: EncryptionUsed
}
