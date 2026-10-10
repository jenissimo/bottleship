import {dxSrgbViewFormats} from '../shared/dx-sampler';

export interface PaddedColorSource {
    texture: GPUTexture;
    format: GPUTextureFormat;
    layer: number;
}

/** Keep the real oversized depth/stencil attachment; copy only the logical color rectangle. */
export class DepthColorPadding {
    private device: GPUDevice | null = null;
    private textures = new Map<string,GPUTexture>();

    prepare(device: GPUDevice, encoder: GPUCommandEncoder, sources: Array<PaddedColorSource|null>,
        width: number, height: number): Array<GPUTextureView|null> {
        if (this.device!==device) { this.destroy(); this.device=device; }
        return sources.map((source,slot)=>{
            if (!source) return null;
            const {texture,format,layer}=source;
            if (texture.width>width || texture.height>height || texture.sampleCount!==1) {
                throw new Error('oversized depth color padding requires a contained single-sample target');
            }
            const key=`${slot}:${width}:${height}:${texture.format}`;
            let padded=this.textures.get(key);
            if (!padded) {
                padded=device.createTexture({size:{width,height},format:texture.format,
                    viewFormats:dxSrgbViewFormats(texture.format),
                    usage:GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
                this.textures.set(key,padded);
            }
            encoder.copyTextureToTexture({texture,origin:{x:0,y:0,z:layer}},{texture:padded},
                {width:texture.width,height:texture.height,depthOrArrayLayers:1});
            return padded.createView({format});
        });
    }

    restore(encoder: GPUCommandEncoder, sources: Array<PaddedColorSource|null>, width: number, height: number): void {
        sources.forEach((source,slot)=>{
            if (!source) return;
            const {texture,layer}=source;
            const padded=this.textures.get(`${slot}:${width}:${height}:${texture.format}`)!;
            encoder.copyTextureToTexture({texture:padded},{texture,origin:{x:0,y:0,z:layer}},
                {width:texture.width,height:texture.height,depthOrArrayLayers:1});
        });
    }

    destroy(): void {
        for (const texture of this.textures.values()) texture.destroy();
        this.textures.clear();
        this.device=null;
    }
}
