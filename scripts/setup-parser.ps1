$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
$requirements = Join-Path $projectRoot 'parser_worker\requirements.txt'

if (-not (Test-Path -LiteralPath $python)) {
    throw 'JARVIS local Python environment was not found. Create .venv before starting Parser.'
}
if (-not (Test-Path -LiteralPath $requirements)) {
    throw 'Parser requirements file was not found.'
}

& $python -c "import telethon; assert telethon.__version__ == '1.44.0'" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Output 'Parser Python dependency is ready.'
    exit 0
}

Write-Output 'Installing Parser dependency into the local JARVIS environment...'
& $python -m pip install --disable-pip-version-check -r $requirements
if ($LASTEXITCODE -ne 0) {
    throw "Parser dependency installation failed with exit code $LASTEXITCODE."
}
