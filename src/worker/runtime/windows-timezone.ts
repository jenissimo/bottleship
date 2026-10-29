/** The time zone the Windows HLE reports (GetTimeZoneInformation's fixed-offset model:
 * the host's current offset, no transition dates, no display names). The CRT reads the
 * same snapshot so _timezone and the Win32 bias cannot disagree.
 */
export interface WindowsTimezoneSnapshot {
    biasMinutes: number;
    standardBiasMinutes: number;
    daylightBiasMinutes: number;
    standardName: string;
    daylightName: string;
    hasDaylightTransitions: boolean;
}
export function readWindowsTimezoneSnapshot(): WindowsTimezoneSnapshot {
    return { biasMinutes: new Date().getTimezoneOffset(), standardBiasMinutes: 0,
        daylightBiasMinutes: 0, standardName: "", daylightName: "", hasDaylightTransitions: false };
}
