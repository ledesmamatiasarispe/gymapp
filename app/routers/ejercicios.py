"""Catálogo de ejercicios, compartido por todo el gimnasio."""
import re
import secrets
import sqlite3
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import config
from ..db import get_db, transaccion
from ..deps import requiere_staff, usuario_actual

router = APIRouter(prefix="/api/ejercicios", tags=["ejercicios"])

# Miniaturas propias: el navegador ya las manda achicadas (un cuadro del video o una
# imagen subida), así que el tope es holgado. Se reconoce el formato por su firma y
# no por la extensión o el content-type que diga el cliente.
_MINIATURA_MAX = 2 * 1024 * 1024
_NOMBRE_MINIATURA = re.compile(r"^\d+-[0-9a-f]{8}\.(jpg|png|webp)$")


def _carpeta_miniaturas() -> Path:
    return config.DB_PATH.parent / "miniaturas"


def _formato_imagen(datos: bytes) -> str | None:
    if datos.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if datos.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if datos[:4] == b"RIFF" and datos[8:12] == b"WEBP":
        return "webp"
    return None


def _borrar_archivo(nombre: str | None) -> None:
    if nombre and _NOMBRE_MINIATURA.match(nombre):
        (_carpeta_miniaturas() / nombre).unlink(missing_ok=True)


class Ejercicio(BaseModel):
    numero: int | None = None
    nombre: str
    grupo: str | None = None
    video_url: str | None = None
    descripcion: str | None = None
    activo: bool = True


def _limpio(body: Ejercicio) -> dict:
    d = body.model_dump()
    for k in ("nombre", "grupo", "video_url", "descripcion"):
        d[k] = (d[k] or "").strip() or None
    if not d["nombre"]:
        raise HTTPException(422, "El ejercicio necesita un nombre")
    if d["numero"] is not None and d["numero"] < 1:
        raise HTTPException(422, "El número tiene que ser positivo")
    return d


@router.get("")
def listar(q: str | None = None, grupo: str | None = None, inactivos: bool = False,
           conn=Depends(get_db), user=Depends(usuario_actual)):
    filtro, args = ["1=1"], []
    if not inactivos:
        filtro.append("activo = 1")
    if grupo:
        filtro.append("grupo = ?")
        args.append(grupo)
    if q and q.strip():
        q = q.strip()
        if q.isdigit():
            filtro.append("numero = ?")
            args.append(int(q))
        else:
            filtro.append("nombre LIKE ?")
            args.append(f"%{q}%")
    return [dict(r) for r in conn.execute(
        f"SELECT * FROM ejercicios WHERE {' AND '.join(filtro)} ORDER BY numero IS NULL, numero, nombre", args)]


@router.get("/grupos")
def grupos(conn=Depends(get_db), user=Depends(usuario_actual)):
    return [r[0] for r in conn.execute(
        "SELECT DISTINCT grupo FROM ejercicios WHERE grupo IS NOT NULL ORDER BY grupo")]


@router.post("", status_code=201)
def alta(body: Ejercicio, conn=Depends(get_db), user=Depends(requiere_staff)):
    d = _limpio(body)
    if d["numero"] is None:
        d["numero"] = (conn.execute("SELECT max(numero) FROM ejercicios").fetchone()[0] or 0) + 1
    try:
        with transaccion(conn):
            cur = conn.execute(
                "INSERT INTO ejercicios (numero, nombre, grupo, video_url, descripcion, activo) VALUES (?,?,?,?,?,?)",
                (d["numero"], d["nombre"], d["grupo"], d["video_url"], d["descripcion"], int(d["activo"])))
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"Ya existe un ejercicio con el número {d['numero']}")
    return dict(conn.execute("SELECT * FROM ejercicios WHERE id = ?", (cur.lastrowid,)).fetchone())


@router.put("/{ejercicio_id}")
def modificar(ejercicio_id: int, body: Ejercicio, conn=Depends(get_db), user=Depends(requiere_staff)):
    d = _limpio(body)
    if not conn.execute("SELECT 1 FROM ejercicios WHERE id = ?", (ejercicio_id,)).fetchone():
        raise HTTPException(404, "Ejercicio no encontrado")
    try:
        with transaccion(conn):
            conn.execute(
                """UPDATE ejercicios SET numero = ?, nombre = ?, grupo = ?, video_url = ?, descripcion = ?, activo = ?
                   WHERE id = ?""",
                (d["numero"], d["nombre"], d["grupo"], d["video_url"], d["descripcion"], int(d["activo"]), ejercicio_id))
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"Ya existe un ejercicio con el número {d['numero']}")
    return dict(conn.execute("SELECT * FROM ejercicios WHERE id = ?", (ejercicio_id,)).fetchone())


def _fila(conn, ejercicio_id: int) -> dict:
    fila = conn.execute("SELECT * FROM ejercicios WHERE id = ?", (ejercicio_id,)).fetchone()
    if not fila:
        raise HTTPException(404, "Ejercicio no encontrado")
    return dict(fila)


@router.post("/{ejercicio_id}/miniatura")
async def subir_miniatura(ejercicio_id: int, archivo: UploadFile, conn=Depends(get_db), user=Depends(requiere_staff)):
    """Reemplaza la miniatura automática (la del video) por una imagen propia."""
    anterior = _fila(conn, ejercicio_id)["miniatura"]
    datos = await archivo.read(_MINIATURA_MAX + 1)
    if len(datos) > _MINIATURA_MAX:
        raise HTTPException(422, "La imagen es demasiado grande (máximo 2 MB)")
    formato = _formato_imagen(datos)
    if not formato:
        raise HTTPException(422, "La miniatura tiene que ser una imagen JPG, PNG o WEBP")
    # Nombre nuevo en cada cambio: el navegador la puede guardar en caché para siempre.
    nombre = f"{ejercicio_id}-{secrets.token_hex(4)}.{formato}"
    _carpeta_miniaturas().mkdir(parents=True, exist_ok=True)
    (_carpeta_miniaturas() / nombre).write_bytes(datos)
    try:
        with transaccion(conn):
            conn.execute("UPDATE ejercicios SET miniatura = ? WHERE id = ?", (nombre, ejercicio_id))
    except BaseException:
        _borrar_archivo(nombre)
        raise
    _borrar_archivo(anterior)
    return _fila(conn, ejercicio_id)


@router.delete("/{ejercicio_id}/miniatura")
def quitar_miniatura(ejercicio_id: int, conn=Depends(get_db), user=Depends(requiere_staff)):
    """Vuelve a la miniatura automática."""
    anterior = _fila(conn, ejercicio_id)["miniatura"]
    with transaccion(conn):
        conn.execute("UPDATE ejercicios SET miniatura = NULL WHERE id = ?", (ejercicio_id,))
    _borrar_archivo(anterior)
    return _fila(conn, ejercicio_id)


@router.get("/miniaturas/{nombre}", include_in_schema=False)
def ver_miniatura(nombre: str):
    """Sin login: la pide un <img>, que no manda el token. No es un dato sensible."""
    ruta = _carpeta_miniaturas() / nombre
    if not _NOMBRE_MINIATURA.match(nombre) or not ruta.is_file():
        raise HTTPException(404, "Miniatura no encontrada")
    return FileResponse(ruta, headers={"Cache-Control": "public, max-age=31536000, immutable"})
