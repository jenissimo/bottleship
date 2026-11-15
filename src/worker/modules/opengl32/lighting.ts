import { type OpenGLContext, type GLLightState, VERT_FLOATS, VERT_SECONDARY_COLOR, mat4Multiply } from "./context";

// Vertex lighting is evaluated on owned object-space draw data, never on the CVA cache.
// The scratch is synchronous and reused; no allocation occurs per vertex.
const LIGHTING=0x0b50, LIGHT0=0x4000, NORMALIZE=0x0ba1, RESCALE_NORMAL=0x803a;
const COLOR_MATERIAL=0x0b57, FRONT=0x0404, BACK=0x0405, FRONT_AND_BACK=0x0408;
const AMBIENT=0x1200, DIFFUSE=0x1201, SPECULAR=0x1202, EMISSION=0x1600, AMBIENT_AND_DIFFUSE=0x1602;
const LOCAL_VIEWER=0x0b51, TWO_SIDE=0x0b52, COLOR_CONTROL=0x81f8, SEPARATE_SPECULAR=0x81fa;
const CCW=0x0901;
/** @transient(normal matrix scratch, overwritten before each lit draw) */
const normalMatrix=new Float64Array(9);
/** @transient(projected orientation scratch, overwritten before two-sided draws) */
const mvp=new Float32Array(16);
/** @transient(active light references, rebuilt before each lit draw) */
const enabledLights: GLLightState[]=[];
/** @transient(normalized light/spot directions, rebuilt before each lit draw) */
const lightVectors=new Float64Array(8*7); // normalized directional/spot vectors, cos(cutoff)
type Material={ambient:Float32Array;diffuse:Float32Array;specular:Float32Array;emission:Float32Array;shininess:number};
type Pair={front:Material;back:Material};
type ImmediateMaterials={snapshots:Pair[];index:number};
// Saved by the OpenGL participant through capture/restoreImmediateMaterials;
// context reset and every Begin/End discard its previous immediate-only entry.
// @participant(opengl32)
const immediateMaterials=new WeakMap<OpenGLContext,ImmediateMaterials>();
function material(ctx:OpenGLContext,back:boolean):Material {
    return back ? {
        ambient:ctx.materialBackAmbient,diffuse:ctx.materialBackDiffuse,
        specular:ctx.materialBackSpecular,emission:ctx.materialBackEmission,shininess:ctx.materialBackShininess,
    } : {
        ambient:ctx.materialFrontAmbient,diffuse:ctx.materialFrontDiffuse,
        specular:ctx.materialFrontSpecular,emission:ctx.materialFrontEmission,shininess:ctx.materialFrontShininess,
    };
}
function copyMaterial(m:Material):Material {
    return {ambient:m.ambient.slice(),diffuse:m.diffuse.slice(),specular:m.specular.slice(),emission:m.emission.slice(),shininess:m.shininess};
}
function snapshot(ctx:OpenGLContext):Pair {
    return {front:copyMaterial(material(ctx,false)),back:copyMaterial(material(ctx,true))};
}
/** Lazy snapshots only when glMaterial changes during an immediate primitive. */
export function beforeImmediateMaterialChange(ctx:OpenGLContext):void {
    if(!ctx.immediateMode || !ctx.enableFlags.has(LIGHTING) || immediateMaterials.has(ctx)) return;
    immediateMaterials.set(ctx,{snapshots:[snapshot(ctx)],index:0});
}
export function afterImmediateMaterialChange(ctx:OpenGLContext):void {
    const state=immediateMaterials.get(ctx);
    if(!ctx.immediateMode || !state) return;
    state.snapshots.push(snapshot(ctx)); state.index=state.snapshots.length-1;
}
export function resetImmediateMaterials(ctx:OpenGLContext):void { immediateMaterials.delete(ctx); }
export function immediateMaterialIndex(ctx:OpenGLContext):number { return immediateMaterials.get(ctx)?.index ?? 0; }
export type ImmediateMaterialSnapshot={index:number;materials:number[][]};
export function captureImmediateMaterials(ctx:OpenGLContext):ImmediateMaterialSnapshot|null {
    const state=immediateMaterials.get(ctx); if(!state) return null;
    return {index:state.index,materials:state.snapshots.map(pair=>{
        const values:number[]=[];
        for(const mat of [pair.front,pair.back]) values.push(...mat.ambient,...mat.diffuse,...mat.specular,...mat.emission,mat.shininess);
        return values;
    })};
}
export function restoreImmediateMaterials(ctx:OpenGLContext,data:ImmediateMaterialSnapshot|null):void {
    immediateMaterials.delete(ctx); if(!data || !ctx.immediateMode) return;
    if(!Array.isArray(data.materials)||data.materials.some(v=>v.length!==34||v.some(x=>!Number.isFinite(x)))||
        !Number.isInteger(data.index)||data.index<0||data.index>=data.materials.length) throw new Error("Invalid immediate lighting materials");
    function read(v:number[],b:number):Material {
        return {ambient:new Float32Array(v.slice(b,b+4)),diffuse:new Float32Array(v.slice(b+4,b+8)),
            specular:new Float32Array(v.slice(b+8,b+12)),emission:new Float32Array(v.slice(b+12,b+16)),shininess:v[b+16]};
    }
    immediateMaterials.set(ctx,{index:data.index,snapshots:data.materials.map(v=>({front:read(v,0),back:read(v,17)}))});
}

/** Column-major inverse-transpose upper-left modelview. Singular transforms have
 * undefined GL normals; use zero normals rather than propagating infinities. */
export function prepareNormalMatrix(m:ArrayLike<number>,out:Float64Array):void {
    const a=m[0],b=m[4],c=m[8],d=m[1],e=m[5],f=m[9],g=m[2],h=m[6],i=m[10];
    const A=e*i-f*h,B=f*g-d*i,C=d*h-e*g;
    const det=a*A+b*B+c*C;
    const inv=det===0?0:1/det;
    out[0]=A*inv; out[1]=(c*h-b*i)*inv; out[2]=(b*f-c*e)*inv;
    out[3]=B*inv; out[4]=(a*i-c*g)*inv; out[5]=(c*d-a*f)*inv;
    out[6]=C*inv; out[7]=(b*g-a*h)*inv; out[8]=(a*e-b*d)*inv;
}
function clamp(x:number):number { return Math.min(1,Math.max(0,x)); }
/** Orientation in homogeneous clip xyw. Unlike NDC area this survives vertices
 * behind the eye: clipping keeps the winding of the surviving polygon. */
export function triangleFrontFacing(buf:Float32Array,b:number,m:ArrayLike<number>,frontFace:number):boolean {
    const b1=b+VERT_FLOATS,b2=b1+VERT_FLOATS;
    const x0=m[0]*buf[b]+m[4]*buf[b+1]+m[8]*buf[b+2]+m[12]*buf[b+3];
    const y0=m[1]*buf[b]+m[5]*buf[b+1]+m[9]*buf[b+2]+m[13]*buf[b+3];
    const w0=m[3]*buf[b]+m[7]*buf[b+1]+m[11]*buf[b+2]+m[15]*buf[b+3];
    const x1=m[0]*buf[b1]+m[4]*buf[b1+1]+m[8]*buf[b1+2]+m[12]*buf[b1+3];
    const y1=m[1]*buf[b1]+m[5]*buf[b1+1]+m[9]*buf[b1+2]+m[13]*buf[b1+3];
    const w1=m[3]*buf[b1]+m[7]*buf[b1+1]+m[11]*buf[b1+2]+m[15]*buf[b1+3];
    const x2=m[0]*buf[b2]+m[4]*buf[b2+1]+m[8]*buf[b2+2]+m[12]*buf[b2+3];
    const y2=m[1]*buf[b2]+m[5]*buf[b2+1]+m[9]*buf[b2+2]+m[13]*buf[b2+3];
    const w2=m[3]*buf[b2]+m[7]*buf[b2+1]+m[11]*buf[b2+2]+m[15]*buf[b2+3];
    const det=x0*(y1*w2-w1*y2)-y0*(x1*w2-w1*x2)+w0*(x1*y2-y1*x2);
    return frontFace===CCW ? det>=0 : det<=0;
}

/** Call before MVP/fog overwrites positions/nx. mode is already assembled. */
export function applyLightingFlat(ctx:OpenGLContext,buf:Float32Array,offset:number,count:number,mode:number,immediate=false):void {
    if(!ctx.enableFlags.has(LIGHTING)) {
        // A reused arena must never inherit a previous draw's secondary color.
        for(let v=0,b=offset;v<count;v++,b+=VERT_FLOATS)
            buf[b+VERT_SECONDARY_COLOR]=buf[b+VERT_SECONDARY_COLOR+1]=buf[b+VERT_SECONDARY_COLOR+2]=0;
        return;
    }
    const mv=ctx.modelviewStack.stack[ctx.modelviewStack.top];
    prepareNormalMatrix(mv,normalMatrix);
    const twoSide=!!ctx.hints.get(TWO_SIDE) && mode!==0 && mode!==1 && mode!==2 && mode!==3;
    if(twoSide) mat4Multiply(mvp,ctx.projectionStack.stack[ctx.projectionStack.top],mv);
    const normalize=ctx.enableFlags.has(NORMALIZE)||ctx.enableFlags.has(RESCALE_NORMAL);
    // GL permits RESCALE_NORMAL to normalize each transformed normal instead of
    // multiplying by the uniform-scale factor (OpenGL 1.5 section 2.11.3).
    const localViewer=!!ctx.hints.get(LOCAL_VIEWER);
    const separate=ctx.hints.get(COLOR_CONTROL)===SEPARATE_SPECULAR;
    const cm=ctx.enableFlags.has(COLOR_MATERIAL), cmParam=ctx.colorMaterialParam, cmFace=ctx.colorMaterialFace;
    const front=material(ctx,false),backMaterial=material(ctx,true);
    const snapshots=immediate ? immediateMaterials.get(ctx)?.snapshots : undefined;
    enabledLights.length=0;
    for(let k=0;k<8;k++) if(ctx.enableFlags.has(LIGHT0+k)) {
        const light=ctx.lights[k],p=enabledLights.length*7; enabledLights.push(light);
        let x=light.position[0],y=light.position[1],z=light.position[2];
        const len=Math.hypot(x,y,z),inv=len?1/len:0;
        lightVectors[p]=x*inv;lightVectors[p+1]=y*inv;lightVectors[p+2]=z*inv;
        x=light.spotDirection[0];y=light.spotDirection[1];z=light.spotDirection[2];
        const sd=Math.hypot(x,y,z),si=sd?1/sd:0;
        lightVectors[p+3]=x*si;lightVectors[p+4]=y*si;lightVectors[p+5]=z*si;
        lightVectors[p+6]=Math.cos(light.spotCutoff*Math.PI/180);
    }
    let back=false;
    for(let v=0,b=offset;v<count;v++,b+=VERT_FLOATS) {
        if(twoSide && v%3===0 && v+2<count) back=!triangleFrontFacing(buf,b,mvp,ctx.frontFace);
        const pair=snapshots?.[buf[b+VERT_SECONDARY_COLOR]|0];
        const mat=pair ? (back?pair.back:pair.front) : (back?backMaterial:front);
        const tracked=cm && (cmFace===FRONT_AND_BACK || cmFace===(back?BACK:FRONT));
        const trackA=tracked&&(cmParam===AMBIENT||cmParam===AMBIENT_AND_DIFFUSE);
        const trackD=tracked&&(cmParam===DIFFUSE||cmParam===AMBIENT_AND_DIFFUSE);
        const trackS=tracked&&cmParam===SPECULAR,trackE=tracked&&cmParam===EMISSION;
        const cr=buf[b+4],cg=buf[b+5],cb=buf[b+6],ca=clamp(buf[b+7]);
        const ar=trackA?cr:mat.ambient[0],ag=trackA?cg:mat.ambient[1],ab=trackA?cb:mat.ambient[2];
        const dr=trackD?cr:mat.diffuse[0],dg=trackD?cg:mat.diffuse[1],db=trackD?cb:mat.diffuse[2];
        const sr=trackS?cr:mat.specular[0],sg=trackS?cg:mat.specular[1],sb=trackS?cb:mat.specular[2];
        let r=(trackE?cr:mat.emission[0])+ar*ctx.lightModelAmbient[0];
        let g=(trackE?cg:mat.emission[1])+ag*ctx.lightModelAmbient[1];
        let blue=(trackE?cb:mat.emission[2])+ab*ctx.lightModelAmbient[2];
        let specR=0,specG=0,specB=0;
        const ox=buf[b],oy=buf[b+1],oz=buf[b+2],ow=buf[b+3];
        const ew=mv[3]*ox+mv[7]*oy+mv[11]*oz+mv[15]*ow,invW=ew===0?1:1/ew;
        const ex=(mv[0]*ox+mv[4]*oy+mv[8]*oz+mv[12]*ow)*invW;
        const ey=(mv[1]*ox+mv[5]*oy+mv[9]*oz+mv[13]*ow)*invW;
        const ez=(mv[2]*ox+mv[6]*oy+mv[10]*oz+mv[14]*ow)*invW;
        const nx=buf[b+8],ny=buf[b+9],nz=buf[b+10],sign=back?-1:1;
        let x=(normalMatrix[0]*nx+normalMatrix[3]*ny+normalMatrix[6]*nz)*sign;
        let y=(normalMatrix[1]*nx+normalMatrix[4]*ny+normalMatrix[7]*nz)*sign;
        let z=(normalMatrix[2]*nx+normalMatrix[5]*ny+normalMatrix[8]*nz)*sign;
        if(normalize) { const len=Math.hypot(x,y,z);if(len){x/=len;y/=len;z/=len;} }
        let vx=0,vy=0,vz=1;
        if(localViewer) {const len=Math.hypot(ex,ey,ez);if(len){vx=-ex/len;vy=-ey/len;vz=-ez/len;}else{vz=0;}}
        for(let k=0;k<enabledLights.length;k++) {
            const light=enabledLights[k],p=k*7;
            let lx=lightVectors[p],ly=lightVectors[p+1],lz=lightVectors[p+2],atten=1;
            if(light.position[3]!==0) {
                const iw=1/light.position[3];
                lx=light.position[0]*iw-ex;ly=light.position[1]*iw-ey;lz=light.position[2]*iw-ez;
                const dist=Math.hypot(lx,ly,lz),inv=dist?1/dist:0;
                lx*=inv;ly*=inv;lz*=inv;
                const denom=light.constantAttenuation+light.linearAttenuation*dist+light.quadraticAttenuation*dist*dist;
                atten=denom>0?1/denom:1;
            }
            if(light.spotCutoff!==180) {
                const spot=-(lx*lightVectors[p+3]+ly*lightVectors[p+4]+lz*lightVectors[p+5]);
                if(spot<lightVectors[p+6]) continue;
                atten*=Math.pow(Math.max(0,spot),light.spotExponent);
            }
            const dot=x*lx+y*ly+z*lz,diff=Math.max(0,dot);
            r+=atten*(ar*light.ambient[0]+dr*light.diffuse[0]*diff);
            g+=atten*(ag*light.ambient[1]+dg*light.diffuse[1]*diff);
            blue+=atten*(ab*light.ambient[2]+db*light.diffuse[2]*diff);
            if(dot>0 && (sr!==0||sg!==0||sb!==0)) {
                const hx=lx+vx,hy=ly+vy,hz=lz+vz,len=Math.hypot(hx,hy,hz);
                const nh=len?Math.max(0,(x*hx+y*hy+z*hz)/len):0;
                const spec=atten*Math.pow(nh,mat.shininess);
                specR+=sr*light.specular[0]*spec;specG+=sg*light.specular[1]*spec;specB+=sb*light.specular[2]*spec;
            }
        }
        buf[b+4]=clamp(r+(separate?0:specR));buf[b+5]=clamp(g+(separate?0:specG));buf[b+6]=clamp(blue+(separate?0:specB));
        buf[b+7]=trackD?ca:clamp(mat.diffuse[3]);
        buf[b+VERT_SECONDARY_COLOR]=separate?clamp(specR):0;
        buf[b+VERT_SECONDARY_COLOR+1]=separate?clamp(specG):0;
        buf[b+VERT_SECONDARY_COLOR+2]=separate?clamp(specB):0;
    }
}
