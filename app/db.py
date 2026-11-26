"""SQLite: conexión y esquema.

Una conexión por request (``get_db``), con WAL para que el profe pueda editar
mientras varios alumnos leen, y ``foreign_keys`` activado — SQLite lo trae
apagado por defecto y sin él los ``ON DELETE`` del esquema no hacen nada.
"""
import sqlite3
from contextlib import contextmanager
from datetime import datetime

from . import config

# Una sesión de entrenamiento: cada vez que el alumno hace un día de la rutina.
# La rutina se repite (3 días x 4 semanas = 12 sesiones), así que la sesión no se
# identifica por día+fecha: está abierta mientras se entrena y "Terminar" la cierra
# (terminado_en). Hay a lo sumo una abierta por alumno y día de rutina (índice
# parcial ux_entrenamiento_abierto). dia_id va con SET NULL y se guarda una copia
# del nombre: si el profe cambia la rutina, el historial del alumno no se pierde.
# Separada del resto del esquema porque la migración la crea con otro nombre.
DDL_ENTRENAMIENTOS = """CREATE TABLE IF NOT EXISTS {nombre} (
    id           INTEGER PRIMARY KEY,
    alumno_id    INTEGER NOT NULL REFERENCES usuarios(id),
    rutina_id    INTEGER REFERENCES rutinas(id) ON DELETE SET NULL,
    dia_id       INTEGER REFERENCES rutina_dias(id) ON DELETE SET NULL,
    dia_nombre   TEXT NOT NULL,
    fecha        TEXT NOT NULL,
    esfuerzo     INTEGER CHECK (esfuerzo BETWEEN 1 AND 10),
    nota         TEXT,
    creado_en    TEXT NOT NULL,
    terminado_en TEXT
)"""

SCHEMA = """
CREATE TABLE IF NOT EXISTS usuarios (
    id            INTEGER PRIMARY KEY,
    rol           TEXT NOT NULL CHECK (rol IN ('admin', 'profesor', 'alumno')),
    nombre        TEXT NOT NULL,
    usuario       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    -- solo para alumnos: el profe que lo tiene a cargo
    profesor_id   INTEGER REFERENCES usuarios(id),
    email         TEXT,
    telefono      TEXT,
    notas         TEXT,
    activo        INTEGER NOT NULL DEFAULT 1,
    creado_en     TEXT NOT NULL,
    -- pantallas cuyo tutorial ya se le mostró (JSON). En el servidor y no en el
    -- navegador: así sale una sola vez aunque entre desde otro celular o la PC.
    tutoriales_vistos TEXT
);

CREATE TABLE IF NOT EXISTS sesiones (
    token       TEXT PRIMARY KEY,
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    creado_en   TEXT NOT NULL,
    expira_en   TEXT NOT NULL,
    activa      INTEGER NOT NULL DEFAULT 1
);

-- Catálogo compartido por todo el gimnasio. `numero` es el código con el que
-- el profe arma la planilla (la columna A de "Entrenamiento" es este número).
CREATE TABLE IF NOT EXISTS ejercicios (
    id          INTEGER PRIMARY KEY,
    numero      INTEGER UNIQUE,
    nombre      TEXT NOT NULL,
    grupo       TEXT,
    video_url   TEXT,
    descripcion TEXT,
    activo      INTEGER NOT NULL DEFAULT 1,
    -- imagen propia que eligió el profe (archivo en data/miniaturas). NULL = la que
    -- genera YouTube/Drive para el video, que el frontend arma a partir de video_url.
    miniatura   TEXT
);

-- alumno_id NULL = plantilla del profe (se asigna copiándola a un alumno).
CREATE TABLE IF NOT EXISTS rutinas (
    id           INTEGER PRIMARY KEY,
    alumno_id    INTEGER REFERENCES usuarios(id),
    profesor_id  INTEGER NOT NULL REFERENCES usuarios(id),
    titulo       TEXT NOT NULL,
    notas        TEXT,
    fecha_inicio TEXT,
    aumento_pct  REAL CHECK (aumento_pct BETWEEN 0 AND 100),
    estado       TEXT NOT NULL DEFAULT 'borrador'
                 CHECK (estado IN ('borrador', 'publicada', 'archivada')),
    creado_en    TEXT NOT NULL,
    modificado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rutina_dias (
    id        INTEGER PRIMARY KEY,
    rutina_id INTEGER NOT NULL REFERENCES rutinas(id) ON DELETE CASCADE,
    orden     INTEGER NOT NULL,
    nombre    TEXT NOT NULL,
    color     TEXT
);

-- Bloque = "Entrada en calor", "Trabajo del día", "Elongación".
-- prescripcion/comentario a nivel bloque cubren el caso de la Elongación de la
-- planilla, que es "10´" + un comentario sin ningún ejercicio.
CREATE TABLE IF NOT EXISTS rutina_bloques (
    id           INTEGER PRIMARY KEY,
    dia_id       INTEGER NOT NULL REFERENCES rutina_dias(id) ON DELETE CASCADE,
    orden        INTEGER NOT NULL,
    nombre       TEXT NOT NULL,
    detalle      TEXT,
    prescripcion TEXT,
    comentario   TEXT
);

-- superserie: ítems consecutivos del mismo bloque con el mismo número se hacen
-- seguidos y cuentan como una serie. NULL = ejercicio suelto.
CREATE TABLE IF NOT EXISTS rutina_items (
    id           INTEGER PRIMARY KEY,
    bloque_id    INTEGER NOT NULL REFERENCES rutina_bloques(id) ON DELETE CASCADE,
    orden        INTEGER NOT NULL,
    ejercicio_id INTEGER REFERENCES ejercicios(id),
    nombre_libre TEXT,
    prescripcion TEXT,
    comentario   TEXT,
    superserie   INTEGER
);

{entrenamientos}

CREATE TABLE IF NOT EXISTS entrenamiento_items (
    id               INTEGER PRIMARY KEY,
    entrenamiento_id INTEGER NOT NULL REFERENCES entrenamientos(id) ON DELETE CASCADE,
    item_id          INTEGER REFERENCES rutina_items(id) ON DELETE SET NULL,
    ejercicio_nombre TEXT NOT NULL,
    hecho            INTEGER NOT NULL DEFAULT 0,
    carga            TEXT,
    nota             TEXT,
    UNIQUE (entrenamiento_id, item_id)
);

CREATE INDEX IF NOT EXISTS ix_rutinas_alumno ON rutinas(alumno_id);
CREATE INDEX IF NOT EXISTS ix_dias_rutina ON rutina_dias(rutina_id);
CREATE INDEX IF NOT EXISTS ix_bloques_dia ON rutina_bloques(dia_id);
CREATE INDEX IF NOT EXISTS ix_items_bloque ON rutina_items(bloque_id);
"""

# Van después de las migraciones: necesitan columnas que una base vieja todavía no tiene.
INDICES = """
CREATE INDEX IF NOT EXISTS ix_entrenamientos_alumno ON entrenamientos(alumno_id, fecha);
CREATE UNIQUE INDEX IF NOT EXISTS ux_entrenamiento_abierto
    ON entrenamientos(alumno_id, dia_id) WHERE terminado_en IS NULL;
"""


def _migrar_entrenamientos_a_sesiones(conn: sqlite3.Connection) -> None:
    """Bases creadas antes de las sesiones: tenían UNIQUE(alumno_id, dia_id, fecha) y
    no tenían terminado_en. SQLite no puede borrar una constraint, así que se
    reconstruye la tabla con el procedimiento que recomienda SQLite: crear la nueva
    con otro nombre, copiar, borrar la vieja y renombrar la nueva. (Renombrar la
    vieja primero no sirve: SQLite reescribe la FK de entrenamiento_items para que
    siga a la tabla renombrada, y al borrarla quedaría colgada.)

    Los entrenamientos que ya existían quedan terminados. foreign_keys se apaga
    durante la copia: con él prendido, el DROP de la vieja borraría en cascada
    todos los entrenamiento_items."""
    columnas = {r[1] for r in conn.execute("PRAGMA table_info(entrenamientos)")}
    if "terminado_en" in columnas:
        return
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.execute("BEGIN")
        conn.execute(DDL_ENTRENAMIENTOS.format(nombre="entrenamientos_nueva"))
        conn.execute(
            """INSERT INTO entrenamientos_nueva (id, alumno_id, rutina_id, dia_id, dia_nombre, fecha,
                                                 esfuerzo, nota, creado_en, terminado_en)
               SELECT id, alumno_id, rutina_id, dia_id, dia_nombre, fecha, esfuerzo, nota, creado_en, creado_en
               FROM entrenamientos""")
        conn.execute("DROP TABLE entrenamientos")
        conn.execute("ALTER TABLE entrenamientos_nueva RENAME TO entrenamientos")
        if conn.execute("PRAGMA foreign_key_check").fetchone():
            raise RuntimeError("La migración de entrenamientos dejó referencias rotas")
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


# Columnas agregadas después de la primera versión: (tabla, columna, definición).
_COLUMNAS_NUEVAS = (
    ("rutinas", "aumento_pct", "REAL CHECK (aumento_pct BETWEEN 0 AND 100)"),
    ("ejercicios", "miniatura", "TEXT"),
    ("usuarios", "tutoriales_vistos", "TEXT"),
)


def _agregar_columnas_nuevas(conn: sqlite3.Connection) -> None:
    """Bases creadas antes de que existieran esas columnas."""
    for tabla, columna, definicion in _COLUMNAS_NUEVAS:
        if columna not in {r[1] for r in conn.execute(f"PRAGMA table_info({tabla})")}:
            conn.execute(f"ALTER TABLE {tabla} ADD COLUMN {columna} {definicion}")


def ahora() -> str:
    return datetime.now().isoformat(timespec="seconds")


def conectar() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db() -> None:
    conn = conectar()
    try:
        conn.executescript(SCHEMA.replace("{entrenamientos}", DDL_ENTRENAMIENTOS.format(nombre="entrenamientos") + ";"))
        _migrar_entrenamientos_a_sesiones(conn)
        _agregar_columnas_nuevas(conn)
        conn.executescript(INDICES)
        conn.commit()
    finally:
        conn.close()


def get_db():
    """Dependencia de FastAPI: una conexión por request."""
    conn = conectar()
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def transaccion(conn: sqlite3.Connection):
    """Commit si el bloque termina bien, rollback si lanza."""
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
