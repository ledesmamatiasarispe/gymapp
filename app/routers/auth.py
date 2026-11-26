import json
import sqlite3

from fastapi import APIRouter, Depends, Header, HTTPException, Path
from pydantic import BaseModel

from .. import security
from ..db import get_db
from ..deps import usuario_actual

router = APIRouter(prefix="/api/auth", tags=["auth"])


class Login(BaseModel):
    usuario: str
    password: str


class CambioClave(BaseModel):
    actual: str
    nueva: str


@router.post("/login")
def login(body: Login, conn: sqlite3.Connection = Depends(get_db)):
    u = conn.execute(
        "SELECT * FROM usuarios WHERE usuario = ? AND activo = 1", (body.usuario.strip(),)
    ).fetchone()
    if not u or not security.verificar(body.password, u["salt"], u["password_hash"]):
        raise HTTPException(401, "Usuario o contraseña incorrectos")
    token = security.crear_sesion(conn, u["id"])
    return {"token": token, "user": {k: u[k] for k in ("id", "rol", "nombre", "usuario", "profesor_id")}}


@router.post("/logout")
def logout(authorization: str | None = Header(None), conn: sqlite3.Connection = Depends(get_db),
           user: dict = Depends(usuario_actual)):
    token = (authorization or "").split(" ", 1)[-1].strip()
    conn.execute("UPDATE sesiones SET activa = 0 WHERE token = ?", (token,))
    conn.commit()
    return {"ok": True}


@router.get("/me")
def me(user: dict = Depends(usuario_actual)):
    return user


def _tutoriales_vistos(conn: sqlite3.Connection, usuario_id: int) -> list[str]:
    fila = conn.execute("SELECT tutoriales_vistos FROM usuarios WHERE id = ?", (usuario_id,)).fetchone()
    return json.loads(fila[0]) if fila and fila[0] else []


@router.get("/tutoriales")
def tutoriales(conn: sqlite3.Connection = Depends(get_db), user: dict = Depends(usuario_actual)):
    """Pantallas cuyo tutorial ya se le mostró: el tutorial arranca solo nada más la primera vez."""
    return _tutoriales_vistos(conn, user["id"])


@router.post("/tutoriales/{clave}")
def tutorial_visto(clave: str = Path(pattern=r"^[a-z][a-z-]{0,39}$"),
                   conn: sqlite3.Connection = Depends(get_db), user: dict = Depends(usuario_actual)):
    vistos = _tutoriales_vistos(conn, user["id"])
    if clave not in vistos:
        vistos.append(clave)
        conn.execute("UPDATE usuarios SET tutoriales_vistos = ? WHERE id = ?", (json.dumps(vistos), user["id"]))
        conn.commit()
    return vistos


@router.post("/cambiar-clave")
def cambiar_clave(body: CambioClave, authorization: str | None = Header(None),
                  conn: sqlite3.Connection = Depends(get_db), user: dict = Depends(usuario_actual)):
    u = conn.execute("SELECT * FROM usuarios WHERE id = ?", (user["id"],)).fetchone()
    if not security.verificar(body.actual, u["salt"], u["password_hash"]):
        raise HTTPException(400, "La contraseña actual no es correcta")
    if len(body.nueva) < 6:
        raise HTTPException(422, "La contraseña nueva necesita al menos 6 caracteres")
    h, salt = security.hashear(body.nueva)
    token = (authorization or "").split(" ", 1)[-1].strip()
    conn.execute("UPDATE usuarios SET password_hash = ?, salt = ? WHERE id = ?", (h, salt, user["id"]))
    # Cierra las demás sesiones (otro celular, una PC prestada) pero no esta.
    conn.execute("UPDATE sesiones SET activa = 0 WHERE usuario_id = ? AND token != ?", (user["id"], token))
    conn.commit()
    return {"ok": True}
