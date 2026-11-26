"""Configuración de la app — rutas y parámetros que se pueden pisar por variable de entorno."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
DATA = Path(os.environ.get("GIMNASIO_DATA", ROOT / "data"))
DB_PATH = Path(os.environ.get("GIMNASIO_DB", DATA / "gimnasio.db"))

SESSION_HOURS = int(os.environ.get("GIMNASIO_SESSION_HOURS", 24 * 30))
PORT = int(os.environ.get("GIMNASIO_PORT", 8100))
