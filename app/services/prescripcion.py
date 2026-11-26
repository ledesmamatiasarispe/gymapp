"""Cómo se prescribe un ejercicio: series × repeticiones, o series × tiempo.

En las planillas de los profes aparecen estas formas (columna «Series/Repeticiones/Tiempo»):

    3x10            3 series de 10 repeticiones                    → modalidad «reps»
    3x8-12          3 series de 8 a 12 repeticiones (rango)        → «reps» con reps_max
    3x10 c/lado     lo mismo, por cada lado (unilateral)           → «reps» + por_lado
    3x15´´          3 series de 15 segundos (isométricos, planchas) → «tiempo»
    3x10´´ c/lado   3 series de 10 segundos por lado               → «tiempo» + por_lado
    1´30´´ / 2´     una serie de 1 min 30 seg / de 2 minutos       → «tiempo», 1 serie
    al fallo, 12-10-8, AMRAP…  lo que no encaja                    → «libre» (texto tal cual)

´´ (o '', ", s, seg) son segundos; ´ (o ', min) son minutos. Lo que va entre paréntesis
después de la cantidad es una aclaración para el alumno («(son 3 series de 10 segundos)»)
y se descarta, porque el texto que se arma a partir de los campos ya lo dice.

``prescripcion`` (texto) se sigue guardando: para «libre» es lo que escribió el profe, y
para las otras dos es el texto armado con ``formatear`` — así el alumno y el historial
lo leen igual que antes, sin tener que conocer los campos.
"""
import re

MODALIDADES = ("reps", "tiempo", "libre")

_SEG = r"(?:s|seg|segs|segundos?)"
_MIN = r"(?:m|min|mins|minutos?)"
_LADO = r"(?:c\s*/\s*lado|c\s*/\s*u|por\s+lado|x\s+lado|cada\s+lado|de\s+cada\s+lado)"

_CANTIDAD = re.compile(
    rf"""^(?:(?P<series>\d+)\s*[x×*]\s*)?
         (?:
            (?P<min>\d+)\s*{_MIN}\s*(?P<seg2>\d+)\s*{_SEG}       # 1´30´´
          | (?P<n>\d+)(?:\s*(?:-|–|a)\s*(?P<n2>\d+))?\s*(?P<unidad>{_SEG}|{_MIN})?
         )
         \s*(?P<lado>{_LADO})?
         \s*(?:\(.*\))?\s*$""",
    re.X | re.I,
)


def _normalizar(texto: str) -> str:
    t = texto.strip().lower()
    t = re.sub(r"(´´|''|’’|′′|″|\"|“|”)", "s", t)  # dos tildes = segundos
    t = re.sub(r"(´|'|’|′)", "m", t)                # una tilde = minutos
    return re.sub(r"\s+", " ", t)


def vacia() -> dict:
    return {"modalidad": None, "series": None, "reps": None, "reps_max": None, "segundos": None, "por_lado": 0}


def parsear(texto: str | None) -> dict:
    """Texto de la planilla → campos. Siempre devuelve los seis campos de ``vacia()``."""
    campos = vacia()
    if not texto or not str(texto).strip():
        return campos
    m = _CANTIDAD.match(_normalizar(str(texto)))
    if not m:
        return {**campos, "modalidad": "libre"}
    series = int(m["series"]) if m["series"] else 1
    lado = 1 if m["lado"] else 0
    if m["min"]:
        return {**campos, "modalidad": "tiempo", "series": series,
                "segundos": int(m["min"]) * 60 + int(m["seg2"]), "por_lado": lado}
    n, n2, unidad = int(m["n"]), m["n2"], (m["unidad"] or "")
    if unidad:
        if n2:  # rango de tiempo («20-30´´»): no lo modelamos
            return {**campos, "modalidad": "libre"}
        segundos = n * 60 if re.fullmatch(_MIN, unidad) else n
        return {**campos, "modalidad": "tiempo", "series": series, "segundos": segundos, "por_lado": lado}
    if not m["series"] and not n2:
        # Un número solo («10») es ambiguo: puede ser reps o minutos. Se deja como texto.
        return {**campos, "modalidad": "libre"}
    reps_max = int(n2) if n2 else None
    if reps_max is not None and reps_max <= n:
        return {**campos, "modalidad": "libre"}  # «12-10-8» y similares (pirámide)
    return {**campos, "modalidad": "reps", "series": series, "reps": n, "reps_max": reps_max, "por_lado": lado}


def duracion(segundos: int) -> str:
    """90 → «1 min 30 seg», 120 → «2 min», 45 → «45 seg»."""
    m, s = divmod(int(segundos), 60)
    if not m:
        return f"{s} seg"
    return f"{m} min {s} seg" if s else f"{m} min"


def formatear(c: dict) -> str | None:
    """Campos → el texto que lee el alumno («3 × 10 reps c/lado», «3 × 15 seg»)."""
    mod = c.get("modalidad")
    series = c.get("series") or 1
    if mod == "reps" and c.get("reps"):
        reps = f"{c['reps']}–{c['reps_max']}" if c.get("reps_max") else f"{c['reps']}"
        texto = f"{series} × {reps} reps" if series > 1 else f"{reps} reps"
    elif mod == "tiempo" and c.get("segundos"):
        texto = f"{series} × {duracion(c['segundos'])}" if series > 1 else duracion(c["segundos"])
    else:
        return None
    return texto + (" c/lado" if c.get("por_lado") else "")


def _entero(v, campo: str, minimo: int = 1) -> int | None:
    if v is None or v == "":
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise ValueError(f"«{campo}» tiene que ser un número entero")
    if n < minimo:
        raise ValueError(f"«{campo}» tiene que ser al menos {minimo}")
    return n


def normalizar_item(item: dict) -> dict:
    """Lo que manda el editor (o el importador) → los campos a guardar, con ``prescripcion``
    coherente. Si no viene ``modalidad`` (un cliente viejo, o datos que solo traen texto),
    se deduce del texto. Lanza ValueError con un mensaje para el profe."""
    mod = item.get("modalidad")
    texto = (str(item.get("prescripcion")).strip() or None) if item.get("prescripcion") is not None else None
    if mod is None:
        c = parsear(texto)
        mod = c["modalidad"]
        if mod in ("reps", "tiempo"):
            return {**c, "prescripcion": formatear(c)}
        return {**vacia(), "modalidad": "libre", "prescripcion": texto}
    if mod not in MODALIDADES:
        raise ValueError(f"Modalidad desconocida: {mod}")
    if mod == "libre":
        return {**vacia(), "modalidad": "libre", "prescripcion": texto}

    c = {**vacia(), "modalidad": mod,
         "series": _entero(item.get("series"), "Series"),
         "por_lado": 1 if item.get("por_lado") else 0}
    if mod == "reps":
        c["reps"] = _entero(item.get("reps"), "Repeticiones")
        c["reps_max"] = _entero(item.get("reps_max"), "Repeticiones (hasta)")
        if c["reps_max"] is not None:
            if c["reps"] is None:
                raise ValueError("Para un rango de repeticiones falta el «desde»")
            if c["reps_max"] <= c["reps"]:
                raise ValueError("En un rango de repeticiones, el «hasta» tiene que ser mayor que el «desde»")
    else:
        c["segundos"] = _entero(item.get("segundos"), "Tiempo")
    if c["series"] is None and (c["reps"] or c["segundos"]):
        c["series"] = 1
    return {**c, "prescripcion": formatear(c)}
