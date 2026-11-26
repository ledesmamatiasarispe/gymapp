"""Contraseñas y sesiones.

Mismo esquema de sesión que GNC API (token opaco en tabla, ``Authorization:
Bearer``), pero con PBKDF2 en vez de un SHA-256 simple: las claves de los
alumnos viajan por internet a través del túnel, y un hash rápido es trivial de
romper por fuerza bruta si alguna vez se filtra la base.
"""
import hashlib
import hmac
import secrets
import sqlite3
from datetime import datetime, timedelta

from . import config
from .db import ahora

_ITERACIONES = 200_000


def hashear(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _ITERACIONES)
    return h.hex(), salt


def verificar(password: str, salt: str, guardado: str) -> bool:
    h, _ = hashear(password, salt)
    return hmac.compare_digest(h, guardado)


def crear_sesion(conn: sqlite3.Connection, usuario_id: int) -> str:
    token = secrets.token_urlsafe(32)
    expira = (datetime.now() + timedelta(hours=config.SESSION_HOURS)).isoformat(timespec="seconds")
    conn.execute(
        "INSERT INTO sesiones (token, usuario_id, creado_en, expira_en) VALUES (?,?,?,?)",
        (token, usuario_id, ahora(), expira),
    )
    conn.commit()
    return token


def usuario_de_token(conn: sqlite3.Connection, token: str) -> sqlite3.Row | None:
    return conn.execute(
        """SELECT u.* FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
           WHERE s.token = ? AND s.activa = 1 AND s.expira_en > ? AND u.activo = 1""",
        (token, ahora()),
    ).fetchone()


def cerrar_sesiones(conn: sqlite3.Connection, usuario_id: int) -> None:
    """Al cambiar o resetear la clave, las sesiones abiertas dejan de valer."""
    conn.execute("UPDATE sesiones SET activa = 0 WHERE usuario_id = ?", (usuario_id,))
