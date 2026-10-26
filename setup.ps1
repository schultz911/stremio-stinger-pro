Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Initializing Stremio Stinger Pro Setup" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Verify Node.js and npm presence
$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue

if (-not $node) {
    Write-Error "Error: Node.js is not installed or not in PATH."
    Exit 1
}

if (-not $npm) {
    Write-Error "Error: npm is not installed or not in PATH."
    Exit 1
}

$nodeVersion = node -v
$npmVersion = npm -v
Write-Host "[OK] Node.js $nodeVersion and npm $npmVersion detected." -ForegroundColor Green

# 2. Handle environment configuration file (.env)
if (-not (Test-Path .env)) {
    Write-Host "Creating .env file from .env.example..." -ForegroundColor Yellow
    Copy-Item .env.example .env
    Write-Host "[OK] .env file created successfully." -ForegroundColor Green
} else {
    Write-Host "[OK] .env file already exists." -ForegroundColor Green
}

# 3. Install project dependencies
Write-Host "Installing dependencies..." -ForegroundColor Yellow
npm ci --include=dev
if ($LastExitCode -ne 0) {
    Write-Error "Error: npm install failed."
    Exit $LastExitCode
}
Write-Host "[OK] Dependencies installed successfully." -ForegroundColor Green

# 4. Verify the setup by running test suite
Write-Host "Running validation tests..." -ForegroundColor Yellow
npm test -- --forceExit
if ($LastExitCode -ne 0) {
    Write-Error "Error: Validation tests failed."
    Exit $LastExitCode
}
Write-Host "[OK] Validation tests completed successfully." -ForegroundColor Green

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Setup completed successfully! Ready." -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

