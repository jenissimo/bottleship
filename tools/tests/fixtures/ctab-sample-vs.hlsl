// Vertex-shader companion to ctab-sample.hlsl: same shapes, opposite register file,
// so the parser is exercised against both 0xFFFE and 0xFFFF table versions.
float4x4 mWorldViewProj;
row_major float4x3 mBones[4];
float4 vColor;
float  fWeights[6];
int    nMode;
bool   bSkinned;
// A loop counter and a dynamic branch are what push fxc to the i#/b# register files —
// D3DXRS_INT4 reports RegisterCount raw (register size 1, not 4), which nothing else covers.
int    nLoop;
bool   bBranch[2];
float4 vSteps[8];

struct Light { float4 pos; float4 col; };
Light gLight;

float4 main(float4 pos : POSITION) : POSITION
{
    float4 p = mul(pos, mWorldViewProj);
    float3 b = mul(pos, mBones[2]).xyz;
    float  w = fWeights[0] + fWeights[5];
    float4 acc = 0;
    [loop] for (int i = 0; i < nLoop; i++) acc += vSteps[i];
    [branch] if (bBranch[0]) acc *= 2;
    [branch] if (bBranch[1]) acc += gLight.col;
    return p * vColor + float4(b * w, (float)nMode) + (bSkinned ? gLight.pos : gLight.col) + acc;
}
