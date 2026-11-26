"""Una base creada antes de las sesiones (UNIQUE por día+fecha, sin terminado_en) se migra sin perder nada."""
import sqlite3

from app import config
from app.db import init_db

_VIEJO = """
CREATE TABLE usuarios (id INTEGER PRIMARY KEY, rol TEXT, nombre TEXT, usuario TEXT, password_hash TEXT,
                       salt TEXT, profesor_id INTEGER, email TEXT, telefono TEXT, notas TEXT,
                       activo INTEGER DEFAULT 1, creado_en TEXT);
CREATE TABLE rutinas (id INTEGER PRIMARY KEY, alumno_id INTEGER, profesor_id INTEGER NOT NULL, titulo TEXT NOT NULL,
                      notas TEXT, fecha_inicio TEXT, estado TEXT NOT NULL DEFAULT 'borrador',
                      creado_en TEXT NOT NULL, modificado_en TEXT NOT NULL);
CREATE TABLE entrenamientos (
    id INTEGER PRIMARY KEY, alumno_id INTEGER NOT NULL REFERENCES usuarios(id),
    rutina_id INTEGER, dia_id INTEGER, dia_nombre TEXT NOT NULL, fecha TEXT NOT NULL,
    esfuerzo INTEGER, nota TEXT, creado_en TEXT NOT NULL, UNIQUE (alumno_id, dia_id, fecha));
CREATE TABLE entrenamiento_items (
    id INTEGER PRIMARY KEY,
    entrenamiento_id INTEGER NOT NULL REFERENCES entrenamientos(id) ON DELETE CASCADE,
    item_id INTEGER, ejercicio_nombre TEXT NOT NULL, hecho INTEGER NOT NULL DEFAULT 0,
    carga TEXT, nota TEXT, UNIQUE (entrenamiento_id, item_id));
INSERT INTO usuarios (id, rol, nombre, usuario, password_hash, salt, creado_en)
    VALUES (1, 'alumno', 'A', 'a', 'x', 'x', '2026-01-01');
INSERT INTO entrenamientos VALUES (1, 1, NULL, NULL, 'Dia 1', '2026-10-20', 7, 'bien', '2026-10-20T10:00:00');
INSERT INTO entrenamiento_items VALUES (1, 1, NULL, 'Plancha', 1, '8 kg', NULL);
"""


def test_migra_entrenamientos_viejos(tmp_path, monkeypatch):
    db = tmp_path / "vieja.db"
    monkeypatch.setattr(config, "DB_PATH", db)
    conn = sqlite3.connect(db)
    conn.executescript(_VIEJO)
    conn.close()

    init_db()
    init_db()  # idempotente

    conn = sqlite3.connect(db)
    e = conn.execute("SELECT esfuerzo, nota, terminado_en FROM entrenamientos WHERE id = 1").fetchone()
    assert e == (7, "bien", "2026-10-20T10:00:00")  # lo que ya existía queda terminado
    assert conn.execute("SELECT carga FROM entrenamiento_items WHERE entrenamiento_id = 1").fetchone() == ("8 kg",)
    # la FK de los ítems sigue apuntando a "entrenamientos", no a una tabla borrada
    assert {f[2] for f in conn.execute("PRAGMA foreign_key_list(entrenamiento_items)")} == {"entrenamientos"}
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    # ya no hay UNIQUE por día+fecha: dos sesiones terminadas el mismo día conviven
    conn.execute("INSERT INTO entrenamientos (alumno_id, dia_nombre, fecha, creado_en, terminado_en) "
                 "VALUES (1, 'Dia 1', '2026-10-20', 'x', 'y')")
    # y las rutinas ganan el aumento sugerido de carga
    assert "aumento_pct" in {c[1] for c in conn.execute("PRAGMA table_info(rutinas)")}
    conn.close()
