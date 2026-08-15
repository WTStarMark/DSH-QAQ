
# Loop integration test: healthy boot -> snapshot -> break -> 3 guarded runs ->
# verify rollback. Location-independent: paths derive from $PSScriptRoot; the
# DSH checkout comes from $env:QAQ_SMOKE_DSH_HOME (or a sibling 'deepseek-harness').
$ErrorActionPreference = 'Continue'
$ROOT = Split-Path $PSScriptRoot -Parent
$HOME_DIR = Join-Path $ROOT 'qaq-loop-home'
$CLONE = if ($env:QAQ_SMOKE_DSH_HOME) { $env:QAQ_SMOKE_DSH_HOME } else { Join-Path (Split-Path $ROOT -Parent) 'deepseek-harness' }
$CLI = Join-Path $ROOT 'src\cli.ts'
$OUTLOG = Join-Path $ROOT 'loop-test.log'
$BROKEN = Join-Path $ROOT 'qaq-test-plugins\dsh-broken-theme'
$BROKEN_FWD = ($BROKEN -replace '\\', '/')

function Run-Guard($label) {
  Write-Output "===== $label ====="
  $env:DSH_HOME = $HOME_DIR
  $env:QAQ_DSH_CMD = 'node --import tsx/esm apps/cli/src/bin.ts web'
  Push-Location $CLONE
  node --import tsx/esm $CLI dsh web --port 3081 --yes 2>&1 | ForEach-Object { Write-Output "[$label] $_" }
  Pop-Location
  Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue
  Remove-Item Env:\QAQ_DSH_CMD -ErrorAction SilentlyContinue
}

# Phase 1: healthy boot -> success snapshot
Run-Guard "phase1-healthy"
$state1 = Get-Content (Join-Path $HOME_DIR '.qaq\state.json') -Raw -ErrorAction SilentlyContinue
Write-Output "STATE1: $state1"

function Write-NoBom($path, $content) {
  [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

# Phase 2: break the profile (add broken theme)
$pkg = Join-Path $HOME_DIR 'profiles\web\package.json'
$broken = @"
{
  "name": "dsh-profile-web-loop",
  "private": true,
  "dependencies": { "dsh-broken-theme": "link:$BROKEN_FWD" },
  "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-broken-theme" ] } }
}
"@
Write-NoBom $pkg $broken
$nm = Join-Path $HOME_DIR 'profiles\web\node_modules'
New-Item -ItemType Directory -Force -Path $nm | Out-Null
$j = Join-Path $nm 'dsh-broken-theme'
if (!(Test-Path $j)) { New-Item -ItemType Junction -Path $j -Target $BROKEN | Out-Null }
Write-Output "PROFILE-BROKEN"

# Phase 3: run guard 3x against broken -> expect rollback on 3rd
Run-Guard "phase3-run1"
Run-Guard "phase3-run2"
Run-Guard "phase3-run3"

# Phase 4: verify restored profile
$restored = Get-Content $pkg -Raw
Write-Output "RESTORED-PKG: $restored"
Write-Output "===== DONE ====="
