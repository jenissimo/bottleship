/**
 * The one timestamp every VFS file reports, for creation, access and write alike.
 *
 * The VFS records no per-file times, so every surface that exposes one (WIN32_FIND_DATA,
 * GetFileTime, BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, the CRT's _stat/_finddata)
 * reports this instant — the same one, so the Win32 and CRT views of a file cannot
 * disagree. It must never be zero: NTFS does not report a zero FILETIME, and the CRT maps
 * one to time_t -1, which localtime() answers with NULL.
 */
export const VFS_FILE_TIME_UNIX_SECONDS = 1577836800; // 2020-01-01T00:00:00Z

/** FILETIME: 100 ns ticks since 1601-01-01 UTC. */
export const VFS_FILETIME = (BigInt(VFS_FILE_TIME_UNIX_SECONDS) + 11644473600n) * 10_000_000n;
