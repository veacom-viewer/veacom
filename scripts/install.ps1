# Run the verified GitHub release installer.
& {
    $ErrorActionPreference = 'Stop'
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (!$architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $architecture -ne 'AMD64') {
        throw 'VEAcom requires Windows x64. Apple Silicon Macs have a separate installer.'
    }

    $releases = Invoke-RestMethod -Uri 'https://api.github.com/repos/veacom-viewer/veacom/releases?per_page=1'
    $tag = @($releases)[0].tag_name
    if (!$tag -or $tag -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$') {
        throw 'Could not identify a published VEAcom release.'
    }
    $base = "https://github.com/veacom-viewer/veacom/releases/download/$tag"
    $asset = "VEAcom-Electron-$($tag.Substring(1))-win-x64-Installer.exe"
    $directory = Join-Path ([IO.Path]::GetTempPath()) ('veacom-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    try {
        $manifest = Join-Path $directory 'SHA256SUMS.txt'
        Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS.txt" -OutFile $manifest
        $pattern = '^([0-9a-fA-F]{64})\s+\*?' + [Regex]::Escape($asset) + '$'
        $hashes = @(foreach ($line in [IO.File]::ReadAllLines($manifest)) {
            if ($line -cmatch $pattern) { $Matches[1] }
        })
        if ($hashes.Count -ne 1) { throw "The release has no unique SHA-256 checksum for $asset." }
        $installer = Join-Path $directory $asset
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $installer
        if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ine $hashes[0]) {
            throw "SHA-256 verification failed for $asset."
        }
        Set-Content -LiteralPath $installer -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3`r`nHostUrl=$base/$asset"
        Write-Output "Verified $asset. Opening the Windows installer."
        $process = Start-Process -FilePath $installer -PassThru -Wait
        if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode)." }
    } finally {
        Remove-Item -LiteralPath $directory -Recurse -Force
    }
}
