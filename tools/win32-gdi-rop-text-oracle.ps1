# Native Windows: a solid raster operation must not change subsequent text color.
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RopTextOracle {
 [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd,IntPtr dc);
 [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
 [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc,int w,int h);
 [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc,IntPtr obj);
 [DllImport("gdi32.dll")] public static extern IntPtr GetStockObject(int id);
 [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
 [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
 [DllImport("gdi32.dll")] public static extern uint SetTextColor(IntPtr dc,uint color);
 [DllImport("gdi32.dll")] public static extern uint GetTextColor(IntPtr dc);
 [DllImport("gdi32.dll")] public static extern int SetBkMode(IntPtr dc,int mode);
 [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc,int x,int y);
 [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dc,int x,int y,int w,int h,IntPtr src,int sx,int sy,uint rop);
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)] public static extern bool TextOutW(IntPtr dc,int x,int y,string text,int count);
 public static int RedPixels(IntPtr dc) {int n=0;for(int y=0;y<32;y++)for(int x=0;x<128;x++)if(GetPixel(dc,x,y)==255)n++;return n;}
}
'@
$screen=[RopTextOracle]::GetDC([IntPtr]::Zero)
$dc=[RopTextOracle]::CreateCompatibleDC($screen)
$bitmap=[RopTextOracle]::CreateCompatibleBitmap($screen,128,32)
$oldBitmap=[RopTextOracle]::SelectObject($dc,$bitmap)
$oldFont=[RopTextOracle]::SelectObject($dc,[RopTextOracle]::GetStockObject(11))
try {
 [void][RopTextOracle]::SetTextColor($dc,255)
 [void][RopTextOracle]::SetBkMode($dc,1)
 foreach($rop in @(66,16711778)) {
  [void][RopTextOracle]::BitBlt($dc,0,0,128,32,[IntPtr]::Zero,0,0,$rop)
  if (-not [RopTextOracle]::TextOutW($dc,0,0,'crimson33',9)) {throw 'TextOutW failed'}
  [PSCustomObject]@{rop=$rop;textColor=[RopTextOracle]::GetTextColor($dc);redPixels=[RopTextOracle]::RedPixels($dc)}|ConvertTo-Json -Compress
 }
} finally {
 [void][RopTextOracle]::SelectObject($dc,$oldFont)
 [void][RopTextOracle]::SelectObject($dc,$oldBitmap)
 [void][RopTextOracle]::DeleteObject($bitmap)
 [void][RopTextOracle]::DeleteDC($dc)
 [void][RopTextOracle]::ReleaseDC([IntPtr]::Zero,$screen)
}
