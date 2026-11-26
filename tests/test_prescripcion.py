import pytest

from app.services.prescripcion import formatear, normalizar_item, parsear


@pytest.mark.parametrize("texto, esperado, formateado", [
    ("3x10", ("reps", 3, 10, None, None, 0), "3 × 10 reps"),
    ("3x10 c/lado", ("reps", 3, 10, None, None, 1), "3 × 10 reps c/lado"),
    ("3 x 8-12", ("reps", 3, 8, 12, None, 0), "3 × 8–12 reps"),
    ("3x15´´", ("tiempo", 3, None, None, 15, 0), "3 × 15 seg"),
    ("3x10´´ c/lado", ("tiempo", 3, None, None, 10, 1), "3 × 10 seg c/lado"),
    ("3x10´´(son 3 series de 10 segundos cada una) ", ("tiempo", 3, None, None, 10, 0), "3 × 10 seg"),
    ("2x12 (son 2 series de 12 repeticiones)", ("reps", 2, 12, None, None, 0), "2 × 12 reps"),
    ("10´", ("tiempo", 1, None, None, 600, 0), "10 min"),
    ("1´30´´", ("tiempo", 1, None, None, 90, 0), "1 min 30 seg"),
    ("4 x 45 seg", ("tiempo", 4, None, None, 45, 0), "4 × 45 seg"),
])
def test_parsea_las_formas_de_la_planilla(texto, esperado, formateado):
    c = parsear(texto)
    assert tuple(c[k] for k in ("modalidad", "series", "reps", "reps_max", "segundos", "por_lado")) == esperado
    assert formatear(c) == formateado


@pytest.mark.parametrize("texto", ["al fallo", "12-10-8", "AMRAP 10 min", "10"])
def test_lo_que_no_encaja_queda_libre(texto):
    assert parsear(texto)["modalidad"] == "libre"
    assert normalizar_item({"prescripcion": texto}) == {**parsear(""), "modalidad": "libre", "prescripcion": texto}


def test_validaciones():
    with pytest.raises(ValueError):
        normalizar_item({"modalidad": "reps", "series": 0, "reps": 10})
    with pytest.raises(ValueError):
        normalizar_item({"modalidad": "reps", "series": 3, "reps_max": 12})
    assert normalizar_item({"modalidad": "tiempo", "segundos": 30})["series"] == 1
    assert normalizar_item({"modalidad": "reps"})["prescripcion"] is None
