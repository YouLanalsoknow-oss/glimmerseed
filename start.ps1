# GlimmerBook Workbench - Local HTTP Server
# Serves the 3D workbench from the current directory

$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
$root = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'

# Find available port (8771-8780)
$port = 8771
$listener = $null

for ($p = $port; $p -le 8780; $p++) {
    try {
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://localhost:$p/")
        $listener.Start()
        $port = $p
        break
    } catch {
        $listener = $null
        continue
    }
}

if (-not $listener) {
    Write-Host 'ERROR: All ports 8771-8780 are in use.'
    Read-Host 'Press Enter to exit'
    exit 1
}

$url = "http://localhost:$port/"
$host.UI.RawUI.WindowTitle = "GlimmerBook Workbench - $url"
Write-Host "============================================"
Write-Host "  GlimmerBook Workbench"
Write-Host "  Server:  $url"
Write-Host "  Root:    $root"
Write-Host "  Press Ctrl+C to stop"
Write-Host "============================================"
Write-Host ""

# Wait for server to be ready, then open browser
Start-Sleep -Milliseconds 300
Start-Process $url

$mime = @{
    '.html'='text/html'; '.css'='text/css'; '.js'='application/javascript';
    '.json'='application/json'; '.png'='image/png'; '.jpg'='image/jpeg';
    '.svg'='image/svg+xml'; '.ico'='image/x-icon'; '.woff'='font/woff';
    '.woff2'='font/woff2'; '.ttf'='font/ttf'; '.mjs'='application/javascript';
    '.wasm'='application/wasm'; '.map'='application/json'; '.webmanifest'='application/manifest+json'
}

while ($listener.IsListening) {
    $ctx = $null
    try {
        $ctx = $listener.GetContext()
        $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
        if ($path -eq '/') { $path = '/index.html' }
        $relative = $path.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
        $insideRoot = $filePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
        if ($insideRoot -and (Test-Path -LiteralPath $filePath -PathType Leaf)) {
            $ext = [System.IO.Path]::GetExtension($filePath)
            $ext = $ext.ToLowerInvariant()
            $ct = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $ctx.Response.ContentType = $ct
            $ctx.Response.ContentLength64 = $bytes.Length
            if ($ctx.Request.HttpMethod -ne 'HEAD') {
                $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } else {
            $ctx.Response.StatusCode = if ($insideRoot) { 404 } else { 403 }
            $msg = [System.Text.Encoding]::UTF8.GetBytes($(if ($insideRoot) { '404 Not Found' } else { '403 Forbidden' }))
            $ctx.Response.ContentType = 'text/plain; charset=utf-8'
            $ctx.Response.ContentLength64 = $msg.Length
            $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
        }
    } catch [System.Net.HttpListenerException] {
        if ($listener.IsListening) { Write-Warning $_.Exception.Message }
    } catch {
        Write-Warning "Request failed: $($_.Exception.Message)"
    } finally {
        if ($ctx) { $ctx.Response.Close() }
    }
}
