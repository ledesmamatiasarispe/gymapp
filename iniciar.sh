#!/usr/bin/env bash
# Arranca la app del gimnasio en Linux y la abre en el navegador.
cd "$(dirname "$(readlink -f "$0")")"
PORT="${GIMNASIO_PORT:-8100}"
URL="http://localhost:$PORT"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt
fi
mkdir -p data
if ! curl -fs "$URL/api/salud" >/dev/null 2>&1; then
  nohup .venv/bin/python -m app.main >>data/servidor.log 2>&1 &
  for i in $(seq 1 30); do
    curl -fs "$URL/api/salud" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi
xdg-open "$URL" >/dev/null 2>&1 &
