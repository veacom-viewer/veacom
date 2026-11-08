# Turns the NVIDIA display adapter off or on, so Windows falls back to Microsoft's basic display driver:
# the state of a hospital PC without a graphics driver. Records every display adapter before and after.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Status','Disable','Enable')][string]$Action,
    [string]$Output='C:\veacom\swgl-evidence\display-adapter')
. (Join-Path $PSScriptRoot 'Common.ps1')
function Get-Adapters {
    @(Get-PnpDevice -Class Display | Select-Object FriendlyName, InstanceId, Status, Problem) +
    @(Get-CimInstance Win32_VideoController | Select-Object @{n='FriendlyName';e={$_.Name}}, @{n='InstanceId';e={$_.PNPDeviceID}},
        @{n='Status';e={$_.Status}}, @{n='Problem';e={$_.ConfigManagerErrorCode}}, DriverVersion, CurrentHorizontalResolution, CurrentVerticalResolution)
}
$Before = Get-Adapters
$Nvidia = @(Get-PnpDevice -Class Display | Where-Object { $_.InstanceId -match 'VEN_10DE' })
if ($Action -ne 'Status') {
    # Never start disabling near the stop deadline; re-enabling is always allowed.
    if ($Action -eq 'Disable') { Assert-TimeRemaining 5 }
    if (!$Nvidia) { throw 'No NVIDIA display adapter was found.' }
    foreach ($Device in $Nvidia) {
        try {
            if ($Action -eq 'Disable') { Disable-PnpDevice -InstanceId $Device.InstanceId -Confirm:$false }
            else { Enable-PnpDevice -InstanceId $Device.InstanceId -Confirm:$false }
        } catch {
            # Some sessions refuse the PnP cmdlets; pnputil does the same through the driver store.
            $Verb = if ($Action -eq 'Disable') { '/disable-device' } else { '/enable-device' }
            & "$env:WINDIR\System32\pnputil.exe" $Verb $Device.InstanceId | Out-Host
            if ($LASTEXITCODE -ne 0) { throw "pnputil $Verb failed with exit $LASTEXITCODE." }
        }
    }
    $Wanted = if ($Action -eq 'Disable') { 'Error' } else { 'OK' }
    $Deadline = [DateTime]::UtcNow.AddSeconds(60)
    do { Start-Sleep -Seconds 2; $Now = @(Get-PnpDevice -Class Display | Where-Object { $_.InstanceId -match 'VEN_10DE' }) }
    while (($Now | Where-Object Status -ne $Wanted) -and [DateTime]::UtcNow -lt $Deadline)
    if ($Now | Where-Object Status -ne $Wanted) { throw "The NVIDIA adapter did not reach status $Wanted." }
}
$After = Get-Adapters
$Stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss')
Save-Json (Join-Path $Output "$Stamp-$Action.json") @{ action=$Action; time=[DateTimeOffset]::UtcNow.ToString('o'); before=$Before; after=$After }
$After | Format-Table -AutoSize | Out-String -Width 220
