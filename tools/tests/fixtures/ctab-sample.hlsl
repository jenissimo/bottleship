// Exercises every shape D3DXCONSTANT_DESC can report: matrices in both majorities,
// vectors, scalars, arrays, ints, bools and samplers.
float4x4 mWorldViewProj;
row_major float4x3 mBones[4];
float4    vColor;
float3    vLightDir;
float     fFogStart;
float     fWeights[6];
int       nMode;
int4      nParams[3];
bool      bFlags[2];
bool      bShadowed;
sampler2D sDiffuse;
sampler2D sNormal;

struct Light { float4 pos; float4 col; };
Light gLight;

float4 main(float2 uv : TEXCOORD0, float4 pos : TEXCOORD1) : COLOR
{
    float4 p = mul(pos, mWorldViewProj);
    float4 s = tex2D(sDiffuse, uv) + tex2D(sNormal, uv);
    float  w = fWeights[0] + fWeights[5] + fFogStart;
    float3 b = mul(pos, mBones[1]).xyz;
    float4 l = gLight.pos + gLight.col;
    return (p + s + l) * vColor * (bShadowed ? 1.0 : 0.5)
         + float4(vLightDir * w, (float)nMode) + float4(b, 0)
         + (float4)(nParams[0] + nParams[2])
         + (bFlags[0] ? 0.25 : 0.0) + (bFlags[1] ? 0.5 : 0.0);
}
