# YESHUA — deploy script (safe template).
#
# SECURITY: never hard-code the Cloudflare API token in a file that lives on
# disk or in git. This template reads it from an environment variable instead.
#
# Set it once per PowerShell session before deploying:
#   $env:CF_API_TOKEN = "your-cloudflare-token"
#   $env:CF_ACCOUNT_ID = "your-account-id"
# Then run:  ./deploy.ps1   (copy this file to deploy.ps1, which is git-ignored)

$ErrorActionPreference = "Stop"

$token       = $env:CF_API_TOKEN
$accountId   = if ($env:CF_ACCOUNT_ID) { $env:CF_ACCOUNT_ID } else { "6d4b96f60e99de96b3ee3006f323bbcd" }
$projectName = "yeshua"
$siteRoot    = $PSScriptRoot

if (-not $token) {
  Write-Error "CF_API_TOKEN is not set. Run:  `$env:CF_API_TOKEN = 'your-token'  before deploying."
  exit 1
}

# Files/dirs to exclude from deployment
$excludeNames = @('deploy.ps1', 'deploy.example.ps1', 'serve.ps1', 'schema.sql', '.claude', '.git', '.gitignore', '.DS_Store', 'README.md', '_worker.js')
# Patterns to exclude (private content not for public hosting)
$excludePatterns = @('*.pdf', '*.epub', '*.mobi', '*_private*', '*_draft*')

$workerPath = Join-Path $siteRoot '_worker.js'
$hasWorker  = Test-Path $workerPath -PathType Leaf

$apiHeaders = @{ "Authorization" = "Bearer $token" }

# ── Step 1: Get JWT upload token ──────────────────────────────
Write-Host "[1/5] Getting upload JWT..."
$jwtResp = Invoke-RestMethod -Method GET -Uri "https://api.cloudflare.com/client/v4/accounts/$accountId/pages/projects/$projectName/upload-token" -Headers $apiHeaders
$jwt = $jwtResp.result.jwt
$jwtHeaders = @{ "Authorization" = "Bearer $jwt"; "Content-Type" = "application/json" }
Write-Host "    JWT obtained."

# ── Step 2: Collect files recursively & compute hashes ────────
Write-Host "[2/5] Collecting & hashing files..."

function Get-ContentType($ext) {
  switch ($ext.ToLower()) {
    "html" { "text/html; charset=utf-8" }
    "css"  { "text/css; charset=utf-8" }
    "js"   { "application/javascript; charset=utf-8" }
    "mjs"  { "application/javascript; charset=utf-8" }
    "json" { "application/json; charset=utf-8" }
    "svg"  { "image/svg+xml" }
    "jpg"  { "image/jpeg" }
    "jpeg" { "image/jpeg" }
    "png"  { "image/png" }
    "gif"  { "image/gif" }
    "webp" { "image/webp" }
    "ico"  { "image/x-icon" }
    "woff" { "font/woff" }
    "woff2"{ "font/woff2" }
    "ttf"  { "font/ttf" }
    "txt"  { "text/plain; charset=utf-8" }
    "xml"  { "application/xml" }
    "pdf"  { "application/pdf" }
    default { "application/octet-stream" }
  }
}

$files = @()
Get-ChildItem -Path $siteRoot -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($siteRoot.Length).TrimStart('\','/').Replace('\','/')
  $topLevel = $rel.Split('/')[0]
  if ($excludeNames -contains $topLevel -or $excludeNames -contains $_.Name) { return }
  foreach ($pat in $excludePatterns) { if ($_.Name -like $pat) { return } }

  $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
  $ext   = $_.Extension.TrimStart('.')
  $extBytes = [System.Text.Encoding]::UTF8.GetBytes($ext)
  $combined = $bytes + $extBytes
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hashBytes = $sha.ComputeHash($combined)
  $sha.Dispose()
  $hashHex = ([System.BitConverter]::ToString($hashBytes) -replace '-', '').ToLower().Substring(0, 32)

  $files += [PSCustomObject]@{
    Path        = "/$rel"
    Hash        = $hashHex
    Bytes       = $bytes
    Base64      = [Convert]::ToBase64String($bytes)
    ContentType = (Get-ContentType $ext)
    SizeKB      = [math]::Round($bytes.Length / 1024, 1)
  }
  Write-Host ("    {0,-32} {1,6} KB  {2}" -f $rel, $files[-1].SizeKB, $hashHex)
}

# ── Step 3: Check which hashes are missing ────────────────────
Write-Host "[3/5] Checking which files need upload..."
$checkBody = @{ hashes = @($files | ForEach-Object { $_.Hash }) } | ConvertTo-Json
$checkResp = Invoke-RestMethod -Method POST -Uri "https://api.cloudflare.com/client/v4/pages/assets/check-missing" -Headers $jwtHeaders -Body $checkBody
$missing = @($checkResp.result)
Write-Host "    Missing: $($missing.Count) of $($files.Count)"

# ── Step 4: Upload missing files ──────────────────────────────
Write-Host "[4/5] Uploading $($missing.Count) file(s)..."
if ($missing.Count -gt 0) {
  $payload = @()
  foreach ($f in $files) {
    if ($missing -contains $f.Hash) {
      $payload += @{
        key      = $f.Hash
        value    = $f.Base64
        metadata = @{ contentType = $f.ContentType }
        base64   = $true
      }
    }
  }
  $uploadBody = ConvertTo-Json -InputObject $payload -Depth 5 -Compress

  $maxAttempts = 4
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
      $uploadResp = Invoke-RestMethod -Method POST -Uri "https://api.cloudflare.com/client/v4/pages/assets/upload" -Headers $jwtHeaders -Body $uploadBody -ErrorAction Stop
      Write-Host "    Upload: success=$($uploadResp.success), uploaded=$($uploadResp.result.successful_key_count)"
      break
    } catch {
      $status = $_.Exception.Response.StatusCode.value__
      if ($attempt -lt $maxAttempts -and ($status -ge 500 -or $status -eq 0)) {
        $wait = [Math]::Pow(2, $attempt)
        Write-Host "    Upload attempt $attempt failed (HTTP $status). Retrying in ${wait}s..."
        Start-Sleep -Seconds $wait
      } else { throw }
    }
  }
}

# ── Step 5: Create deployment ─────────────────────────────────
Write-Host "[5/5] Creating deployment..."
$manifest = @{}
foreach ($f in $files) { $manifest[$f.Path] = $f.Hash }
$manifestJson = ConvertTo-Json -InputObject $manifest -Compress

$boundary = [Guid]::NewGuid().ToString()
$lf = "`r`n"
$bodyStr = "--$boundary$lf"
$bodyStr += "Content-Disposition: form-data; name=`"manifest`"$lf$lf"
$bodyStr += "$manifestJson$lf"
if ($hasWorker) {
  $workerSource = Get-Content -Path $workerPath -Raw
  $bodyStr += "--$boundary$lf"
  $bodyStr += "Content-Disposition: form-data; name=`"_worker.js`"; filename=`"_worker.js`"$lf"
  $bodyStr += "Content-Type: application/javascript+module$lf$lf"
  $bodyStr += "$workerSource$lf"
  Write-Host "    Including _worker.js as Pages Function ($(($workerSource.Length / 1024).ToString('F1')) KB)"
}
$bodyStr += "--$boundary--$lf"
$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($bodyStr)

$multipartHeaders = @{
  "Authorization" = "Bearer $token"
  "Content-Type"  = "multipart/form-data; boundary=$boundary"
}

$deployResp = Invoke-RestMethod -Method POST -Uri "https://api.cloudflare.com/client/v4/accounts/$accountId/pages/projects/$projectName/deployments" -Headers $multipartHeaders -Body $bodyBytes
Write-Host ""
Write-Host "=== DEPLOYMENT COMPLETE ==="
Write-Host "URL:        $($deployResp.result.url)"
Write-Host "Status:     $($deployResp.result.latest_stage.status)"
Write-Host "Deployment: $($deployResp.result.id)"
Write-Host ""
Write-Host "Production: https://yeshua.pages.dev"
Write-Host "Domain:     https://yeshuabook.com"
