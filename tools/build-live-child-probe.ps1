param(
    [string]$Llvm = 'C:\Program Files\LLVM\bin',
    [string]$Sdk = 'C:\Program Files (x86)\Windows Kits\10',
    [string]$SdkVersion = '10.0.26100.0'
)
$ErrorActionPreference = 'Stop'
$probeRoot = Join-Path $PSScriptRoot '..\logs\child-promotion'
$probeDir = Join-Path $probeRoot 'probe'
New-Item -ItemType Directory -Force $probeDir | Out-Null
$probeNames = @('child', 'parent', 'parent-exit', 'parent-chain')
foreach ($probeMode in 0,1,2,3) {
    $probeName = $probeNames[$probeMode]
    $probeObject = Join-Path $probeRoot "$probeName.obj"
    & "$Llvm\clang.exe" -target i686-pc-windows-msvc -ffreestanding -fno-stack-protector -O1 -DWIN32_LEAN_AND_MEAN "-DPARENT=$probeMode" -I "$Sdk\Include\$SdkVersion\um" -I "$Sdk\Include\$SdkVersion\shared" -I "$Sdk\Include\$SdkVersion\ucrt" -c "$PSScriptRoot\tests\fixtures\live-child.c" -o $probeObject
    if ($LASTEXITCODE) { throw "clang failed for $probeName" }
    & "$Llvm\lld-link.exe" /nodefaultlib /entry:entry /subsystem:windows /machine:x86 /fixed /base:0x400000 $probeObject "/out:$probeDir\$probeName.exe" "/libpath:$Sdk\Lib\$SdkVersion\um\x86" kernel32.lib user32.lib
    if ($LASTEXITCODE) { throw "link failed for $probeName" }
}
foreach ($probe in @(@('waiting', 'parent'), @('exiting', 'parent-exit'), @('chain', 'parent-chain'))) {
    & bun "$PSScriptRoot\make-wgb.ts" $probeDir "$probeRoot\$($probe[0]).wgb" --exe "$($probe[1]).exe" --name "Live child $($probe[0]) probe" --game-id "app:live-child-$($probe[0])-v1" --ram 1024
    if ($LASTEXITCODE) { throw "packing failed for $($probe[0])" }
}
