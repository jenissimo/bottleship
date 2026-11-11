const SIDE_MODIFIER_VK: Readonly<Record<string, number>> = {
    ShiftLeft: 0xa0,
    ShiftRight: 0xa1,
    ControlLeft: 0xa2,
    ControlRight: 0xa3,
    AltLeft: 0xa4,
    AltRight: 0xa5,
};

export function hardwareKeyVk(code: string, keyCode: number): number {
    return SIDE_MODIFIER_VK[code] ?? (keyCode & 0xff);
}
