from datetime import date, timedelta

from .conftest import FIXTURES, login


def _rutina(client, h, alumno_id, ejercicios, titulo="Rutina octubre"):
    dias = [{"nombre": "Día 1", "bloques": [
        {"nombre": "Entrada en calor", "items": [
            {"ejercicio_id": ejercicios[0], "prescripcion": "3x15´´"},
            {"ejercicio_id": ejercicios[1], "prescripcion": "3x10", "superserie": 1},
        ]},
        {"nombre": "Elongación", "prescripcion": "10´", "items": []},
    ]}]
    r = client.post("/api/rutinas", headers=h, json={"alumno_id": alumno_id, "titulo": titulo, "dias": dias})
    assert r.status_code == 201, r.text
    return r.json()


def test_login_incorrecto(client):
    r = client.post("/api/auth/login", json={"usuario": "admin", "password": "mal"})
    assert r.status_code == 401


def test_profe_solo_ve_sus_alumnos(client, gimnasio):
    h, ids = gimnasio["h"], gimnasio["ids"]
    assert [a["usuario"] for a in client.get("/api/alumnos", headers=h["profe1"]).json()] == ["alu1"]
    assert client.get(f"/api/alumnos/{ids['alu2']}", headers=h["profe1"]).status_code == 404
    r = client.post("/api/rutinas", headers=h["profe1"], json={"alumno_id": ids["alu2"], "titulo": "x"})
    assert r.status_code == 404


def test_alumno_no_ve_borradores_ni_rutinas_ajenas(client, gimnasio):
    h, ids, ej = gimnasio["h"], gimnasio["ids"], gimnasio["ejercicios"]
    rut = _rutina(client, h["profe1"], ids["alu1"], ej)
    assert client.get("/api/mi-rutina", headers=h["alu1"]).json() is None
    assert client.get(f"/api/rutinas/{rut['id']}", headers=h["alu1"]).status_code == 404

    client.post(f"/api/rutinas/{rut['id']}/estado", headers=h["profe1"], json={"estado": "publicada"})
    mia = client.get("/api/mi-rutina", headers=h["alu1"]).json()
    assert mia["id"] == rut["id"]
    assert mia["dias"][0]["bloques"][0]["items"][0]["ejercicio_nombre"] == "Plancha"
    assert client.get(f"/api/rutinas/{rut['id']}", headers=h["alu2"]).status_code == 404
    assert client.put(f"/api/rutinas/{rut['id']}", headers=h["alu1"],
                      json={"titulo": "hack", "dias": []}).status_code == 403


def test_publicar_archiva_la_anterior(client, gimnasio):
    h, ids, ej = gimnasio["h"], gimnasio["ids"], gimnasio["ejercicios"]
    r1 = _rutina(client, h["profe1"], ids["alu1"], ej, "Octubre")
    r2 = _rutina(client, h["profe1"], ids["alu1"], ej, "Noviembre")
    client.post(f"/api/rutinas/{r1['id']}/estado", headers=h["profe1"], json={"estado": "publicada"})
    client.post(f"/api/rutinas/{r2['id']}/estado", headers=h["profe1"], json={"estado": "publicada"})
    estados = {r["titulo"]: r["estado"] for r in
               client.get(f"/api/alumnos/{ids['alu1']}/rutinas", headers=h["profe1"]).json()}
    assert estados == {"Octubre": "archivada", "Noviembre": "publicada"}
    assert client.delete(f"/api/rutinas/{r2['id']}", headers=h["profe1"]).status_code == 422


def test_editar_preserva_ids_y_borra_lo_quitado(client, gimnasio):
    h, ids, ej = gimnasio["h"], gimnasio["ids"], gimnasio["ejercicios"]
    rut = _rutina(client, h["profe1"], ids["alu1"], ej)
    dia = rut["dias"][0]
    item_id = dia["bloques"][0]["items"][0]["id"]
    dia["bloques"][0]["items"] = dia["bloques"][0]["items"][:1]  # quito el segundo
    dia["bloques"][0]["items"][0]["prescripcion"] = "4x20´´"
    r = client.put(f"/api/rutinas/{rut['id']}", headers=h["profe1"],
                   json={"titulo": rut["titulo"], "dias": rut["dias"]})
    assert r.status_code == 200, r.text
    items = r.json()["dias"][0]["bloques"][0]["items"]
    assert [(i["id"], i["prescripcion"]) for i in items] == [(item_id, "4x20´´")]


def test_ejercicio_inexistente_o_vacio(client, gimnasio):
    h, ids = gimnasio["h"], gimnasio["ids"]
    dias = [{"nombre": "D1", "bloques": [{"nombre": "B", "items": [{"ejercicio_id": 9999}]}]}]
    r = client.post("/api/rutinas", headers=h["profe1"], json={"alumno_id": ids["alu1"], "titulo": "x", "dias": dias})
    assert r.status_code == 422
    dias[0]["bloques"][0]["items"] = [{"prescripcion": "3x10"}]
    r = client.post("/api/rutinas", headers=h["profe1"], json={"alumno_id": ids["alu1"], "titulo": "x", "dias": dias})
    assert r.status_code == 422


def test_plantilla_duplicada_sobre_alumno(client, gimnasio):
    h, ids, ej = gimnasio["h"], gimnasio["ids"], gimnasio["ejercicios"]
    plantilla = _rutina(client, h["profe1"], None, ej, "Full body inicial")
    assert [p["titulo"] for p in client.get("/api/plantillas", headers=h["profe2"]).json()] == ["Full body inicial"]
    # profe2 la ve pero no la edita; sí la puede duplicar para su alumno
    assert client.put(f"/api/rutinas/{plantilla['id']}", headers=h["profe2"],
                      json={"titulo": "x", "dias": []}).status_code == 403
    r = client.post(f"/api/rutinas/{plantilla['id']}/duplicar", headers=h["profe2"], json={"alumno_id": ids["alu2"]})
    assert r.status_code == 201
    copia = r.json()
    assert copia["alumno_id"] == ids["alu2"] and copia["estado"] == "borrador"
    assert copia["dias"][0]["bloques"][0]["items"][1]["superserie"] == 1
    assert copia["dias"][0]["id"] != plantilla["dias"][0]["id"]


def test_aumento_sugerido_lo_fija_el_profe(client, gimnasio):
    h, ids, ej = gimnasio["h"], gimnasio["ids"], gimnasio["ejercicios"]
    rut = _rutina(client, h["profe1"], ids["alu1"], ej)
    assert rut["aumento_pct"] is None  # por defecto: 1 kg más
    url, base = f"/api/rutinas/{rut['id']}", {"titulo": rut["titulo"], "dias": rut["dias"]}
    assert client.put(url, headers=h["profe1"], json={**base, "aumento_pct": 5}).json()["aumento_pct"] == 5
    # un cliente que no manda el campo no lo pisa
    assert client.put(url, headers=h["profe1"], json=base).json()["aumento_pct"] == 5
    assert client.put(url, headers=h["profe1"], json={**base, "aumento_pct": 101}).status_code == 422
    copia = client.post(f"{url}/duplicar", headers=h["profe1"], json={"alumno_id": ids["alu1"]}).json()
    assert copia["aumento_pct"] == 5
    assert client.put(url, headers=h["profe1"], json={**base, "aumento_pct": None}).json()["aumento_pct"] is None


def _publicada(client, gimnasio):
    """Rutina publicada para alu1; devuelve (rutina, headers, base del día 1, ids de sus dos ítems)."""
    h, ids, ej = gimnasio["h"], gimnasio["ids"], gimnasio["ejercicios"]
    rut = _rutina(client, h["profe1"], ids["alu1"], ej)
    client.post(f"/api/rutinas/{rut['id']}/estado", headers=h["profe1"], json={"estado": "publicada"})
    dia = rut["dias"][0]
    base = {"dia_id": dia["id"], "fecha": date.today().isoformat()}
    return rut, h, base, [i["id"] for i in dia["bloques"][0]["items"]]


def _hacer(client, h, base, item_id, **extra):
    r = client.put("/api/entrenamientos/item", headers=h, json={**base, "item_id": item_id, "hecho": True, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def test_registro_ejercicio_por_ejercicio(client, gimnasio):
    rut, h, base, (i1, i2) = _publicada(client, gimnasio)
    alu, alu_id = h["alu1"], gimnasio["ids"]["alu1"]
    # el primer ejercicio abre la sesión; el segundo se suma; corregir la carga no duplica
    assert len(_hacer(client, alu, base, i1)["items"]) == 1
    _hacer(client, alu, base, i2, carga="8")
    r = _hacer(client, alu, base, i2, carga="10 kg")
    assert {i["item_id"]: i["carga"] for i in r["items"]} == {i1: None, i2: "10 kg"}
    assert r["terminado_en"] is None
    assert client.get(f"/api/dias/{base['dia_id']}/entrenamiento", headers=alu).json()["id"] == r["id"]

    t = client.put("/api/entrenamientos/cierre", headers=alu, json={**base, "esfuerzo": 8, "nota": "Bien"}).json()
    assert t["esfuerzo"] == 8 and t["terminado_en"] and len(t["items"]) == 2  # terminar no borra los ejercicios
    hist = client.get(f"/api/alumnos/{alu_id}/entrenamientos", headers=h["profe1"]).json()
    assert len(hist) == 1 and hist[0]["hechos"] == 2
    cargas = client.get(f"/api/rutinas/{rut['id']}/ultimas-cargas", headers=alu).json()
    assert cargas[str(i2)]["carga"] == "10 kg"
    assert client.get(f"/api/alumnos/{alu_id}/entrenamientos", headers=h["profe2"]).status_code == 404


def test_la_rutina_se_repite_y_cada_vez_es_una_entrada(client, gimnasio):
    """3 días x 4 semanas: cada vez que se termina un día, una entrada nueva; la rutina sigue igual."""
    rut, h, base, (i1, i2) = _publicada(client, gimnasio)
    alu = h["alu1"]
    for semana in range(3):
        fecha = (date.today() - timedelta(days=7 * (3 - semana))).isoformat()
        _hacer(client, alu, {**base, "fecha": fecha}, i1)
        client.put("/api/entrenamientos/cierre", headers=alu, json={**base, "fecha": fecha})
        # terminado, el día vuelve a empezar de cero
        assert client.get(f"/api/dias/{base['dia_id']}/entrenamiento", headers=alu).json() is None
    _hacer(client, alu, base, i2)
    client.put("/api/entrenamientos/cierre", headers=alu, json=base)

    hist = client.get(f"/api/alumnos/{gimnasio['ids']['alu1']}/entrenamientos", headers=alu).json()
    assert len(hist) == 4 and all(e["terminado_en"] for e in hist)
    resumen = client.get(f"/api/rutinas/{rut['id']}/resumen-dias", headers=alu).json()
    assert resumen[str(base["dia_id"])] == {"veces": 4, "ultima": base["fecha"], "en_curso": None}
    # la rutina sigue publicada y entera
    mia = client.get("/api/mi-rutina", headers=alu).json()
    assert mia["id"] == rut["id"] and len(mia["dias"][0]["bloques"][0]["items"]) == 2


def test_dos_veces_el_mismo_dia_son_dos_entradas(client, gimnasio):
    rut, h, base, (i1, _) = _publicada(client, gimnasio)
    for _ in range(2):
        _hacer(client, h["alu1"], base, i1)
        client.put("/api/entrenamientos/cierre", headers=h["alu1"], json=base)
    hist = client.get(f"/api/alumnos/{gimnasio['ids']['alu1']}/entrenamientos", headers=h["alu1"]).json()
    assert len(hist) == 2 and hist[0]["fecha"] == hist[1]["fecha"]


def test_sesion_en_curso_en_el_resumen(client, gimnasio):
    rut, h, base, (i1, _) = _publicada(client, gimnasio)
    _hacer(client, h["alu1"], base, i1)
    resumen = client.get(f"/api/rutinas/{rut['id']}/resumen-dias", headers=h["alu1"]).json()
    assert resumen[str(base["dia_id"])] == {"veces": 0, "ultima": None, "en_curso": {"hechos": 1}}


def test_sesion_abandonada_se_cierra_sola(client, gimnasio):
    from app.db import conectar
    rut, h, base, (i1, i2) = _publicada(client, gimnasio)
    alu = h["alu1"]
    eid = _hacer(client, alu, base, i1)["id"]
    conn = conectar()
    conn.execute("UPDATE entrenamientos SET creado_en = '2000-01-01T10:00:00' WHERE id = ?", (eid,))
    conn.commit()
    conn.close()
    # al volver, el día empieza de cero y la sesión vieja queda en el historial como incompleta
    assert client.get(f"/api/dias/{base['dia_id']}/entrenamiento", headers=alu).json() is None
    assert _hacer(client, alu, base, i2)["id"] != eid
    hist = client.get(f"/api/alumnos/{gimnasio['ids']['alu1']}/entrenamientos", headers=alu).json()
    vieja = next(e for e in hist if e["id"] == eid)
    assert vieja["terminado_en"] and vieja["hechos"] == 1


def test_registro_invalido(client, gimnasio):
    rut, h, base, (i1, _) = _publicada(client, gimnasio)
    manana = (date.today() + timedelta(days=1)).isoformat()
    put = lambda hh, **b: client.put("/api/entrenamientos/item", headers=hh, json={**base, "item_id": i1, "hecho": True, **b})
    assert put(h["alu1"], fecha=manana).status_code == 422
    assert put(h["alu1"], item_id=99999).status_code == 422
    assert put(h["profe1"]).status_code == 403
    assert put(h["alu2"]).status_code == 404  # el alumno de otro profe no registra sobre esta rutina


def test_registrar_sobre_un_borrador_no(client, gimnasio):
    h, ids, ej = gimnasio["h"], gimnasio["ids"], gimnasio["ejercicios"]
    dia = _rutina(client, h["profe1"], ids["alu1"], ej)["dias"][0]
    r = client.put("/api/entrenamientos/item", headers=h["alu1"], json={
        "dia_id": dia["id"], "fecha": date.today().isoformat(), "item_id": dia["bloques"][0]["items"][0]["id"], "hecho": True})
    assert r.status_code == 404


def test_marcar_y_desmarcar_no_deja_entrenamiento_vacio(client, gimnasio):
    rut, h, base, (i1, _) = _publicada(client, gimnasio)
    _hacer(client, h["alu1"], base, i1)
    r = client.put("/api/entrenamientos/item", headers=h["alu1"], json={**base, "item_id": i1, "hecho": False})
    assert r.json() is None
    assert client.get(f"/api/alumnos/{gimnasio['ids']['alu1']}/entrenamientos", headers=h["alu1"]).json() == []


def test_alumno_no_archiva_elimina_ni_edita_sus_rutinas(client, gimnasio):
    rut, h, base, _ = _publicada(client, gimnasio)
    alu, rid = h["alu1"], rut["id"]
    for estado in ("archivada", "borrador", "publicada"):
        assert client.post(f"/api/rutinas/{rid}/estado", headers=alu, json={"estado": estado}).status_code == 403
    assert client.delete(f"/api/rutinas/{rid}", headers=alu).status_code == 403
    assert client.put(f"/api/rutinas/{rid}", headers=alu, json={"titulo": "x", "dias": []}).status_code == 403
    assert client.post(f"/api/rutinas/{rid}/duplicar", headers=alu, json={}).status_code == 403
    assert client.get("/api/mi-rutina", headers=alu).json()["estado"] == "publicada"


def test_historial_sobrevive_a_editar_la_rutina(client, gimnasio):
    rut, h, base, (_, i2) = _publicada(client, gimnasio)
    _hacer(client, h["alu1"], base, i2, carga="8 kg")
    client.put("/api/entrenamientos/cierre", headers=h["alu1"], json=base)
    rut["dias"][0]["bloques"][0]["items"] = []
    client.put(f"/api/rutinas/{rut['id']}", headers=h["profe1"], json={"titulo": rut["titulo"], "dias": rut["dias"]})
    hist = client.get(f"/api/alumnos/{gimnasio['ids']['alu1']}/entrenamientos", headers=h["alu1"]).json()
    assert hist[0]["items"][0]["ejercicio_nombre"] == "Sentadilla"
    assert hist[0]["items"][0]["item_id"] is None


def test_importar_planilla(client, gimnasio):
    h, ids = gimnasio["h"], gimnasio["ids"]
    with open(FIXTURES / "planilla_ejemplo.xlsx", "rb") as f:
        r = client.post("/api/importar/rutina", headers=h["profe1"],
                        data={"alumno_id": str(ids["alu1"])},
                        files={"archivo": ("19 oct 2026 Matias Arispe.xlsx", f)})
    assert r.status_code == 201, r.text
    res = r.json()
    assert res["avisos"] == []
    assert res["ejercicios_actualizados"] == 2 and res["ejercicios_nuevos"] == 236
    rut = res["rutina"]
    assert rut["titulo"] == "19 oct 2026 Matias Arispe" and rut["estado"] == "borrador"
    item = rut["dias"][0]["bloques"][0]["items"][0]
    assert item["ejercicio_numero"] == 2 and item["video_url"]
    # el ejercicio 1 lo había cargado el profe como "Plancha": la planilla manda
    assert client.get("/api/ejercicios?q=1", headers=h["profe1"]).json()[0]["nombre"] == "Empujo la pared"


def test_importar_archivo_invalido(client, gimnasio):
    r = client.post("/api/importar/rutina", headers=gimnasio["h"]["profe1"],
                    files={"archivo": ("x.xlsx", b"no soy un excel")})
    assert r.status_code == 422


def test_reset_de_clave_cierra_sesiones(client, gimnasio):
    h, ids = gimnasio["h"], gimnasio["ids"]
    r = client.post(f"/api/usuarios/{ids['alu1']}/resetear-clave", headers=h["profe1"])
    nueva = r.json()["password_temporal"]
    assert client.get("/api/auth/me", headers=h["alu1"]).status_code == 401
    login(client, "alu1", nueva)
    assert client.post(f"/api/usuarios/{ids['alu2']}/resetear-clave", headers=h["profe1"]).status_code == 404


def test_profe_no_gestiona_profes(client, gimnasio):
    h = gimnasio["h"]
    assert client.post("/api/profesores", headers=h["profe1"],
                       json={"nombre": "X", "usuario": "x", "password": "123456"}).status_code == 403


_JPG = b"\xff\xd8\xff\xe0" + b"0" * 100


def test_miniatura_propia_reemplaza_la_automatica(client, gimnasio, tmp_path):
    h, ids, ej = gimnasio["h"], gimnasio["ids"], gimnasio["ejercicios"]
    eid = ej[0]
    url = f"/api/ejercicios/{eid}/miniatura"
    sube = lambda datos, quien="profe1": client.post(url, headers=h[quien], files={"archivo": ("m.jpg", datos, "image/jpeg")})
    assert sube(_JPG, "alu1").status_code == 403
    assert sube(b"<html>no soy una imagen</html>").status_code == 422
    primera = sube(_JPG).json()["miniatura"]
    assert client.get(f"/api/ejercicios/miniaturas/{primera}").content == _JPG  # sin login: la pide un <img>
    # la rutina la trae junto al ejercicio
    rut = _rutina(client, h["profe1"], ids["alu1"], ej)
    assert rut["dias"][0]["bloques"][0]["items"][0]["ejercicio_miniatura"] == primera
    # cambiarla borra el archivo anterior; quitarla vuelve a la automática
    segunda = sube(_JPG).json()["miniatura"]
    assert segunda != primera and not (tmp_path / "miniaturas" / primera).exists()
    assert client.delete(url, headers=h["profe1"]).json()["miniatura"] is None
    assert client.get(f"/api/ejercicios/miniaturas/{segunda}").status_code == 404
    assert client.get("/api/ejercicios/miniaturas/..%2Ftest.db").status_code == 404


def test_tutoriales_vistos_se_guardan_por_usuario(client, gimnasio):
    h = gimnasio["h"]
    assert client.get("/api/auth/tutoriales", headers=h["alu1"]).json() == []
    client.post("/api/auth/tutoriales/mi-rutina", headers=h["alu1"])
    client.post("/api/auth/tutoriales/mi-rutina", headers=h["alu1"])  # repetirlo no duplica
    assert client.post("/api/auth/tutoriales/entrenar", headers=h["alu1"]).json() == ["mi-rutina", "entrenar"]
    assert client.get("/api/auth/tutoriales", headers=h["alu2"]).json() == []  # cada uno los suyos
    assert client.post("/api/auth/tutoriales/<script>", headers=h["alu1"]).status_code in (404, 422)
