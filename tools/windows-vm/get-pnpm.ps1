[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Tools)
$ErrorActionPreference = 'Stop'
$Manager = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).packageManager
if ($Manager -ne 'pnpm@12.18.0') { throw 'Update the verified Windows pnpm release checksum when changing packageManager.' }
$Version = $Manager.Substring(5)
$Expected = 'dfe2123affd2ed4be280ba7ab4678c0fae130b4936fabefa9b1675b60514ef7c'
$Cache = Join-Path $Tools "pnpm\$Version"
[IO.Directory]::CreateDirectory($Cache) | Out-Null
$Archive = Join-Path $Cache 'pnpm-win32-x64.zip'
if (!(Test-Path -LiteralPath $Archive -PathType Leaf)) {
    $Temp = Join-Path $Cache ([IO.Path]::GetRandomFileName())
    try {
        Invoke-WebRequest "https://github.com/pnpm/pnpm/releases/download/v$Version/pnpm-win32-x64.zip" -UseBasicParsing -OutFile $Temp
        if ((Get-FileHash $Temp -Algorithm SHA256).Hash -ine $Expected) { throw 'Downloaded pnpm archive checksum mismatch.' }
        Move-Item -LiteralPath $Temp -Destination $Archive
    } finally { if (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp } }
}
if ((Get-FileHash $Archive -Algorithm SHA256).Hash -ine $Expected) { throw 'Cached pnpm archive checksum mismatch.' }
$Bin = Join-Path $Cache $Expected
if (!(Test-Path -LiteralPath $Bin -PathType Container)) {
    $Temp = Join-Path $Cache ([IO.Path]::GetRandomFileName())
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Temp)
        Move-Item -LiteralPath $Temp -Destination $Bin
    } finally { if (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Recurse } }
}
$Exe = Join-Path $Bin 'pnpm.exe'
if ((& $Exe --version) -ne $Version -or $LASTEXITCODE -ne 0) { throw 'Unexpected Windows pnpm version.' }
$Exe
