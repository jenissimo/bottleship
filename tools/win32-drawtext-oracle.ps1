# Run on native Windows. Emits DrawTextExW height/length results at line-height boundaries.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeDrawTextOracle {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Params { public uint size; public int tab, left, right; public uint length; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Metrics {
        public int height, ascent, descent, internalLeading, externalLeading, averageWidth, maxWidth, weight, overhang, aspectX, aspectY;
        public ushort first, last, defaultChar, breakChar;
        public byte italic, underlined, struck, pitch, charset;
    }
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] public static extern IntPtr GetStockObject(int id);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern bool GetTextMetricsW(IntPtr dc, out Metrics metrics);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int DrawTextExW(IntPtr dc, StringBuilder text, int length, ref Rect rect, uint flags, ref Params p);
}
'@
$dc = [NativeDrawTextOracle]::CreateCompatibleDC([IntPtr]::Zero)
$old = [NativeDrawTextOracle]::SelectObject($dc, [NativeDrawTextOracle]::GetStockObject(11))
try {
    $metrics = New-Object NativeDrawTextOracle+Metrics
    if (-not [NativeDrawTextOracle]::GetTextMetricsW($dc, [ref]$metrics)) { throw 'GetTextMetrics failed' }
    foreach ($height in @(0, ($metrics.height - 1), $metrics.height, ($metrics.height + 1), (2 * $metrics.height - 1))) {
        foreach ($flags in @(0, 256)) {
            $rect = New-Object NativeDrawTextOracle+Rect
            $rect.right = 400
            $rect.bottom = $height
            $p = New-Object NativeDrawTextOracle+Params
            $p.size = 20
            $text = New-Object System.Text.StringBuilder("ab`r`ncd`r`nef")
            $result = [NativeDrawTextOracle]::DrawTextExW($dc, $text, -1, [ref]$rect, $flags, [ref]$p)
            [PSCustomObject]@{lineHeight=$metrics.height;rectHeight=$height;flags=$flags;height=$result;lengthDrawn=$p.length} | ConvertTo-Json -Compress
        }
    }
} finally {
    [void][NativeDrawTextOracle]::SelectObject($dc, $old)
    [void][NativeDrawTextOracle]::DeleteDC($dc)
}
