# Builds a staged commit for the T4 checks: frozen pnpm installs of the root and of packaging\ (electron-builder),
# desktop runtimes, the locked Rust release engine, the web build, the app-local Visual C++ runtime and the
# unpacked release package. launch-build.ps1 starts it in the desktop session. Every step records its result in
# build.json and the others still run, but a step whose inputs failed is skipped rather than run on stale output.
# Engine tests, unit tests and the installer run in the hosted Windows job (.github/workflows/windows.yml), not here.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Name,
    [string]$Tools = 'C:\veacom\migration-tools',
    [string]$BuildTools = 'C:\veacom\BuildTools',
    [string]$Study = 'C:\veacom\bench-data\studies\ct-small')
. (Join-Path $PSScriptRoot 'Common.ps1')
$Run = Get-RunPaths $Name
$Root = $Run.Root
$Output = Join-Path $Run.Evidence 'build'
[IO.Directory]::CreateDirectory($Output) | Out-Null
$Result = [ordered]@{ status = 'running'; name = $Name; commit = $null; started = [DateTimeOffset]::UtcNow.ToString('o');
    stopDeadline = $script:StopDeadline.ToString('o'); current = $null; steps = @(); warnings = @() }
$script:Passed = @()
function Save-Build { Save-Json (Join-Path $Output 'build.json') $Result }
function Invoke-Step([string]$StepName, [string[]]$Needs, [scriptblock]$Body) {
    $Entry = [ordered]@{ name = $StepName; status = 'running'; started = [DateTimeOffset]::UtcNow.ToString('o') }
    $Missing = @(@($Needs) | Where-Object { $_ -and $script:Passed -notcontains $_ })
    if ($Missing.Count) { $Entry.status = 'skipped'; $Entry.reason = 'needs ' + ($Missing -join ', ') }
    else {
        $Result.current = $StepName
        Save-Build
        try { & $Body | Out-Null; $Entry.status = 'passed'; $script:Passed += $StepName }
        catch { $Entry.status = 'failed'; $Entry.error = $_.Exception.Message }
    }
    $Entry.finished = [DateTimeOffset]::UtcNow.ToString('o')
    $Result.steps += $Entry
    $Result.current = $null
    Save-Build
}
function Invoke-Cmd([string]$StepName, [string[]]$Lines, [int]$Minutes) {
    $File = Join-Path $Output "$StepName.cmd"
    [IO.File]::WriteAllText($File, ($Lines -join "`r`n") + "`r`n", [Text.Encoding]::ASCII)
    Invoke-LoggedTool -Name $StepName -Executable "$env:WINDIR\System32\cmd.exe" -Arguments @('/d', '/c', $File) `
        -WorkingDirectory $Root -OutputDirectory $Output -TimeoutMinutes $Minutes | Out-Null
}
try {
    Save-Build
    Assert-TimeRemaining 30
    $Stage = Read-Json (Join-Path $Run.Evidence 'stage.json')
    $Result.commit = $Stage.commit
    $Node = Join-Path $Tools 'node\node.exe'
    $VcVars = Join-Path $BuildTools 'VC\Auxiliary\Build\vcvars64.bat'
    $Cmake = Join-Path $BuildTools 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin'
    $Cargo = Join-Path $env:USERPROFILE '.cargo\bin'
    foreach ($File in @($Node, $VcVars, (Join-Path $Cmake 'cmake.exe'), (Join-Path $Cargo 'cargo.exe'))) {
        if (!(Test-Path -LiteralPath $File -PathType Leaf)) { throw "Missing build prerequisite: $File" }
    }
    $env:PATH = "$(Split-Path $Node);$Cargo;C:\Program Files\Git\cmd;$Cmake;" + $env:PATH
    $env:VSCMD_SKIP_SENDTELEMETRY = '1'; $env:CI = 'true'; $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    $Result.node = [string](& $Node --version)
    $Wanted = 'v' + ([IO.File]::ReadAllText((Join-Path $Root '.nvmrc'))).Trim()
    if ($Result.node -ne $Wanted) { $Result.warnings += "Node on the VM is $($Result.node); .nvmrc asks for $Wanted." }

    Invoke-Step 'get-pnpm' @() {
        $Pnpm = & (Join-Path $PSScriptRoot 'get-pnpm.ps1') -Root $Root -Tools $Tools
        $env:PATH = "$(Split-Path $Pnpm);" + $env:PATH
        $Result.pnpm = $Pnpm
    }
    Invoke-Step 'pnpm-install' @('get-pnpm') { Invoke-Cmd 'pnpm-install' @('@pnpm.exe install --frozen-lockfile', '@exit /b %errorlevel%') 20 }
    # electron-builder installs apart from the root (packaging\pnpm-workspace.yaml) and packages the root app.
    Invoke-Step 'packaging-install' @('get-pnpm') { Invoke-Cmd 'packaging-install' @('@pnpm.exe --dir packaging install --frozen-lockfile', '@exit /b %errorlevel%') 10 }
    Invoke-Step 'setup-runtime' @('pnpm-install') { Invoke-Cmd 'setup-runtime' @('@pnpm.exe run setup:runtime', '@exit /b %errorlevel%') 10 }
    # The click budgets accept only the approved synthetic ct-small (tests/golden/ct-small.json).
    Invoke-Step 'study-fingerprint' @() {
        Invoke-LoggedTool -Name 'study-fingerprint' -Executable $Node -Arguments @('tools\check-golden-study.mjs', $Study) `
            -WorkingDirectory $Root -OutputDirectory $Output -TimeoutMinutes 3 | Out-Null
    }
    Invoke-Step 'native-build' @() {
        Invoke-Cmd 'native-build' @(('@call "' + $VcVars + '"'), '@if errorlevel 1 exit /b %errorlevel%',
            '@cargo build --locked --release --manifest-path native\Cargo.toml', '@exit /b %errorlevel%') 40
        $Core = Get-Item -LiteralPath (Join-Path $Root 'native\target\release\veacom-core.exe')
        if ($Core.LastWriteTimeUtc.ToFileTimeUtc() -lt [long]$Stage.stagedFileTimeUtc) {
            throw 'veacom-core.exe is older than this staging: cargo did not rebuild it from these sources.'
        }
        $Result.nativeSha256 = (Get-FileHash -LiteralPath $Core.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    Invoke-Step 'web-build' @('pnpm-install') { Invoke-Cmd 'web-build' @('@pnpm.exe run build:web', '@exit /b %errorlevel%') 10 }
    # Windows PowerShell leaves $PSScriptRoot empty in that script's parameter defaults, so pass both folders.
    Invoke-Step 'app-local-runtime' @('native-build') {
        $Crt = Get-ChildItem (Join-Path $BuildTools 'VC\Redist\MSVC\*\x64\Microsoft.VC*.CRT') -Directory | Sort-Object FullName -Descending | Select-Object -First 1
        if (!$Crt) { throw 'The x64 release CRT directory was not found.' }
        Invoke-LoggedTool -Name 'app-local-runtime' -Executable "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
            -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'scripts\windows-runtime.ps1'),
                '-TargetDirectory', (Join-Path $Root 'native\target\release'), '-RedistDirectory', $Crt.FullName) `
            -WorkingDirectory $Root -OutputDirectory $Output -TimeoutMinutes 5 | Out-Null
    }
    Invoke-Step 'package' @('packaging-install', 'setup-runtime', 'web-build', 'app-local-runtime') {
        $Release = Join-Path $Root 'release-electron'
        if (Test-Path -LiteralPath $Release) { Remove-Item -LiteralPath $Release -Recurse -Force }
        Invoke-LoggedTool -Name 'package' -Executable $Node -Arguments @('packaging\node_modules\electron-builder\cli.js', '--config', 'electron-builder.release.cjs',
            '--win', '--x64', '--dir', '--publish', 'never', '-c.forceCodeSigning=false') -WorkingDirectory $Root -OutputDirectory $Output -TimeoutMinutes 15 | Out-Null
        $Packaged = Join-Path $Release 'win-unpacked\VEAcom Electron.exe'
        $PackagedCore = Join-Path $Release 'win-unpacked\resources\native\veacom-core.exe'
        if ((Get-FileHash -LiteralPath $PackagedCore -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Result.nativeSha256) {
            throw 'The packaged engine differs from the one this build produced.'
        }
        $Result.packaged = $Packaged
        $Result.packagedExeSha256 = (Get-FileHash -LiteralPath $Packaged -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $Result.status = if (@($Result.steps | Where-Object { $_.status -ne 'passed' }).Count) { 'failed' } else { 'passed' }
} catch { $Result.status = 'failed'; $Result.error = $_.Exception.Message; throw }
finally { $Result.current = $null; $Result.finished = [DateTimeOffset]::UtcNow.ToString('o'); Save-Build }
