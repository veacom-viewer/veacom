# Checks the Windows release package and its installer, for the hosted Windows job (.github/workflows/windows.yml).
# Run from the repository root with Windows PowerShell or pwsh after electron-builder (installed in packaging/):
#   -Action Package    the packaged engine is the one this job built, and its app-local runtime is intact
#   -Action Install    silent per-user install: files, engine and uninstall registration in place, in a folder
#                      named after the product
#   -Action Uninstall  silent uninstall: folder, registration and processes gone
# Each action writes <action>.json into -Output and throws on any failure. Install also writes the installed
# executable to $GITHUB_OUTPUT as `executable`, when that file is set.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Package', 'Install', 'Uninstall')][string]$Action,
    [Parameter(Mandatory=$true)][string]$Output,
    [string]$Release = 'release-electron',
    [string]$Engine = 'native\target\release\veacom-core.exe',
    [string]$Product = 'VEAcom Electron')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Output = [IO.Path]::GetFullPath($Output)
[IO.Directory]::CreateDirectory($Output) | Out-Null
$Package = [IO.Path]::GetFullPath((Join-Path $Release 'win-unpacked'))

function Save-Json([string]$Name, $Value) {
    [IO.File]::WriteAllText((Join-Path $Output $Name), ($Value | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
}
function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-Field($Object, [string]$Name) { if ($Object.PSObject.Properties[$Name]) { $Object.$Name } else { $null } }
function Get-Registration {
    @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { [string](Get-Field $_ 'DisplayName') -like "$Product*" })
}
function Get-InstallFolder {
    $Registered = @(Get-Registration | ForEach-Object { Get-Field $_ 'InstallLocation' } | Where-Object { $_ })
    if ($Registered.Count) { return ([string]$Registered[0]).Trim('"').TrimEnd('\') }
    return (Join-Path $env:LOCALAPPDATA "Programs\$Product")
}
function Wait-Until([scriptblock]$Condition, [int]$Seconds) {
    $Until = [DateTime]::UtcNow.AddSeconds($Seconds)
    while (!(& $Condition)) {
        if ([DateTime]::UtcNow -ge $Until) { return $false }
        Start-Sleep -Seconds 2
    }
    return $true
}

$PackagedEngine = Join-Path $Package 'resources\native\veacom-core.exe'
if ($Action -eq 'Package') {
    $Native = Split-Path $PackagedEngine
    $Built = Get-Sha256 $Engine
    $Packaged = Get-Sha256 $PackagedEngine
    if ($Built -ne $Packaged) { throw "The packaged engine ($Packaged) is not the one this job built ($Built)." }
    # Windows PowerShell's ConvertFrom-Json passes a JSON array on as one object; @() of the variable unwraps it.
    $Parsed = ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $Native 'windows-runtime-manifest.json')))
    $Runtime = @($Parsed)
    if (!$Runtime.Count) { throw 'The package has no app-local Visual C++ runtime.' }
    foreach ($Library in $Runtime) {
        $File = Join-Path $Native $Library.name
        if (!(Test-Path -LiteralPath $File -PathType Leaf)) { throw "The package lacks $($Library.name) from its runtime manifest." }
        if ((Get-Sha256 $File) -ne $Library.sha256) { throw "$($Library.name) in the package differs from its runtime manifest." }
    }
    $Files = @(Get-ChildItem -LiteralPath $Package -Recurse -File)
    Save-Json 'windows-package.json' ([ordered]@{ passed = $true; package = $Package; engineSha256 = $Packaged
        executableSha256 = (Get-Sha256 (Join-Path $Package "$Product.exe")); runtime = @($Runtime | ForEach-Object { "$($_.name) $($_.version)" })
        files = $Files.Count; megabytes = [Math]::Round((($Files | Measure-Object Length -Sum).Sum) / 1MB, 1) })
    Write-Output "Packaged engine matches the build; $($Runtime.Count) runtime libraries match their manifest."
}
elseif ($Action -eq 'Install') {
    $Installers = @(Get-ChildItem -LiteralPath $Release -Filter '*-Installer.exe' -File)
    if ($Installers.Count -ne 1) { throw "Expected one installer in $Release, found $($Installers.Count)." }
    $Installer = $Installers[0]
    if (@(Get-Registration).Count -or (Test-Path -LiteralPath (Get-InstallFolder))) { throw "$Product is already installed; this check needs a clean machine." }
    $Process = Start-Process -FilePath $Installer.FullName -ArgumentList '/S' -PassThru -Wait
    if ($Process.ExitCode -ne 0) { throw "The installer exited with $($Process.ExitCode)." }
    $Installed = $false
    if (Wait-Until { @(Get-Registration).Count -and (Test-Path -LiteralPath (Join-Path (Get-InstallFolder) "$Product.exe")) } 120) { $Installed = $true }
    if (!$Installed) { throw "The silent install did not leave $Product.exe and its uninstall registration within two minutes." }
    $Folder = Get-InstallFolder
    # Installed releases update in place only while the folder keeps the product's name.
    if ((Split-Path -Leaf $Folder) -cne $Product) { throw "The installer chose $Folder, not a folder named $Product." }
    $Executable = Join-Path $Folder "$Product.exe"
    $Engine = Get-Sha256 (Join-Path $Folder 'resources\native\veacom-core.exe')
    if ($Engine -ne (Get-Sha256 $PackagedEngine)) { throw 'The installed engine differs from the packaged one.' }
    $Registration = (Get-Registration)[0]
    Save-Json 'install.json' ([ordered]@{ passed = $true; installer = $Installer.Name; installerBytes = $Installer.Length
        installerSha256 = (Get-Sha256 $Installer.FullName); folder = $Folder; engineSha256 = $Engine
        executableMatchesPackage = ((Get-Sha256 $Executable) -eq (Get-Sha256 (Join-Path $Package "$Product.exe")))
        displayName = (Get-Field $Registration 'DisplayName'); displayVersion = (Get-Field $Registration 'DisplayVersion') })
    if ($env:GITHUB_OUTPUT) { [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "executable=$Executable`n") }
    Write-Output "Installed $($Installer.Name) into $Folder."
}
else {
    $Folder = Get-InstallFolder
    $Uninstaller = Join-Path $Folder "Uninstall $Product.exe"
    if (!(Test-Path -LiteralPath $Uninstaller -PathType Leaf)) { throw "No uninstaller at $Uninstaller." }
    $Process = Start-Process -FilePath $Uninstaller -ArgumentList '/S' -PassThru -Wait
    if ($Process.ExitCode -ne 0) { throw "The uninstaller exited with $($Process.ExitCode)." }
    # The NSIS uninstaller copies itself to a temporary folder and returns at once; wait for the copy to finish.
    $Gone = Wait-Until { !(Test-Path -LiteralPath $Folder) -and !@(Get-Registration).Count } 120
    $Left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $Path = Get-Field $_ 'Path'
        ($Path -and $Path.StartsWith($Folder + '\', [StringComparison]::OrdinalIgnoreCase)) -or $_.ProcessName -eq $Product -or $_.ProcessName -eq 'veacom-core' })
    $Result = [ordered]@{ passed = ($Gone -and !$Left.Count); folderRemoved = !(Test-Path -LiteralPath $Folder)
        registrationRemoved = !@(Get-Registration).Count; processesLeft = @($Left | ForEach-Object { "$($_.ProcessName) $($_.Id)" }) }
    Save-Json 'uninstall.json' $Result
    if (!$Result.passed) { throw "The silent uninstall left something behind: folder removed $($Result.folderRemoved), registration removed $($Result.registrationRemoved), processes $($Result.processesLeft -join ', ')." }
    Write-Output "Uninstalled: $Folder and its registration are gone, and nothing of it is running."
}
