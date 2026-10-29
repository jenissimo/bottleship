# Repack the original Crimson Skies Trial CAB self-extractor with BottleShip's readers.
# Assets stay outside the repository. The game's EULA remains in the bundle.
param(
 [Parameter(Mandatory=$true)][string]$Installer,
 [Parameter(Mandatory=$true)][string]$WorkDir,
 [Parameter(Mandatory=$true)][string]$OutputWgb,
 [switch]$ContentAddressed
)
$ErrorActionPreference = 'Stop'
$Installer=(Resolve-Path -LiteralPath $Installer).Path
if ((Get-FileHash -LiteralPath $Installer -Algorithm MD5).Hash -ne 'D37510FA7BF206F2CE7DF34131AAD16F') {
 throw 'Expected the original 43,501,048-byte CrimsonTrial.exe (MD5 D37510FA7BF206F2CE7DF34131AAD16F)'
}
if (Test-Path -LiteralPath $WorkDir) { throw 'WorkDir must be a new directory' }
$WorkDir=[IO.Path]::GetFullPath($WorkDir)
$OutputWgb=[IO.Path]::GetFullPath($OutputWgb)
$source=Join-Path $WorkDir 'source'
$game=Join-Path $WorkDir 'game'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
 & bun tools/installer-extract.ts $Installer $source --report (Join-Path $WorkDir 'extraction.json')
 if ($LASTEXITCODE -ne 0) { throw 'Installer extraction failed' }
 New-Item -ItemType Directory -Path $game | Out-Null
 Copy-Item -Path (Join-Path $source 'Game/*') -Destination $game -Recurse
 $fonts=Join-Path $game 'WINDOWS/Fonts'
 New-Item -ItemType Directory -Path $fonts -Force | Out-Null
 Copy-Item -Path (Join-Path $source 'system/Fonts/*') -Destination $fonts
 # Exact long destinations from the installer's Unicode source/destination table.
 # CAB entries retain these DOS aliases; no game file contents are changed.
 foreach($pair in @(
  @('CRIMSO~1.IFR','CrimsonFF.ifr'),
  @('CSZONE~1.EXE','cszoneregister.exe'),
  @('zbd/c3/RTEXTU~1.ZBD','rtexture2.zbd'),
  @('zbd/c3/RTEXTU~2.ZBD','rtexture8.zbd')
 )) { Rename-Item -LiteralPath (Join-Path $game $pair[0]) -NewName $pair[1] }
 $packArgs=@('tools/make-wgb.ts',$game,$OutputWgb,'--name','Crimson Skies Trial','--game-id','app:crimson-skies-demo','--exe','Crimson.exe','--os','win98','--width','640','--height','480','--bpp','16','--ram','128','--file-times')
 if ($ContentAddressed) { $packArgs+='--content-addressed' }
 & bun @packArgs
 if ($LASTEXITCODE -ne 0) { throw 'WGB creation failed' }
} finally { Pop-Location }
