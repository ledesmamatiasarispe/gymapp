from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import config
from scripts.crear_admin import main as crear_admin

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    from app.main import app
    crear_admin("admin", "Admin", "admin123")
    with TestClient(app) as c:
        yield c


def login(client, usuario, password) -> dict:
    r = client.post("/api/auth/login", json={"usuario": usuario, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture
def admin(client):
    return login(client, "admin", "admin123")


@pytest.fixture
def gimnasio(client, admin):
    """Dos profes, cada uno con un alumno, y un catálogo mínimo."""
    h = {}
    for p in ("profe1", "profe2"):
        r = client.post("/api/profesores", headers=admin, json={"nombre": p.title(), "usuario": p, "password": "clave123"})
        assert r.status_code == 201, r.text
        h[p] = login(client, p, "clave123")
    ids = {}
    for p, a in (("profe1", "alu1"), ("profe2", "alu2")):
        r = client.post("/api/alumnos", headers=h[p], json={"nombre": a.title(), "usuario": a, "password": "clave123"})
        assert r.status_code == 201, r.text
        ids[a] = r.json()["id"]
        h[a] = login(client, a, "clave123")
    ej = []
    for n, nombre in ((1, "Plancha"), (2, "Sentadilla")):
        r = client.post("/api/ejercicios", headers=h["profe1"], json={"numero": n, "nombre": nombre})
        ej.append(r.json()["id"])
    return {"h": h, "ids": ids, "ejercicios": ej}
