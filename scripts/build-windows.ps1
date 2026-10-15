$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electronDist = Join-Path $projectRoot 'node_modules/electron/dist'
$desktopPackage = Get-Content (Join-Path $projectRoot 'apps/desktop/package.json') -Raw | ConvertFrom-Json
$releaseRoot = Join-Path $projectRoot 'release'
$versionedName = "Ben Infotech Workforce-$($desktopPackage.version)"
$bundlePath = Join-Path $releaseRoot $versionedName
$resourcesPath = Join-Path $bundlePath 'resources'
$appPath = Join-Path $resourcesPath 'app'
$sharedPath = Join-Path $appPath 'node_modules/@eam/shared'
$archivePath = Join-Path $releaseRoot "$versionedName-win-x64.zip"

if ($env:OS -ne 'Windows_NT') { throw 'The portable bundle must be built on Windows.' }
if (-not (Test-Path (Join-Path $electronDist 'electron.exe'))) { throw 'Electron runtime is missing; run npm install from the project root first.' }
if ((Test-Path $bundlePath) -or (Test-Path $archivePath)) { throw "Build output already exists for version $($desktopPackage.version). Move the old output before rebuilding." }

New-Item -ItemType Directory -Path $releaseRoot, $appPath, $sharedPath -Force | Out-Null
Copy-Item -Path (Join-Path $electronDist '*') -Destination $bundlePath -Recurse -Force
Copy-Item -Path (Join-Path $projectRoot 'apps/desktop/src') -Destination $appPath -Recurse
Copy-Item -Path (Join-Path $projectRoot 'apps/desktop/package.json') -Destination (Join-Path $appPath 'package.json')
Copy-Item -Path (Join-Path $projectRoot 'packages/shared/package.json') -Destination $sharedPath
Copy-Item -Path (Join-Path $projectRoot 'packages/shared/src.js') -Destination $sharedPath
Move-Item -Path (Join-Path $bundlePath 'electron.exe') -Destination (Join-Path $bundlePath 'Ben Infotech Workforce.exe')
Compress-Archive -Path (Join-Path $bundlePath '*') -DestinationPath $archivePath
Write-Output "Portable application: $bundlePath"
Write-Output "ZIP archive: $archivePath"
