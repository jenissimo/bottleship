/**
 * OpenGL 1.3 enumerant constants (Khronos OpenGL registry).
 */

// Boolean values
export const GL_FALSE = 0x0;
export const GL_TRUE = 0x1;

// Data types
export const GL_BYTE = 0x1400;
export const GL_UNSIGNED_BYTE = 0x1401;
export const GL_SHORT = 0x1402;
export const GL_UNSIGNED_SHORT = 0x1403;
export const GL_INT = 0x1404;
export const GL_UNSIGNED_INT = 0x1405;
export const GL_FLOAT = 0x1406;
export const GL_DOUBLE = 0x140A;
export const GL_2_BYTES = 0x1407;
export const GL_3_BYTES = 0x1408;
export const GL_4_BYTES = 0x1409;

// Primitives
export const GL_POINTS = 0x0000;
export const GL_LINES = 0x0001;
export const GL_LINE_LOOP = 0x0002;
export const GL_LINE_STRIP = 0x0003;
export const GL_TRIANGLES = 0x0004;
export const GL_TRIANGLE_STRIP = 0x0005;
export const GL_TRIANGLE_FAN = 0x0006;
export const GL_QUADS = 0x0007;
export const GL_QUAD_STRIP = 0x0008;
export const GL_POLYGON = 0x0009;

// Vertex Arrays
export const GL_VERTEX_ARRAY = 0x8074;
export const GL_NORMAL_ARRAY = 0x8075;
export const GL_COLOR_ARRAY = 0x8076;
export const GL_INDEX_ARRAY = 0x8077;
export const GL_TEXTURE_COORD_ARRAY = 0x8078;
export const GL_EDGE_FLAG_ARRAY = 0x8079;
export const GL_VERTEX_ARRAY_SIZE = 0x807A;
export const GL_VERTEX_ARRAY_TYPE = 0x807B;
export const GL_VERTEX_ARRAY_STRIDE = 0x807C;
export const GL_NORMAL_ARRAY_TYPE = 0x807E;
export const GL_NORMAL_ARRAY_STRIDE = 0x807F;
export const GL_COLOR_ARRAY_SIZE = 0x8081;
export const GL_COLOR_ARRAY_TYPE = 0x8082;
export const GL_COLOR_ARRAY_STRIDE = 0x8083;
export const GL_INDEX_ARRAY_TYPE = 0x8085;
export const GL_INDEX_ARRAY_STRIDE = 0x8086;
export const GL_TEXTURE_COORD_ARRAY_SIZE = 0x8088;
export const GL_TEXTURE_COORD_ARRAY_TYPE = 0x8089;
export const GL_TEXTURE_COORD_ARRAY_STRIDE = 0x808A;
export const GL_EDGE_FLAG_ARRAY_STRIDE = 0x808C;
export const GL_V2F = 0x2A20;
export const GL_V3F = 0x2A21;
export const GL_C4UB_V2F = 0x2A22;
export const GL_C4UB_V3F = 0x2A23;
export const GL_C3F_V3F = 0x2A24;
export const GL_N3F_V3F = 0x2A25;
export const GL_C4F_N3F_V3F = 0x2A26;
export const GL_T2F_V3F = 0x2A27;
export const GL_T4F_V4F = 0x2A28;
export const GL_T2F_C4UB_V3F = 0x2A29;
export const GL_T2F_C3F_V3F = 0x2A2A;
export const GL_T2F_N3F_V3F = 0x2A2B;
export const GL_T2F_C4F_N3F_V3F = 0x2A2C;
export const GL_T4F_C4F_N3F_V4F = 0x2A2D;

// Matrix Mode
export const GL_MATRIX_MODE = 0x0BA0;
export const GL_MODELVIEW = 0x1700;
export const GL_PROJECTION = 0x1701;
export const GL_TEXTURE = 0x1702;

// Points
export const GL_POINT_SMOOTH = 0x0B10;
export const GL_POINT_SIZE = 0x0B11;
export const GL_POINT_SIZE_RANGE = 0x0B12;
export const GL_POINT_SIZE_GRANULARITY = 0x0B13;

// Lines
export const GL_LINE_SMOOTH = 0x0B20;
export const GL_LINE_WIDTH = 0x0B21;
export const GL_LINE_WIDTH_RANGE = 0x0B22;
export const GL_LINE_WIDTH_GRANULARITY = 0x0B23;
export const GL_LINE_STIPPLE = 0x0B24;
export const GL_LINE_STIPPLE_PATTERN = 0x0B25;
export const GL_LINE_STIPPLE_REPEAT = 0x0B26;

// Polygons
export const GL_POINT = 0x1B00;
export const GL_LINE = 0x1B01;
export const GL_FILL = 0x1B02;
export const GL_CW = 0x0900;
export const GL_CCW = 0x0901;
export const GL_FRONT = 0x0404;
export const GL_BACK = 0x0405;
export const GL_POLYGON_MODE = 0x0B40;
export const GL_POLYGON_SMOOTH = 0x0B41;
export const GL_POLYGON_STIPPLE = 0x0B42;
export const GL_CULL_FACE = 0x0B44;
export const GL_CULL_FACE_MODE = 0x0B45;
export const GL_FRONT_FACE = 0x0B46;
export const GL_POLYGON_OFFSET_FACTOR = 0x8038;
export const GL_POLYGON_OFFSET_UNITS = 0x2A00;
export const GL_POLYGON_OFFSET_POINT = 0x2A01;
export const GL_POLYGON_OFFSET_LINE = 0x2A02;
export const GL_POLYGON_OFFSET_FILL = 0x8037;

// Display Lists
export const GL_COMPILE = 0x1300;
export const GL_COMPILE_AND_EXECUTE = 0x1301;
export const GL_LIST_BASE = 0x0B32;
export const GL_LIST_INDEX = 0x0B33;
export const GL_LIST_MODE = 0x0B30;

// Depth buffer
export const GL_NEVER = 0x0200;
export const GL_LESS = 0x0201;
export const GL_EQUAL = 0x0202;
export const GL_LEQUAL = 0x0203;
export const GL_GREATER = 0x0204;
export const GL_NOTEQUAL = 0x0205;
export const GL_GEQUAL = 0x0206;
export const GL_ALWAYS = 0x0207;
export const GL_DEPTH_TEST = 0x0B71;
export const GL_DEPTH_BITS = 0x0D56;
export const GL_DEPTH_CLEAR_VALUE = 0x0B73;
export const GL_DEPTH_FUNC = 0x0B74;
export const GL_DEPTH_RANGE = 0x0B70;
export const GL_DEPTH_WRITEMASK = 0x0B72;
export const GL_DEPTH_COMPONENT = 0x1902;

// Lighting
export const GL_LIGHTING = 0x0B50;
export const GL_LIGHT0 = 0x4000;
export const GL_LIGHT1 = 0x4001;
export const GL_LIGHT2 = 0x4002;
export const GL_LIGHT3 = 0x4003;
export const GL_LIGHT4 = 0x4004;
export const GL_LIGHT5 = 0x4005;
export const GL_LIGHT6 = 0x4006;
export const GL_LIGHT7 = 0x4007;
export const GL_SPOT_EXPONENT = 0x1205;
export const GL_SPOT_CUTOFF = 0x1206;
export const GL_CONSTANT_ATTENUATION = 0x1207;
export const GL_LINEAR_ATTENUATION = 0x1208;
export const GL_QUADRATIC_ATTENUATION = 0x1209;
export const GL_AMBIENT = 0x1200;
export const GL_DIFFUSE = 0x1201;
export const GL_SPECULAR = 0x1202;
export const GL_SHININESS = 0x1601;
export const GL_EMISSION = 0x1600;
export const GL_POSITION = 0x1203;
export const GL_SPOT_DIRECTION = 0x1204;
export const GL_AMBIENT_AND_DIFFUSE = 0x1602;
export const GL_COLOR_INDEXES = 0x1603;
export const GL_LIGHT_MODEL_TWO_SIDE = 0x0B52;
export const GL_LIGHT_MODEL_LOCAL_VIEWER = 0x0B51;
export const GL_LIGHT_MODEL_AMBIENT = 0x0B53;
export const GL_FRONT_AND_BACK = 0x0408;
export const GL_SHADE_MODEL = 0x0B54;
export const GL_FLAT = 0x1D00;
export const GL_SMOOTH = 0x1D01;
export const GL_COLOR_MATERIAL = 0x0B57;
export const GL_COLOR_MATERIAL_FACE = 0x0B55;
export const GL_COLOR_MATERIAL_PARAMETER = 0x0B56;
export const GL_NORMALIZE = 0x0BA1;

// User clipping planes
export const GL_CLIP_PLANE0 = 0x3000;
export const GL_CLIP_PLANE1 = 0x3001;
export const GL_CLIP_PLANE2 = 0x3002;
export const GL_CLIP_PLANE3 = 0x3003;
export const GL_CLIP_PLANE4 = 0x3004;
export const GL_CLIP_PLANE5 = 0x3005;

// Accumulation buffer
export const GL_ACCUM = 0x0100;
export const GL_LOAD = 0x0101;
export const GL_RETURN = 0x0102;
export const GL_MULT = 0x0103;
export const GL_ADD = 0x0104;

// Alpha testing
export const GL_ALPHA_TEST = 0x0BC0;
export const GL_ALPHA_TEST_FUNC = 0x0BC1;
export const GL_ALPHA_TEST_REF = 0x0BC2;

// Blending
export const GL_BLEND = 0x0BE2;
export const GL_BLEND_SRC = 0x0BE1;
export const GL_BLEND_DST = 0x0BE0;
export const GL_ZERO = 0x0000;
export const GL_ONE = 0x0001;
export const GL_SRC_COLOR = 0x0300;
export const GL_ONE_MINUS_SRC_COLOR = 0x0301;
export const GL_SRC_ALPHA = 0x0302;
export const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
export const GL_DST_ALPHA = 0x0304;
export const GL_ONE_MINUS_DST_ALPHA = 0x0305;
export const GL_DST_COLOR = 0x0306;
export const GL_ONE_MINUS_DST_COLOR = 0x0307;
export const GL_SRC_ALPHA_SATURATE = 0x0308;

// Render Mode
/** GL_MAX_NAME_STACK_DEPTH we publish; GL 1.3 requires at least 64. */
export const NAME_STACK_MAX_DEPTH = 64;
export const GL_FEEDBACK = 0x1C01;
export const GL_RENDER = 0x1C00;
export const GL_SELECT = 0x1C02;

// Fog
export const GL_FOG = 0x0B60;
export const GL_FOG_INDEX = 0x0B61;
export const GL_FOG_DENSITY = 0x0B62;
export const GL_FOG_START = 0x0B63;
export const GL_FOG_END = 0x0B64;
export const GL_FOG_MODE = 0x0B65;
export const GL_FOG_COLOR = 0x0B66;
export const GL_LINEAR = 0x2601;
export const GL_EXP = 0x0800;
export const GL_EXP2 = 0x0801;

// Logic Ops
export const GL_COLOR_LOGIC_OP = 0x0BF2;

// Stencil
export const GL_STENCIL_TEST = 0x0B90;
export const GL_STENCIL_BITS = 0x0D57;
export const GL_STENCIL_FUNC = 0x0B92;
export const GL_STENCIL_VALUE_MASK = 0x0B93;
export const GL_STENCIL_FAIL = 0x0B94;
export const GL_STENCIL_PASS_DEPTH_FAIL = 0x0B95;
export const GL_STENCIL_PASS_DEPTH_PASS = 0x0B96;
export const GL_STENCIL_REF = 0x0B97;
export const GL_STENCIL_WRITEMASK = 0x0B98;
export const GL_STENCIL_CLEAR_VALUE = 0x0B91;
export const GL_KEEP = 0x1E00;
export const GL_REPLACE = 0x1E01;
export const GL_INCR = 0x1E02;
export const GL_DECR = 0x1E03;

// Buffers, Pixel Drawing/Reading
export const GL_NONE = 0x0;
export const GL_COLOR_INDEX = 0x1900;
export const GL_RED = 0x1903;
export const GL_GREEN = 0x1904;
export const GL_BLUE = 0x1905;
export const GL_ALPHA = 0x1906;
export const GL_LUMINANCE = 0x1909;
export const GL_LUMINANCE_ALPHA = 0x190A;
export const GL_RGB = 0x1907;
export const GL_RGBA = 0x1908;
export const GL_DITHER = 0x0BD0;
export const GL_DOUBLEBUFFER = 0x0C32;
export const GL_DRAW_BUFFER = 0x0C01;
export const GL_READ_BUFFER = 0x0C02;
export const GL_DEPTH_BUFFER_BIT = 0x00000100;
export const GL_STENCIL_BUFFER_BIT = 0x00000400;
export const GL_COLOR_BUFFER_BIT = 0x00004000;

// Implementation limits
export const GL_MAX_MODELVIEW_STACK_DEPTH = 0x0D36;
export const GL_MAX_PROJECTION_STACK_DEPTH = 0x0D38;
export const GL_MAX_TEXTURE_STACK_DEPTH = 0x0D39;
export const GL_MAX_LIGHTS = 0x0D31;
export const GL_MAX_CLIP_PLANES = 0x0D32;
export const GL_MAX_TEXTURE_SIZE = 0x0D33;
export const GL_MAX_VIEWPORT_DIMS = 0x0D3A;
export const GL_MAX_ATTRIB_STACK_DEPTH = 0x0D35;
export const GL_MAX_CLIENT_ATTRIB_STACK_DEPTH = 0x0D3B;

// Gets
export const GL_COLOR_CLEAR_VALUE = 0x0C22;
export const GL_COLOR_WRITEMASK = 0x0C23;
export const GL_CURRENT_COLOR = 0x0B00;
export const GL_CURRENT_NORMAL = 0x0B02;
export const GL_CURRENT_TEXTURE_COORDS = 0x0B03;
export const GL_MODELVIEW_MATRIX = 0x0BA6;
export const GL_MODELVIEW_STACK_DEPTH = 0x0BA3;
export const GL_PROJECTION_MATRIX = 0x0BA7;
export const GL_PROJECTION_STACK_DEPTH = 0x0BA4;
export const GL_TEXTURE_MATRIX = 0x0BA8;
export const GL_TEXTURE_STACK_DEPTH = 0x0BA5;
export const GL_VIEWPORT = 0x0BA2;
export const GL_RGBA_MODE = 0x0C31;

// Hints
export const GL_FOG_HINT = 0x0C54;
export const GL_LINE_SMOOTH_HINT = 0x0C52;
export const GL_PERSPECTIVE_CORRECTION_HINT = 0x0C50;
export const GL_POINT_SMOOTH_HINT = 0x0C51;
export const GL_POLYGON_SMOOTH_HINT = 0x0C53;
export const GL_DONT_CARE = 0x1100;
export const GL_FASTEST = 0x1101;
export const GL_NICEST = 0x1102;

// Scissor box
export const GL_SCISSOR_TEST = 0x0C11;
export const GL_SCISSOR_BOX = 0x0C10;

// Pixel Store
export const GL_PACK_ALIGNMENT = 0x0D05;
export const GL_UNPACK_ALIGNMENT = 0x0CF5;
export const GL_UNPACK_ROW_LENGTH = 0x0CF2;
export const GL_UNPACK_SKIP_PIXELS = 0x0CF4;
export const GL_UNPACK_SKIP_ROWS = 0x0CF3;

// Texture mapping
export const GL_TEXTURE_ENV = 0x2300;
export const GL_TEXTURE_ENV_MODE = 0x2200;
export const GL_TEXTURE_ENV_COLOR = 0x2201;
export const GL_TEXTURE_1D = 0x0DE0;
export const GL_TEXTURE_2D = 0x0DE1;
export const GL_TEXTURE_WRAP_S = 0x2802;
export const GL_TEXTURE_WRAP_T = 0x2803;
export const GL_TEXTURE_MAG_FILTER = 0x2800;
export const GL_TEXTURE_MIN_FILTER = 0x2801;
export const GL_TEXTURE_BORDER_COLOR = 0x1004;
export const GL_TEXTURE_WIDTH = 0x1000;
export const GL_TEXTURE_HEIGHT = 0x1001;
export const GL_TEXTURE_COMPONENTS = 0x1003;
export const GL_TEXTURE_INTERNAL_FORMAT = 0x1003;
export const GL_TEXTURE_BORDER = 0x1005;
export const GL_TEXTURE_RED_SIZE = 0x805C;
export const GL_TEXTURE_GREEN_SIZE = 0x805D;
export const GL_TEXTURE_BLUE_SIZE = 0x805E;
export const GL_TEXTURE_ALPHA_SIZE = 0x805F;
export const GL_TEXTURE_LUMINANCE_SIZE = 0x8060;
export const GL_TEXTURE_INTENSITY_SIZE = 0x8061;
export const GL_TEXTURE_DEPTH = 0x8071;
export const GL_TEXTURE_COMPRESSED = 0x86A1;
export const GL_TEXTURE_COMPRESSED_IMAGE_SIZE = 0x86A0;
export const GL_NEAREST_MIPMAP_NEAREST = 0x2700;
export const GL_LINEAR_MIPMAP_NEAREST = 0x2701;
export const GL_NEAREST_MIPMAP_LINEAR = 0x2702;
export const GL_LINEAR_MIPMAP_LINEAR = 0x2703;
export const GL_NEAREST = 0x2600;
export const GL_REPEAT = 0x2901;
export const GL_CLAMP = 0x2900;
export const GL_DECAL = 0x2101;
export const GL_MODULATE = 0x2100;
export const GL_TEXTURE_GEN_S = 0x0C60;
export const GL_TEXTURE_GEN_T = 0x0C61;
export const GL_TEXTURE_GEN_R = 0x0C62;
export const GL_TEXTURE_GEN_Q = 0x0C63;
export const GL_TEXTURE_GEN_MODE = 0x2500;
export const GL_OBJECT_PLANE = 0x2501;
export const GL_EYE_PLANE = 0x2502;
export const GL_OBJECT_LINEAR = 0x2401;
export const GL_EYE_LINEAR = 0x2400;
export const GL_SPHERE_MAP = 0x2402;
export const GL_S = 0x2000;
export const GL_T = 0x2001;
export const GL_R = 0x2002;
export const GL_Q = 0x2003;

// Utility
export const GL_VENDOR = 0x1F00;
export const GL_RENDERER = 0x1F01;
export const GL_VERSION = 0x1F02;
export const GL_EXTENSIONS = 0x1F03;

// Errors
export const GL_NO_ERROR = 0x0;
export const GL_INVALID_VALUE = 0x0501;
export const GL_INVALID_ENUM = 0x0500;
export const GL_INVALID_OPERATION = 0x0502;
export const GL_STACK_OVERFLOW = 0x0503;
export const GL_STACK_UNDERFLOW = 0x0504;
export const GL_OUT_OF_MEMORY = 0x0505;

// Attrib bits
export const GL_CURRENT_BIT = 0x00000001;
export const GL_POINT_BIT = 0x00000002;
export const GL_LINE_BIT = 0x00000004;
export const GL_POLYGON_BIT = 0x00000008;
export const GL_LIGHTING_BIT = 0x00000040;
export const GL_FOG_BIT = 0x00000080;
export const GL_VIEWPORT_BIT = 0x00000800;
export const GL_TRANSFORM_BIT = 0x00001000;
export const GL_ENABLE_BIT = 0x00002000;
export const GL_HINT_BIT = 0x00008000;
export const GL_TEXTURE_BIT = 0x00040000;
export const GL_SCISSOR_BIT = 0x00080000;
export const GL_ALL_ATTRIB_BITS = 0x000FFFFF;

// OpenGL 1.1
export const GL_PROXY_TEXTURE_1D = 0x8063;
export const GL_PROXY_TEXTURE_2D = 0x8064;

/** The GL_MAX_TEXTURE_SIZE we publish. One constant, because the proxy-texture probe
 *  and glGetIntegerv must agree — a probe that says "fits" for a size the query calls
 *  too large is worse than either answer alone. */
export const GL_IMPL_MAX_TEXTURE_SIZE = 2048;
export const GL_TEXTURE_BINDING_1D = 0x8068;
export const GL_TEXTURE_BINDING_2D = 0x8069;
export const GL_ALPHA4 = 0x803B;
export const GL_ALPHA8 = 0x803C;
export const GL_ALPHA12 = 0x803D;
export const GL_ALPHA16 = 0x803E;
export const GL_LUMINANCE8 = 0x8040;
export const GL_LUMINANCE4_ALPHA4 = 0x8043;
export const GL_LUMINANCE6_ALPHA2 = 0x8044;
export const GL_LUMINANCE8_ALPHA8 = 0x8045;
export const GL_LUMINANCE12_ALPHA4 = 0x8046;
export const GL_LUMINANCE12_ALPHA12 = 0x8047;
export const GL_LUMINANCE16_ALPHA16 = 0x8048;
export const GL_INTENSITY = 0x8049;
export const GL_INTENSITY4 = 0x804A;
export const GL_INTENSITY8 = 0x804B;
export const GL_INTENSITY12 = 0x804C;
export const GL_INTENSITY16 = 0x804D;
export const GL_RGB8 = 0x8051;
export const GL_RGBA8 = 0x8058;
export const GL_RGB5_A1 = 0x8057;
export const GL_RGBA4 = 0x8056;
export const GL_RGB5 = 0x8050;
export const GL_R3_G3_B2 = 0x2A10;
export const GL_RGB4 = 0x804F;
export const GL_RGB10 = 0x8052;
export const GL_RGB12 = 0x8053;
export const GL_RGB16 = 0x8054;
export const GL_LUMINANCE4 = 0x803F;
export const GL_LUMINANCE12 = 0x8041;
export const GL_LUMINANCE16 = 0x8042;

// OpenGL 1.2
export const GL_UNSIGNED_BYTE_3_3_2 = 0x8032;
export const GL_UNSIGNED_SHORT_4_4_4_4 = 0x8033;
export const GL_UNSIGNED_SHORT_5_5_5_1 = 0x8034;
export const GL_UNSIGNED_INT_8_8_8_8 = 0x8035;
export const GL_UNSIGNED_SHORT_5_6_5 = 0x8363;
export const GL_UNSIGNED_SHORT_5_6_5_REV = 0x8364;
export const GL_UNSIGNED_SHORT_4_4_4_4_REV = 0x8365;
export const GL_UNSIGNED_SHORT_1_5_5_5_REV = 0x8366;
export const GL_UNSIGNED_INT_8_8_8_8_REV = 0x8367;
export const GL_BGR = 0x80E0;
export const GL_BGRA = 0x80E1;
export const GL_CLAMP_TO_EDGE = 0x812F;
export const GL_TEXTURE_3D = 0x806F;
export const GL_MAX_ELEMENTS_VERTICES = 0x80E8;
export const GL_MAX_ELEMENTS_INDICES = 0x80E9;
export const GL_LIGHT_MODEL_COLOR_CONTROL = 0x81F8;
export const GL_SINGLE_COLOR = 0x81F9;
export const GL_SEPARATE_SPECULAR_COLOR = 0x81FA;
export const GL_RESCALE_NORMAL = 0x803A;

// OpenGL 1.3 - Multitexture
export const GL_TEXTURE0 = 0x84C0;
export const GL_TEXTURE1 = 0x84C1;
export const GL_TEXTURE2 = 0x84C2;
export const GL_TEXTURE3 = 0x84C3;
export const GL_ACTIVE_TEXTURE = 0x84E0;
export const GL_CLIENT_ACTIVE_TEXTURE = 0x84E1;
export const GL_MAX_TEXTURE_UNITS = 0x84E2;
export const GL_TRANSPOSE_MODELVIEW_MATRIX = 0x84E3;
export const GL_TRANSPOSE_PROJECTION_MATRIX = 0x84E4;
export const GL_TRANSPOSE_TEXTURE_MATRIX = 0x84E5;

// GL 1.3 - Multisample
export const GL_MULTISAMPLE = 0x809D;
export const GL_SAMPLE_ALPHA_TO_COVERAGE = 0x809E;
export const GL_SAMPLE_COVERAGE = 0x80A0;
export const GL_SAMPLE_BUFFERS = 0x80A8;
export const GL_SAMPLES = 0x80A9;

// GL 1.3 - Compressed textures
export const GL_NUM_COMPRESSED_TEXTURE_FORMATS = 0x86A2;
export const GL_COMPRESSED_TEXTURE_FORMATS = 0x86A3;
export const GL_TEXTURE_COMPRESSION_HINT = 0x84EF;

// GL_EXT_texture_compression_s3tc
export const GL_COMPRESSED_RGB_S3TC_DXT1_EXT = 0x83F0;
export const GL_COMPRESSED_RGBA_S3TC_DXT1_EXT = 0x83F1;
export const GL_COMPRESSED_RGBA_S3TC_DXT3_EXT = 0x83F2;
export const GL_COMPRESSED_RGBA_S3TC_DXT5_EXT = 0x83F3;

// GL_ARB_texture_compression_rgtc / GL_EXT_texture_compression_latc
export const GL_COMPRESSED_RED_RGTC1 = 0x8DBB;
export const GL_COMPRESSED_SIGNED_RED_RGTC1 = 0x8DBC;
export const GL_COMPRESSED_RG_RGTC2 = 0x8DBD;
export const GL_COMPRESSED_SIGNED_RG_RGTC2 = 0x8DBE;
export const GL_COMPRESSED_LUMINANCE_LATC1_EXT = 0x8C70;
export const GL_COMPRESSED_SIGNED_LUMINANCE_LATC1_EXT = 0x8C71;
export const GL_COMPRESSED_LUMINANCE_ALPHA_LATC2_EXT = 0x8C72;
export const GL_COMPRESSED_SIGNED_LUMINANCE_ALPHA_LATC2_EXT = 0x8C73;

// GL 1.3 - Texture combine
export const GL_COMBINE = 0x8570;
export const GL_COMBINE_RGB = 0x8571;
export const GL_COMBINE_ALPHA = 0x8572;
export const GL_SOURCE0_RGB = 0x8580;
export const GL_SOURCE1_RGB = 0x8581;
export const GL_SOURCE2_RGB = 0x8582;
export const GL_SOURCE0_ALPHA = 0x8588;
export const GL_SOURCE1_ALPHA = 0x8589;
export const GL_SOURCE2_ALPHA = 0x858A;
export const GL_OPERAND0_RGB = 0x8590;
export const GL_OPERAND1_RGB = 0x8591;
export const GL_OPERAND2_RGB = 0x8592;
export const GL_OPERAND0_ALPHA = 0x8598;
export const GL_OPERAND1_ALPHA = 0x8599;
export const GL_OPERAND2_ALPHA = 0x859A;
export const GL_RGB_SCALE = 0x8573;
export const GL_ADD_SIGNED = 0x8574;
export const GL_INTERPOLATE = 0x8575;
export const GL_SUBTRACT = 0x84E7;
export const GL_CONSTANT = 0x8576;
export const GL_PRIMARY_COLOR = 0x8577;
export const GL_PREVIOUS = 0x8578;
export const GL_DOT3_RGB = 0x86AE;
export const GL_DOT3_RGBA = 0x86AF;
/** EXT_texture_env_dot3 spells the two DOT3 functions with its own values; every other
 *  token of EXT_ and ARB_texture_env_combine is numerically identical. */
export const GL_DOT3_RGB_EXT = 0x8740;
export const GL_DOT3_RGBA_EXT = 0x8741;
export const GL_ALPHA_SCALE = 0x0D1C;

// Cube map
export const GL_TEXTURE_CUBE_MAP = 0x8513;
export const GL_NORMAL_MAP = 0x8511;
export const GL_REFLECTION_MAP = 0x8512;

export const GL_CLAMP_TO_BORDER = 0x812D;
