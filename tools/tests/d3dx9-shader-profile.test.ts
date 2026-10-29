/**
 * D3DXGetPixelShaderProfile / D3DXGetVertexShaderProfile pick the profile from the device
 * caps alone (Wine d3dx9 shader.c, observed behaviour).
 */
import { describe, expect, test } from "bun:test";
import { pixelShaderProfile, vertexShaderProfile } from "../../src/worker/modules/d3dx9/compile-shader";

const ARBITRARYSWIZZLE = 1, GRADIENTINSTRUCTIONS = 2, PREDICATION = 4, NODEPENDENTREADLIMIT = 8,
    NOTEXINSTRUCTIONLIMIT = 16;
const PS_2_A = ARBITRARYSWIZZLE | GRADIENTINSTRUCTIONS | PREDICATION | NODEPENDENTREADLIMIT | NOTEXINSTRUCTIONLIMIT;

function psCaps(version: number, flags = 0, temps = 12, slots = 96): DataView {
    const caps = new DataView(new ArrayBuffer(304));
    caps.setUint32(204, (0xffff0000 | version) >>> 0, true);
    caps.setUint32(264, flags, true);
    caps.setInt32(268, 0, true);
    caps.setInt32(272, temps, true);
    caps.setInt32(280, slots, true);
    return caps;
}

describe("D3DX shader profiles", () => {
    test("pixel shader 2.x profiles follow temps and PS20Caps", () => {
        expect(pixelShaderProfile(psCaps(0x0200))).toBe("ps_2_0");
        expect(pixelShaderProfile(psCaps(0x0200, PS_2_A, 22))).toBe("ps_2_a");
        expect(pixelShaderProfile(psCaps(0x0200, PS_2_A & ~PREDICATION, 22))).toBe("ps_2_0");
        expect(pixelShaderProfile(psCaps(0x0200, PS_2_A, 21))).toBe("ps_2_0");
        expect(pixelShaderProfile(psCaps(0x0200, NOTEXINSTRUCTIONLIMIT, 32))).toBe("ps_2_b");
        expect(pixelShaderProfile(psCaps(0x0200, 0, 32, 512))).toBe("ps_2_0");
        expect(pixelShaderProfile(psCaps(0x0200, PS_2_A, 32))).toBe("ps_2_a");
    });

    test("other pixel shader versions", () => {
        expect(pixelShaderProfile(psCaps(0x0101))).toBe("ps_1_1");
        expect(pixelShaderProfile(psCaps(0x0104))).toBe("ps_1_4");
        expect(pixelShaderProfile(psCaps(0x0300))).toBe("ps_3_0");
        expect(pixelShaderProfile(psCaps(0))).toBeNull();
    });

    test("vertex shader 2.x profile", () => {
        const caps = new DataView(new ArrayBuffer(304));
        caps.setUint32(196, 0xfffe0200, true);
        expect(vertexShaderProfile(caps)).toBe("vs_2_0");
        caps.setUint32(248, 1, true);
        caps.setInt32(252, 24, true);
        caps.setInt32(256, 13, true);
        expect(vertexShaderProfile(caps)).toBe("vs_2_a");
    });
});
