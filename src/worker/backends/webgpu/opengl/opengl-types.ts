import { GLCommandStream, GLTextureObject } from "../../../modules/opengl32/context";

export interface OpenGLFrameInput {
    commands: GLCommandStream;
    /** Backing store of the frame vertex arena; DRAW records index into it. */
    vertArena: Float32Array;
    textures: Map<number, GLTextureObject>;
}
