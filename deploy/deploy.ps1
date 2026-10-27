# Copies the project to the server and starts it: .\deploy\deploy.ps1 -Server trader@1.2.3.4
# Add -IncludeState to carry the current seasons (data folders) over. Stop the PC's copies FIRST:
# two processes trading the same Alpaca account corrupt the books.
# -Services picks which funds run (main = Alpaca fund, hi = high activity, niche = OKX demo).
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string[]]$Services = @('main', 'hi'),
  [switch]$IncludeState
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pack = Join-Path $env:TEMP 'ai-trader-deploy.tgz'
$dirOf = @{ main = 'data'; niche = 'data-niche'; hi = 'data-hi' }

Write-Host 'Packing the project (no secrets, no data, no node_modules)...'
tar -czf $pack -C $root --exclude=node_modules --exclude=.git --exclude=web/dist --exclude=data --exclude=data-niche --exclude=data-hi --exclude=data-live --exclude=.env --exclude=secrets.env --exclude=LIVE_APPROVAL.json --exclude='*.log' .

Write-Host "Copying to $Server ..."
scp $pack "${Server}:ai-trader.tgz"
ssh $Server 'mkdir -p ai-trader && tar -xzf ai-trader.tgz -C ai-trader && rm ai-trader.tgz'

Write-Host 'Copying .env (API keys) over SSH as secrets.env...'
scp (Join-Path $root '.env') "${Server}:ai-trader/secrets.env"
ssh $Server 'chmod 600 ai-trader/secrets.env'

if ($IncludeState) {
  foreach ($s in $Services) {
    $p = Join-Path $root $dirOf[$s]
    if (Test-Path $p) {
      Write-Host "Copying $($dirOf[$s]) ..."
      ssh $Server "mkdir -p ai-trader/$($dirOf[$s])"
      # The state and trade log; logs are not needed.
      foreach ($f in 'state.json', 'trades.jsonl') {
        if (Test-Path (Join-Path $p $f)) { scp (Join-Path $p $f) "${Server}:ai-trader/$($dirOf[$s])/$f" }
      }
    }
  }
}

# Docker prints build progress on stderr, which PowerShell treats as an error, and a dropped SSH session
# kills a foreground build. So build in the background on the server and poll for the result.
$names = $Services -join ' '
Write-Host "Building and starting: $names (the first build takes a few minutes)..."
$ErrorActionPreference = 'Continue'
ssh $Server "cd ai-trader && nohup docker compose up -d --build $names > build.log 2>&1 &" 2>&1 | Out-Null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 10
  $state = ssh $Server 'cd ai-trader && docker compose ps --format "{{.Service}}:{{.State}}"' 2>$null
  if (($Services | Where-Object { $state -match "^$_`:running" }).Count -eq $Services.Count) { break }
}
ssh $Server 'cd ai-trader && docker compose ps' 2>&1 | Out-Host
Write-Host "Done. Look at it with: ssh -L 8787:127.0.0.1:8787 -L 8789:127.0.0.1:8789 $Server"
