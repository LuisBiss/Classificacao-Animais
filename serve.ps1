# serve.ps1 - Servidor HTTP simples para o Classificador de Animais
# Uso: powershell -ExecutionPolicy Bypass -File serve.ps1

$port   = 8080
$root   = $PSScriptRoot
$prefix = "http://localhost:$port/"

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.json' = 'application/json'
    '.bin'  = 'application/octet-stream'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.webp' = 'image/webp'
    '.ico'  = 'image/x-icon'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host ""
Write-Host "  Servidor rodando em: http://localhost:$port" -ForegroundColor Green
Write-Host "  Pressione Ctrl+C para parar" -ForegroundColor Yellow
Write-Host ""

Start-Process "http://localhost:$port/"

try {
    while ($listener.IsListening) {
        $ctx  = $listener.GetContext()
        $req  = $ctx.Request
        $resp = $ctx.Response

        $resp.Headers.Add("Access-Control-Allow-Origin", "*")

        $urlPath = $req.Url.AbsolutePath
        if ($urlPath -eq '/') { $urlPath = '/index.html' }

        $filePath = Join-Path $root ($urlPath.TrimStart('/').Replace('/', '\'))

        if (Test-Path $filePath -PathType Leaf) {
            $ext  = [System.IO.Path]::GetExtension($filePath).ToLower()
            $ct   = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            $data = [System.IO.File]::ReadAllBytes($filePath)

            $resp.StatusCode        = 200
            $resp.ContentType       = $ct
            $resp.ContentLength64   = $data.Length
            $resp.OutputStream.Write($data, 0, $data.Length)

            Write-Host "  200  $urlPath" -ForegroundColor Green
        } else {
            $msg  = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $urlPath")
            $resp.StatusCode      = 404
            $resp.ContentType     = 'text/plain'
            $resp.ContentLength64 = $msg.Length
            $resp.OutputStream.Write($msg, 0, $msg.Length)

            Write-Host "  404  $urlPath" -ForegroundColor Red
        }

        $resp.OutputStream.Close()
    }
} finally {
    $listener.Stop()
}
