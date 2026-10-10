import type {D3D9Device} from '../../backends/webgpu/d3d9/d3d9-device';
import type {EffectParameter} from './effect-state';
import {evaluatePreshader,PresTable,type Preshader} from './effect-preshader';

interface OutputRange {
    table: PresTable;
    start: number;
    data: Float32Array|Int32Array;
}
const noFloatOutput=new Float32Array(0);
const noGuestMemory=new Uint8Array(0);

/** A shader PRES owns only the registers it writes, not the gaps before its highest output. */
export class ShaderPreshader {
    private ranges: OutputRange[]=[];

    constructor(private pres: Preshader) {
        for(const table of [PresTable.OConst,PresTable.OIConst,PresTable.OBConst]) {
            const width=table===PresTable.OBConst?1:4;
            const registers=[...new Set(pres.instructions.filter(i=>i.output.table===table)
                .map(i=>Math.floor(i.output.offset/width)))].sort((a,b)=>a-b);
            for(let i=0;i<registers.length;) {
                const start=registers[i++]!;
                let end=start+1;
                while(i<registers.length&&registers[i]===end) {i++;end++;}
                const length=(end-start)*width;
                this.ranges.push({table,start,data:table===PresTable.OConst
                    ?new Float32Array(length):new Int32Array(length)});
            }
        }
    }

    apply(device: D3D9Device,parameters: readonly EffectParameter[],vertex: boolean): boolean {
        if(!evaluatePreshader(this.pres,parameters,noFloatOutput))return false;
        for(const {table,start,data} of this.ranges) {
            const width=table===PresTable.OBConst?1:4;
            const source=this.pres.registers[table]!;
            for(let i=0;i<data.length;i++)data[i]=source[start*width+i]!;
            if(table===PresTable.OConst) {
                if(vertex)device.setVertexShaderConstantFFromArray(start,data as Float32Array,noGuestMemory);
                else device.setPixelShaderConstantFFromArray(start,data as Float32Array,noGuestMemory);
            } else if(table===PresTable.OIConst) {
                if(vertex)device.setVertexShaderConstantIFromArray(start,data as Int32Array);
                else device.setPixelShaderConstantIFromArray(start,data as Int32Array);
            } else {
                if(vertex)device.setVertexShaderConstantBFromArray(start,data as Int32Array);
                else device.setPixelShaderConstantBFromArray(start,data as Int32Array);
            }
        }
        return true;
    }
}
