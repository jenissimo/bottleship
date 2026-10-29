# Native Windows ground truth for DrawTextEx CALCRECT wrapped widths.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DrawTextRectOracle {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Params { public uint size; public int tab, left, right; public uint length; }
 [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
 [DllImport("gdi32.dll")] public static extern IntPtr GetStockObject(int id);
 [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
 [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int DrawTextExW(IntPtr dc,StringBuilder text,int length,ref Rect rect,uint flags,ref Params p);
}
'@
$dc=[DrawTextRectOracle]::CreateCompatibleDC([IntPtr]::Zero)
$old=[DrawTextRectOracle]::SelectObject($dc,[DrawTextRectOracle]::GetStockObject(11))
try {
 foreach($text in @('x','ab cd ef','abcdefghij','')) {
  foreach($width in @(800,20)) {
   $r=New-Object DrawTextRectOracle+Rect
   $r.left=7; $r.top=3; $r.right=7+$width; $r.bottom=24
   $p=New-Object DrawTextRectOracle+Params
   $p.size=20
   $s=New-Object Text.StringBuilder($text)
   $height=[DrawTextRectOracle]::DrawTextExW($dc,$s,$text.Length,[ref]$r,0xc10,[ref]$p)
   [PSCustomObject]@{text=$text;width=$width;height=$height;left=$r.left;top=$r.top;right=$r.right;bottom=$r.bottom;lengthDrawn=$p.length}|ConvertTo-Json -Compress
  }
 }
} finally {
 [void][DrawTextRectOracle]::SelectObject($dc,$old)
 [void][DrawTextRectOracle]::DeleteDC($dc)
}
