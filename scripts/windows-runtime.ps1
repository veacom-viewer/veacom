# Copies Microsoft's x64 release CRT beside the Rust executable for app-local loading.
# Run after the native release build and before electron-builder packages the app.
[CmdletBinding()]
param(
    [string]$TargetDirectory = (Join-Path $PSScriptRoot '..\native\target\release'),
    [string]$RedistDirectory
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This helper requires Windows.' }
$TargetDirectory = [IO.Path]::GetFullPath($TargetDirectory)
if (!(Test-Path (Join-Path $TargetDirectory 'veacom-core.exe') -PathType Leaf)) { throw 'Build veacom-core.exe first.' }
if (!$RedistDirectory) {
    $VersionRoot = $env:VCToolsRedistDir
    if (!$VersionRoot) {
        $Vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
        if (!(Test-Path $Vswhere)) { throw 'Cannot find Visual Studio. Supply -RedistDirectory with the x64 Microsoft.VC143.CRT directory.' }
        $Install = & $Vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if (!$Install) { throw 'The Visual C++ build tools are not installed.' }
        $Version = Get-ChildItem (Join-Path $Install 'VC\Redist\MSVC') -Directory | Where-Object Name -Match '^\d+(\.\d+)+$' | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
        if (!$Version) { throw 'The Visual C++ redistributable directory was not found.' }
        $VersionRoot = $Version.FullName
    }
    $Crt = Get-ChildItem (Join-Path $VersionRoot 'x64') -Directory -Filter 'Microsoft.VC*.CRT' | Sort-Object Name -Descending | Select-Object -First 1
    if (!$Crt) { throw 'The x64 release CRT directory was not found.' }
    $RedistDirectory = $Crt.FullName
}
$RedistDirectory = (Resolve-Path $RedistDirectory).Path
if ($RedistDirectory -match 'debug_nonredist|DebugCRT' -or !(Test-Path (Join-Path $RedistDirectory 'vcruntime140.dll'))) { throw 'Supply the release x64 CRT directory, not debug libraries.' }
function Assert-X64([string]$File) {
    $Stream = [IO.File]::OpenRead($File)
    $Reader = New-Object IO.BinaryReader $Stream
    try {
        $Stream.Position = 0x3c
        $Header = $Reader.ReadInt32()
        $Stream.Position = $Header + 4
        if ($Reader.ReadUInt16() -ne 0x8664) { throw "Not an x64 executable: $File" }
    } finally { $Reader.Dispose() }
}
Assert-X64 (Join-Path $TargetDirectory 'veacom-core.exe')
$Manifest = @()
foreach ($Library in Get-ChildItem $RedistDirectory -Filter '*.dll' -File) {
    Assert-X64 $Library.FullName
    $Signature = Get-AuthenticodeSignature $Library.FullName
    if ($Signature.Status -ne 'Valid' -or $Signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw "Unverified Microsoft runtime: $($Library.Name)" }
    $Destination = Join-Path $TargetDirectory $Library.Name
    Copy-Item $Library.FullName $Destination -Force
    $Manifest += [ordered]@{ name=$Library.Name; version=$Library.VersionInfo.FileVersion; sha256=(Get-FileHash $Destination -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$Manifest | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $TargetDirectory 'windows-runtime-manifest.json') -Encoding UTF8
Write-Output "Copied $($Manifest.Count) signed x64 runtime libraries to $TargetDirectory."
