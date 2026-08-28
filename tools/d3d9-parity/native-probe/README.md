# Native D3D9 probe

`NativeD3D9Probe.csproj` is a small Windows-only, dependency-free probe for
`IDirect3D9` and `IDirect3DDevice9Ex`. It calls `Direct3DCreate9`,
`GetDeviceCaps`, `CheckDeviceFormat`, and `CheckDeviceMultiSampleType` through
the COM vtable. It then creates a minimal windowed Ex device and records real
HRESULTs for `SetConvolutionMonoKernel`, `ComposeRects`,
`CheckResourceResidency`, and `CheckDeviceState`. The result is a schema-1
capture written to stdout. In addition to the lossless caps blob, it reads the
native `VolumeTextureFilterCaps` field at the D3DCAPS9 offset used by the
refusal probe. It does not synthesize missing device/resource/Ex/sampler
answers: if an Ex device cannot be created, the process exits without emitting
a capture that could be mistaken for evidence.

The capture keeps the caps bytes as `caps.rawHex`; `compare-capture.ts` validates
the exact 304-byte length and decodes all 76 D3DCAPS9 words into the common
`{ name, offset, kind, value, advertised, setBits }` observation. Format and
multisample probes share the `{ supported, qualityLevels }` result schema on
both the native and local sides. Extra native-only metadata such as adapter
count is retained only as provenance and is not compared as a local result.

Run from the repository root:

```powershell
dotnet run --project tools/d3d9-parity/native-probe/NativeD3D9Probe.csproj -- > tools/d3d9-parity/captures/native-d3d9-windows-current.json
bun tools/d3d9-parity/compare-capture.ts tools/d3d9-parity/captures/native-d3d9-windows-current.json
```

The Ex probes intentionally use safe invalid-input vectors (null resources,
zero rectangle count, and a null destination window) so they can run without
creating additional resources. Their observed HRESULTs are evidence about the
native implementation and are not silently substituted into the local oracle.

The comparator is expected to report missing probes and mismatches until the
corresponding native/DXVK operations are implemented. A mismatch is evidence
of a real driver/backend difference, not a passing fixture.

For CI/reporting use, pass `--reporting`. It always exits zero after emitting a
JSON report, including when a capture is unavailable, malformed, or divergent;
the default invocation exits non-zero for invalid or mismatching evidence.
