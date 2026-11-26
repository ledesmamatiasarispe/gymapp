"""Profesores (los da de alta el admin) y alumnos (los da de alta su profe)."""
import secrets
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import security
from ..db import ahora, get_db, transaccion
from ..deps import exigir_acceso_alumno, requiere_admin, requiere_staff

router = APIRouter(prefix="/api", tags=["usuarios"])

_COLUMNAS = "id, rol, nombre, usuario, profesor_id, email, telefono, notas, activo, creado_en"


class UsuarioAlta(BaseModel):
    nombre: str
    usuario: str
    password: str | None = None  # si no viene, se genera una y se devuelve una sola vez
    email: str | None = None
    telefono: str | None = None
    notas: str | None = None
    profesor_id: int | None = None  # solo alumnos, y solo lo puede elegir el admin


class UsuarioCambios(BaseModel):
    nombre: str | None = None
    email: str | None = None
    telefono: str | None = None
    notas: str | None = None
    activo: bool | None = None
    profesor_id: int | None = None


def _clave_temporal() -> str:
    # Sin caracteres ambiguos (0/O, 1/l): se dicta o se manda por WhatsApp.
    return "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(8))


def _alta(conn, rol: str, body: UsuarioAlta, profesor_id: int | None) -> dict:
    nombre, usuario = body.nombre.strip(), body.usuario.strip()
    if not nombre or not usuario:
        raise HTTPException(422, "Nombre y usuario son obligatorios")
    if " " in usuario:
        raise HTTPException(422, "El usuario no puede tener espacios")
    password = body.password or _clave_temporal()
    if len(password) < 6:
        raise HTTPException(422, "La contraseña necesita al menos 6 caracteres")
    h, salt = security.hashear(password)
    try:
        with transaccion(conn):
            cur = conn.execute(
                """INSERT INTO usuarios (rol, nombre, usuario, password_hash, salt, profesor_id,
                                         email, telefono, notas, creado_en)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (rol, nombre, usuario, h, salt, profesor_id, body.email, body.telefono, body.notas, ahora()),
            )
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"Ya existe el usuario «{usuario}»")
    u = dict(conn.execute(f"SELECT {_COLUMNAS} FROM usuarios WHERE id = ?", (cur.lastrowid,)).fetchone())
    if not body.password:
        u["password_temporal"] = password
    return u


def _exigir_profesor(conn, profesor_id: int) -> None:
    if not conn.execute("SELECT 1 FROM usuarios WHERE id = ? AND rol IN ('profesor','admin') AND activo = 1",
                        (profesor_id,)).fetchone():
        raise HTTPException(422, "Profesor inexistente")


# ── Profesores ────────────────────────────────────────────────────────────────

@router.get("/profesores")
def listar_profesores(conn=Depends(get_db), user=Depends(requiere_staff)):
    return [dict(r) for r in conn.execute(
        f"""SELECT {_COLUMNAS},
                   (SELECT count(*) FROM usuarios a WHERE a.profesor_id = u.id AND a.activo = 1) AS alumnos
            FROM usuarios u WHERE rol IN ('profesor', 'admin') ORDER BY activo DESC, nombre""")]


@router.post("/profesores", status_code=201)
def alta_profesor(body: UsuarioAlta, conn=Depends(get_db), admin=Depends(requiere_admin)):
    return _alta(conn, "profesor", body, None)


# ── Alumnos ───────────────────────────────────────────────────────────────────

@router.get("/alumnos")
def listar_alumnos(todos: bool = False, conn=Depends(get_db), user=Depends(requiere_staff)):
    """Un profe ve sus alumnos; el admin ve todos."""
    filtro, args = "a.rol = 'alumno'", []
    if user["rol"] != "admin":
        filtro += " AND a.profesor_id = ?"
        args.append(user["id"])
    if not todos:
        filtro += " AND a.activo = 1"
    return [dict(r) for r in conn.execute(
        f"""SELECT a.id, a.nombre, a.usuario, a.email, a.telefono, a.activo, a.profesor_id,
                   p.nombre AS profesor_nombre,
                   (SELECT titulo FROM rutinas r WHERE r.alumno_id = a.id AND r.estado = 'publicada'
                    ORDER BY r.modificado_en DESC LIMIT 1) AS rutina_actual,
                   (SELECT max(fecha) FROM entrenamientos e WHERE e.alumno_id = a.id) AS ultimo_entrenamiento
            FROM usuarios a LEFT JOIN usuarios p ON p.id = a.profesor_id
            WHERE {filtro} ORDER BY a.activo DESC, a.nombre""", args)]


@router.post("/alumnos", status_code=201)
def alta_alumno(body: UsuarioAlta, conn=Depends(get_db), user=Depends(requiere_staff)):
    profesor_id = user["id"]
    if user["rol"] == "admin" and body.profesor_id:
        _exigir_profesor(conn, body.profesor_id)
        profesor_id = body.profesor_id
    return _alta(conn, "alumno", body, profesor_id)


@router.get("/alumnos/{alumno_id}")
def ver_alumno(alumno_id: int, conn=Depends(get_db), user=Depends(requiere_staff)):
    exigir_acceso_alumno(conn, user, alumno_id)
    return dict(conn.execute(
        f"""SELECT {', '.join('a.' + c.strip() for c in _COLUMNAS.split(','))}, p.nombre AS profesor_nombre
            FROM usuarios a LEFT JOIN usuarios p ON p.id = a.profesor_id WHERE a.id = ?""",
        (alumno_id,)).fetchone())


# ── Comunes ───────────────────────────────────────────────────────────────────

def _exigir_gestion(conn, user: dict, usuario_id: int) -> sqlite3.Row:
    """Admin gestiona a todos; un profe solo a sus alumnos."""
    u = conn.execute("SELECT * FROM usuarios WHERE id = ?", (usuario_id,)).fetchone()
    if not u:
        raise HTTPException(404, "Usuario no encontrado")
    if user["rol"] == "admin":
        return u
    if u["rol"] == "alumno":
        exigir_acceso_alumno(conn, user, usuario_id)
        return u
    raise HTTPException(403, "Solo el administrador gestiona profesores")


@router.put("/usuarios/{usuario_id}")
def modificar_usuario(usuario_id: int, body: UsuarioCambios, conn=Depends(get_db), user=Depends(requiere_staff)):
    u = _exigir_gestion(conn, user, usuario_id)
    cambios = body.model_dump(exclude_unset=True)
    if "profesor_id" in cambios:
        # Un profe puede pasarle un alumno suyo a otro profe (el acceso ya se
        # validó arriba), pero no "adoptar" uno ajeno.
        if u["rol"] != "alumno":
            raise HTTPException(422, "Solo los alumnos tienen profesor")
        _exigir_profesor(conn, cambios["profesor_id"])
    if cambios.get("activo") is False and usuario_id == user["id"]:
        raise HTTPException(422, "No podés darte de baja a vos mismo")
    if "nombre" in cambios and not (cambios["nombre"] or "").strip():
        raise HTTPException(422, "El nombre es obligatorio")
    if cambios:
        sets = ", ".join(f"{k} = ?" for k in cambios)
        with transaccion(conn):
            conn.execute(f"UPDATE usuarios SET {sets} WHERE id = ?", (*cambios.values(), usuario_id))
            if cambios.get("activo") is False:
                security.cerrar_sesiones(conn, usuario_id)
    return dict(conn.execute(f"SELECT {_COLUMNAS} FROM usuarios WHERE id = ?", (usuario_id,)).fetchone())


@router.post("/usuarios/{usuario_id}/resetear-clave")
def resetear_clave(usuario_id: int, conn=Depends(get_db), user=Depends(requiere_staff)):
    _exigir_gestion(conn, user, usuario_id)
    password = _clave_temporal()
    h, salt = security.hashear(password)
    with transaccion(conn):
        conn.execute("UPDATE usuarios SET password_hash = ?, salt = ? WHERE id = ?", (h, salt, usuario_id))
        security.cerrar_sesiones(conn, usuario_id)
    return {"password_temporal": password}
