"""Gimnasio — rutinas de profes para alumnos. FastAPI + SQLite + frontend estático."""
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .db import init_db
from .routers import auth, ejercicios, entrenamientos, importar, rutinas, usuarios


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Gimnasio", lifespan=lifespan)
for r in (auth, usuarios, ejercicios, rutinas, entrenamientos, importar):
    app.include_router(r.router)


@app.middleware("http")
async def sin_cache_estatico(request: Request, call_next):
    # El navegador revalida JS/CSS en cada carga (304 si no cambió): después de
    # actualizar la app, ningún celular se queda con una versión vieja.
    resp = await call_next(request)
    if request.url.path.startswith(("/js/", "/css/")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/api/salud")
def salud():
    return {"ok": True}


app.mount("/css", StaticFiles(directory=config.FRONTEND / "css"), name="css")
app.mount("/js", StaticFiles(directory=config.FRONTEND / "js"), name="js")


@app.get("/manifest.webmanifest", include_in_schema=False)
def manifest():
    return FileResponse(config.FRONTEND / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/icono.svg", include_in_schema=False)
def icono():
    return FileResponse(config.FRONTEND / "icono.svg", media_type="image/svg+xml")


@app.get("/", include_in_schema=False)
def index():
    # Sin cache: después de actualizar, el celular del alumno tiene que traer la versión nueva.
    return FileResponse(config.FRONTEND / "index.html", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=config.PORT)
