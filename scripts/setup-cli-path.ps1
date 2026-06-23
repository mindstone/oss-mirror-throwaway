param(
  [string]$CliSource = $env:REBEL_CLI_SOURCE
)

$ErrorActionPreference = "Stop"
$DryRun = $env:SETUP_CLI_DRY_RUN -eq "1"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $CliSource) {
  $CliSource = Join-Path $ScriptDir "rebel.js"
}

$InstallDir = if ($env:REBEL_CLI_BIN_DIR) {
  $env:REBEL_CLI_BIN_DIR
} else {
  Join-Path $env:LOCALAPPDATA "Programs\rebel"
}

$ExeTarget = Join-Path $InstallDir "rebel.exe"
$CmdTarget = Join-Path $InstallDir "rebel.cmd"
$PsTarget = Join-Path $InstallDir "rebel.ps1"

function Write-DryRun([string]$Message) {
  if ($DryRun) {
    Write-Host "DRY RUN: $Message"
  }
}

if (-not (Test-Path -LiteralPath $CliSource -PathType Leaf)) {
  Write-Warning "Rebel CLI source not found: $CliSource"
  exit 0
}

if (Test-Path -LiteralPath $ExeTarget) {
  Write-Warning "Refusing to overwrite existing rebel binary at $ExeTarget"
  exit 0
}

if ($DryRun) {
  Write-DryRun "would create $InstallDir"
  Write-DryRun "would create command shims $CmdTarget and $PsTarget for $CliSource"
} else {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $nodePath = Join-Path $ScriptDir "..\node-bundle\node.exe"
  $cmd = "@echo off`r`n`"$nodePath`" `"$CliSource`" %*`r`n"
  Set-Content -LiteralPath $CmdTarget -Value $cmd -Encoding ASCII
  $ps = "& `"$nodePath`" `"$CliSource`" @args`r`n"
  Set-Content -LiteralPath $PsTarget -Value $ps -Encoding UTF8
  Write-Host "Installed Rebel CLI shims in $InstallDir"
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathParts = @()
if ($userPath) {
  $pathParts = $userPath -split [IO.Path]::PathSeparator
}

if ($pathParts -notcontains $InstallDir) {
  if ($DryRun) {
    Write-DryRun "would add $InstallDir to the per-user PATH"
  } else {
    $nextPath = if ($userPath) {
      "$userPath$([IO.Path]::PathSeparator)$InstallDir"
    } else {
      $InstallDir
    }
    [Environment]::SetEnvironmentVariable("Path", $nextPath, "User")
    Write-Host "Added $InstallDir to the per-user PATH. Restart your terminal to pick it up."
  }
}
