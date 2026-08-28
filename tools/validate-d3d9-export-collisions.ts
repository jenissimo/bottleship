/**
 * Guard the hand-written D3D9 export composition against duplicate ownership.
 *
 * The module index merges independent tables with Object.assign. That is
 * intentional for inherited prefixes, but a resource constructor must have a
 * single owner: a later factory would otherwise replace a real handler with a
 * fallback and the failure would depend on merge order.
 */

import { createResourcesExports } from "../src/worker/modules/d3d9/resources";
import { createVolumeExports } from "../src/worker/modules/d3d9/volume";

const volumeTextureCreate = "IDirect3DDevice9_CreateVolumeTexture";
const resources = createResourcesExports();
const volume = createVolumeExports();

if (volumeTextureCreate in resources) {
    throw new Error(
        `${volumeTextureCreate} has two owners: resources.ts and volume.ts. ` +
        "Keep the volume constructor in volume.ts only.",
    );
}
if (typeof volume[volumeTextureCreate] !== "function") {
    throw new Error(`${volumeTextureCreate} is not owned by volume.ts`);
}

console.log("validate-d3d9-export-collisions: OK (CreateVolumeTexture has one owner)");
