/** Identity exposed to legacy driver databases; capabilities are supplied by the renderer. */
export interface GraphicsAdapterConfig {
    vendorId: number;
    deviceId: number;
    description: string;
    driver: string;
    driverVersion: [number, number, number, number];
}

/** Accept a complete identity so a manifest cannot mix one vendor with another's driver. */
export function normalizeGraphicsAdapter(value: unknown): GraphicsAdapterConfig | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Partial<GraphicsAdapterConfig>;
    const word = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffff;
    const text = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 &&
        !s.includes('\0') && new TextEncoder().encode(s).length < 512;
    if (!word(v.vendorId) || !word(v.deviceId) || !text(v.description) || !text(v.driver) ||
        /[\\/]/.test(v.driver) || !Array.isArray(v.driverVersion) || v.driverVersion.length !== 4 ||
        !Array.from(v.driverVersion).every(word)) return null;
    return {
        vendorId: v.vendorId, deviceId: v.deviceId, description: v.description, driver: v.driver,
        driverVersion: [...v.driverVersion] as GraphicsAdapterConfig['driverVersion'],
    };
}
