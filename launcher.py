"""Arranque para dejar la app corriendo sola, como el launcher de GNC API.

Lo lanza iniciar_auto.vbs al iniciar Windows (acceso directo en la carpeta Inicio).
Corre el servidor y, si se cae, lo vuelve a levantar a los 5 segundos: el túnel de
Cloudflare apunta a este puerto y no tiene que quedar apuntando a nada.
La salida va a data/servidor.log.
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PY = ROOT / ".venv" / "Scripts" / "python.exe"
LOG = ROOT / "data" / "servidor.log"


def main() -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    while True:
        with LOG.open("a", encoding="utf-8") as log:
            log.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} iniciando servidor\n")
            log.flush()
            r = subprocess.run([str(PY if PY.exists() else sys.executable), "-m", "app.main"],
                               cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                               # el launcher corre con pythonw: sin esto, python.exe abriría una consola
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if r.returncode == 0:
                log.write("servidor detenido\n")
                return
            log.write(f"el servidor se cerró (código {r.returncode}); reinicio en 5 s\n")
        time.sleep(5)


if __name__ == "__main__":
    main()
