"""Registro del alumno: sesiones de entrenamiento sobre los días de su rutina.

La rutina es un plan que se repite (por ejemplo 3 días x 4 semanas): cada vez
que el alumno hace un día se abre una **sesión**, se registra ejercicio por
ejercicio y "Terminar" la cierra. Cada sesión terminada es una entrada del
historial; la rutina no cambia, y el día vuelve a quedar listo para la próxima.

- A lo sumo una sesión abierta por alumno y día de rutina (índice parcial
  ``ux_entrenamiento_abierto``: dos toques simultáneos no abren dos).
- La fecha es un dato de la sesión, no su clave: el alumno puede anotarla con
  la fecha de ayer si se olvidó de registrarla.
- Una sesión abierta que nadie terminó (se fue del gimnasio sin tocar
  "Terminar") se cierra sola a las ``_HORAS_ABANDONO`` horas: queda en el
  historial como incompleta y el día vuelve a empezar de cero.

El alumno no puede tocar sus rutinas (archivar, eliminar, editar): eso lo
controla ``exigir_rutina(..., editar=True)`` en el router de rutinas. Acá solo
registra lo que hizo.
"""
import sqlite3
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..db import ahora, get_db, transaccion
from ..deps import exigir_acceso_alumno, exigir_rutina, usuario_actual

router = APIRouter(prefix="/api", tags=["entrenamientos"])

_HORAS_ABANDONO = 12


class ItemHecho(BaseModel):
    dia_id: int
    fecha: date
    item_id: int
    hecho: bool = False
    carga: str | None = None
    nota: str | None = None
    esfuerzo: int | None = Field(None, ge=1, le=10)  # cómo se sintió al terminar ese ejercicio
    peso_kg: float | None = Field(None, gt=0, le=1000)  # con cuánto peso lo hizo


class Cierre(BaseModel):
    dia_id: int
    fecha: date
    esfuerzo: int | None = Field(None, ge=1, le=10)
    nota: str | None = None


def _limpio(s: str | None) -> str | None:
    return (s or "").strip() or None


def _detalle(conn, entrenamiento_id: int) -> dict:
    e = dict(conn.execute("SELECT * FROM entrenamientos WHERE id = ?", (entrenamiento_id,)).fetchone())
    e["items"] = [dict(i) for i in conn.execute(
        "SELECT * FROM entrenamiento_items WHERE entrenamiento_id = ? ORDER BY id", (entrenamiento_id,))]
    return e


def _exigir_dia_registrable(conn, user: dict, dia_id: int, fecha: date | None = None):
    """Valida que el alumno pueda registrar ese día; devuelve (día, {item_id: nombre})."""
    if user["rol"] != "alumno":
        raise HTTPException(403, "El entrenamiento lo registra el alumno")
    if fecha and fecha > date.today():
        raise HTTPException(422, "No se puede registrar un entrenamiento futuro")
    dia = conn.execute("SELECT * FROM rutina_dias WHERE id = ?", (dia_id,)).fetchone()
    if not dia:
        raise HTTPException(404, "Día de rutina no encontrado")
    exigir_rutina(conn, user, dia["rutina_id"])  # que la rutina sea suya y esté publicada/archivada
    nombres = {r["id"]: r["nombre"] for r in conn.execute(
        """SELECT i.id, coalesce(e.nombre, i.nombre_libre) AS nombre
           FROM rutina_items i JOIN rutina_bloques b ON b.id = i.bloque_id
           LEFT JOIN ejercicios e ON e.id = i.ejercicio_id
           WHERE b.dia_id = ?""", (dia_id,))}
    return dia, nombres


def _cerrar_abandonadas(conn: sqlite3.Connection, alumno_id: int) -> None:
    limite = (datetime.now() - timedelta(hours=_HORAS_ABANDONO)).isoformat(timespec="seconds")
    conn.execute(
        """UPDATE entrenamientos SET terminado_en = ?
           WHERE alumno_id = ? AND terminado_en IS NULL AND creado_en < ?""",
        (ahora(), alumno_id, limite))


def _sesion_abierta(conn, alumno_id: int, dia_id: int) -> int | None:
    fila = conn.execute(
        "SELECT id FROM entrenamientos WHERE alumno_id = ? AND dia_id = ? AND terminado_en IS NULL",
        (alumno_id, dia_id)).fetchone()
    return fila["id"] if fila else None


def _abrir_o_retomar(conn, user: dict, dia, fecha: date) -> int:
    """La sesión abierta de ese día (con la fecha al día), o una nueva."""
    _cerrar_abandonadas(conn, user["id"])
    eid = _sesion_abierta(conn, user["id"], dia["id"])
    if eid:
        conn.execute("UPDATE entrenamientos SET fecha = ? WHERE id = ?", (fecha.isoformat(), eid))
        return eid
    try:
        return conn.execute(
            """INSERT INTO entrenamientos (alumno_id, rutina_id, dia_id, dia_nombre, fecha, creado_en)
               VALUES (?,?,?,?,?,?)""",
            (user["id"], dia["rutina_id"], dia["id"], dia["nombre"], fecha.isoformat(), ahora())).lastrowid
    except sqlite3.IntegrityError:
        # Dos toques al mismo tiempo: el otro request abrió la sesión entre el SELECT
        # y este INSERT. El índice parcial lo frenó; se retoma la que abrió el otro.
        eid = _sesion_abierta(conn, user["id"], dia["id"])
        if eid is None:
            raise
        return eid


def _guardar_item(conn, eid: int, item: ItemHecho, nombre: str) -> None:
    """Alta, corrección o baja (si quedó vacío) del registro de un ejercicio."""
    carga, nota = _limpio(item.carga), _limpio(item.nota)
    if not (item.hecho or carga or nota or item.esfuerzo or item.peso_kg):
        conn.execute("DELETE FROM entrenamiento_items WHERE entrenamiento_id = ? AND item_id = ?", (eid, item.item_id))
        return
    conn.execute(
        """INSERT INTO entrenamiento_items (entrenamiento_id, item_id, ejercicio_nombre, hecho, carga, nota, esfuerzo, peso_kg)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT (entrenamiento_id, item_id)
           DO UPDATE SET hecho = excluded.hecho, carga = excluded.carga, nota = excluded.nota,
                         esfuerzo = excluded.esfuerzo, peso_kg = excluded.peso_kg""",
        (eid, item.item_id, nombre, int(item.hecho), carga, nota, item.esfuerzo,
         round(item.peso_kg, 2) if item.peso_kg else None))


def _descartar_si_vacia(conn, eid: int) -> bool:
    """Marcar y desmarcar no debería dejar una sesión fantasma en el historial."""
    vacia = conn.execute(
        """SELECT 1 FROM entrenamientos e WHERE e.id = ? AND e.esfuerzo IS NULL AND e.nota IS NULL
           AND NOT EXISTS (SELECT 1 FROM entrenamiento_items i WHERE i.entrenamiento_id = e.id)""", (eid,)).fetchone()
    if vacia:
        conn.execute("DELETE FROM entrenamientos WHERE id = ?", (eid,))
    return bool(vacia)


@router.put("/entrenamientos/item")
def registrar_item(body: ItemHecho, conn=Depends(get_db), user=Depends(usuario_actual)):
    """Registra un ejercicio apenas se hace. El primero abre la sesión del día."""
    dia, nombres = _exigir_dia_registrable(conn, user, body.dia_id, body.fecha)
    if body.item_id not in nombres:
        raise HTTPException(422, "Ese ejercicio no es de este día")
    with transaccion(conn):
        eid = _abrir_o_retomar(conn, user, dia, body.fecha)
        _guardar_item(conn, eid, body, nombres[body.item_id])
        if _descartar_si_vacia(conn, eid):
            return None
    return _detalle(conn, eid)


@router.put("/entrenamientos/cierre")
def terminar(body: Cierre, conn=Depends(get_db), user=Depends(usuario_actual)):
    """Esfuerzo y comentario del día, y cierra la sesión: pasa al historial y el día queda listo para la próxima."""
    dia, _ = _exigir_dia_registrable(conn, user, body.dia_id, body.fecha)
    with transaccion(conn):
        eid = _abrir_o_retomar(conn, user, dia, body.fecha)
        conn.execute("UPDATE entrenamientos SET esfuerzo = ?, nota = ? WHERE id = ?",
                     (body.esfuerzo, _limpio(body.nota), eid))
        if _descartar_si_vacia(conn, eid):
            return None
        conn.execute("UPDATE entrenamientos SET terminado_en = ? WHERE id = ?", (ahora(), eid))
    return _detalle(conn, eid)


@router.get("/dias/{dia_id}/entrenamiento")
def sesion_en_curso(dia_id: int, conn=Depends(get_db), user=Depends(usuario_actual)):
    """La sesión abierta de ese día (para seguir donde se dejó), o null si hay que empezar de cero."""
    _exigir_dia_registrable(conn, user, dia_id)
    with transaccion(conn):
        _cerrar_abandonadas(conn, user["id"])
    eid = _sesion_abierta(conn, user["id"], dia_id)
    return _detalle(conn, eid) if eid else None


@router.get("/rutinas/{rutina_id}/resumen-dias")
def resumen_dias(rutina_id: int, conn=Depends(get_db), user=Depends(usuario_actual)):
    """Por día de la rutina: cuántas veces se terminó, la última fecha y, si hay, la sesión en curso."""
    r = exigir_rutina(conn, user, rutina_id)
    if r["alumno_id"] is None:
        return {}
    with transaccion(conn):
        _cerrar_abandonadas(conn, r["alumno_id"])
    filas = conn.execute(
        """SELECT d.id AS dia_id,
                  count(e.terminado_en) AS veces,
                  max(CASE WHEN e.terminado_en IS NOT NULL THEN e.fecha END) AS ultima,
                  max(CASE WHEN e.terminado_en IS NULL THEN e.id END) AS abierta_id
           FROM rutina_dias d
           LEFT JOIN entrenamientos e ON e.dia_id = d.id AND e.alumno_id = ?
           WHERE d.rutina_id = ? GROUP BY d.id""", (r["alumno_id"], rutina_id))
    resumen = {}
    for f in filas:
        en_curso = None
        if f["abierta_id"]:
            en_curso = {"hechos": conn.execute(
                "SELECT count(*) FROM entrenamiento_items WHERE entrenamiento_id = ? AND hecho = 1",
                (f["abierta_id"],)).fetchone()[0]}
        resumen[str(f["dia_id"])] = {"veces": f["veces"], "ultima": f["ultima"], "en_curso": en_curso}
    return resumen


@router.get("/rutinas/{rutina_id}/ultimas-cargas")
def ultimas_cargas(rutina_id: int, conn=Depends(get_db), user=Depends(usuario_actual)):
    """Última carga anotada por ítem en una sesión terminada: con cuánto lo hizo la vez anterior."""
    r = exigir_rutina(conn, user, rutina_id)
    if r["alumno_id"] is None:
        return {}
    filas = conn.execute(
        """SELECT ei.item_id, ei.carga, ei.peso_kg, e.fecha FROM entrenamiento_items ei
           JOIN entrenamientos e ON e.id = ei.entrenamiento_id
           WHERE e.rutina_id = ? AND e.alumno_id = ? AND (ei.carga IS NOT NULL OR ei.peso_kg IS NOT NULL)
                 AND e.terminado_en IS NOT NULL
           ORDER BY e.fecha, e.id""", (rutina_id, r["alumno_id"]))
    return {str(f["item_id"]): {"carga": f["carga"], "peso_kg": f["peso_kg"], "fecha": f["fecha"]} for f in filas}


@router.get("/alumnos/{alumno_id}/entrenamientos")
def historial(alumno_id: int, limite: int = 60, conn=Depends(get_db), user=Depends(usuario_actual)):
    """Una entrada por sesión, la más reciente primero. Las que están en curso traen terminado_en = null."""
    exigir_acceso_alumno(conn, user, alumno_id)
    with transaccion(conn):
        _cerrar_abandonadas(conn, alumno_id)
    filas = [dict(r) for r in conn.execute(
        """SELECT e.*, r.titulo AS rutina_titulo,
                  (SELECT count(*) FROM entrenamiento_items i WHERE i.entrenamiento_id = e.id AND i.hecho = 1) AS hechos,
                  (SELECT count(*) FROM rutina_items ri JOIN rutina_bloques b ON b.id = ri.bloque_id
                   WHERE b.dia_id = e.dia_id) AS total
           FROM entrenamientos e LEFT JOIN rutinas r ON r.id = e.rutina_id
           WHERE e.alumno_id = ? ORDER BY e.fecha DESC, e.id DESC LIMIT ?""", (alumno_id, min(limite, 500)))]
    for f in filas:
        f["items"] = [dict(i) for i in conn.execute(
            "SELECT * FROM entrenamiento_items WHERE entrenamiento_id = ? ORDER BY id", (f["id"],))]
    return filas
