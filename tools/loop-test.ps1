
$ErrorActionPreference = 'Continue'
$HOME_DIR = 'D:\Mochen\Project\QAQ\qaq-loop-home'
$CLONE = 'D:\Mochen\Project\QAQ\deepseek-harness'
$CLI = 'D:\Mochen\Project\QAQ\src\cli.ts'
$OUTLOG = 'D:\Mochen\Project\QAQ\loop-test.log'

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

# Phase 2: break the profile (add broken theme)
$pkg = Join-Path $HOME_DIR 'profiles\web\package.json'
$broken = @'
{
  "name": "dsh-profile-web-loop",
  "private": true,
  "dependencies": { "dsh-broken-theme": "link:D:/Mochen/Project/QAQ/qaq-test-plugins/dsh-broken-theme" },
  "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-broken-theme" ] } }
}
'@
Set-Content -Path $pkg -Value $broken -Encoding UTF8
$nm = Join-Path $HOME_DIR 'profiles\web\node_modules'
New-Item -ItemType Directory -Force -Path $nm | Out-Null
$j = Join-Path $nm 'dsh-broken-theme'
if (!(Test-Path $j)) { New-Item -ItemType Junction -Path $j -Target 'D:\Mochen\Project\QAQ\qaq-test-plugins\dsh-broken-theme' | Out-Null }
Write-Output "PROFILE-BROKEN"

# Phase 3: run guard 3x against broken -> expect rollback on 3rd
Run-Guard "phase3-run1"
Run-Guard "phase3-run2"
Run-Guard "phase3-run3"

# Phase 4: verify restored profile
$restored = Get-Content $pkg -Raw
Write-Output "RESTORED-PKG: $restored"
Write-Output "===== DONE ====="
