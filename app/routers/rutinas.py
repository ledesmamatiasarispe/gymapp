"""Rutinas de alumnos y plantillas.

Ciclo: borrador (solo lo ve el profe) → publicada (la ve el alumno) → archivada
(queda en el historial del alumno). Publicar una rutina archiva la que el
alumno tenía publicada: el alumno tiene una sola rutina vigente a la vez.
Las plantillas (alumno_id NULL) no se publican: se duplican sobre un alumno.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..db import ahora, get_db, transaccion
from ..deps import exigir_acceso_alumno, exigir_rutina, requiere_staff, usuario_actual
from ..services import rutinas as svc

router = APIRouter(prefix="/api", tags=["rutinas"])

# Cuánto sugerirle al alumno que suba la carga respecto de la última vez (el botón
# verde de "Hoy hice …"). NULL = el criterio por defecto, 1 kg; 0 = no sugerir.
AumentoPct = Field(None, ge=0, le=100)

_RESUMEN = """SELECT r.id, r.alumno_id, r.profesor_id, r.titulo, r.fecha_inicio, r.estado,
                     r.creado_en, r.modificado_en, p.nombre AS profesor_nombre,
                     (SELECT count(*) FROM rutina_dias d WHERE d.rutina_id = r.id) AS dias
              FROM rutinas r JOIN usuarios p ON p.id = r.profesor_id"""


class RutinaAlta(BaseModel):
    alumno_id: int | None = None
    titulo: str
    notas: str | None = None
    fecha_inicio: str | None = None
    aumento_pct: float | None = AumentoPct
    dias: list[dict] = []


class RutinaCambios(BaseModel):
    titulo: str
    notas: str | None = None
    fecha_inicio: str | None = None
    aumento_pct: float | None = AumentoPct  # si no viene, se deja como estaba
    dias: list[dict]


class CambioEstado(BaseModel):
    estado: str


class Duplicar(BaseModel):
    alumno_id: int | None = None
    titulo: str | None = None


@router.get("/alumnos/{alumno_id}/rutinas")
def rutinas_de_alumno(alumno_id: int, conn=Depends(get_db), user=Depends(usuario_actual)):
    exigir_acceso_alumno(conn, user, alumno_id)
    filtro = "" if user["rol"] != "alumno" else "AND r.estado != 'borrador'"
    return [dict(r) for r in conn.execute(
        f"""{_RESUMEN} WHERE r.alumno_id = ? {filtro}
            ORDER BY r.estado = 'publicada' DESC, r.modificado_en DESC""", (alumno_id,))]


@router.get("/plantillas")
def plantillas(conn=Depends(get_db), user=Depends(requiere_staff)):
    return [dict(r) for r in conn.execute(
        f"{_RESUMEN} WHERE r.alumno_id IS NULL ORDER BY r.titulo")]


@router.get("/mi-rutina")
def mi_rutina(conn=Depends(get_db), user=Depends(usuario_actual)):
    """La rutina vigente del alumno logueado, completa. null si no tiene."""
    r = conn.execute(
        "SELECT id FROM rutinas WHERE alumno_id = ? AND estado = 'publicada' ORDER BY modificado_en DESC LIMIT 1",
        (user["id"],)).fetchone()
    return svc.leer(conn, r["id"]) if r else None


@router.post("/rutinas", status_code=201)
def alta(body: RutinaAlta, conn=Depends(get_db), user=Depends(requiere_staff)):
    if body.alumno_id is not None:
        exigir_acceso_alumno(conn, user, body.alumno_id)
    with transaccion(conn):
        rid = svc.crear(conn, profesor_id=user["id"], alumno_id=body.alumno_id, titulo=body.titulo,
                        notas=body.notas, fecha_inicio=body.fecha_inicio, aumento_pct=body.aumento_pct,
                        dias=body.dias)
    return svc.leer(conn, rid)


@router.get("/rutinas/{rutina_id}")
def ver(rutina_id: int, conn=Depends(get_db), user=Depends(usuario_actual)):
    exigir_rutina(conn, user, rutina_id)
    return svc.leer(conn, rutina_id)


@router.put("/rutinas/{rutina_id}")
def modificar(rutina_id: int, body: RutinaCambios, conn=Depends(get_db), user=Depends(requiere_staff)):
    exigir_rutina(conn, user, rutina_id, editar=True)
    if not body.titulo.strip():
        raise HTTPException(422, "La rutina necesita un título")
    with transaccion(conn):
        conn.execute("UPDATE rutinas SET titulo = ?, notas = ?, fecha_inicio = ? WHERE id = ?",
                     (body.titulo.strip(), (body.notas or "").strip() or None, body.fecha_inicio or None, rutina_id))
        if "aumento_pct" in body.model_fields_set:
            conn.execute("UPDATE rutinas SET aumento_pct = ? WHERE id = ?", (body.aumento_pct, rutina_id))
        svc.guardar_contenido(conn, rutina_id, body.dias)
    return svc.leer(conn, rutina_id)


@router.post("/rutinas/{rutina_id}/estado")
def cambiar_estado(rutina_id: int, body: CambioEstado, conn=Depends(get_db), user=Depends(requiere_staff)):
    r = exigir_rutina(conn, user, rutina_id, editar=True)
    if body.estado not in ("borrador", "publicada", "archivada"):
        raise HTTPException(422, "Estado inválido")
    if r["alumno_id"] is None:
        raise HTTPException(422, "Las plantillas no se publican: duplicala sobre un alumno")
    if body.estado == "publicada" and not conn.execute(
            "SELECT 1 FROM rutina_dias WHERE rutina_id = ?", (rutina_id,)).fetchone():
        raise HTTPException(422, "No se puede publicar una rutina sin días")
    with transaccion(conn):
        if body.estado == "publicada":
            conn.execute(
                "UPDATE rutinas SET estado = 'archivada' WHERE alumno_id = ? AND estado = 'publicada' AND id != ?",
                (r["alumno_id"], rutina_id))
        conn.execute("UPDATE rutinas SET estado = ?, modificado_en = ? WHERE id = ?",
                     (body.estado, ahora(), rutina_id))
    return svc.leer(conn, rutina_id)


@router.post("/rutinas/{rutina_id}/duplicar", status_code=201)
def duplicar(rutina_id: int, body: Duplicar, conn=Depends(get_db), user=Depends(requiere_staff)):
    exigir_rutina(conn, user, rutina_id)
    if body.alumno_id is not None:
        exigir_acceso_alumno(conn, user, body.alumno_id)
    with transaccion(conn):
        rid = svc.duplicar(conn, rutina_id, profesor_id=user["id"], alumno_id=body.alumno_id, titulo=body.titulo)
    return svc.leer(conn, rid)


@router.delete("/rutinas/{rutina_id}")
def eliminar(rutina_id: int, conn=Depends(get_db), user=Depends(requiere_staff)):
    """Solo borradores y plantillas: lo que el alumno ya vio queda archivado, no se borra."""
    r = exigir_rutina(conn, user, rutina_id, editar=True)
    if r["alumno_id"] is not None and r["estado"] != "borrador":
        raise HTTPException(422, "Solo se eliminan borradores; archivala en su lugar")
    with transaccion(conn):
        conn.execute("DELETE FROM rutinas WHERE id = ?", (rutina_id,))
    return {"ok": True}
