$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$VenvPath = Join-Path $ProjectRoot '.venv'
$PythonPath = Join-Path $VenvPath 'Scripts\python.exe'
$RequirementsPath = Join-Path $ProjectRoot 'speech\requirements.txt'

if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    & py -3.12 -m venv $VenvPath
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to create the project-local Python 3.12 environment.'
    }
}

& $PythonPath -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)"
if ($LASTEXITCODE -ne 0) {
    throw 'The existing project-local .venv is not using Python 3.12.'
}

& $PythonPath -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to upgrade pip in the project-local environment.'
}

& $PythonPath -m pip install --requirement $RequirementsPath
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to install speech dependencies in the project-local environment.'
}

Write-Host 'Local speech environment is ready. The Whisper model will download on first transcription.'
