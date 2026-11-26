"""Crea (o resetea) el usuario administrador.

    .venv\\Scripts\\python -m scripts.crear_admin <usuario> "<Nombre>" <contraseña>
"""
import sys

from app import security
from app.db import ahora, conectar, init_db


def main(usuario: str, nombre: str, password: str) -> None:
    init_db()
    h, salt = security.hashear(password)
    conn = conectar()
    try:
        fila = conn.execute("SELECT id FROM usuarios WHERE usuario = ?", (usuario,)).fetchone()
        if fila:
            conn.execute("UPDATE usuarios SET rol='admin', nombre=?, password_hash=?, salt=?, activo=1 WHERE id=?",
                         (nombre, h, salt, fila["id"]))
            print(f"Admin «{usuario}» actualizado.")
        else:
            conn.execute(
                "INSERT INTO usuarios (rol, nombre, usuario, password_hash, salt, creado_en) VALUES ('admin',?,?,?,?,?)",
                (nombre, usuario, h, salt, ahora()))
            print(f"Admin «{usuario}» creado.")
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    main(*sys.argv[1:])
