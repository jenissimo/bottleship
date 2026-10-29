# Reproduce the original English Return of the King demo bundle.
param(
 [Parameter(Mandatory=$true)][string]$Archive,
 [Parameter(Mandatory=$true)][string]$WorkDir,
 [Parameter(Mandatory=$true)][string]$OutputWgb
)
$ErrorActionPreference='Stop'
$Archive=(Resolve-Path -LiteralPath $Archive).Path
if((Get-FileHash -LiteralPath $Archive -Algorithm MD5).Hash -ne 'C48F48C6596F36CB9253B3AD2259BF47') {
 throw 'Expected the original 87,877,162-byte ReturnKing.zip from Archive.org'
}
if(Test-Path -LiteralPath $WorkDir) {throw 'WorkDir must be a new directory'}
$WorkDir=[IO.Path]::GetFullPath($WorkDir)
$OutputWgb=[IO.Path]::GetFullPath($OutputWgb)
$source=Join-Path $WorkDir 'source'
$game=Join-Path $WorkDir 'game'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
 & bun tools/wgb.ts extract-dir $Archive 'ReturnKing/' $source
 if($LASTEXITCODE -ne 0) {throw 'Demo extraction failed'}
 New-Item -ItemType Directory -Path $game | Out-Null
 # Installed payload from EA's file list; autorun/setup files stay on the media.
 foreach($line in [IO.File]::ReadAllLines((Join-Path $source 'en-us_filelist.txt'))) {
  if($line -notmatch '^1,1,(.+)$') {continue}
  $relative=$Matches[1]
  if($relative -eq 'Support\*.* /s') {
   Copy-Item -LiteralPath (Join-Path $source 'Support') -Destination (Join-Path $game 'Support') -Recurse
   continue
  }
  if($relative -match '[*?]' -or $relative -match '\.\.') {throw 'Unexpected manifest path'}
  $destination=Join-Path $game $relative
  New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $destination
 }
 Copy-Item -LiteralPath (Join-Path $source 'en-us_license.txt') -Destination $game
 & bun tools/make-wgb.ts $game $OutputWgb --name 'The Lord of the Rings: The Return of the King Demo' --game-id 'app:lotr-return-of-the-king-demo' --exe 'ROTK_Demo.exe' --os winxp --width 640 --height 480 --bpp 32 --ram 256 --file-times --reg-path 'Software\EA Games\LOTR The Return of the King (tm) Demo' --reg-name 'Install Dir' --reg-install 'C:\'
 if($LASTEXITCODE -ne 0) {throw 'WGB creation failed'}
 & bun tools/wgb.ts replace $OutputWgb 'cover.jpg' (Join-Path $PSScriptRoot '../public/covers/lotr-return-of-the-king-box.jpg')
 if($LASTEXITCODE -ne 0) {throw 'Cover embedding failed'}
 & bun tools/wgb.ts patch-manifest $OutputWgb meta.cover 'cover.jpg'
 if($LASTEXITCODE -ne 0) {throw 'Cover metadata update failed'}
} finally {Pop-Location}
