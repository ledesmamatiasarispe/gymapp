"""El importador contra una planilla real del gimnasio (tests/fixtures/planilla_ejemplo.xlsx)."""
from app.services.importador import parsear

from .conftest import FIXTURES


def _resultado():
    return parsear((FIXTURES / "planilla_ejemplo.xlsx").read_bytes())


def test_catalogo_con_grupos_arrastrados_y_videos():
    res = _resultado()
    assert len(res.ejercicios) == 238
    por_numero = {e["numero"]: e for e in res.ejercicios}
    assert por_numero[1]["grupo"] == "Lumbar"
    assert por_numero[7]["grupo"] == "Lumbar"  # el grupo se arrastra hasta el próximo
    assert por_numero[8]["grupo"] == "Planchas"
    assert por_numero[2]["nombre"] == "Empuje el suelo"  # columna D, la que usa el VLOOKUP
    assert por_numero[2]["video_url"].startswith("https://drive.google.com/file/d/")
    assert not any(e["grupo"].endswith(":") for e in res.ejercicios)


def test_estructura_de_la_rutina():
    rutina = _resultado().rutina
    assert rutina["notas"].startswith("Mati:")
    assert [d["nombre"] for d in rutina["dias"]] == ["Dia 1", "Dia 2", "Dia 3"]
    dia1 = rutina["dias"][0]
    assert dia1["color"] == "#fce5cd"
    assert [b["nombre"] for b in dia1["bloques"]] == ["Entrada en calor", "Trabajo del día", "Elongación"]
    assert [i["numero"] for i in dia1["bloques"][0]["items"]] == [2, 4, 8]
    assert dia1["bloques"][1]["detalle"] == "Full body"
    assert dia1["bloques"][1]["items"][3]["prescripcion"] == "2x10 c/lado"
    elongacion = dia1["bloques"][2]
    assert elongacion["items"] == [] and elongacion["prescripcion"] == "10´"
    assert elongacion["comentario"].startswith("Primero nos alimentamos")


def test_superseries_por_sombreado():
    dia3 = _resultado().rutina["dias"][2]
    calor, trabajo = dia3["bloques"][0], dia3["bloques"][1]
    ss = [(i["numero"], i["superserie"]) for i in calor["items"]]
    assert ss[0][1] is None and ss[1][1] is None
    assert ss[2][1] is not None and ss[2][1] == ss[3][1]  # 9 + 43
    pares = [i for i in trabajo["items"] if i["superserie"] is not None]
    assert [i["numero"] for i in pares] == [66, 111]
    assert pares[0]["superserie"] != ss[2][1]
    # Días 1 y 2 no tienen sombreados
    for d in _resultado().rutina["dias"][:2]:
        assert all(i["superserie"] is None for b in d["bloques"] for i in b["items"])
