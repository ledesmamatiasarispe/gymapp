"""Rutina como árbol: Rutina → Días → Bloques → Ítems.

El editor manda el árbol entero y ``guardar_contenido`` lo sincroniza contra la
base *preservando ids*: lo que llega con id de esta rutina se actualiza, lo
nuevo se inserta y lo que falta se borra. Borrar y reinsertar todo sería más
corto, pero cambiaría los ids en cada guardado y el historial del alumno
(``entrenamiento_items.item_id``) quedaría apuntando a nada.
"""
import sqlite3

from fastapi import HTTPException

from ..db import ahora
from . import prescripcion

_CAMPOS_DIA = ("nombre", "color")
_CAMPOS_BLOQUE = ("nombre", "detalle", "prescripcion", "comentario")
_CAMPOS_PRESC = ("modalidad", "series", "reps", "reps_max", "segundos", "por_lado")
_CAMPOS_ITEM = ("ejercicio_id", "nombre_libre", "prescripcion", "comentario", "superserie", *_CAMPOS_PRESC, "peso_kg")
# Se guardan tal cual (números/None); el resto de los campos son texto y se recortan.
_CAMPOS_CRUDOS = {"ejercicio_id", "superserie", *_CAMPOS_PRESC, "peso_kg"}


def _texto(v) -> str | None:
    if v is None:
        return None
    v = str(v).strip()
    return v or None


def leer(conn: sqlite3.Connection, rutina_id: int) -> dict:
    r = conn.execute(
        """SELECT r.*, a.nombre AS alumno_nombre, p.nombre AS profesor_nombre
           FROM rutinas r
           LEFT JOIN usuarios a ON a.id = r.alumno_id
           JOIN usuarios p ON p.id = r.profesor_id
           WHERE r.id = ?""",
        (rutina_id,),
    ).fetchone()
    rutina = dict(r)
    dias = [dict(d) for d in conn.execute(
        "SELECT * FROM rutina_dias WHERE rutina_id = ? ORDER BY orden, id", (rutina_id,))]
    for d in dias:
        d["bloques"] = [dict(b) for b in conn.execute(
            "SELECT * FROM rutina_bloques WHERE dia_id = ? ORDER BY orden, id", (d["id"],))]
        for b in d["bloques"]:
            b["items"] = [dict(i) for i in conn.execute(
                """SELECT i.*, e.numero AS ejercicio_numero, e.nombre AS ejercicio_nombre,
                          e.grupo AS ejercicio_grupo, e.video_url, e.descripcion AS ejercicio_descripcion,
                          e.miniatura AS ejercicio_miniatura
                   FROM rutina_items i LEFT JOIN ejercicios e ON e.id = i.ejercicio_id
                   WHERE i.bloque_id = ? ORDER BY i.orden, i.id""",
                (b["id"],),
            )]
    rutina["dias"] = dias
    return rutina


def _validar_ejercicios(conn: sqlite3.Connection, dias: list[dict]) -> None:
    for d in dias:
        for b in d.get("bloques", []):
            for i in b.get("items", []):
                if not i.get("ejercicio_id") and not _texto(i.get("nombre_libre")):
                    raise HTTPException(422, f"Hay un ítem sin ejercicio en «{d.get('nombre')} / {b.get('nombre')}»")
    ids = {i.get("ejercicio_id") for d in dias for b in d.get("bloques", []) for i in b.get("items", [])}
    ids.discard(None)
    if not ids:
        return
    existentes = {r[0] for r in conn.execute(
        f"SELECT id FROM ejercicios WHERE id IN ({','.join('?' * len(ids))})", tuple(ids))}
    faltan = ids - existentes
    if faltan:
        raise HTTPException(422, f"Ejercicios inexistentes: {sorted(faltan)}")


def _sincronizar(conn, tabla, padre_col, padre_id, filas, campos, hijos=None):
    """Sincroniza las filas hijas de `padre_id` con `filas`; devuelve [(fila, id)]."""
    existentes = {r[0] for r in conn.execute(f"SELECT id FROM {tabla} WHERE {padre_col} = ?", (padre_id,))}
    vistos, resultado = set(), []
    for orden, fila in enumerate(filas):
        valores = []
        for c in campos:
            v = fila.get(c)
            valores.append(v if c in _CAMPOS_CRUDOS else _texto(v))
        if tabla != "rutina_items" and not valores[0]:
            raise HTTPException(422, "Cada día y cada bloque necesita un nombre")
        fid = fila.get("id")
        if fid in existentes and fid not in vistos:
            sets = ", ".join(f"{c} = ?" for c in campos)
            conn.execute(f"UPDATE {tabla} SET orden = ?, {sets} WHERE id = ?", (orden, *valores, fid))
        else:
            cols = ", ".join(campos)
            cur = conn.execute(
                f"INSERT INTO {tabla} ({padre_col}, orden, {cols}) VALUES (?, ?, {', '.join('?' * len(campos))})",
                (padre_id, orden, *valores),
            )
            fid = cur.lastrowid
        vistos.add(fid)
        resultado.append((fila, fid))
    sobrantes = existentes - vistos
    if sobrantes:
        conn.execute(f"DELETE FROM {tabla} WHERE id IN ({','.join('?' * len(sobrantes))})", tuple(sobrantes))
    return resultado


def _peso(v) -> float | None:
    """Peso indicado en kg: acepta 12, 12.5 o "12,5"; vacío = sin peso."""
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        n = float(str(v).replace(",", ".").replace("kg", "").strip())
    except ValueError:
        raise ValueError("el peso tiene que ser un número de kilos")
    if not 0 < n <= 1000:
        raise ValueError("el peso tiene que estar entre 0 y 1000 kg")
    return round(n, 2)


def _normalizar_prescripciones(dias: list[dict]) -> list[dict]:
    """Cada ítem con sus campos de prescripción coherentes (ver services/prescripcion.py)."""
    salida = []
    for d in dias:
        bloques = []
        for b in d.get("bloques", []):
            items = []
            for i in b.get("items", []):
                try:
                    items.append({**i, **prescripcion.normalizar_item(i), "peso_kg": _peso(i.get("peso_kg"))})
                except ValueError as e:
                    nombre = i.get("nombre_libre") or f"ejercicio {i.get('ejercicio_id')}"
                    raise HTTPException(422, f"{d.get('nombre')} / {b.get('nombre')} / {nombre}: {e}")
            bloques.append({**b, "items": items})
        salida.append({**d, "bloques": bloques})
    return salida


def guardar_contenido(conn: sqlite3.Connection, rutina_id: int, dias: list[dict]) -> None:
    """Reemplaza el contenido de la rutina por `dias`. Debe correr dentro de una transacción."""
    _validar_ejercicios(conn, dias)
    dias = _normalizar_prescripciones(dias)
    for dia, dia_id in _sincronizar(conn, "rutina_dias", "rutina_id", rutina_id, dias, _CAMPOS_DIA):
        bloques = dia.get("bloques", [])
        for bloque, bloque_id in _sincronizar(conn, "rutina_bloques", "dia_id", dia_id, bloques, _CAMPOS_BLOQUE):
            _sincronizar(conn, "rutina_items", "bloque_id", bloque_id, bloque.get("items", []), _CAMPOS_ITEM)
    conn.execute("UPDATE rutinas SET modificado_en = ? WHERE id = ?", (ahora(), rutina_id))


def crear(conn: sqlite3.Connection, *, profesor_id: int, alumno_id: int | None, titulo: str,
          notas: str | None = None, fecha_inicio: str | None = None, aumento_pct: float | None = None,
          dias: list[dict] | None = None) -> int:
    titulo = _texto(titulo)
    if not titulo:
        raise HTTPException(422, "La rutina necesita un título")
    t = ahora()
    cur = conn.execute(
        """INSERT INTO rutinas (alumno_id, profesor_id, titulo, notas, fecha_inicio, aumento_pct, estado, creado_en, modificado_en)
           VALUES (?, ?, ?, ?, ?, ?, 'borrador', ?, ?)""",
        (alumno_id, profesor_id, titulo, _texto(notas), _texto(fecha_inicio), aumento_pct, t, t),
    )
    rid = cur.lastrowid
    if dias:
        guardar_contenido(conn, rid, dias)
    return rid


def _sin_ids(dias: list[dict]) -> list[dict]:
    return [
        {**{k: d.get(k) for k in _CAMPOS_DIA},
         "bloques": [
             {**{k: b.get(k) for k in _CAMPOS_BLOQUE},
              "items": [{k: i.get(k) for k in _CAMPOS_ITEM} for i in b["items"]]}
             for b in d["bloques"]]}
        for d in dias
    ]


def duplicar(conn: sqlite3.Connection, rutina_id: int, *, profesor_id: int, alumno_id: int | None,
             titulo: str | None = None) -> int:
    """Copia una rutina (o plantilla) entera; la copia arranca en borrador."""
    origen = leer(conn, rutina_id)
    return crear(
        conn, profesor_id=profesor_id, alumno_id=alumno_id,
        titulo=titulo or origen["titulo"], notas=origen["notas"], aumento_pct=origen["aumento_pct"],
        dias=_sin_ids(origen["dias"]),
    )
