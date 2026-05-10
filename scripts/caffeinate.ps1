<#
.SYNOPSIS
    Toggle Windows sleep/monitor/hibernate behaviour for long-running tasks.

.DESCRIPTION
    `start` disables sleep/monitor/hibernate timeouts and starts presentation mode
    so the PC stays awake while a long task runs.
    `stop`  restores sensible defaults (monitor 10/5 min, standby 30/15 min,
    hibernate never) and stops presentation mode.

    The script self-elevates via UAC if not already running as administrator.

.EXAMPLE
    powershell.exe -File scripts\caffeinate.ps1 start
    powershell.exe -File scripts\caffeinate.ps1 stop
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet('start', 'stop')]
    [string]$Action,

    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    $argList = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', "`"$PSCommandPath`"",
        $Action,
        '-Elevated'
    )
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs
    exit
}

switch ($Action) {
    'start' {
        Write-Host 'Caffeine ON: disabling sleep, monitor, and hibernate timeouts.'
        powercfg /change standby-timeout-ac 0
        powercfg /change standby-timeout-dc 0
        powercfg /change monitor-timeout-ac 0
        powercfg /change monitor-timeout-dc 0
        powercfg /change hibernate-timeout-ac 0
        powercfg /change hibernate-timeout-dc 0
        presentationsettings /start
        Write-Host 'Done. Run `caffeinate.ps1 stop` when the task finishes.'
    }
    'stop' {
        Write-Host 'Caffeine OFF: restoring monitor 10/5 min, standby 30/15 min, hibernate never.'
        powercfg /change monitor-timeout-ac 10
        powercfg /change monitor-timeout-dc 5
        powercfg /change standby-timeout-ac 30
        powercfg /change standby-timeout-dc 15
        powercfg /change hibernate-timeout-ac 0
        powercfg /change hibernate-timeout-dc 0
        presentationsettings /stop
        Write-Host 'Done. Power settings restored.'
    }
}

if ($Elevated) {
    Write-Host ''
    Read-Host 'Press Enter to close this window'
}
