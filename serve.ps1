$port = 3000
$root = $PSScriptRoot

$localIP = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.InterfaceAlias -notlike "*Loopback*" -and $_.IPAddress -notlike "169.*" } |
  Select-Object -First 1).IPAddress

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Server running at http://localhost:$port"

$mimeTypes = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css'
  '.js'   = 'application/javascript'
  '.json' = 'application/json'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.png'  = 'image/png'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.woff2'= 'font/woff2'
  '.woff' = 'font/woff'
}

# Excluded paths (mirror deploy.ps1 exclusions)
$excludedRoots = @('.claude', '.git', 'deploy.ps1', 'serve.ps1', 'schema.sql')

while ($listener.IsListening) {
  try {
    $ctx  = $listener.GetContext()
    $req  = $ctx.Request
    $resp = $ctx.Response

    try {
      $path = $req.Url.LocalPath
      if ($path -eq '/') { $path = '/index.html' }

      $relPath = $path.TrimStart('/')

      # Block access to dev/internal files
      $topSegment = $relPath.Split('/')[0]
      if ($excludedRoots -contains $topSegment) {
        $resp.StatusCode = 403
        $msg = [System.Text.Encoding]::UTF8.GetBytes('Forbidden')
        $resp.OutputStream.Write($msg, 0, $msg.Length)
      } else {
        $file = Join-Path $root $relPath

        # Pretty URL: /checkout -> checkout.html
        if (-not (Test-Path $file -PathType Leaf) -and -not [System.IO.Path]::HasExtension($file)) {
          $htmlFile = "$file.html"
          if (Test-Path $htmlFile -PathType Leaf) { $file = $htmlFile }
        }

        if (Test-Path $file -PathType Leaf) {
          $ext  = [System.IO.Path]::GetExtension($file).ToLower()
          $mime = if ($mimeTypes[$ext]) { $mimeTypes[$ext] } else { 'application/octet-stream' }
          $bytes = [System.IO.File]::ReadAllBytes($file)
          $resp.ContentType = $mime
          $resp.ContentLength64 = $bytes.Length
          $resp.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
          $resp.StatusCode = 404
          $msg = [System.Text.Encoding]::UTF8.GetBytes('Not found')
          $resp.OutputStream.Write($msg, 0, $msg.Length)
        }
      }
    } catch {
      Write-Host "Request error: $($_.Exception.Message)"
      try {
        $resp.StatusCode = 500
        $msg = [System.Text.Encoding]::UTF8.GetBytes('Server error')
        $resp.OutputStream.Write($msg, 0, $msg.Length)
      } catch { }
    } finally {
      try { $resp.Close() } catch { }
    }
  } catch {
    Write-Host "Listener error: $($_.Exception.Message)"
    Start-Sleep -Milliseconds 100
  }
}
