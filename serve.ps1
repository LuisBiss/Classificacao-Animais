# serve.ps1 - Servidor HTTP simples para o Classificador de Animais
# Uso: powershell -ExecutionPolicy Bypass -File serve.ps1

$port   = 8080
$root   = $PSScriptRoot
$prefix = "http://localhost:$port/"

# Groq exige TLS 1.2 — o Windows PowerShell 5.1 nao usa por padrao.
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
$groqEndpoint = 'https://api.groq.com/openai/v1/chat/completions'

# Carrega o .env (se existir) para o ambiente. Variaveis ja definidas no
# ambiente tem precedencia.
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $idx = $line.IndexOf('=')
            $k = $line.Substring(0, $idx).Trim()
            $v = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
            if (-not [Environment]::GetEnvironmentVariable($k)) {
                Set-Item -Path "env:$k" -Value $v
            }
        }
    }
}

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

        # ── Proxy para a API do Groq ─────────────────────────────────
        # O navegador envia o corpo (payload) do /chat/completions; aqui
        # apenas injetamos o cabecalho Authorization com $env:API_KEY e
        # encaminhamos. A chave nunca chega ao cliente.
        if ($req.HttpMethod -eq 'POST' -and $urlPath -eq '/api/groq') {
            $reader = New-Object System.IO.StreamReader($req.InputStream, $req.ContentEncoding)
            $body   = $reader.ReadToEnd()
            $reader.Close()

            $key = $env:API_KEY
            if ([string]::IsNullOrWhiteSpace($key)) {
                $msg  = '{"error":{"message":"API_KEY nao definida no servidor. Defina a variavel de ambiente API_KEY antes de iniciar o serve.ps1."}}'
                $data = [System.Text.Encoding]::UTF8.GetBytes($msg)
                $resp.StatusCode      = 500
                $resp.ContentType     = 'application/json'
                $resp.ContentLength64 = $data.Length
                $resp.OutputStream.Write($data, 0, $data.Length)
                $resp.OutputStream.Close()
                Write-Host "  500  /api/groq  (API_KEY ausente)" -ForegroundColor Red
                continue
            }

            try {
                $groq = Invoke-WebRequest -Uri $groqEndpoint `
                    -Method Post `
                    -Headers @{ 'Authorization' = "Bearer $key" } `
                    -ContentType 'application/json' `
                    -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
                    -UserAgent 'ClassificadorAnimais/1.0' `
                    -UseBasicParsing
                $data = [System.Text.Encoding]::UTF8.GetBytes($groq.Content)
                $resp.StatusCode      = [int]$groq.StatusCode
                $resp.ContentType     = 'application/json'
                $resp.ContentLength64 = $data.Length
                $resp.OutputStream.Write($data, 0, $data.Length)
                Write-Host "  $([int]$groq.StatusCode)  /api/groq -> Groq" -ForegroundColor Green
            } catch {
                $status  = 502
                $errBody = $null
                if ($_.Exception.Response) {
                    try {
                        $status = [int]$_.Exception.Response.StatusCode
                        $sr     = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                        $errBody = $sr.ReadToEnd(); $sr.Close()
                    } catch { }
                }
                if (-not $errBody) {
                    $em = ($_.Exception.Message -replace '"', "'")
                    $errBody = "{""error"":{""message"":""Falha ao contatar a Groq: $em""}}"
                }
                $data = [System.Text.Encoding]::UTF8.GetBytes($errBody)
                $resp.StatusCode      = $status
                $resp.ContentType     = 'application/json'
                $resp.ContentLength64 = $data.Length
                $resp.OutputStream.Write($data, 0, $data.Length)
                Write-Host "  $status  /api/groq  (erro Groq)" -ForegroundColor Red
            }
            $resp.OutputStream.Close()
            continue
        }

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
