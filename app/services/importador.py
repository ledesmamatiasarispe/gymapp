"""Importación de las planillas de Google Sheets (exportadas como .xlsx).

Formato que se reconoce (el de las planillas actuales del gimnasio):

Hoja «Datos» — el catálogo:
    A = grupo (solo en la primera fila de cada grupo, se arrastra hacia abajo)
    B = número de ejercicio, C/D = nombre (D es el que usa el VLOOKUP de la
    rutina), y el hipervínculo de D (o C) es el video en Drive.

Hoja «Entrenamiento» — la rutina de un alumno:
    - Filas sueltas en A antes del primer «Dia N» → notas generales.
    - «Dia N» → un día nuevo; su relleno es el color del día.
    - Fila con texto en negrita en A («Entrada en calor», «Trabajo del día»,
      «Elongación») → un bloque nuevo; B es el detalle («Full body») y C/D la
      prescripción/comentario del bloque si no tiene ejercicios.
    - Fila con un número en A → un ítem: ese número del catálogo, C =
      series/reps/tiempo, D = comentario.
    - **Superseries**: en la planilla se sombrean. Se detectan porque el relleno
      de B difiere del color del día; filas consecutivas con el mismo relleno
      distinto forman una superserie.
"""
import io
import re
from dataclasses import dataclass, field

import openpyxl
from openpyxl.worksheet.worksheet import Worksheet

from . import prescripcion

_DIA = re.compile(r"^\s*d[ií]a\s*\d+", re.IGNORECASE)
_ENCABEZADOS = {"ejercicios", "series/repeticiones/tiempo", "comentarios"}
_SIN_RELLENO = {None, "00000000", "FFFFFFFF"}


@dataclass
class Resultado:
    ejercicios: list[dict] = field(default_factory=list)
    rutina: dict | None = None
    avisos: list[str] = field(default_factory=list)


def _txt(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _numero(v) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)) and float(v).is_integer():
        return int(v)
    if isinstance(v, str) and v.strip().isdigit():
        return int(v.strip())
    return None


def _relleno(celda) -> str | None:
    if celda.fill is None or celda.fill.fill_type is None:
        return None
    rgb = celda.fill.fgColor.rgb
    return rgb if isinstance(rgb, str) and rgb not in _SIN_RELLENO else None


def _es_formula(v) -> bool:
    return isinstance(v, str) and v.startswith("=")


def _css(rgb: str | None) -> str | None:
    return f"#{rgb[-6:].lower()}" if rgb else None


def parsear_catalogo(ws: Worksheet) -> list[dict]:
    ejercicios, grupo = [], None
    for a, b, c, d in ws.iter_rows(min_row=1, max_col=4):
        if _txt(a.value):
            grupo = _txt(a.value).rstrip(":").strip()
            grupo = grupo[0].upper() + grupo[1:]
        n = _numero(b.value)
        if n is None:
            continue
        nombre = _txt(d.value) or _txt(c.value)
        if not nombre:
            continue
        link = None
        for celda in (d, c):
            if celda.hyperlink and celda.hyperlink.target:
                link = celda.hyperlink.target
                break
        ejercicios.append({"numero": n, "nombre": nombre, "grupo": grupo, "video_url": link})
    return ejercicios


def parsear_rutina(ws: Worksheet, nombres: dict[int, str]) -> tuple[dict, list[str]]:
    """Devuelve ({notas, dias}, avisos). Los ítems llevan `numero`, no ids: los resuelve quien guarda."""
    notas, dias, avisos = [], [], []
    dia = bloque = None
    ss_color, ss_contador, ss_actual = None, 0, None

    for fila in ws.iter_rows(min_row=1, max_col=4):
        a, b, c, d = fila
        va, vb, vc, vd = a.value, b.value, _txt(c.value), _txt(d.value)

        if isinstance(va, str) and _DIA.match(va):
            dia = {"nombre": _txt(va), "color": _css(_relleno(a)), "bloques": []}
            dias.append(dia)
            bloque, ss_color = None, None
            continue

        if dia is None:
            if _txt(va):
                notas.append(_txt(va))
            continue

        numero = _numero(va)
        if numero is None and _txt(va):
            # Encabezado de bloque («Entrada en calor | Ejercicios | Series... | Comentarios»).
            detalle = _txt(vb) if not _es_formula(vb) else None
            bloque = {
                "nombre": _txt(va),
                "detalle": None if (detalle or "").lower() in _ENCABEZADOS else detalle,
                "prescripcion": None if (vc or "").lower() in _ENCABEZADOS else vc,
                "comentario": None if (vd or "").lower() in _ENCABEZADOS else vd,
                "items": [],
            }
            dia["bloques"].append(bloque)
            ss_color = None
            continue

        nombre_libre = None
        if numero is None:
            # Ejercicio escrito a mano en B, sin número de catálogo.
            if vb is None or _es_formula(vb) or not _txt(vb):
                ss_color = None  # una fila vacía corta la superserie
                continue
            nombre_libre = _txt(vb)

        if bloque is None:
            bloque = {"nombre": "Ejercicios", "detalle": None, "prescripcion": None, "comentario": None, "items": []}
            dia["bloques"].append(bloque)

        if numero is not None and numero not in nombres:
            avisos.append(f"{dia['nombre']}: el ejercicio #{numero} no está en el catálogo (fila {a.row})")
            nombre_libre = f"Ejercicio #{numero}"

        color_fila = _relleno(b)
        sombreado = color_fila is not None and _css(color_fila) != dia["color"]
        if sombreado:
            if color_fila != ss_color:
                ss_contador += 1
                ss_actual = ss_contador
            ss_color = color_fila
        else:
            ss_color = None

        bloque["items"].append({
            "numero": numero if numero in nombres else None,
            "nombre_libre": nombre_libre,
            "prescripcion": vc,
            **prescripcion.parsear(vc),
            "comentario": vd,
            "superserie": ss_actual if sombreado else None,
        })

    # Una "superserie" de un solo ejercicio es solo una fila pintada: no la marcamos.
    for d_ in dias:
        for b_ in d_["bloques"]:
            cuenta: dict[int, int] = {}
            for i in b_["items"]:
                if i["superserie"] is not None:
                    cuenta[i["superserie"]] = cuenta.get(i["superserie"], 0) + 1
            for i in b_["items"]:
                if i["superserie"] is not None and cuenta[i["superserie"]] < 2:
                    i["superserie"] = None

    return {"notas": "\n".join(notas) or None, "dias": dias}, avisos


def _hoja(wb, nombre: str, predicado) -> Worksheet | None:
    for ws in wb.worksheets:
        if ws.title.strip().lower() == nombre:
            return ws
    for ws in wb.worksheets:
        if predicado(ws):
            return ws
    return None


def _parece_rutina(ws: Worksheet) -> bool:
    return any(isinstance(c.value, str) and _DIA.match(c.value)
               for fila in ws.iter_rows(max_col=1, max_row=80) for c in fila)


def parsear(contenido: bytes, *, catalogo_existente: dict[int, str] | None = None) -> Resultado:
    try:
        wb = openpyxl.load_workbook(io.BytesIO(contenido))
    except Exception as e:  # zip inválido, no es xlsx, etc.
        raise ValueError(f"No se pudo leer el archivo como .xlsx: {e}") from e

    res = Resultado()
    hoja_datos = _hoja(wb, "datos", lambda ws: False)
    if hoja_datos is not None:
        res.ejercicios = parsear_catalogo(hoja_datos)

    hoja_rutina = _hoja(wb, "entrenamiento", _parece_rutina)
    if hoja_rutina is not None and hoja_rutina is not hoja_datos:
        nombres = dict(catalogo_existente or {})
        nombres.update({e["numero"]: e["nombre"] for e in res.ejercicios})
        res.rutina, res.avisos = parsear_rutina(hoja_rutina, nombres)
    return res
