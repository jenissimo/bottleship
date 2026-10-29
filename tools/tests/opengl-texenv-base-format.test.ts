import { describe, expect, test } from "bun:test";
import { OpenGLBackendExecutor } from "../../src/worker/backends/webgpu/opengl/opengl-backend-executor";
import { baseInternalFormat, BaseFormat } from "../../src/worker/modules/opengl32/texture";
import {
    GL_RGB, GL_RGBA, GL_RGB8, GL_RGBA8, GL_ALPHA, GL_ALPHA8, GL_LUMINANCE, GL_LUMINANCE8,
    GL_LUMINANCE_ALPHA, GL_INTENSITY, GL_INTENSITY8,
} from "../../src/worker/modules/opengl32/constants";
import { probeOfflineWgslValidator, validateWgslOffline } from "../d3d9-parity/wgsl-validator";

/**
 * The classic texture functions read the texture's BASE format, not just its texels: a
 * GL_ALPHA font under GL_MODULATE draws in the current glColor (C = Cf, A = Af·At), so a
 * shader that multiplies by the stored rgb = 0 draws every glyph black.
 */
describe("GL texture base format reaches the fragment shader", () => {
    test("internal formats resolve to the base format the shader is told", () => {
        expect(baseInternalFormat(GL_ALPHA)).toBe(BaseFormat.ALPHA);
        expect(baseInternalFormat(GL_ALPHA8)).toBe(BaseFormat.ALPHA);
        expect(baseInternalFormat(GL_LUMINANCE)).toBe(BaseFormat.LUMINANCE);
        expect(baseInternalFormat(GL_LUMINANCE8)).toBe(BaseFormat.LUMINANCE);
        expect(baseInternalFormat(1)).toBe(BaseFormat.LUMINANCE);
        expect(baseInternalFormat(GL_LUMINANCE_ALPHA)).toBe(BaseFormat.LUMINANCE_ALPHA);
        expect(baseInternalFormat(2)).toBe(BaseFormat.LUMINANCE_ALPHA);
        expect(baseInternalFormat(GL_INTENSITY)).toBe(BaseFormat.INTENSITY);
        expect(baseInternalFormat(GL_INTENSITY8)).toBe(BaseFormat.INTENSITY);
        expect(baseInternalFormat(GL_RGB)).toBe(BaseFormat.RGB);
        expect(baseInternalFormat(GL_RGB8)).toBe(BaseFormat.RGB);
        expect(baseInternalFormat(3)).toBe(BaseFormat.RGB);
        expect(baseInternalFormat(GL_RGBA)).toBe(BaseFormat.RGBA);
        expect(baseInternalFormat(GL_RGBA8)).toBe(BaseFormat.RGBA);
        expect(baseInternalFormat(4)).toBe(BaseFormat.RGBA);
    });

    test("a zeroed format uniform means RGBA", () => {
        expect(BaseFormat.RGBA).toBe(0);
    });

    test("the GL shader takes each unit's format and validates", () => {
        const wgsl = (OpenGLBackendExecutor.prototype as unknown as { buildShaderCode(): string })
            .buildShaderCode.call(null);
        expect(wgsl).toContain("texFormat0: u32,        // 100..104");
        expect(wgsl).toContain("uniforms.envColor0, uniforms.texFormat0)");
        expect(wgsl).toContain("uniforms.envColor1, uniforms.texFormat1)");
        const validator = probeOfflineWgslValidator();
        if (validator.available) {
            const result = validateWgslOffline(wgsl, validator);
            expect(result.status, result.diagnostics ?? result.reason).toBe("passed");
        }
    });
});
