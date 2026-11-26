/**
 * GLU32 API Descriptor (glu32.dll)
 *
 * OpenGL Utility Library. All stdcall.
 * GLdouble params use f64 (8 bytes on stack).
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const u = (name: string): ParameterDescriptor => ({ name, type: "u32" });
const i = (name: string): ParameterDescriptor => ({ name, type: "i32" });
const f = (name: string): ParameterDescriptor => ({ name, type: "f32" });
const d = (name: string): ParameterDescriptor => ({ name, type: "f64" });
const p = (name: string): ParameterDescriptor => ({ name, type: "ptr" });

const glu = (name: string, params: ParameterDescriptor[], returnType: "u32" | "void" = "void"): FunctionDescriptor => ({
    name,
    params,
    returnType,
    callingConvention: "stdcall",
});

export const glu32Module: ModuleDescriptor = {
    name: "glu32",
    functions: [
        // Matrix utilities
        glu("gluPickMatrix", [d("x"), d("y"), d("width"), d("height"), p("viewport")]),
        glu("gluPerspective", [d("fovy"), d("aspect"), d("zNear"), d("zFar")]),
        glu("gluOrtho2D", [d("left"), d("right"), d("bottom"), d("top")]),
        glu("gluLookAt", [d("eyeX"), d("eyeY"), d("eyeZ"), d("centerX"), d("centerY"), d("centerZ"), d("upX"), d("upY"), d("upZ")]),

        // Texture utilities
        glu("gluBuild2DMipmaps", [u("target"), i("internalFormat"), i("width"), i("height"), u("format"), u("type"), p("data")], "u32"),
        glu("gluScaleImage", [u("format"), i("wIn"), i("hIn"), u("typeIn"), p("dataIn"), i("wOut"), i("hOut"), u("typeOut"), p("dataOut")], "u32"),

        // Projection utilities
        glu("gluProject", [d("objX"), d("objY"), d("objZ"), p("model"), p("proj"), p("view"), p("winX"), p("winY"), p("winZ")], "u32"),
        glu("gluUnProject", [d("winX"), d("winY"), d("winZ"), p("model"), p("proj"), p("view"), p("objX"), p("objY"), p("objZ")], "u32"),

        // Quadric objects
        glu("gluNewQuadric", [], "u32"),
        glu("gluDeleteQuadric", [u("quad")]),
        glu("gluQuadricNormals", [u("quad"), u("normal")]),
        glu("gluQuadricTexture", [u("quad"), u("texture")]),
        glu("gluQuadricOrientation", [u("quad"), u("orientation")]),
        glu("gluQuadricDrawStyle", [u("quad"), u("draw")]),
        glu("gluSphere", [u("quad"), d("radius"), i("slices"), i("stacks")]),
        glu("gluCylinder", [u("quad"), d("base"), d("top"), d("height"), i("slices"), i("stacks")]),
        glu("gluDisk", [u("quad"), d("inner"), d("outer"), i("slices"), i("loops")]),
        glu("gluPartialDisk", [u("quad"), d("inner"), d("outer"), i("slices"), i("loops"), d("start"), d("sweep")]),

        // Error/string
        glu("gluErrorString", [u("error")], "u32"),
        glu("gluGetString", [u("name")], "u32"),

        // NURBS (stubs)
        glu("gluNewNurbsRenderer", [], "u32"),
        glu("gluDeleteNurbsRenderer", [u("nurb")]),
        glu("gluNurbsProperty", [u("nurb"), u("property"), f("value")]),

        // Tesselator (stubs)
        glu("gluNewTess", [], "u32"),
        glu("gluDeleteTess", [u("tess")]),
    ]
};
