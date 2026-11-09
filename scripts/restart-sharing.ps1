# This entry point shares the already-running backend. It only manages the tunnel.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$deployRoot = Join-Path $repoRoot 'output/deploy'
$cfBinary = Join-Path $deployRoot 'cloudflared.exe'
$tokenFile = Join-Path $deployRoot '.tunnel-token'
$pidFile = Join-Path $deployRoot 'tunnel.pid'
$logDir = Join-Path $repoRoot 'backend/logs'

if (-not (Test-Path -LiteralPath $cfBinary -PathType Leaf)) { throw 'cloudflared.exe is missing.' }
if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) { throw 'Tunnel credential is missing.' }
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 5
    if ($health.status -ne 'ok') { throw 'Backend health check failed.' }
} catch {
    throw 'The local backend on port 8000 is not ready. Start it yourself, then run this script again. No services were stopped.'
}

# A saved PID may have been reused. Stop only our cloudflared with this token-file.
if (Test-Path -LiteralPath $pidFile) {
    $servicePid = 0
    if ([int]::TryParse(([IO.File]::ReadAllText($pidFile)).Trim(), [ref]$servicePid) -and $servicePid -gt 0) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$servicePid"
        if ($process) {
            $tokenPattern = '(?:^|\s)--token-file(?:\s+|=)(?:"' + [regex]::Escape($tokenFile) + '"|' + [regex]::Escape($tokenFile) + '(?=\s|$))'
            $isOwnedTunnel = $process.ExecutablePath -eq $cfBinary -and ([string]$process.CommandLine -match $tokenPattern)
            if ($isOwnedTunnel) {
                Stop-Process -Id $servicePid -Force -ErrorAction Stop
                Wait-Process -Id $servicePid -Timeout 5 -ErrorAction SilentlyContinue
            } else {
                Write-Warning 'The saved tunnel PID belongs to another process; that process was left running.'
            }
        }
    } else {
        Write-Warning 'The saved tunnel PID is invalid; no process was stopped.'
    }
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$cfProcess = Start-Process -FilePath $cfBinary -ArgumentList @(
    'tunnel', '--no-autoupdate', 'run', '--token-file', ('"' + $tokenFile + '"')
) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'cloudflared-windows.out.log') -RedirectStandardError (Join-Path $logDir 'cloudflared-windows.err.log') -PassThru
Start-Sleep -Seconds 1
if ($cfProcess.HasExited) { throw 'The tunnel process exited. Check backend/logs/cloudflared-windows.err.log.' }
Set-Content -LiteralPath $pidFile -Value $cfProcess.Id
Write-Output "Tunnel process started: $($cfProcess.Id). The backend on port 8000 was left running."
Write-Output 'Open https://xiaocheng.online after the tunnel connects (this may take a few seconds).'
