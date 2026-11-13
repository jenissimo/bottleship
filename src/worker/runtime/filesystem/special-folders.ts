/**
 * The shell folders this system has, by CSIDL. One table for both ways a program finds them:
 * shell32's SHGetFolderPath/SHGetSpecialFolderPath and the registry's
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders, which older
 * programs (Flash Player projectors among them) read instead of calling shell32.
 */
export const CSIDL_PERSONAL = 0x05;
export const CSIDL_APPDATA = 0x1a;
export const CSIDL_LOCAL_APPDATA = 0x1c;
export const CSIDL_WINDOWS = 0x24;
export const CSIDL_SYSTEM = 0x25;
export const CSIDL_PROGRAM_FILES = 0x26;

/** The folder a CSIDL names (flags in the high byte ignored), or undefined when we have none. */
export function specialFolderPath(csidl: number): string | undefined {
    switch (csidl & 0xff) {
        case CSIDL_PERSONAL: return "C:\\My Documents";
        case CSIDL_APPDATA: return "C:\\Windows\\Application Data";
        case CSIDL_LOCAL_APPDATA: return "C:\\Windows\\Local Settings\\Application Data";
        case CSIDL_WINDOWS: return "C:\\Windows";
        case CSIDL_SYSTEM: return "C:\\Windows\\System";
        case CSIDL_PROGRAM_FILES: return "C:\\Program Files";
        default: return undefined;
    }
}

/** The per-user folders as Windows lists them under Explorer\Shell Folders: value name → CSIDL. */
export const SHELL_FOLDERS_VALUES: ReadonlyArray<readonly [string, number]> = [
    ["AppData", CSIDL_APPDATA],
    ["Local AppData", CSIDL_LOCAL_APPDATA],
    ["Personal", CSIDL_PERSONAL],
];
