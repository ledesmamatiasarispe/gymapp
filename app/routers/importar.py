"""Importar planillas de Google Sheets (Archivo → Descargar → .xlsx)."""
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from ..db import get_db, transaccion
from ..deps import exigir_acceso_alumno, requiere_staff
from ..services import importador
from ..services import rutinas as svc

router = APIRouter(prefix="/api/importar", tags=["importar"])

_MAX_BYTES = 5 * 1024 * 1024


async def _leer(archivo: UploadFile) -> bytes:
    contenido = await archivo.read(_MAX_BYTES + 1)
    if len(contenido) > _MAX_BYTES:
        raise HTTPException(413, "El archivo es demasiado grande (máx. 5 MB)")
    return contenido


def _parsear(conn, contenido: bytes) -> importador.Resultado:
    existentes = {r["numero"]: r["nombre"] for r in conn.execute(
        "SELECT numero, nombre FROM ejercicios WHERE numero IS NOT NULL")}
    try:
        return importador.parsear(contenido, catalogo_existente=existentes)
    except ValueError as e:
        raise HTTPException(422, str(e))


def _guardar_catalogo(conn, ejercicios: list[dict]) -> dict:
    """Alta o actualización por número. Un video que la planilla no trae no pisa el cargado a mano."""
    nuevos = actualizados = 0
    for e in ejercicios:
        fila = conn.execute("SELECT id FROM ejercicios WHERE numero = ?", (e["numero"],)).fetchone()
        if fila:
            conn.execute(
                """UPDATE ejercicios SET nombre = ?, grupo = coalesce(?, grupo), video_url = coalesce(?, video_url)
                   WHERE id = ?""", (e["nombre"], e["grupo"], e["video_url"], fila["id"]))
            actualizados += 1
        else:
            conn.execute("INSERT INTO ejercicios (numero, nombre, grupo, video_url) VALUES (?,?,?,?)",
                         (e["numero"], e["nombre"], e["grupo"], e["video_url"]))
            nuevos += 1
    return {"ejercicios_nuevos": nuevos, "ejercicios_actualizados": actualizados}


@router.post("/catalogo")
async def importar_catalogo(archivo: UploadFile = File(...), conn=Depends(get_db), user=Depends(requiere_staff)):
    res = _parsear(conn, await _leer(archivo))
    if not res.ejercicios:
        raise HTTPException(422, "No se encontró una hoja «Datos» con ejercicios numerados")
    with transaccion(conn):
        return _guardar_catalogo(conn, res.ejercicios)


@router.post("/rutina", status_code=201)
async def importar_rutina(archivo: UploadFile = File(...), alumno_id: int | None = Form(None),
                          titulo: str | None = Form(None), conn=Depends(get_db), user=Depends(requiere_staff)):
    """Crea la rutina en borrador (para revisarla antes de publicar). Si la planilla
    trae la hoja «Datos», actualiza el catálogo en la misma transacción."""
    if alumno_id is not None:
        exigir_acceso_alumno(conn, user, alumno_id)
    res = _parsear(conn, await _leer(archivo))
    if res.rutina is None or not res.rutina["dias"]:
        raise HTTPException(422, "No se encontró una hoja de entrenamiento con «Dia 1», «Dia 2»…")

    with transaccion(conn):
        resumen = _guardar_catalogo(conn, res.ejercicios)
        ids = {r["numero"]: r["id"] for r in conn.execute("SELECT id, numero FROM ejercicios WHERE numero IS NOT NULL")}
        for d in res.rutina["dias"]:
            for b in d["bloques"]:
                for i in b["items"]:
                    i["ejercicio_id"] = ids.get(i.pop("numero"))
        rid = svc.crear(conn, profesor_id=user["id"], alumno_id=alumno_id,
                        titulo=(titulo or "").strip() or Path(archivo.filename or "Rutina importada").stem,
                        notas=res.rutina["notas"], dias=res.rutina["dias"])
    return {**resumen, "avisos": res.avisos, "rutina": svc.leer(conn, rid)}
