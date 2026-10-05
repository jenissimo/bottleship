import type { D3DMaterial7Data, D3DLight7Data } from "./types";
import type { RGBA } from "../../../backends/webgpu/ddraw/types";

/**
 * Encapsulates all state required for D3D Fixed-Function Lighting (FFP) emulation.
 * This state is collected from D3D devices (D3D7/D3D8) and passed to the WebGPU backend.
 */
export interface FFPLightingState {
    /** Whether lighting is globally enabled (D3DRENDERSTATE_LIGHTING) */
    lightingEnabled: boolean;
    /** Current active material */
    material: D3DMaterial7Data;
    /** List of all defined and enabled lights (max 8 supported by emulation) */
    lights: D3DLight7Data[];
    /** Global ambient lighting color (D3DRENDERSTATE_AMBIENT) */
    ambientColor: RGBA;
    /** Current World transformation matrix (for normal transformation) */
    worldMatrix: Float32Array;
    /** World×View matrix (camera/eye space) for D3DTSS_TCI_CAMERASPACE* texgen.
     *  Null when the device has no view transform available. */
    worldViewMatrix?: Float32Array | null;
    /** View matrix alone (world→view). Used to transform lights world→view so the FFP
     *  lighting path (which lights in view space) sees lights in the same space as the
     *  view-space vertex position/normal. Null when no view transform is available. */
    viewMatrix?: Float32Array | null;
    /**
     * Source of material properties for diffuse/ambient/specular/emissive.
     * 0 = MATERIAL (from SetMaterial)
     * 1 = COLOR1 (from vertex diffuse)
     * 2 = COLOR2 (from vertex specular)
     */
    diffuseSource: number;
    ambientSource: number;
    specularSource: number;
    emissiveSource: number;
}

/**
 * Interface for D3D devices to provide FFP lighting state to the backend executor.
 */
export interface FFPLightingSource {
    /**
     * Fetches current lighting state.
     * @returns The FFP lighting state or null if lighting is fully disabled.
     */
    getFFPLightingState(): FFPLightingState | null;
}
