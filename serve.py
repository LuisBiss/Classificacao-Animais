#!/usr/bin/env python3
"""serve.py — servidor local (equivalente multiplataforma do serve.ps1).

Serve os arquivos estaticos do projeto e expoe um unico endpoint dinamico,
POST /api/groq, que injeta a variavel de ambiente API_KEY como cabecalho
Authorization e encaminha a requisicao para a API da Groq. A chave nunca
chega ao cliente.

Uso:
    API_KEY=gsk_... python3 serve.py          # com o recurso Groq
    python3 serve.py                           # so os recursos locais
"""
import http.server
import json
import os
import socketserver
import urllib.error
import urllib.request
from functools import partial

PORT = 8080
GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"
ROOT = os.path.dirname(os.path.abspath(__file__))


def load_dotenv(path):
    """Carrega pares CHAVE=valor de um .env para o ambiente.

    Variaveis ja definidas no ambiente tem precedencia (setdefault), entao
    `API_KEY=... python3 serve.py` continua sobrescrevendo o .env.
    """
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_dotenv(os.path.join(ROOT, ".env"))


class Handler(http.server.SimpleHTTPRequestHandler):
    def _send_json(self, status, payload_bytes):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload_bytes)

    def do_POST(self):
        if self.path != "/api/groq":
            self.send_error(404, "Not Found")
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        key = os.environ.get("API_KEY")
        if not key or not key.strip():
            self._send_json(500, (
                b'{"error":{"message":"API_KEY nao definida no servidor. '
                b'Inicie com: API_KEY=... python3 serve.py"}}'
            ))
            return

        req = urllib.request.Request(
            GROQ_ENDPOINT,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                # O Cloudflare da Groq bloqueia o UA padrao do urllib (erro 1010)
                "User-Agent": "ClassificadorAnimais/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                self._send_json(r.status, r.read())
        except urllib.error.HTTPError as e:
            data = e.read() or json.dumps(
                {"error": {"message": f"Groq HTTP {e.code}"}}
            ).encode()
            self._send_json(e.code, data)
        except Exception as e:  # noqa: BLE001 — devolve qualquer falha como JSON
            self._send_json(502, json.dumps(
                {"error": {"message": f"Falha ao contatar a Groq: {e}"}}
            ).encode())


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    handler = partial(Handler, directory=ROOT)
    has_key = bool(os.environ.get("API_KEY"))
    print(f"  Servidor rodando em: http://localhost:{PORT}")
    print(f"  API_KEY detectada:   {'SIM' if has_key else 'NAO (recurso Groq desativado)'}")
    print("  Ctrl+C para parar")
    with ThreadingServer(("", PORT), handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
