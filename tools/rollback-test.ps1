
$ErrorActionPreference = 'Continue'
$H = 'D:\Mochen\Project\QAQ\qaq-rollback-test-home'
$CLONE = 'D:\Mochen\Project\QAQ\deepseek-harness'
$CLI = 'D:\Mochen\Project\QAQ\src\cli.ts'
$LOG = 'D:\Mochen\Project\QAQ\rollback-test.log'

function Write-NoBom($path, $content) {
  [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

# Reset home
if (Test-Path $H) { Remove-Item $H -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $H 'profiles\web') | Out-Null

# Clean (good) config
$goodPkg = '{"name":"dsh-profile-web","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}'
Write-NoBom (Join-Path $H 'profiles\web\package.json') $goodPkg
Write-NoBom (Join-Path $H 'profiles\web\cordis.patch.yml') '[]'

# NOW we seed a last-good snapshot manually: run recordSuccess via qaq backup on this good config first.
$env:DSH_HOME = $H
$env:QAQ_DSH_CMD = 'node --import tsx/esm apps/cli/src/bin.ts web'
Push-Location $CLONE
node --import tsx/esm $CLI backup --profile web 2>&1 | ForEach-Object { Write-Output "[backup-good] $_" }
Pop-Location
Remove-Item Env:\DSH_HOME, Env:\QAQ_DSH_CMD -ErrorAction SilentlyContinue
Write-Output "SEEDED-GOOD"

# Now break the profile (add broken theme) WITHOUT BOM
$brokenPkg = @'
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": { "dsh-broken-theme": "link:D:/Mochen/Project/QAQ/qaq-test-plugins/dsh-broken-theme" },
  "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-broken-theme" ] } }
}
'@
Write-NoBom (Join-Path $H 'profiles\web\package.json') $brokenPkg
$nm = Join-Path $H 'profiles\web\node_modules'
New-Item -ItemType Directory -Force -Path $nm | Out-Null
$jn = Join-Path $nm 'dsh-broken-theme'
if (!(Test-Path $jn)) { New-Item -ItemType Junction -Path $jn -Target 'D:\Mochen\Project\QAQ\qaq-test-plugins\dsh-broken-theme' | Out-Null }
Write-Output "PROFILE-BROKEN"

function Run-Guard($label) {
  $env:DSH_HOME = $H
  $env:QAQ_DSH_CMD = 'node --import tsx/esm apps/cli/src/bin.ts web'
  Push-Location $CLONE
  Write-Output "===== $label ====="
  node --import tsx/esm $CLI dsh web --port 3081 --yes 2>&1 | ForEach-Object { Write-Output "[$label] $_" }
  Pop-Location
  Remove-Item Env:\DSH_HOME, Env:\QAQ_DSH_CMD -ErrorAction SilentlyContinue
}

Run-Guard "broken-run-1"
Run-Guard "broken-run-2"
Run-Guard "broken-run-3"

# Verify restored profile (should be good config, broken theme removed)
$restored = Get-Content (Join-Path $H 'profiles\web\package.json') -Raw
Write-Output "RESTORED-PKG: $restored"
$state = Get-Content (Join-Path $H '.qaq\state.json') -Raw -ErrorAction SilentlyContinue
Write-Output "FINAL-STATE: $state"
Write-Output "===== DONE ====="
