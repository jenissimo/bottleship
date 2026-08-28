using System.Runtime.InteropServices;
using System.Text.Json;

// Small, dependency-free Windows D3D9 probe. The base probes use only
// IDirect3D9 methods that do not require a created device. The Ex control-plane
// probes additionally create a minimal IDirect3DDevice9Ex so that their
// HRESULTs come from the actual native implementation. The resulting JSON is
// a real native capture (not a copy of the local oracle) and can be passed to
// compare-capture.ts; mismatches are evidence, not silently converted into
// passes.
internal static class Program
{
    private const uint D3D_SDK_VERSION = 32;
    private const uint D3DDEVTYPE_HAL = 1;
    private const uint D3DCREATE_SOFTWARE_VERTEXPROCESSING = 0x00000020;
    private const uint D3DFMT_UNKNOWN = 0;
    private const uint D3DFMT_X8R8G8B8 = 22;
    private const uint D3DFMT_A8R8G8B8 = 21;
    private const uint D3DFMT_R5G6B5 = 23;
    private const uint D3DFMT_R16F = 111;
    private const uint D3DFMT_G16R16F = 112;
    private const uint D3DFMT_A16B16G16R16F = 113;
    private const uint D3DRTYPE_TEXTURE = 3;
    private const uint D3DUSAGE_RENDERTARGET = 0x00000001;
    private const uint D3DMULTISAMPLE_NONE = 0;
    private const uint D3DMULTISAMPLE_2_SAMPLES = 2;
    private const uint D3DSWAPEFFECT_DISCARD = 1;
    private const uint D3DCOMPOSERECTS_COPY = 1;

    [DllImport("d3d9.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern IntPtr Direct3DCreate9(uint sdkVersion);
    [DllImport("d3d9.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern int Direct3DCreate9Ex(uint sdkVersion, out IntPtr d3d9Ex);
    [DllImport("user32.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern IntPtr GetDesktopWindow();

    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate uint GetAdapterCountFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetDeviceCapsFn(IntPtr self, uint adapter, uint deviceType, IntPtr caps);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CheckDeviceFormatFn(IntPtr self, uint adapter, uint deviceType, uint adapterFormat, uint usage, uint resourceType, uint checkFormat);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CheckDeviceMultiSampleTypeFn(IntPtr self, uint adapter, uint deviceType, uint surfaceFormat, int windowed, uint multiSampleType, IntPtr qualityLevels);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CreateDeviceExFn(IntPtr self, uint adapter, uint deviceType, IntPtr focusWindow, uint behaviorFlags, ref D3DPRESENT_PARAMETERS presentationParameters, IntPtr fullscreenDisplayMode, out IntPtr device);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int SetConvolutionMonoKernelFn(IntPtr self, uint width, uint height, IntPtr rows, IntPtr columns);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int ComposeRectsFn(IntPtr self, IntPtr src, IntPtr dst, IntPtr srcRectDescs, uint numRects, IntPtr dstRectDescs, uint operation, int xOffset, int yOffset);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CheckResourceResidencyFn(IntPtr self, IntPtr resourceArray, uint numResources);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CheckDeviceStateFn(IntPtr self, IntPtr destinationWindow);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate uint ReleaseFn(IntPtr self);

    [StructLayout(LayoutKind.Sequential)]
    private struct D3DPRESENT_PARAMETERS
    {
        public uint BackBufferWidth;
        public uint BackBufferHeight;
        public uint BackBufferFormat;
        public uint BackBufferCount;
        public uint MultiSampleType;
        public uint MultiSampleQuality;
        public uint SwapEffect;
        public IntPtr DeviceWindow;
        public int Windowed;
        public int EnableAutoDepthStencil;
        public uint AutoDepthStencilFormat;
        public uint Flags;
        public uint FullScreenRefreshRateInHz;
        public uint PresentationInterval;
    }

    private static T VTable<T>(IntPtr com, int slot) where T : Delegate
    {
        var table = Marshal.ReadIntPtr(com);
        var address = Marshal.ReadIntPtr(table, slot * IntPtr.Size);
        return Marshal.GetDelegateForFunctionPointer<T>(address);
    }

    private static uint HResult(int hr) => unchecked((uint)hr);

    private static Dictionary<string, object?> ParseCaps(byte[] bytes)
    {
        var fields = new Dictionary<string, object?>();
        // Keep this raw and lossless. The TS comparator can report the complete
        // native object as a mismatch without pretending driver fields are local
        // evidence classifications.
        fields["size"] = bytes.Length;
        fields["rawHex"] = Convert.ToHexString(bytes);
        return fields;
    }

    private static uint ReadCapsUInt32(byte[] bytes, int offset)
    {
        if (offset < 0 || offset + sizeof(uint) > bytes.Length)
            throw new ArgumentOutOfRangeException(nameof(offset));
        return BitConverter.ToUInt32(bytes, offset);
    }

    public static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("native D3D9 probe requires Windows");
            return 2;
        }

        var d3d = Direct3DCreate9(D3D_SDK_VERSION);
        if (d3d == IntPtr.Zero)
        {
            Console.Error.WriteLine("Direct3DCreate9 returned NULL");
            return 3;
        }

        try
        {
            var getAdapterCount = VTable<GetAdapterCountFn>(d3d, 4);
            var getDeviceCaps = VTable<GetDeviceCapsFn>(d3d, 14);
            var checkDeviceFormat = VTable<CheckDeviceFormatFn>(d3d, 10);
            var checkDeviceMsaa = VTable<CheckDeviceMultiSampleTypeFn>(d3d, 11);
            var adapters = getAdapterCount(d3d);
            if (adapters == 0)
            {
                Console.Error.WriteLine("IDirect3D9 reports zero adapters");
                return 4;
            }

            var probes = new Dictionary<string, object?>();
            var caps = new byte[304];
            var capsPtr = Marshal.AllocHGlobal(caps.Length);
            try
            {
                var hr = getDeviceCaps(d3d, 0, D3DDEVTYPE_HAL, capsPtr);
                Marshal.Copy(capsPtr, caps, 0, caps.Length);
                probes["caps-layout-and-evidence"] = new
                {
                    adapterCount = adapters,
                    hresult = HResult(hr),
                    caps = ParseCaps(caps),
                };
                // VolumeTextureFilterCaps is an explicitly refused local cap.
                // Read the native field directly so this seam can be compared
                // without pretending the complete driver caps blob has local
                // evidence classifications.
                probes["caps-volume-filter-refusal"] = ReadCapsUInt32(caps, 72);
            }
            finally { Marshal.FreeHGlobal(capsPtr); }

            probes["check-device-format-cross-bpp"] = CheckFormat(checkDeviceFormat(
                d3d, 0, D3DDEVTYPE_HAL, D3DFMT_R5G6B5, 0, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8));
            probes["check-device-format-unsupported-float-rt"] = CheckFormat(checkDeviceFormat(
                d3d, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, D3DUSAGE_RENDERTARGET, D3DRTYPE_TEXTURE, D3DFMT_R16F));
            // Keep sampled-texture answers separate from the render-target
            // probe above. The bounded BottleShip path can opt into native
            // 16-bit-float texture storage without promising float attachments.
            probes["check-device-format-r16f-texture"] = CheckFormat(checkDeviceFormat(
                d3d, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_R16F));
            probes["check-device-format-g16r16f-texture"] = CheckFormat(checkDeviceFormat(
                d3d, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_G16R16F));
            probes["check-device-format-a16b16g16r16f-texture"] = CheckFormat(checkDeviceFormat(
                d3d, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_A16B16G16R16F));

            probes["d3d9-msaa-none"] = CheckMsaa(d3d, checkDeviceMsaa, D3DMULTISAMPLE_NONE);
            probes["d3d9-msaa-2x-refusal"] = CheckMsaa(d3d, checkDeviceMsaa, D3DMULTISAMPLE_2_SAMPLES);

            // These methods live on IDirect3DDevice9Ex rather than the base
            // IDirect3D9 object. Do not emit a synthetic value when the host
            // cannot create an Ex device: an incomplete capture is more useful
            // than silently turning an unavailable native result into parity.
            if (!TryProbeEx(probes, out var exError))
            {
                Console.Error.WriteLine($"D3D9Ex probe unavailable: {exError}");
                return 5;
            }

            var result = new
            {
                schema = 1,
                target = "native-d3d9",
                source = "IDirect3D9/IDirect3DDevice9Ex vtables via d3d9.dll",
                environment = $"Windows={Environment.OSVersion.VersionString}; process={RuntimeInformation.ProcessArchitecture}; adapters={adapters}; ex-device=true",
                probes,
            };
            Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
            return 0;
        }
        finally
        {
            VTable<ReleaseFn>(d3d, 2)(d3d);
        }
    }

    private static object CheckMsaa(IntPtr d3d, CheckDeviceMultiSampleTypeFn fn, uint type)
    {
        var qualityPtr = Marshal.AllocHGlobal(sizeof(uint));
        try
        {
            Marshal.WriteInt32(qualityPtr, 0);
            var hr = fn(d3d, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 1, type, qualityPtr);
            return new { supported = hr >= 0, qualityLevels = hr >= 0 ? unchecked((uint)Marshal.ReadInt32(qualityPtr)) : 0u };
        }
        finally { Marshal.FreeHGlobal(qualityPtr); }
    }

    private static object CheckFormat(int hr) => new { supported = hr >= 0, qualityLevels = 0u };

    private static bool TryProbeEx(Dictionary<string, object?> probes, out string error)
    {
        error = "unknown error";
        IntPtr d3dEx = IntPtr.Zero;
        IntPtr device = IntPtr.Zero;
        try
        {
            var createHr = Direct3DCreate9Ex(D3D_SDK_VERSION, out d3dEx);
            if (createHr < 0 || d3dEx == IntPtr.Zero)
            {
                error = $"Direct3DCreate9Ex failed with HRESULT 0x{HResult(createHr):X8}";
                return false;
            }

            var createDeviceEx = VTable<CreateDeviceExFn>(d3dEx, 20);
            var presentation = new D3DPRESENT_PARAMETERS
            {
                // A tiny windowed swap chain keeps this probe independent of
                // the current desktop mode. UNKNOWN is the native D3D9
                // contract for a windowed back buffer.
                BackBufferWidth = 1,
                BackBufferHeight = 1,
                BackBufferFormat = D3DFMT_UNKNOWN,
                BackBufferCount = 1,
                MultiSampleType = D3DMULTISAMPLE_NONE,
                MultiSampleQuality = 0,
                SwapEffect = D3DSWAPEFFECT_DISCARD,
                DeviceWindow = GetDesktopWindow(),
                Windowed = 1,
                EnableAutoDepthStencil = 0,
                AutoDepthStencilFormat = 0,
                Flags = 0,
                FullScreenRefreshRateInHz = 0,
                PresentationInterval = 0,
            };
            var createDeviceHr = createDeviceEx(
                d3dEx, 0, D3DDEVTYPE_HAL, presentation.DeviceWindow,
                D3DCREATE_SOFTWARE_VERTEXPROCESSING, ref presentation,
                IntPtr.Zero, out device);
            if (createDeviceHr < 0 || device == IntPtr.Zero)
            {
                error = $"IDirect3D9Ex::CreateDeviceEx failed with HRESULT 0x{HResult(createDeviceHr):X8}";
                return false;
            }

            // Slots are defined by IDirect3DDevice9Ex's append-only COM
            // interface: the inherited IDirect3DDevice9 methods occupy 0..118,
            // followed by the Ex methods at 119..133.
            var convolution = VTable<SetConvolutionMonoKernelFn>(device, 119);
            var composeRects = VTable<ComposeRectsFn>(device, 120);
            var checkResidency = VTable<CheckResourceResidencyFn>(device, 125);
            var checkDeviceState = VTable<CheckDeviceStateFn>(device, 128);

            // Null resources with zero rectangles are intentional invalid-input
            // vectors. They are safe to issue through the COM contract and
            // distinguish a real native implementation from a compatibility
            // stub that unconditionally returns D3D_OK.
            probes["ex-convolution-invalidcall"] = HResult(convolution(
                device, 3, 3, IntPtr.Zero, IntPtr.Zero));
            probes["ex-compose-rects-compat-stub"] = HResult(composeRects(
                device, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0,
                IntPtr.Zero, D3DCOMPOSERECTS_COPY, 0, 0));
            probes["ex-check-resource-residency-stub"] = HResult(checkResidency(
                device, IntPtr.Zero, 0));
            probes["ex-check-device-state-stub"] = HResult(checkDeviceState(
                device, IntPtr.Zero));
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
        finally
        {
            if (device != IntPtr.Zero)
                VTable<ReleaseFn>(device, 2)(device);
            if (d3dEx != IntPtr.Zero)
                VTable<ReleaseFn>(d3dEx, 2)(d3dEx);
        }
    }
}
