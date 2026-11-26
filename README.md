# Rutinas — gimnasio

Los profes arman rutinas y los alumnos las ven en el celular, con el video de cada ejercicio, y registran lo que hicieron. Mismo stack que GNC API (FastAPI + SQLite + HTML/JS vanilla), pero repartido en módulos.

## Arrancar

```
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m scripts.crear_admin admin "Administrador" <contraseña>
iniciar.bat                      # http://localhost:8100
```

Variables opcionales: `GIMNASIO_PORT` (8100), `GIMNASIO_DB` (`data/gimnasio.db`), `GIMNASIO_SESSION_HOURS` (720).

Tests: `.venv\Scripts\python -m pytest`

## Roles

| Rol | Puede |
|---|---|
| **admin** | todo + alta/baja de profesores |
| **profesor** | sus alumnos (alta, reset de clave), sus rutinas, catálogo de ejercicios, plantillas (ve las de todos y edita solo las suyas) |
| **alumno** | su rutina publicada, registrar entrenamientos, su historial |

Las reglas están todas en `app/deps.py`.

## Modelo

```
Ejercicio (catálogo: número, nombre, grupo, video)
Rutina (alumno o plantilla; borrador → publicada → archivada)
  └ Día (nombre, color)
     └ Bloque (Entrada en calor / Trabajo del día / Elongación; detalle, tiempo, indicación)
        └ Ítem (ejercicio o texto libre, prescripción, comentario, superserie)
Entrenamiento (alumno + día + fecha, esfuerzo 1-10, nota)
  └ ítems hechos con la carga real
```

- **Prescripción** de cada ítem (`app/services/prescripcion.py`), con tres modalidades:
  - *Series × repeticiones*: `series`, `reps` y opcionalmente `reps_max` para un rango (3 × 8–12).
  - *Series × tiempo*: `series` y `segundos` (planchas, isométricos: 3 × 15 seg).
  - *Texto libre*: lo que no encaja (al fallo, pirámide 12-10-8, AMRAP).

  `por_lado` marca los unilaterales (c/lado). `prescripcion` guarda el texto que ve el alumno, armado a partir de los campos. El importador traduce la notación de la planilla (`3x10`, `3x15´´`, `2x10 c/lado`, `1´30´´`), y las rutinas guardadas antes como texto se convierten solas al arrancar.
- **Publicar** una rutina archiva la que el alumno tenía publicada: tiene una sola vigente a la vez.
- **Peso indicado** (`rutina_items.peso_kg`, opcional): el profe lo pone en el editor y el alumno lo ve junto a la prescripción.
- **Registro**: la ventanita arranca con lo indicado (prescripción y peso), así si lo hizo tal cual solo toca Registrar; si no, lo cambia. El peso real queda en `entrenamiento_items.peso_kg`. El alumno anota cuánto hizo y cómo se sintió (1 a 10, como el esfuerzo del cierre; `entrenamiento_items.esfuerzo`). La app no le sugiere ninguna carga; lo de la última vez aparece solo como referencia. (La columna `rutinas.aumento_pct` quedó de una versión anterior y la interfaz ya no la usa.)
- **Entrenar**: en la PC (mouse) cada ejercicio tiene un botón verde **▶ Comenzar**; en el celular, deslizar a la derecha hace lo mismo (y sobre uno ya registrado, abre el registro para corregirlo). Comenzar abre la ficha con un cronómetro arriba (en los de tiempo muestra también el objetivo por serie) y desde ahí se registra. El video arranca solo dentro de la ficha (primero el archivo directo de Drive y, si Drive no lo entrega, su visor embebido). Los videos de Drive tienen que estar compartidos con «cualquier persona con el enlace» para verse dentro de la app, sobre todo en el celular.
- **Superserie**: ítems consecutivos del bloque con el mismo número. En el editor es el botón ⛓ ("unir con el anterior").
- Al editar una rutina se **preservan los ids** de lo que no cambió, y el historial guarda una copia del nombre del ejercicio: editar o borrar ítems no rompe lo que el alumno ya registró.

## Tutoriales guiados

Cada pantalla tiene un recorrido paso a paso, con el mismo motor que GNC API: oscurece todo salvo el control que explica. Arranca **solo la primera vez** que cada persona entra a esa pantalla, y después se abre con el botón **Ayuda** del encabezado. Qué tutoriales vio cada uno se guarda en el servidor (`usuarios.tutoriales_vistos`) y no en el navegador, así no vuelve a salir al entrar desde otro celular o por otra dirección.

**Para agregar una pantalla nueva:**
1. Al final de su función de vista, llamar a `ofrecerTour('clave')`.
2. Definir los pasos en `TOURS['clave']` (sección 7 de `frontend/js/app.js`), con la forma `{sel | buscar, titulo, texto}`.

Un paso sin `sel` es de presentación: el globo sale centrado. Un paso cuyo elemento no está en pantalla, por ejemplo sin superseries ese día, se saltea solo.

## Importar planillas de Google Sheets

En Sheets: **Archivo → Descargar → Microsoft Excel (.xlsx)**, y después en la app usar *Importar planilla* (en el alumno o en Plantillas). Se lee:

- Hoja **Datos** → catálogo. Grupo en A (se arrastra hacia abajo), número en B, nombre en D, y el **hipervínculo** de D es el video.
- Hoja **Entrenamiento** → rutina. Las notas van antes de «Dia 1». Cada «Dia N» abre un día, y su relleno es el color del día. Una fila con texto en A abre un bloque, y una con número en A es un ejercicio. **Las filas sombreadas con un color distinto al del día son superseries.**

La rutina queda en **borrador** para revisarla antes de publicarla. Ver `app/services/importador.py`; el test usa una planilla real (`tests/fixtures/planilla_ejemplo.xlsx`).

Los videos de Drive se ven dentro de la app (`/preview`), así que tienen que estar compartidos como "cualquier persona con el enlace". YouTube también se embebe.

## Miniaturas de los ejercicios

Por defecto se usa la que generan Drive o YouTube para el video. La de Drive tiene el mismo requisito que el video: si el archivo no está compartido, se ve el número del ejercicio. En **Ejercicios**, tocando la miniatura, el profe puede:

- **sacar un cuadro de un video** que tenga en la PC o el celular, eligiendo el momento con una barra;
- **subir una imagen**;
- **volver a la automática**.

Del video de Drive o YouTube no se puede sacar un cuadro: el navegador no deja leer imágenes de otro sitio. Por eso el cuadro sale de un archivo. Las imágenes se achican en el navegador (480 px de ancho, JPG) y se guardan en `data/miniaturas/`.

## Publicar con túnel (pendiente)

La app escucha en `0.0.0.0:8100`. Para que los alumnos entren desde afuera, la idea es usar el mismo `cloudflared` que GNC, con un hostname nuevo apuntando a `http://localhost:8100`. El túnel da HTTPS, que hace falta para "copiar mensaje" y para instalarla como app en el celular.
