"""Dependencias de FastAPI: usuario actual y control de acceso.

Las reglas de quién ve qué están todas acá, para que ningún router las
reimplemente:
- admin: todo.
- profesor: sus alumnos, las rutinas de ellos y sus propias plantillas.
- alumno: solo lo suyo, y de sus rutinas solo las que no están en borrador.
"""
import sqlite3

from fastapi import Depends, Header, HTTPException

from . import security
from .db import get_db


def usuario_actual(
    authorization: str | None = Header(None), conn: sqlite3.Connection = Depends(get_db)
) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "No autenticado")
    u = security.usuario_de_token(conn, authorization.split(" ", 1)[1].strip())
    if not u:
        raise HTTPException(401, "Sesión vencida, volvé a entrar")
    return {k: u[k] for k in ("id", "rol", "nombre", "usuario", "profesor_id")}


def requiere_staff(user: dict = Depends(usuario_actual)) -> dict:
    if user["rol"] not in ("admin", "profesor"):
        raise HTTPException(403, "Solo para profesores")
    return user


def requiere_admin(user: dict = Depends(usuario_actual)) -> dict:
    if user["rol"] != "admin":
        raise HTTPException(403, "Solo para administradores")
    return user


def exigir_acceso_alumno(conn: sqlite3.Connection, user: dict, alumno_id: int) -> sqlite3.Row:
    """Devuelve el alumno si el usuario lo puede ver; 404 si no (no se revela si existe)."""
    a = conn.execute("SELECT * FROM usuarios WHERE id = ? AND rol = 'alumno'", (alumno_id,)).fetchone()
    if not a:
        raise HTTPException(404, "Alumno no encontrado")
    if user["rol"] == "admin":
        return a
    if user["rol"] == "profesor" and a["profesor_id"] == user["id"]:
        return a
    if user["rol"] == "alumno" and a["id"] == user["id"]:
        return a
    raise HTTPException(404, "Alumno no encontrado")


def exigir_rutina(conn: sqlite3.Connection, user: dict, rutina_id: int, *, editar: bool = False) -> sqlite3.Row:
    r = conn.execute("SELECT * FROM rutinas WHERE id = ?", (rutina_id,)).fetchone()
    if not r:
        raise HTTPException(404, "Rutina no encontrada")
    if user["rol"] == "admin":
        return r
    if user["rol"] == "profesor":
        if r["alumno_id"] is None:
            # Las plantillas las ve cualquier profe (para copiarlas), pero solo
            # las edita quien la armó.
            if editar and r["profesor_id"] != user["id"]:
                raise HTTPException(403, "Esta plantilla es de otro profesor; duplicala para editarla")
            return r
        exigir_acceso_alumno(conn, user, r["alumno_id"])
        return r
    # alumno
    if editar or r["alumno_id"] != user["id"] or r["estado"] == "borrador":
        raise HTTPException(404, "Rutina no encontrada")
    return r
