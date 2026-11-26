'use strict';
/* Rutinas — frontend vanilla. Router por hash, una función por vista.
 *
 * Secciones:
 *   1. Núcleo: estado, api(), modal, toasts, utilidades
 *   2. Router y navegación por rol
 *   3. Rutina (render compartido por alumno y profe) + videos
 *   4. Vistas del alumno: mi rutina, entrenar, historial
 *   5. Vistas del profe: alumnos, alumno, rutina, plantillas, ejercicios, profesores
 *   6. Editor de rutinas
 */

// ══ 1. Núcleo ═══════════════════════════════════════════════════════════════

const S = {
  token: leerLS('token'),
  user: JSON.parse(leerLS('user') || 'null'),
  catalogo: null,   // cache de /api/ejercicios para el editor
  sucio: false,     // el editor tiene cambios sin guardar
  tutoriales: null, // Promise<Set> de tutoriales ya vistos (ver tutorialesVistos)
};

function leerLS(k) { try { return localStorage.getItem(k); } catch { return null; } }
function grabarLS(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* modo privado */ } }

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const main = () => $('#main');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(method, path, body, { form, keepalive = false } = {}) {
  const opts = { method, headers: {}, keepalive };
  if (S.token) opts.headers.Authorization = `Bearer ${S.token}`;
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  if (r.status === 401 && path !== '/api/auth/login') { cerrarSesionLocal(); throw new Error('Sesión vencida'); }
  const datos = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) {
    let msg = datos?.detail ?? `Error ${r.status}`;
    if (Array.isArray(msg)) msg = msg.map(e => e.msg).join('; ');
    throw new Error(msg);
  }
  return datos;
}

function toast(msg, error = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' error' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), error ? 5000 : 2600);
}

/** Corre una acción async mostrando el error como toast. */
async function intentar(fn) {
  try { return await fn(); } catch (e) { toast(e.message, true); }
}

function modal(html, { ancho = false, enfocar = true } = {}) {
  const m = $('#modal');
  m.className = ancho ? 'ancho' : '';
  m.innerHTML = html;
  $('#modal-fondo').hidden = false;
  if (enfocar) setTimeout(() => $('input:not([type=hidden]), select, textarea', m)?.focus(), 30);
  return m;
}
function cerrarModal() { $('#modal-fondo').hidden = true; $('#modal').innerHTML = ''; }
$('#modal-fondo').addEventListener('click', e => { if (e.target.id === 'modal-fondo') cerrarModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal-fondo').hidden) cerrarModal(); });

function confirmar(msg, { si = 'Confirmar', peligro = false } = {}) {
  return new Promise(res => {
    const m = modal(`<h3>${esc(msg)}</h3><div class="pie">
      <button class="btn-ghost" data-r="0">Cancelar</button>
      <button class="${peligro ? 'btn-peligro' : 'btn btn-primario'}" data-r="1">${esc(si)}</button></div>`);
    m.addEventListener('click', e => {
      const b = e.target.closest('[data-r]');
      if (b) { cerrarModal(); res(b.dataset.r === '1'); }
    });
  });
}

/** Modal con formulario; resuelve con los valores o null si se cancela. */
function formulario(titulo, camposHtml, { boton = 'Guardar', alEnviar } = {}) {
  return new Promise(res => {
    const m = modal(`<h3>${esc(titulo)}</h3><form>${camposHtml}
      <div class="error" hidden></div>
      <div class="pie"><button type="button" class="btn-ghost" data-cancelar>Cancelar</button>
      <button class="btn btn-primario">${esc(boton)}</button></div></form>`);
    const f = $('form', m);
    $('[data-cancelar]', m).onclick = () => { cerrarModal(); res(null); };
    f.onsubmit = async e => {
      e.preventDefault();
      const datos = Object.fromEntries(new FormData(f));
      if (!alEnviar) { cerrarModal(); return res(datos); }
      const btn = $('button:not([type=button])', f);
      btn.disabled = true;
      try { const r = await alEnviar(datos, f); cerrarModal(); res(r); }
      catch (err) { const el = $('.error', f); el.textContent = err.message; el.hidden = false; }
      finally { btn.disabled = false; }
    };
  });
}

function campo(etiqueta, nombre, { tipo = 'text', valor = '', extra = '' } = {}) {
  if (tipo === 'textarea') return `<label class="campo">${esc(etiqueta)}<textarea name="${nombre}" ${extra}>${esc(valor)}</textarea></label>`;
  return `<label class="campo">${esc(etiqueta)}<input type="${tipo}" name="${nombre}" value="${esc(valor)}" ${extra}></label>`;
}

const pad = n => String(n).padStart(2, '0');
function hoyISO() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fecha(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const f = new Date(y, m - 1, d);
  return `${['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][f.getDay()]} ${pad(d)}/${pad(m)}/${String(y).slice(2)}`;
}
function hace(iso) {
  if (!iso) return 'nunca';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const dias = Math.round((hoy - new Date(y, m - 1, d)) / 86400000);
  return dias <= 0 ? 'hoy' : dias === 1 ? 'ayer' : `hace ${dias} días`;
}
const normalizar = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); toast('Copiado'); }
  catch { toast('No se pudo copiar; seleccioná el texto a mano', true); }
}

const ICON = {
  rutina: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 5v14M18 5v14M3 8v8M21 8v8M6 12h12"/></svg>',
  historial: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  alumnos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M17 11a3 3 0 1 0 0-6M22 21c0-3-2-5-5-5.5"/></svg>',
  plantillas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  ejercicios: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  profesores: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="7" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7M12 14v4"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8z"/></svg>',
};

// ══ 1b. Recorridos guiados ══════════════════════════════════════════════════
// Mismo motor que GNC API: un overlay que oscurece todo salvo el elemento del
// paso, y un globo con Saltar / Atrás / Siguiente. Cada pantalla define sus
// pasos en TOURS (sección 7) como {sel | buscar, titulo, texto}; un paso sin
// sel ni buscar es de presentación (globo centrado, nada resaltado), y un paso
// cuyo elemento no está en pantalla (ej. no hay superseries ese día) se saltea.
//
// Cada vista llama a ofrecerTour('clave') al terminar de pintarse: eso muestra
// el botón Ayuda del encabezado y, solo la primera vez que esa persona entra a
// esa pantalla, arranca el recorrido. Lo ya visto se guarda en el servidor y no
// en el navegador: si no, volvería a salir en cada celular, en cada dirección
// por la que se entre (localhost, la IP) o al borrar los datos del navegador.

const T = { pasos: [], i: 0, gen: 0, actual: null };

/** Pantallas cuyo tutorial ya vio (Set), pedidas una vez por sesión. null si no se pudo saber. */
function tutorialesVistos() {
  S.tutoriales ??= api('GET', '/api/auth/tutoriales').then(l => new Set(l)).catch(() => null);
  return S.tutoriales;
}

async function ofrecerTour(clave) {
  if (!TOURS[clave]) return;
  T.actual = clave;
  $('#btn-ayuda').hidden = false;
  const vistos = await tutorialesVistos();
  // Sin saber qué vio (sin conexión), mejor no mostrarlo que mostrárselo cada vez.
  if (!vistos || vistos.has(clave)) return;
  vistos.add(clave);
  api('POST', `/api/auth/tutoriales/${clave}`).catch(() => { /* a lo sumo, lo vuelve a ver una vez */ });
  setTimeout(() => { if (T.actual === clave) iniciarTour(clave); }, 400);
}

function iniciarTour(clave) {
  const pasos = TOURS[clave];
  if (!pasos) return;
  Object.assign(T, { pasos, i: 0 });
  $('#tour-overlay').classList.add('open');
  window.addEventListener('resize', reposicionarTour);
  document.addEventListener('keydown', tecladoTour);
  mostrarPaso(1);
}

function cerrarTour() {
  T.gen++;
  $('#tour-overlay').classList.remove('open');
  window.removeEventListener('resize', reposicionarTour);
  document.removeEventListener('keydown', tecladoTour);
}

function tecladoTour(e) {
  if (e.key === 'Escape') cerrarTour();
  else if (e.key === 'ArrowRight') avanzarTour(1);
  else if (e.key === 'ArrowLeft') avanzarTour(-1);
}

function avanzarTour(delta) {
  const j = T.i + delta;
  if (j < 0) return;
  if (j >= T.pasos.length) { cerrarTour(); return; }
  T.i = j;
  mostrarPaso(delta);
}

/** El elemento del paso, solo si está visible; null para pasos de presentación. */
function elementoDelPaso(paso) {
  if (!paso.sel && !paso.buscar) return null;
  const el = paso.buscar ? paso.buscar() : $(paso.sel);
  return el && el.getClientRects().length && el.offsetWidth ? el : undefined;  // undefined = no está: saltear
}

function mostrarPaso(direccion) {
  const paso = T.pasos[T.i];
  const gen = ++T.gen;
  const el = elementoDelPaso(paso);
  if (el === undefined) {  // ese elemento no está en esta pantalla ahora: se saltea en la dirección en que se venía
    if (direccion < 0 && T.i === 0) direccion = 1;  // hacia atrás no queda nada visible: se sigue hacia adelante
    const j = T.i + (direccion < 0 ? -1 : 1);
    if (j >= T.pasos.length) { cerrarTour(); return; }
    T.i = j;
    return mostrarPaso(direccion);
  }
  pintarGlobo(paso);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  seguirElemento(el, gen);
}

function pintarGlobo(paso) {
  const total = T.pasos.length, ultimo = T.i === total - 1;
  $('#tour-tip').innerHTML = `
    <div class="paso">Paso ${T.i + 1} de ${total}</div>
    <div class="titulo">${paso.titulo}</div>
    <div class="texto">${paso.texto}</div>
    <div class="botones">
      <button class="btn-chico" data-tour="cerrar">${ultimo ? 'Cerrar' : 'Saltar'}</button>
      <div style="display:flex;gap:6px">
        ${T.i > 0 ? '<button class="btn-ghost" data-tour="atras">‹ Atrás</button>' : ''}
        <button class="btn btn-primario" data-tour="siguiente">${ultimo ? '¡Listo!' : 'Siguiente ›'}</button>
      </div>
    </div>`;
}
$('#tour-tip').addEventListener('click', e => {
  const a = e.target.closest('[data-tour]')?.dataset.tour;
  if (a === 'cerrar') cerrarTour();
  if (a === 'atras') avanzarTour(-1);
  if (a === 'siguiente') avanzarTour(1);
});

/** Sigue al elemento cuadro a cuadro mientras dura el scroll suave (como en GNC: un timeout fijo quedaba corto). */
function seguirElemento(el, gen) {
  let quietos = 0, ticks = 0, prev = '';
  const tick = () => {
    if (gen !== T.gen || !$('#tour-overlay').classList.contains('open')) return;
    const r = ubicar(el);
    const pos = `${r.top},${r.left}`;
    quietos = pos === prev ? quietos + 1 : 0;
    prev = pos;
    if (quietos < 6 && ++ticks < 180) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function ubicar(el) {
  const spot = $('#tour-spot'), tip = $('#tour-tip');
  const tipW = tip.offsetWidth || 320, tipH = tip.offsetHeight || 160;
  const vw = window.innerWidth, vh = window.innerHeight;
  if (!el) {  // presentación: nada resaltado, globo centrado
    spot.classList.add('sin-elemento');
    Object.assign(spot.style, { top: `${vh / 2}px`, left: `${vw / 2}px`, width: '0px', height: '0px' });
    Object.assign(tip.style, { top: `${Math.max(10, (vh - tipH) / 2)}px`, left: `${Math.max(10, (vw - tipW) / 2)}px` });
    return { top: 0, left: 0 };
  }
  spot.classList.remove('sin-elemento');
  const r = el.getBoundingClientRect(), pad = 6;
  Object.assign(spot.style, {
    top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  // Debajo del elemento; si no entra, arriba; si tampoco (elemento muy alto, ej. un bloque entero), abajo de todo.
  let top = r.bottom + 14;
  if (top + tipH > vh - 10) top = r.top - tipH - 14;
  if (top < 10) top = vh - tipH - 10;
  let left = Math.min(Math.max(10, r.left), vw - tipW - 10);
  Object.assign(tip.style, { top: `${top}px`, left: `${Math.max(10, left)}px` });
  return r;
}

function reposicionarTour() {
  if (!$('#tour-overlay').classList.contains('open')) return;
  const el = elementoDelPaso(T.pasos[T.i]);
  if (el !== undefined) ubicar(el);
}

$('#btn-ayuda').onclick = () => { if (T.actual) iniciarTour(T.actual); };

// ══ 2. Router ═══════════════════════════════════════════════════════════════

const esStaff = () => S.user && S.user.rol !== 'alumno';

const RUTAS = [
  [/^#\/login$/, () => vistaLogin(), null],
  [/^#\/rutina$/, () => vistaMiRutina(), 'alumno'],
  [/^#\/entrenar\/(\d+)$/, m => vistaEntrenar(+m[1]), 'alumno'],
  [/^#\/historial$/, () => vistaMiHistorial(), 'alumno'],
  [/^#\/alumnos$/, () => vistaAlumnos(), 'staff'],
  [/^#\/alumnos\/(\d+)$/, m => vistaAlumno(+m[1]), 'staff'],
  [/^#\/rutinas\/(\d+)$/, m => vistaRutinaStaff(+m[1]), 'staff'],
  [/^#\/rutinas\/(\d+)\/editar$/, m => vistaEditor(+m[1]), 'staff'],
  [/^#\/plantillas$/, () => vistaPlantillas(), 'staff'],
  [/^#\/ejercicios$/, () => vistaEjercicios(), 'staff'],
  [/^#\/profesores$/, () => vistaProfesores(), 'admin'],
];

function permitido(req) {
  if (!req) return true;
  if (!S.user) return false;
  if (req === 'alumno') return S.user.rol === 'alumno';
  if (req === 'staff') return esStaff();
  return S.user.rol === 'admin';
}

let hashAnterior = location.hash;
async function router() {
  if (S.sucio && location.hash !== hashAnterior) {
    if (!window.confirm('Hay cambios sin guardar en la rutina. ¿Salir igual?')) {
      history.replaceState(null, '', hashAnterior);
      return;
    }
    S.sucio = false;
  }
  hashAnterior = location.hash;
  // Cada vista ofrece su propio recorrido (ofrecerTour) al terminar de pintarse.
  cerrarTour();
  T.actual = null;
  $('#btn-ayuda').hidden = true;
  if (!S.user) { if (location.hash !== '#/login') return location.replace('#/login'); }
  else if (!location.hash || location.hash === '#/login' || location.hash === '#') {
    return location.replace(esStaff() ? '#/alumnos' : '#/rutina');
  }
  pintarNav();
  for (const [re, fn, req] of RUTAS) {
    const m = location.hash.match(re);
    if (m && permitido(req)) {
      // #main nuevo en cada vista: así los listeners que deja una vista no se acumulan en la siguiente.
      const limpio = main().cloneNode(false);
      main().replaceWith(limpio);
      limpio.innerHTML = '<div class="cargando">Cargando…</div>';
      window.scrollTo(0, 0);
      try { await fn(m); }
      catch (e) { main().innerHTML = `<div class="panel error">${esc(e.message)}</div>`; }
      return;
    }
  }
  location.replace(S.user ? (esStaff() ? '#/alumnos' : '#/rutina') : '#/login');
}
window.addEventListener('hashchange', router);
window.addEventListener('beforeunload', e => { if (S.sucio) { e.preventDefault(); e.returnValue = ''; } });

function pintarNav() {
  const nav = $('#nav'), menu = $('#usuario-menu');
  if (!S.user) { nav.hidden = true; menu.hidden = true; return; }
  menu.hidden = false;
  $('#btn-usuario').textContent = S.user.nombre;
  const items = S.user.rol === 'alumno'
    ? [['#/rutina', 'Mi rutina', 'rutina'], ['#/historial', 'Historial', 'historial']]
    : [['#/alumnos', 'Alumnos', 'alumnos'], ['#/plantillas', 'Plantillas', 'plantillas'], ['#/ejercicios', 'Ejercicios', 'ejercicios'],
       ...(S.user.rol === 'admin' ? [['#/profesores', 'Profesores', 'profesores']] : [])];
  const actual = location.hash.split('/').slice(0, 2).join('/');
  // Dentro de una rutina o del editor, marcamos la sección de la que se vino.
  const seccion = actual === '#/rutinas' || actual === '#/entrenar' ? (esStaff() ? '#/alumnos' : '#/rutina') : actual;
  nav.innerHTML = items.map(([h, t, i]) =>
    `<a class="nav-item ${seccion === h ? 'activo' : ''}" href="${h}">${ICON[i]}<span>${t}</span></a>`).join('');
  nav.hidden = false;
}

$('#btn-usuario').onclick = e => { e.stopPropagation(); $('#usuario-dropdown').hidden = !$('#usuario-dropdown').hidden; };
document.addEventListener('click', () => { $('#usuario-dropdown').hidden = true; });
$('#usuario-dropdown').onclick = async e => {
  const a = e.target.dataset.accion;
  if (a === 'salir') { await api('POST', '/api/auth/logout').catch(() => {}); cerrarSesionLocal(); }
  if (a === 'cambiar-clave') {
    const ok = await formulario('Cambiar contraseña',
      campo('Contraseña actual', 'actual', { tipo: 'password', extra: 'required autocomplete="current-password"' }) +
      campo('Contraseña nueva (mín. 6)', 'nueva', { tipo: 'password', extra: 'required minlength="6" autocomplete="new-password"' }),
      { alEnviar: d => api('POST', '/api/auth/cambiar-clave', d) });
    if (ok) toast('Contraseña cambiada');
  }
};

function cerrarSesionLocal() {
  S.token = null; S.user = null; S.catalogo = null; S.sucio = false; S.tutoriales = null;
  grabarLS('token', null); grabarLS('user', null);
  location.hash = '#/login';
}

function vistaLogin() {
  main().innerHTML = `<div class="login"><div class="panel">
    <h2>Ingresar</h2>
    <form id="f-login">
      ${campo('Usuario', 'usuario', { extra: 'required autocomplete="username" autocapitalize="none"' })}
      ${campo('Contraseña', 'password', { tipo: 'password', extra: 'required autocomplete="current-password"' })}
      <div class="error" hidden></div>
      <button class="btn btn-primario" style="width:100%;justify-content:center">Entrar</button>
    </form></div>
    <p class="sub" style="text-align:center">¿Te olvidaste la contraseña? Pedile a tu profe que te la resetee.</p></div>`;
  $('#f-login').onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api('POST', '/api/auth/login', d);
      S.token = r.token; S.user = r.user; S.tutoriales = null;
      grabarLS('token', r.token); grabarLS('user', JSON.stringify(r.user));
      location.hash = '';
    } catch (err) { const el = $('.error', e.target); el.textContent = err.message; el.hidden = false; }
  };
}

// ══ 3. Rutina (render compartido) ═══════════════════════════════════════════

/** Agrupa ítems consecutivos con el mismo número de superserie. */
function gruposDeItems(items) {
  const out = [];
  for (const it of items) {
    const ult = out[out.length - 1];
    if (it.superserie != null && ult && ult.ss === it.superserie) ult.items.push(it);
    else out.push({ ss: it.superserie, items: [it] });
  }
  return out;
}

const nombreItem = it => it.ejercicio_nombre || it.nombre_libre || '(sin ejercicio)';

/** URL embebible: Drive y YouTube se ven dentro de la app; el resto se abre aparte. */
/** De dónde es un link de video: { drive: id } o { youtube: id }, o null si no es de ninguno. */
function idVideo(url) {
  if (!url) return null;
  let m = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || url.match(/drive\.google\.com\/open\?id=([\w-]+)/);
  if (m) return { drive: m[1] };
  m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m ? { youtube: m[1] } : null;
}

function urlEmbebida(url) {
  const v = idVideo(url);
  if (v?.drive) return `https://drive.google.com/file/d/${v.drive}/preview`;
  if (v?.youtube) return `https://www.youtube.com/embed/${v.youtube}`;
  return null;
}

/** La miniatura propia que eligió el profe o, si no hay, la que generan Drive/YouTube para el video.
 * La de Drive solo se ve si el video está compartido con cualquiera que tenga el link: si no
 * carga, quien la muestre tiene que volver al número (ver htmlNro). */
function urlMiniatura(miniatura, videoUrl) {
  if (miniatura) return `/api/ejercicios/miniaturas/${encodeURIComponent(miniatura)}`;
  const v = idVideo(videoUrl);
  if (v?.drive) return `https://drive.google.com/thumbnail?id=${v.drive}&sz=w320`;
  if (v?.youtube) return `https://i.ytimg.com/vi/${v.youtube}/mqdefault.jpg`;
  return null;
}

/** El cuadradito del número, o la miniatura con el número encima. Si la imagen no carga, queda el número. */
function htmlNro(numero, miniatura, videoUrl, { titulo = '', tocable = true } = {}) {
  const mini = urlMiniatura(miniatura, videoUrl);
  if (!mini) return `<div class="nro">${esc(numero ?? '·')}</div>`;
  return `<div class="nro con-mini" ${videoUrl && tocable ? `data-video="${esc(videoUrl)}" data-titulo="${esc(titulo)}"` : ''}>
    <img src="${esc(mini)}" alt="" loading="lazy" onerror="this.parentNode.classList.remove('con-mini');this.remove()">
    <span>${esc(numero ?? '·')}</span></div>`;
}

/** Pone el video en `marco` (.video-marco) y lo arranca solo. Drive: primero el archivo directo
 * en un <video>, que puede arrancar solo; si Drive no lo entrega (no es público), su visor
 * embebido, que pide tocar su ▶. YouTube: el reproductor embebido con autoplay. */
/** El recuadro toma la forma del video (los de celular son verticales): sin esto, un video
 * vertical en un recuadro 16:9 queda cortado. El alto no pasa del 60 % de la pantalla. */
function ajustarMarco(marco, ancho, alto) {
  if (!ancho || !alto) return;
  marco.style.aspectRatio = `${ancho} / ${alto}`;
  marco.style.width = `min(100%, calc(60dvh * ${(ancho / alto).toFixed(4)}))`;
  marco.style.marginInline = 'auto';
}

function montarVideo(marco, url) {
  const v = idVideo(url);
  const iframe = src => {
    marco.innerHTML = `<iframe ${!ES_PC && src.includes('drive.google.com') ? 'class="escalado"' : ''} src="${esc(src)}" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
  };
  if (v?.youtube) { iframe(`https://www.youtube.com/embed/${v.youtube}?autoplay=1&playsinline=1`); return; }
  if (!v?.drive) return;
  // La forma se saca de la miniatura de Drive (sirve también cuando termina en su visor embebido)
  // y, si el archivo carga directo, del video mismo.
  const mini = new Image();
  mini.onload = () => ajustarMarco(marco, mini.naturalWidth, mini.naturalHeight);
  mini.src = `https://drive.google.com/thumbnail?id=${encodeURIComponent(v.drive)}&sz=w640`;
  marco.innerHTML = `<video controls playsinline preload="auto"
    src="https://drive.usercontent.google.com/download?id=${esc(v.drive)}&export=download"></video>`;
  const vid = $('video', marco);
  let cambiado = false;
  const alVisor = () => { if (!cambiado) { cambiado = true; iframe(urlEmbebida(url)); } };
  vid.addEventListener('error', alVisor);
  vid.addEventListener('loadedmetadata', () => ajustarMarco(marco, vid.videoWidth, vid.videoHeight));
  // Sin sonido el navegador siempre deja arrancar; con sonido, solo si viene de un toque.
  vid.play().catch(e => {
    if (e.name === 'NotAllowedError') { vid.muted = true; vid.play().catch(() => {}); }
  });
}

function abrirVideo(url, titulo) {
  const emb = urlEmbebida(url);
  if (!emb) { window.open(url, '_blank', 'noopener'); return; }
  modal(`<div class="titulo-fila" style="margin-bottom:10px"><h3 style="margin:0">${esc(titulo)}</h3><div class="spacer"></div>
    <a class="btn-chico" href="${esc(url)}" target="_blank" rel="noopener">Abrir aparte</a>
    <button class="btn-chico" onclick="cerrarModal()">Cerrar</button></div>
    <div class="video-marco" data-marco></div>
    <p class="sub" style="margin-top:8px">¿No carga? Tocá «Abrir aparte». Si tampoco se ve ahí, el video no está compartido
      como «cualquier persona con el enlace»: avisale a tu profe.</p>`, { ancho: true });
  montarVideo($('#modal [data-marco]'), url);
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-video]');
  if (b) { e.preventDefault(); abrirVideo(b.dataset.video, b.dataset.titulo || 'Video'); }
});

/** En la PC (mouse) se entrena con botones; en el celular, deslizando. */
const ES_PC = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/** 12.5 → «12,5 kg». */
const kg = n => (n == null || n === '' ? '' : `${String(+n).replace('.', ',')} kg`);
/** Lo que el alumno tiene que hacer: la prescripción y, si el profe lo puso, el peso. */
const prescConPeso = it => [it.prescripcion, it.peso_kg ? `con ${kg(it.peso_kg)}` : null].filter(Boolean).join(' · ');
/** Lo registrado (o lo de la última vez): cuánto, con qué peso. */
const cargaConPeso = r => [r?.carga, r?.peso_kg ? kg(r.peso_kg) : null].filter(Boolean).join(' · ');

function htmlItem(it, { cargas = {}, registro = null } = {}) {
  // Entrenando, el video se ve en Comenzar: la tarjeta no tiene play propio ni miniatura tocable.
  const video = it.video_url && !registro
    ? `<button class="btn-video" data-video="${esc(it.video_url)}" data-titulo="${esc(nombreItem(it))}" title="Ver video">${ICON.play}</button>` : '<span></span>';
  const ult = cargas[it.id];
  const reg = registro?.[it.id];
  return `<div class="item ${registro ? 'entrenar' : ''} ${reg?.hecho ? 'hecho' : ''}" data-item="${it.id}">
    ${htmlNro(it.ejercicio_numero, it.ejercicio_miniatura, it.video_url, { titulo: nombreItem(it), tocable: !registro })}
    <div><div class="nombre" ${registro ? '' : `data-info="${it.id}"`}>${esc(nombreItem(it))}</div>${prescConPeso(it) ? `<div class="presc">${esc(prescConPeso(it))}</div>` : ''}</div>
    ${video}
    ${it.comentario ? `<div class="coment">${esc(it.comentario)}</div>` : ''}
    ${ult ? `<div class="ultima">Última vez (${fecha(ult.fecha)}): ${esc(cargaConPeso(ult))}</div>` : ''}
    ${registro && ES_PC ? `<div class="acciones-pc">${reg?.hecho
      ? `<button type="button" class="btn-ghost" data-editar="${it.id}">Editar registro</button>`
      : `<button type="button" class="btn btn-verde" data-comenzar="${it.id}">▶ Comenzar</button>`}</div>` : ''}
    ${registro ? `<div class="registro" data-registro="${it.id}" ${reg?.hecho ? '' : 'hidden'}>${htmlRegistro(reg)}</div>
      <div class="estado-item" data-estado="${it.id}"></div>` : ''}
  </div>`;
}

/** Lo registrado hoy, en la tarjeta (modo entrenar). Se registra y se corrige deslizando: no hay botón. */
function htmlRegistro(r) {
  const detalle = [cargaConPeso(r) && esc(cargaConPeso(r)), r?.esfuerzo && `sensación ${r.esfuerzo}/10`, r?.nota && esc(r.nota)].filter(Boolean).join(' · ');
  return `<span class="check on">✓</span><span class="registro-texto">${detalle ? `Hoy: ${detalle}` : 'Hecho'}</span>`;
}

function htmlDia(dia, opts = {}) {
  if (!dia.bloques.length) return '<div class="vacio">Este día todavía no tiene ejercicios.</div>';
  return dia.bloques.map(b => `<section class="bloque">
    <div class="bloque-titulo"><h3>${esc(b.nombre)}</h3>${b.detalle ? `<span class="detalle">${esc(b.detalle)}</span>` : ''}</div>
    ${b.prescripcion || b.comentario ? `<div class="bloque-extra">${b.prescripcion ? `<b>${esc(b.prescripcion)}</b> ` : ''}${esc(b.comentario || '')}</div>` : ''}
    ${gruposDeItems(b.items).map(g => g.ss != null && g.items.length > 1
      ? `<div class="superserie">${g.items.map(it => htmlItem(it, opts)).join('')}</div>`
      : g.items.map(it => htmlItem(it, opts)).join('')).join('')}
  </section>`).join('');
}

function htmlTabsDias(rutina, sel) {
  return `<div class="tabs-dias">${rutina.dias.map((d, i) =>
    `<button class="tab-dia ${i === sel ? 'activo' : ''}" data-tab="${i}">
       ${d.color ? `<span class="punto" style="background:${esc(d.color)}"></span>` : ''}${esc(d.nombre)}</button>`).join('')}</div>`;
}

function htmlNotas(rutina, abierto) {
  if (!rutina.notas) return '';
  return `<details class="notas-profe" ${abierto ? 'open' : ''}><summary>Indicaciones de ${esc(rutina.profesor_nombre)}</summary>
    <p>${esc(rutina.notas)}</p></details>`;
}

/** Pinta la rutina con pestañas por día en `cont`. `extra(dia)` agrega HTML al pie del día.
 * Con `velo`, los ejercicios quedan detrás de una cortina gris que no deja tocarlos: se leen,
 * y lo de `extra` (el botón Empezar) queda adelante. */
function montarRutina(cont, rutina, { claveDia, cargas = {}, extra = () => '', velo = false } = {}) {
  let sel = Math.min(+(leerLS(claveDia) || 0), Math.max(rutina.dias.length - 1, 0));
  const pintar = () => {
    const cuerpo = rutina.dias.length ? htmlDia(rutina.dias[sel], { cargas }) : '';
    $('.dias-wrap', cont).innerHTML = rutina.dias.length
      ? htmlTabsDias(rutina, sel) + (velo ? `<div class="con-velo">${cuerpo}<div class="velo"></div></div>` : cuerpo) + extra(rutina.dias[sel])
      : '<div class="vacio">La rutina no tiene días cargados.</div>';
  };
  cont.insertAdjacentHTML('beforeend', '<div class="dias-wrap"></div>');
  cont.addEventListener('click', e => {
    const t = e.target.closest('[data-tab]');
    if (t) { sel = +t.dataset.tab; grabarLS(claveDia, sel); pintar(); }
  });
  pintar();
}

function htmlHistorial(lista) {
  if (!lista.length) return '<div class="vacio">Todavía no hay entrenamientos registrados.</div>';
  return lista.map(e => {
    const pct = e.total ? Math.round(100 * e.hechos / e.total) : 0;
    return `<details class="entreno"><summary>
      <span class="fecha">${fecha(e.fecha)}</span>
      <span style="flex:1;min-width:120px">${esc(e.dia_nombre)} <span class="sub">· ${esc(e.rutina_titulo || 'rutina eliminada')}</span></span>
      <span class="sub">${e.hechos}/${e.total}</span><span class="progreso"><div style="width:${pct}%"></div></span>
      ${e.terminado_en ? '' : '<span class="badge borrador">En curso</span>'}
      ${e.esfuerzo ? `<span class="badge" style="color:var(--yellow)">Esfuerzo ${e.esfuerzo}</span>` : ''}
    </summary><div class="cuerpo">
      ${e.nota ? `<div class="nota">“${esc(e.nota)}”</div>` : ''}
      <ul>${e.items.map(i => `<li><span style="color:${i.hecho ? 'var(--green)' : 'var(--muted)'}">${i.hecho ? '✓' : '·'}</span>
        <span style="flex:1">${esc(i.ejercicio_nombre)}</span><span class="sub">${esc(cargaConPeso(i))}</span>${i.esfuerzo ? `<span class="badge" style="color:var(--yellow)" title="Cómo se sintió">${i.esfuerzo}/10</span>` : ''}</li>`).join('')
        || '<li class="sub">Sin detalle por ejercicio</li>'}</ul>
    </div></details>`;
  }).join('');
}

const itemsPorId = dias => Object.fromEntries(dias.flatMap(d => d.bloques.flatMap(b => b.items)).map(i => [i.id, i]));

/** Botonera 1 a 10 de esfuerzo percibido (la misma del cierre de la sesión). */
const htmlEsfuerzo = sel => `<div class="esfuerzo" role="group" aria-label="Esfuerzo del 1 al 10">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n =>
  `<button type="button" data-esf="${n}" class="${sel === n ? 'on' : ''}" aria-pressed="${sel === n}">${n}</button>`).join('')}</div>`;

/** Ficha de un ejercicio: video, indicación del profe, técnica y última carga.
 * Con `alMarcar`, ofrece registrarlo desde ahí (modo entrenar). Con `cronometro`, arriba
 * de todo cuenta el tiempo desde que se abrió (el «Comenzar» de la PC). */
function abrirInfo(it, { cargas = {}, hecho = false, alMarcar = null, cronometro = false } = {}) {
  const emb = urlEmbebida(it.video_url);
  const ult = cargas[it.id];
  const seccion = (titulo, texto) => texto
    ? `<div class="info-seccion"><div class="info-titulo">${titulo}</div><p>${esc(texto)}</p></div>` : '';
  const objetivo = it.modalidad === 'tiempo' && it.segundos ? it.segundos : null;
  const m = modal(`
    ${cronometro ? `<div class="cronometro">
      <span class="crono-etiqueta">Tiempo</span>
      <span class="crono-valor" data-crono role="timer" aria-label="Tiempo transcurrido">0:00</span>
      ${objetivo ? `<span class="crono-objetivo" data-objetivo>Objetivo por serie: ${esc(duracionTexto(objetivo))}</span>` : ''}
      <button type="button" class="btn-chico" data-reiniciar>Reiniciar</button></div>` : ''}
    <div class="titulo-fila" style="margin-bottom:8px;flex-wrap:nowrap">
      <div class="nro-grande">${esc(it.ejercicio_numero ?? '·')}</div>
      <div style="flex:1;min-width:0"><h3 style="margin:0">${esc(nombreItem(it))}</h3>
        ${it.ejercicio_grupo ? `<div class="sub">${esc(it.ejercicio_grupo)}</div>` : ''}</div>
      <button class="btn-chico" data-cerrar>✕</button></div>
    ${prescConPeso(it) ? `<div class="presc-grande">${esc(prescConPeso(it))}</div>` : ''}
    ${emb ? `<div class="video-marco" style="margin:10px 0" data-marco></div>
             <p class="sub">¿No carga el video? <a href="${esc(it.video_url)}" target="_blank" rel="noopener">Abrilo aparte</a>.</p>`
          : it.video_url ? `<p><a class="btn-ghost" href="${esc(it.video_url)}" target="_blank" rel="noopener">▶ Ver video</a></p>` : ''}
    ${seccion('Indicación del profe', it.comentario)}
    ${seccion('Técnica', it.ejercicio_descripcion)}
    ${ult ? seccion('Última vez', `${cargaConPeso(ult)} (${fecha(ult.fecha)})`) : ''}
    ${!it.comentario && !it.ejercicio_descripcion && !it.video_url && !ult ? '<p class="sub">Sin más información cargada para este ejercicio.</p>' : ''}
    ${alMarcar ? `<div class="pie"><button class="btn ${hecho ? 'btn-ghost' : 'btn-primario'}" data-marcar>
        ${hecho ? 'Editar registro' : '✓ Registrar'}</button></div>` : ''}`, { ancho: !!emb });
  $('[data-cerrar]', m).onclick = cerrarModal;
  const marco = $('[data-marco]', m);
  if (marco) montarVideo(marco, it.video_url);
  if (alMarcar) $('[data-marcar]', m).onclick = () => { cerrarModal(); alMarcar(it.id); };
  if (cronometro) {
    const valor = $('[data-crono]', m), obj = $('[data-objetivo]', m);
    let inicio = Date.now();
    const tic = () => {
      // Se cerró la ficha (o se abrió otra): el cronómetro se apaga solo.
      if (!document.contains(valor)) { clearInterval(reloj); return; }
      const seg = Math.floor((Date.now() - inicio) / 1000);
      valor.textContent = `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, '0')}`;
      obj?.classList.toggle('cumplido', seg >= objetivo);
    };
    const reloj = setInterval(tic, 250);
    $('[data-reiniciar]', m).onclick = () => { inicio = Date.now(); tic(); };
  }
}

/** Deslizar ejercicios ([data-item]) dentro de `cont`: derecha → `derecha(id)`, izquierda → `izquierda(id)`.
 * Solo se activa con un gesto claramente horizontal: el desplazamiento vertical sigue siendo scroll. */
function habilitarSwipe(cont, { derecha = null, izquierda = null }) {
  const UMBRAL = 80;
  let g = null, bloquearClickHasta = 0;
  const limpiar = el => { el.classList.remove('deslizando', 'swipe-der', 'swipe-izq', 'swipe-listo'); el.style.transform = ''; };
  cont.addEventListener('pointerdown', e => {
    const el = e.target.closest('[data-item]');
    if (!el || e.target.closest('input, textarea, button, a') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    g = { el, id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, activo: false };
  });
  cont.addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.activo) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { g = null; return; }  // es scroll
      if (Math.abs(dx) < 12) return;
      g.activo = true;
      g.el.classList.add('deslizando');
      try { g.el.setPointerCapture(e.pointerId); } catch { /* ya liberado */ }
    }
    const permitido = dx > 0 ? derecha : izquierda;
    g.dx = permitido ? dx : 0;
    g.el.style.transform = `translateX(${Math.sign(g.dx) * Math.min(Math.abs(g.dx), 140)}px)`;
    g.el.classList.toggle('swipe-der', g.dx > 0);
    g.el.classList.toggle('swipe-izq', g.dx < 0);
    g.el.classList.toggle('swipe-listo', Math.abs(g.dx) >= UMBRAL);
  });
  const fin = e => {
    if (!g || e.pointerId !== g.id) return;
    const { el, dx, activo } = g;
    g = null;
    if (!activo) return;
    limpiar(el);
    // El navegador dispara un click apenas se suelta: ese no es un toque. La ventana es
    // corta para no comerse el toque siguiente de verdad (cerrar la ficha y tocar otra cosa).
    bloquearClickHasta = Date.now() + 80;
    if (dx >= UMBRAL) { navigator.vibrate?.(15); derecha(+el.dataset.item, el); }
    else if (dx <= -UMBRAL) izquierda(+el.dataset.item, el);
  };
  cont.addEventListener('pointerup', fin);
  cont.addEventListener('pointercancel', e => { if (g && e.pointerId === g.id) { limpiar(g.el); g = null; } });
  cont.addEventListener('click', e => {
    if (Date.now() < bloquearClickHasta) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
}

// ══ 4. Alumno ═══════════════════════════════════════════════════════════════

async function vistaMiRutina() {
  const rutina = await api('GET', '/api/mi-rutina');
  if (!rutina) {
    main().innerHTML = `<h2>Hola, ${esc(S.user.nombre.split(' ')[0])}</h2>
      <div class="vacio panel">Tu profe todavía no te publicó una rutina.</div>`;
    return;
  }
  const [cargas, resumen] = await Promise.all([
    api('GET', `/api/rutinas/${rutina.id}/ultimas-cargas`),
    api('GET', `/api/rutinas/${rutina.id}/resumen-dias`)]);
  const claveNotas = `notas_vistas_${rutina.id}_${rutina.modificado_en}`;
  const notasAbiertas = !leerLS(claveNotas);
  grabarLS(claveNotas, '1');
  main().innerHTML = `<div class="titulo-fila"><div><h2>${esc(rutina.titulo)}</h2>
      <div class="sub">${rutina.fecha_inicio ? `Desde ${fecha(rutina.fecha_inicio)} · ` : ''}Profe: ${esc(rutina.profesor_nombre)}</div></div></div>
    ${htmlNotas(rutina, notasAbiertas)}`;
  montarRutina(main(), rutina, {
    claveDia: `dia_${rutina.id}`, cargas, velo: true,
    // La rutina se repite: cada día muestra cuántas veces se hizo, y "Continuar" solo
    // si hay una sesión abierta (empezada y sin terminar).
    extra: d => {
      const r = resumen[d.id] || {};
      const total = d.bloques.reduce((n, b) => n + b.items.length, 0);
      const texto = r.en_curso ? `Continuar ${esc(d.nombre)} · ${r.en_curso.hechos}/${total}` : `Empezar ${esc(d.nombre)}`;
      const veces = r.veces
        ? `Lo hiciste ${r.veces} ${r.veces === 1 ? 'vez' : 'veces'} · la última, ${fecha(r.ultima)}`
        : 'Todavía no lo hiciste';
      return `<div class="barra-guardar"><span class="sub" style="margin-right:auto;align-self:center">${veces}</span>
          <a class="btn btn-primario" href="#/entrenar/${d.id}">${texto}</a></div>`;
    },
  });
  // Los ejercicios se tocan recién entrenando: tocar la cortina trae el botón Empezar
  // adelante del ejercicio tocado, en vez de no hacer nada.
  main().addEventListener('click', e => {
    const velo = e.target.closest('.velo');
    if (!velo) return;
    const boton = $('.barra-guardar .btn-primario', main());
    if (!boton) return;
    $('.velo-cta', velo)?.remove();
    const cta = boton.cloneNode(true);
    cta.classList.add('velo-cta');
    const caja = velo.getBoundingClientRect();
    cta.style.top = `${Math.min(Math.max(e.clientY - caja.top, 30), caja.height - 30)}px`;
    velo.appendChild(cta);
  });
  ofrecerTour('mi-rutina');
}

/** Entrenar: cada ejercicio se registra (con su carga) apenas se hace, en una ventanita que
 * propone lo de la última vez. Si se corta la señal o se cierra la app a mitad, lo hecho hasta ahí ya está guardado. */
async function vistaEntrenar(diaId) {
  const rutina = await api('GET', '/api/mi-rutina');
  const dia = rutina?.dias.find(d => d.id === diaId);
  if (!dia) { main().innerHTML = '<div class="vacio">Ese día ya no está en tu rutina vigente.</div>'; return; }
  const cargas = await api('GET', `/api/rutinas/${rutina.id}/ultimas-cargas`);
  const total = dia.bloques.reduce((n, b) => n + b.items.length, 0);
  let reg = {}, esfuerzo = null, nota = '', fechaSel = hoyISO();

  // Retoma la sesión abierta de este día (empezada y sin terminar) o arranca de cero.
  const cargar = async () => {
    const previo = await api('GET', `/api/dias/${diaId}/entrenamiento`);
    reg = {}; esfuerzo = previo?.esfuerzo ?? null; nota = previo?.nota ?? '';
    if (previo) fechaSel = previo.fecha;
    for (const i of previo?.items || []) if (i.item_id) reg[i.item_id] = { hecho: !!i.hecho, carga: i.carga || '', nota: i.nota || '', esfuerzo: i.esfuerzo ?? null, peso_kg: i.peso_kg ?? null };
    pintar();
  };

  const pintarProgreso = () => {
    const hechos = Object.values(reg).filter(r => r.hecho).length;
    $('#cuenta').textContent = hechos === total && total ? '¡Día completo! 💪' : `${hechos} de ${total} hechos`;
    $('#barra-progreso').style.width = `${total ? Math.round(100 * hechos / total) : 0}%`;
  };

  const pintar = () => {
    main().innerHTML = `<a class="volver" href="#/rutina">← Mi rutina</a>
      <div class="titulo-fila"><div><h2>${esc(dia.nombre)}</h2><div class="sub">${esc(rutina.titulo)}</div></div><div class="spacer"></div>
        <input type="date" id="fecha" value="${fechaSel}" max="${hoyISO()}" style="width:auto"></div>
      <div class="progreso-entreno"><span id="cuenta"></span><div class="barra"><div id="barra-progreso"></div></div></div>
      <p class="sub ayuda-swipe">${ES_PC
        ? 'Tocá <b>▶ Comenzar</b> en cada ejercicio: se abre el video con un cronómetro, y al terminar, <b>✓ Registrar</b>'
        : 'Deslizá a la <b>derecha</b> para comenzar (video y cronómetro). Si ya lo registraste, deslizalo de nuevo para corregirlo'}</p>
      <div id="ejercicios">${htmlDia(dia, { cargas, registro: reg })}</div>
      <div class="panel" id="cierre">
        <h3>¿Cómo te fue?</h3>
        <div class="sub" style="margin-bottom:8px">Esfuerzo percibido (1 = muy fácil, 10 = al límite)</div>
        ${htmlEsfuerzo(esfuerzo)}
        <label class="campo" style="margin-top:12px">Comentario para tu profe (opcional)
          <textarea id="nota" placeholder="Molestias, dudas, qué te costó…">${esc(nota)}</textarea></label>
        <button class="btn btn-primario" id="terminar" style="width:100%;justify-content:center">Terminar entrenamiento</button>
      </div>`;
    // La fecha es un dato de la sesión (por si la anota al día siguiente): se guarda con el próximo ejercicio o al terminar.
    $('#fecha').onchange = e => { fechaSel = e.target.value || hoyISO(); };
    pintarProgreso();
    marcarSiguiente();
  };

  // ── Guardado por ejercicio. Una cola por ítem: dos registros rápidos no llegan desordenados.
  const colas = {};
  const estado = (id, txt, clase = '') => {
    const el = $(`[data-estado="${id}"]`);
    if (el) { el.textContent = txt; el.className = `estado-item ${clase}`; }
  };
  const enviar = id => {
    const r = reg[id] || {};
    const body = { dia_id: diaId, fecha: fechaSel, item_id: id, hecho: !!r.hecho, carga: r.carga || null, nota: r.nota || null,
                   esfuerzo: r.esfuerzo ?? null, peso_kg: r.peso_kg ?? null };
    estado(id, 'Guardando…');
    colas[id] = (colas[id] || Promise.resolve()).then(() => api('PUT', '/api/entrenamientos/item', body, { keepalive: true }))
      .then(() => estado(id, r.hecho || r.carga ? '✓ Guardado' : '', 'ok'))
      .catch(err => { estado(id, 'No se guardó · registralo de nuevo', 'error'); toast(err.message, true); });
    return colas[id];
  };

  /** Resalta el próximo ejercicio sin hacer; con `desplazar`, lleva la pantalla hasta él. */
  const marcarSiguiente = (desdeId = null, desplazar = false) => {
    const items = $$('#ejercicios [data-item]');
    $$('#ejercicios .siguiente').forEach(x => x.classList.remove('siguiente'));
    const desde = desdeId ? items.findIndex(x => +x.dataset.item === desdeId) : -1;
    const sig = [...items.slice(desde + 1), ...items.slice(0, desde + 1)].find(x => !reg[+x.dataset.item]?.hecho);
    if (!sig) { if (desplazar) $('#cierre').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    sig.classList.add('siguiente');
    if (desplazar) sig.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const guardar = (id, r) => {
    reg[id] = r;
    const el = $(`#ejercicios [data-item="${id}"]`);
    el?.classList.toggle('hecho', r.hecho);
    const resumen = $(`[data-registro="${id}"]`);
    if (resumen) { resumen.hidden = !r.hecho; resumen.innerHTML = htmlRegistro(r); }
    const acc = el?.querySelector('.acciones-pc');
    if (acc) acc.innerHTML = r.hecho
      ? `<button type="button" class="btn-ghost" data-editar="${id}">Editar registro</button>`
      : `<button type="button" class="btn btn-verde" data-comenzar="${id}">▶ Comenzar</button>`;
    pintarProgreso();
    enviar(id);
    if (r.hecho) setTimeout(() => marcarSiguiente(id, true), 250);
    else marcarSiguiente();
  };

  /** Ventanita de registro: arranca con lo que indicó el profe (repeticiones/tiempo y peso), así
   * si lo hizo tal cual solo toca Registrar; si no, lo cambia. Lo de la última vez es solo referencia.
   * Si ya lo había anotado hoy, sale lo anotado para corregirlo. */
  const registrar = id => {
    const it = porId[id], r = reg[id] || {}, ult = cargas[id];
    const pesoInicial = r.hecho ? r.peso_kg : (r.peso_kg ?? it.peso_kg);
    const conPeso = pesoInicial != null || it.peso_kg != null;
    const m = modal(`
      <div class="titulo-fila" style="margin-bottom:6px;flex-wrap:nowrap">
        <div class="nro-grande">${esc(it.ejercicio_numero ?? '·')}</div>
        <div style="flex:1;min-width:0"><h3 style="margin:0">${esc(nombreItem(it))}</h3>
          ${prescConPeso(it) ? `<div class="sub">${esc(prescConPeso(it))}</div>` : ''}</div>
        <button type="button" class="btn-chico" data-cancelar>✕</button></div>
      <p class="sub">${ult ? `La última vez (${fecha(ult.fecha)}): <b class="ultima-carga">${esc(cargaConPeso(ult))}</b>` : 'Primera vez que anotás este ejercicio.'}</p>
      <form>
        ${campo('¿Cuánto hiciste?', 'carga', { valor: r.hecho ? (r.carga || '') : (r.carga || it.prescripcion || ''),
          extra: `placeholder="${it.modalidad === 'tiempo' ? 'ej. 3 × 20 seg' : 'ej. 3 × 10 con 8 kg'}" autocomplete="off"` })}
        ${conPeso ? campo('Peso que usaste (kg)', 'peso_kg', { valor: pesoInicial != null ? String(pesoInicial).replace('.', ',') : '',
          extra: 'inputmode="decimal" autocomplete="off" placeholder="ej. 12,5"' }) : ''}
        <div class="campo">¿Cómo te sentiste? <span class="sub">(1 = muy fácil, 10 = al límite)</span>${htmlEsfuerzo(r.esfuerzo ?? null)}</div>
        ${campo('Nota (opcional)', 'nota', { valor: r.nota || '', extra: 'placeholder="Molestia, me costó la última serie…" autocomplete="off"' })}
        <div class="pie">
          ${r.hecho ? '<button type="button" class="btn-ghost" data-desmarcar style="margin-right:auto">Desmarcar</button>' : ''}
          <button type="button" class="btn-ghost" data-cancelar>Cancelar</button>
          <button class="btn btn-primario">✓ Registrar</button></div>
      </form>`, { enfocar: ES_PC });  // en el celular, sin foco: el teclado taparía el botón Registrar
    const f = $('form', m);
    const valor = n => f.elements[n].value.trim();
    $$('[data-cancelar]', m).forEach(b => { b.onclick = cerrarModal; });
    let esf = r.esfuerzo ?? null;
    $('.esfuerzo', m).onclick = e => {
      const b = e.target.closest('[data-esf]');
      if (!b) return;
      esf = esf === +b.dataset.esf ? null : +b.dataset.esf;
      $$('[data-esf]', m).forEach(x => { x.classList.toggle('on', +x.dataset.esf === esf); x.setAttribute('aria-pressed', +x.dataset.esf === esf); });
    };
    const leerPeso = () => {
      if (!f.elements.peso_kg) return null;
      const n = parseFloat(valor('peso_kg').replace(',', '.').replace(/kg/i, ''));
      return Number.isFinite(n) && n > 0 && n <= 1000 ? Math.round(n * 100) / 100 : null;
    };
    f.onsubmit = e => {
      e.preventDefault();
      if (f.elements.peso_kg && valor('peso_kg') && leerPeso() == null) { toast('El peso tiene que ser un número de kilos, por ejemplo 12,5', true); return; }
      cerrarModal(); guardar(id, { hecho: true, carga: valor('carga'), nota: valor('nota'), esfuerzo: esf, peso_kg: leerPeso() });
    };
    if (r.hecho) $('[data-desmarcar]', m).onclick = () => { cerrarModal(); guardar(id, { hecho: false, carga: '', nota: '', esfuerzo: null, peso_kg: null }); };
  };

  const porId = itemsPorId([dia]);
  // Deslizar a la derecha hace lo mismo que «▶ Comenzar» en la PC; si ya estaba hecho, abre el registro para corregirlo.
  const comenzar = id => abrirInfo(porId[id], { cargas, alMarcar: registrar, cronometro: true });
  if (!ES_PC) habilitarSwipe(main(), { derecha: id => (reg[id]?.hecho ? registrar(id) : comenzar(id)) });

  main().onclick = e => {
    const c = e.target.closest('[data-comenzar]');
    if (c) { comenzar(+c.dataset.comenzar); return; }
    const ed = e.target.closest('[data-editar]');
    if (ed) { registrar(+ed.dataset.editar); return; }
    const f = e.target.closest('[data-esf]');
    if (f) { esfuerzo = esfuerzo === +f.dataset.esf ? null : +f.dataset.esf; $$('[data-esf]').forEach(b => b.classList.toggle('on', +b.dataset.esf === esfuerzo)); }
    if (e.target.id === 'terminar') terminar(e.target);
  };
  main().oninput = e => { if (e.target.id === 'nota') nota = e.target.value; };

  const terminar = btn => intentar(async () => {
    btn.disabled = true;
    try {
      await Promise.all(Object.values(colas));
      const sesion = await api('PUT', '/api/entrenamientos/cierre', { dia_id: diaId, fecha: fechaSel, esfuerzo, nota });
      if (!sesion) { toast('No marcaste ningún ejercicio: no se guardó nada', true); return; }
      toast('Entrenamiento guardado 💪');
      location.hash = '#/historial';
    } finally { btn.disabled = false; }
  });

  await cargar();
  ofrecerTour('entrenar');
}

async function vistaMiHistorial() {
  const lista = await api('GET', `/api/alumnos/${S.user.id}/entrenamientos`);
  main().innerHTML = `<h2 style="margin-bottom:14px">Mis entrenamientos</h2>${htmlHistorial(lista)}`;
  ofrecerTour('historial');
}

// ══ 5. Profe ════════════════════════════════════════════════════════════════

function mostrarClave(usuario, nombre, clave, titulo = 'Acceso creado') {
  const msg = `Hola ${nombre.split(' ')[0]}! Ya tenés tu acceso a las rutinas:\n${location.origin}\nUsuario: ${usuario}\nContraseña: ${clave}\n(La podés cambiar desde el menú, arriba a la derecha.)`;
  const m = modal(`<h3>${esc(titulo)}</h3>
    <p class="sub">Contraseña temporal de <b>${esc(usuario)}</b> — se muestra solo esta vez:</p>
    <div class="clave-temporal">${esc(clave)}</div>
    <div class="pie"><button class="btn-ghost" id="copiar-msg">Copiar mensaje para WhatsApp</button>
      <button class="btn btn-primario" onclick="cerrarModal()">Listo</button></div>`);
  $('#copiar-msg', m).onclick = () => copiar(msg);
}

async function opcionesProfesores(sel) {
  const ps = await api('GET', '/api/profesores');
  return ps.filter(p => p.activo).map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('');
}

async function altaAlumno() {
  const selProfe = S.user.rol === 'admin'
    ? `<label class="campo">Profesor<select name="profesor_id">${await opcionesProfesores(S.user.id)}</select></label>` : '';
  const a = await formulario('Nuevo alumno',
    campo('Nombre y apellido', 'nombre', { extra: 'required' }) +
    campo('Usuario (para entrar, sin espacios)', 'usuario', { extra: 'required pattern="\\S+" autocapitalize="none"' }) +
    campo('Teléfono', 'telefono', { tipo: 'text' }) + campo('Email', 'email', { tipo: 'text' }) + selProfe,
    { boton: 'Crear', alEnviar: d => api('POST', '/api/alumnos', { ...d, profesor_id: d.profesor_id ? +d.profesor_id : null }) });
  if (a) { mostrarClave(a.usuario, a.nombre, a.password_temporal); return a; }
}

async function vistaAlumnos() {
  const pintar = async () => {
    const todos = $('#ver-bajas')?.checked;
    const lista = await api('GET', `/api/alumnos${todos ? '?todos=true' : ''}`);
    const q = normalizar($('#q')?.value);
    const filtrada = lista.filter(a => !q || normalizar(a.nombre + ' ' + a.usuario).includes(q));
    $('#lista').innerHTML = filtrada.length ? filtrada.map(a => `<a class="fila" href="#/alumnos/${a.id}" style="${a.activo ? '' : 'opacity:.5'}">
        <div class="principal"><div class="nombre">${esc(a.nombre)}</div>
          <div class="sub">${a.rutina_actual ? esc(a.rutina_actual) : '<span style="color:var(--yellow)">Sin rutina publicada</span>'}
          ${S.user.rol === 'admin' ? ` · ${esc(a.profesor_nombre || '')}` : ''}</div></div>
        <div class="sub">Entrenó ${hace(a.ultimo_entrenamiento)}</div></a>`).join('')
      : `<div class="vacio">${lista.length ? 'Ningún alumno coincide.' : 'Todavía no cargaste alumnos.'}</div>`;
  };
  main().innerHTML = `<div class="titulo-fila"><h2>Alumnos</h2><div class="spacer"></div>
      <button class="btn btn-primario" id="nuevo">+ Nuevo alumno</button></div>
    <div class="buscador"><input type="search" id="q" placeholder="Buscar por nombre…">
      <label class="sub" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="ver-bajas"> Ver dados de baja</label></div>
    <div class="lista" id="lista"></div>`;
  $('#q').oninput = pintar;
  $('#ver-bajas').onchange = pintar;
  $('#nuevo').onclick = async () => { const a = await altaAlumno(); if (a) pintar(); };
  await pintar();
  ofrecerTour('alumnos');
}

function htmlFilaRutina(r) {
  const plantilla = r.alumno_id == null;
  return `<div class="fila" data-rutina="${r.id}">
    <div class="principal"><a class="nombre" href="#/rutinas/${r.id}" style="color:inherit">${esc(r.titulo)}</a>
      <div class="sub">${r.dias} días · modificada ${hace(r.modificado_en)}${plantilla ? ` · ${esc(r.profesor_nombre)}` : ''}</div></div>
    <span class="badge ${plantilla ? 'plantilla' : r.estado}">${plantilla ? 'plantilla' : r.estado}</span>
    <div class="acciones">
      ${!plantilla || r.profesor_id === S.user.id || S.user.rol === 'admin' ? `<a class="btn-chico" href="#/rutinas/${r.id}/editar">Editar</a>` : ''}
      ${!plantilla && r.estado !== 'publicada' ? '<button class="btn-chico" data-acc="publicar">Publicar</button>' : ''}
      ${!plantilla && r.estado === 'publicada' ? '<button class="btn-chico" data-acc="archivar">Archivar</button>' : ''}
      <button class="btn-chico" data-acc="duplicar">${plantilla ? 'Asignar a alumno' : 'Duplicar'}</button>
      ${plantilla || r.estado === 'borrador' ? '<button class="btn-chico" data-acc="eliminar">Eliminar</button>' : ''}
    </div></div>`;
}

/** Acciones de las filas de rutina (alumno y plantillas). `recargar` repinta la vista. */
function accionesRutinas(cont, recargar) {
  cont.addEventListener('click', e => intentar(async () => {
    const b = e.target.closest('[data-acc]');
    if (!b) return;
    const id = +b.closest('[data-rutina]').dataset.rutina;
    const acc = b.dataset.acc;
    if (acc === 'publicar') {
      if (!await confirmar('¿Publicar? El alumno la va a ver y, si tenía otra publicada, esa pasa a archivada.', { si: 'Publicar' })) return;
      await api('POST', `/api/rutinas/${id}/estado`, { estado: 'publicada' }); toast('Rutina publicada');
    } else if (acc === 'archivar') {
      await api('POST', `/api/rutinas/${id}/estado`, { estado: 'archivada' }); toast('Rutina archivada');
    } else if (acc === 'eliminar') {
      if (!await confirmar('¿Eliminar esta rutina? No se puede deshacer.', { si: 'Eliminar', peligro: true })) return;
      await api('DELETE', `/api/rutinas/${id}`); toast('Eliminada');
    } else if (acc === 'duplicar') {
      const copia = await dialogoDuplicar(id);
      if (copia) { location.hash = `#/rutinas/${copia.id}/editar`; return; }
      return;
    }
    await recargar();
  }));
}

async function dialogoDuplicar(rutinaId) {
  const alumnos = await api('GET', '/api/alumnos');
  return formulario('Copiar rutina',
    `<label class="campo">Destino<select name="destino">
       <option value="">Como plantilla</option>
       ${alumnos.map(a => `<option value="${a.id}">${esc(a.nombre)}</option>`).join('')}
     </select></label>` + campo('Título de la copia (opcional)', 'titulo'),
    { boton: 'Copiar', alEnviar: d => api('POST', `/api/rutinas/${rutinaId}/duplicar`,
        { alumno_id: d.destino ? +d.destino : null, titulo: d.titulo || null }) });
}

async function dialogoNuevaRutina(alumnoId) {
  const plantillas = await api('GET', '/api/plantillas');
  return formulario(alumnoId ? 'Nueva rutina' : 'Nueva plantilla',
    campo('Título', 'titulo', { extra: 'required placeholder="Ej. Noviembre — full body"' }) +
    (alumnoId ? campo('Desde', 'fecha_inicio', { tipo: 'date', valor: hoyISO() }) : '') +
    (plantillas.length ? `<label class="campo">Partir de<select name="plantilla">
       <option value="">Rutina vacía</option>${plantillas.map(p => `<option value="${p.id}">${esc(p.titulo)}</option>`).join('')}
     </select></label>` : ''),
    { boton: 'Crear', alEnviar: async d => {
      if (d.plantilla) {
        const r = await api('POST', `/api/rutinas/${d.plantilla}/duplicar`, { alumno_id: alumnoId, titulo: d.titulo });
        if (d.fecha_inicio) await api('PUT', `/api/rutinas/${r.id}`, { titulo: r.titulo, notas: r.notas, fecha_inicio: d.fecha_inicio, dias: r.dias });
        return r;
      }
      return api('POST', '/api/rutinas', { alumno_id: alumnoId, titulo: d.titulo, fecha_inicio: d.fecha_inicio || null, dias: [] });
    } });
}

async function dialogoImportar(alumnoId) {
  const res = await formulario('Importar planilla',
    `<p class="sub" style="margin-bottom:12px">En Google Sheets: <b>Archivo → Descargar → Microsoft Excel (.xlsx)</b>.
      Se lee la hoja «Entrenamiento» (días, bloques, superseries sombreadas) y, si viene, «Datos» actualiza el catálogo de ejercicios y videos.
      La rutina queda en borrador para que la revises antes de publicarla.</p>
     <label class="campo">Archivo .xlsx<input type="file" name="archivo" accept=".xlsx" required></label>` +
    campo('Título (si no, el nombre del archivo)', 'titulo'),
    { boton: 'Importar', alEnviar: async (d, f) => {
      const fd = new FormData(f);
      if (alumnoId) fd.append('alumno_id', alumnoId);
      return api('POST', '/api/importar/rutina', null, { form: fd });
    } });
  if (!res) return;
  S.catalogo = null;
  const avisos = res.avisos.length ? ` · ${res.avisos.length} avisos` : '';
  toast(`Importada: ${res.rutina.dias.length} días · ${res.ejercicios_nuevos} ejercicios nuevos${avisos}`);
  if (res.avisos.length) console.warn('Avisos de importación', res.avisos);
  location.hash = `#/rutinas/${res.rutina.id}/editar`;
}

async function vistaAlumno(id) {
  const [a, rutinas, entrenos] = await Promise.all([
    api('GET', `/api/alumnos/${id}`), api('GET', `/api/alumnos/${id}/rutinas`), api('GET', `/api/alumnos/${id}/entrenamientos`)]);
  main().innerHTML = `<a class="volver" href="#/alumnos">← Alumnos</a>
    <div class="titulo-fila"><div><h2>${esc(a.nombre)} ${a.activo ? '' : '<span class="badge archivada">de baja</span>'}</h2>
      <div class="sub">@${esc(a.usuario)}${a.telefono ? ` · ${esc(a.telefono)}` : ''}${a.email ? ` · ${esc(a.email)}` : ''} · Profe: ${esc(a.profesor_nombre || '')}</div></div>
      <div class="spacer"></div>
      <button class="btn-ghost" id="editar">Editar datos</button>
      <button class="btn-ghost" id="reset">Resetear contraseña</button></div>
    ${a.notas ? `<div class="notas-profe"><p style="margin:0">${esc(a.notas)}</p></div>` : ''}
    <div class="panel"><div class="titulo-fila" style="margin-bottom:10px"><h3 style="margin:0">Rutinas</h3><div class="spacer"></div>
      <button class="btn-ghost" id="importar">Importar planilla</button>
      <button class="btn btn-primario" id="nueva">+ Nueva rutina</button></div>
      <div class="lista" id="rutinas">${rutinas.map(htmlFilaRutina).join('') || '<div class="vacio">Sin rutinas todavía.</div>'}</div></div>
    <div class="panel"><h3>Entrenamientos registrados</h3>${htmlHistorial(entrenos)}</div>`;

  accionesRutinas($('#rutinas'), () => vistaAlumno(id));
  $('#nueva').onclick = async () => { const r = await dialogoNuevaRutina(id); if (r) location.hash = `#/rutinas/${r.id}/editar`; };
  $('#importar').onclick = () => dialogoImportar(id);
  $('#reset').onclick = () => intentar(async () => {
    if (!await confirmar(`¿Generar una contraseña nueva para ${a.nombre}? La actual deja de funcionar.`, { si: 'Resetear' })) return;
    const r = await api('POST', `/api/usuarios/${id}/resetear-clave`);
    mostrarClave(a.usuario, a.nombre, r.password_temporal, 'Contraseña nueva');
  });
  $('#editar').onclick = async () => {
    const selProfe = `<label class="campo">Profesor<select name="profesor_id">${await opcionesProfesores(a.profesor_id)}</select></label>`;
    const r = await formulario('Datos del alumno',
      campo('Nombre', 'nombre', { valor: a.nombre, extra: 'required' }) + campo('Teléfono', 'telefono', { valor: a.telefono || '' }) +
      campo('Email', 'email', { valor: a.email || '' }) + selProfe +
      campo('Notas internas (lesiones, objetivos — el alumno no las ve)', 'notas', { tipo: 'textarea', valor: a.notas || '' }) +
      `<label class="sub" style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="activo" ${a.activo ? 'checked' : ''}> Activo</label>`,
      { alEnviar: d => api('PUT', `/api/usuarios/${id}`, { ...d, profesor_id: +d.profesor_id, activo: d.activo === 'on' }) });
    if (r) { toast('Guardado'); r.profesor_id !== a.profesor_id && S.user.rol !== 'admin' ? location.hash = '#/alumnos' : vistaAlumno(id); }
  };
  ofrecerTour('alumno');
}

async function vistaRutinaStaff(id) {
  const r = await api('GET', `/api/rutinas/${id}`);
  const plantilla = r.alumno_id == null;
  const cargas = plantilla ? {} : await api('GET', `/api/rutinas/${id}/ultimas-cargas`);
  main().innerHTML = `<a class="volver" href="${plantilla ? '#/plantillas' : `#/alumnos/${r.alumno_id}`}">← ${plantilla ? 'Plantillas' : esc(r.alumno_nombre)}</a>
    <div class="titulo-fila"><div><h2>${esc(r.titulo)} <span class="badge ${plantilla ? 'plantilla' : r.estado}">${plantilla ? 'plantilla' : r.estado}</span></h2>
      <div class="sub">${plantilla ? 'Plantilla' : `Para ${esc(r.alumno_nombre)}`} · ${esc(r.profesor_nombre)}${r.fecha_inicio ? ` · desde ${fecha(r.fecha_inicio)}` : ''}</div></div>
      <div class="spacer"></div><a class="btn btn-primario" href="#/rutinas/${id}/editar">Editar</a></div>
    ${htmlNotas(r, true)}`;
  montarRutina(main(), r, { claveDia: `dia_staff_${id}`, cargas });
  const porId = itemsPorId(r.dias);
  main().addEventListener('click', e => {
    const n = e.target.closest('[data-info]');
    if (n) abrirInfo(porId[+n.dataset.info], { cargas });
  });
  ofrecerTour('vista-previa');
}

async function vistaPlantillas() {
  const pintar = async () => {
    const lista = await api('GET', '/api/plantillas');
    $('#lista').innerHTML = lista.map(htmlFilaRutina).join('') ||
      '<div class="vacio">Una plantilla es una rutina sin alumno: la armás una vez y la asignás a quien quieras.</div>';
  };
  main().innerHTML = `<div class="titulo-fila"><h2>Plantillas</h2><div class="spacer"></div>
      <button class="btn-ghost" id="importar">Importar planilla</button>
      <button class="btn btn-primario" id="nueva">+ Nueva plantilla</button></div>
    <div class="lista" id="lista"></div>`;
  accionesRutinas($('#lista'), pintar);
  $('#nueva').onclick = async () => { const r = await dialogoNuevaRutina(null); if (r) location.hash = `#/rutinas/${r.id}/editar`; };
  $('#importar').onclick = () => dialogoImportar(null);
  await pintar();
  ofrecerTour('plantillas');
}

/** Cambia la miniatura de un ejercicio: un cuadro de un video (un archivo que tenga el profe, porque
 * del video de Drive/YouTube el navegador no deja copiar cuadros), una imagen, o volver a la automática.
 * Se achica acá antes de subirla. Resuelve true si cambió algo. */
function editarMiniatura(ej) {
  return new Promise(res => {
    const auto = urlMiniatura(null, ej.video_url);
    const actual = urlMiniatura(ej.miniatura, ej.video_url);
    const origen = ej.miniatura ? 'Elegida a mano.'
      : auto ? `Automática: la que genera ${idVideo(ej.video_url).drive ? 'Drive' : 'YouTube'} para el video.`
      : 'Todavía no tiene: el ejercicio no tiene un video de Drive o YouTube.';
    const m = modal(`<div class="titulo-fila" style="margin-bottom:8px;flex-wrap:nowrap">
        <h3 style="margin:0;flex:1">Miniatura · ${esc(ej.nombre)}</h3><button class="btn-chico" data-cerrar>✕</button></div>
      <div class="mini-grande" id="mini-actual">${actual
        ? `<img src="${esc(actual)}" alt="" onerror="this.replaceWith('No se puede ver (¿el video de Drive no está compartido?)')">` : 'Sin miniatura'}</div>
      <p class="sub" id="mini-origen">${origen}</p>
      <div id="cuadro" hidden>
        <video muted playsinline preload="auto"></video>
        <input type="range" min="0" max="0" step="0.05" value="0" aria-label="Momento del video">
        <p class="sub">Mové la barra hasta el momento que mejor muestre el ejercicio.</p>
      </div>
      <div class="pie mini-opciones">
        ${ej.miniatura ? `<button class="btn-ghost" data-auto style="margin-right:auto">${auto ? 'Volver a la automática' : 'Quitar'}</button>` : ''}
        <label class="btn-ghost">Sacar un cuadro de un video<input type="file" accept="video/*" hidden data-archivo-video></label>
        <label class="btn-ghost">Subir una imagen<input type="file" accept="image/*" hidden data-archivo-imagen></label>
        <button class="btn btn-primario" data-usar hidden>Usar este cuadro</button>
      </div>`, { ancho: true, enfocar: false });
    const video = $('#cuadro video', m), barra = $('#cuadro input', m);
    const listo = () => { if (video.src) URL.revokeObjectURL(video.src); cerrarModal(); res(true); };

    const achicar = (fuente, ancho, alto) => new Promise((ok, mal) => {
      const k = Math.min(1, 480 / ancho);
      const c = document.createElement('canvas');
      c.width = Math.round(ancho * k); c.height = Math.round(alto * k);
      c.getContext('2d').drawImage(fuente, 0, 0, c.width, c.height);
      c.toBlob(b => (b ? ok(b) : mal(new Error('No se pudo generar la imagen'))), 'image/jpeg', 0.85);
    });
    const subir = async blob => {
      const f = new FormData();
      f.append('archivo', blob, 'miniatura.jpg');
      await api('POST', `/api/ejercicios/${ej.id}/miniatura`, null, { form: f });
      toast('Miniatura guardada');
      listo();
    };

    $('[data-cerrar]', m).onclick = cerrarModal;
    $('[data-archivo-imagen]', m).onchange = ev => intentar(async () => {
      const archivo = ev.target.files[0];
      if (!archivo) return;
      let img;
      try { img = await createImageBitmap(archivo); } catch { throw new Error('No se pudo leer esa imagen'); }
      await subir(await achicar(img, img.width, img.height));
    });
    $('[data-archivo-video]', m).onchange = ev => {
      const archivo = ev.target.files[0];
      if (!archivo) return;
      if (video.src) URL.revokeObjectURL(video.src);
      video.src = URL.createObjectURL(archivo);
      video.onloadedmetadata = () => {
        barra.max = video.duration;
        barra.value = video.currentTime = video.duration * 0.3;
        $('#cuadro', m).hidden = false;
        $('#mini-actual', m).hidden = $('#mini-origen', m).hidden = true;
        $('[data-usar]', m).hidden = false;
      };
      video.onerror = () => toast('Este navegador no puede abrir ese video', true);
    };
    barra.oninput = () => { video.currentTime = +barra.value; };
    $('[data-usar]', m).onclick = () => intentar(async () => subir(await achicar(video, video.videoWidth, video.videoHeight)));
    $('[data-auto]', m)?.addEventListener('click', () => intentar(async () => {
      await api('DELETE', `/api/ejercicios/${ej.id}/miniatura`);
      toast(auto ? 'Volvió a la miniatura automática' : 'Miniatura quitada');
      listo();
    }));
  });
}

async function vistaEjercicios() {
  const grupos = await api('GET', '/api/ejercicios/grupos');
  main().innerHTML = `<div class="titulo-fila"><h2>Ejercicios</h2><div class="spacer"></div>
      <button class="btn-ghost" id="importar">Importar catálogo</button>
      <button class="btn btn-primario" id="nuevo">+ Nuevo ejercicio</button></div>
    <div class="buscador"><input type="search" id="q" placeholder="Número o nombre…">
      <select id="grupo"><option value="">Todos los grupos</option>${grupos.map(g => `<option>${esc(g)}</option>`).join('')}</select>
      <label class="sub" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="inactivos"> Ver dados de baja</label></div>
    <div class="panel" style="padding:4px 8px;overflow-x:auto"><table class="tabla"><thead><tr><th>#</th><th>Miniatura</th><th>Ejercicio</th><th>Grupo</th><th>Video</th><th></th></tr></thead>
      <tbody id="filas"></tbody></table></div>
    <datalist id="dl-grupos">${grupos.map(g => `<option value="${esc(g)}">`).join('')}</datalist>`;

  let lista = [];
  const pintar = async () => {
    const p = new URLSearchParams();
    if ($('#grupo').value) p.set('grupo', $('#grupo').value);
    if ($('#inactivos').checked) p.set('inactivos', 'true');
    lista = await api('GET', `/api/ejercicios?${p}`);
    const q = normalizar($('#q').value.trim());
    const ver = lista.filter(e => !q || String(e.numero) === q || normalizar(e.nombre).includes(q));
    $('#filas').innerHTML = ver.map(e => `<tr style="${e.activo ? '' : 'opacity:.5'}">
      <td class="num">${e.numero ?? ''}</td>
      <td><button class="btn-mini" data-miniatura="${e.id}" title="Cambiar la miniatura">${
        urlMiniatura(e.miniatura, e.video_url)
          ? `<img src="${esc(urlMiniatura(e.miniatura, e.video_url))}" alt="" loading="lazy" onerror="this.replaceWith('Elegir')">` : 'Elegir'}</button></td>
      <td>${esc(e.nombre)}${e.descripcion ? `<div class="sub">${esc(e.descripcion)}</div>` : ''}</td>
      <td class="sub">${esc(e.grupo || '')}</td>
      <td>${e.video_url ? `<button class="btn-chico" data-video="${esc(e.video_url)}" data-titulo="${esc(e.nombre)}">▶ Ver</button>` : '<span class="sub">—</span>'}</td>
      <td><button class="btn-chico" data-editar="${e.id}">Editar</button></td></tr>`).join('')
      || '<tr><td colspan="6" class="vacio">No hay ejercicios. Importá el catálogo desde la planilla o cargalos a mano.</td></tr>';
  };
  let t;
  $('#q').oninput = () => { clearTimeout(t); t = setTimeout(pintar, 200); };
  $('#grupo').onchange = pintar;
  $('#inactivos').onchange = pintar;

  const editar = async (e = {}) => {
    const r = await formulario(e.id ? 'Editar ejercicio' : 'Nuevo ejercicio',
      campo('Número (vacío = el siguiente libre)', 'numero', { tipo: 'number', valor: e.numero ?? '', extra: 'min="1"' }) +
      campo('Nombre', 'nombre', { valor: e.nombre || '', extra: 'required' }) +
      campo('Grupo', 'grupo', { valor: e.grupo || '', extra: 'list="dl-grupos"' }) +
      campo('Link al video (Drive o YouTube)', 'video_url', { valor: e.video_url || '', extra: 'placeholder="https://drive.google.com/file/d/…"' }) +
      campo('Descripción / técnica', 'descripcion', { tipo: 'textarea', valor: e.descripcion || '' }) +
      `<label class="sub" style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="activo" ${e.activo === 0 ? '' : 'checked'}> Activo (aparece al armar rutinas)</label>`,
      { alEnviar: d => {
        const body = { ...d, numero: d.numero ? +d.numero : null, activo: d.activo === 'on' };
        return e.id ? api('PUT', `/api/ejercicios/${e.id}`, body) : api('POST', '/api/ejercicios', body);
      } });
    if (r) { S.catalogo = null; toast('Guardado'); pintar(); }
  };
  $('#nuevo').onclick = () => editar();
  $('#filas').onclick = async e => {
    const b = e.target.closest('[data-editar]');
    if (b) editar(lista.find(x => x.id === +b.dataset.editar));
    const m = e.target.closest('[data-miniatura]');
    if (m && await editarMiniatura(lista.find(x => x.id === +m.dataset.miniatura))) { S.catalogo = null; pintar(); }
  };
  $('#importar').onclick = async () => {
    const r = await formulario('Importar catálogo',
      `<p class="sub" style="margin-bottom:12px">Descargá la planilla como .xlsx. Se lee la hoja «Datos»: grupo, número, nombre y el link del video.
        Los ejercicios se actualizan por número; un video cargado a mano no se pisa si la planilla no trae uno.</p>
       <label class="campo">Archivo .xlsx<input type="file" name="archivo" accept=".xlsx" required></label>`,
      { boton: 'Importar', alEnviar: (d, f) => api('POST', '/api/importar/catalogo', null, { form: new FormData(f) }) });
    if (r) { S.catalogo = null; toast(`${r.ejercicios_nuevos} nuevos, ${r.ejercicios_actualizados} actualizados`); vistaEjercicios(); }
  };
  await pintar();
  ofrecerTour('ejercicios');
}

async function vistaProfesores() {
  const pintar = async () => {
    const lista = await api('GET', '/api/profesores');
    $('#lista').innerHTML = lista.map(p => `<div class="fila" style="${p.activo ? '' : 'opacity:.5'}">
      <div class="principal"><div class="nombre">${esc(p.nombre)} ${p.rol === 'admin' ? '<span class="badge plantilla">admin</span>' : ''}</div>
        <div class="sub">@${esc(p.usuario)} · ${p.alumnos} alumnos activos</div></div>
      ${p.id !== S.user.id ? `<div class="acciones"><button class="btn-chico" data-reset="${p.id}">Resetear contraseña</button>
        <button class="btn-chico" data-baja="${p.id}" data-activo="${p.activo}">${p.activo ? 'Dar de baja' : 'Reactivar'}</button></div>` : ''}
      </div>`).join('');
    $('#lista').onclick = e => intentar(async () => {
      const r = e.target.closest('[data-reset]'), b = e.target.closest('[data-baja]');
      if (r) {
        const p = lista.find(x => x.id === +r.dataset.reset);
        const res = await api('POST', `/api/usuarios/${p.id}/resetear-clave`);
        mostrarClave(p.usuario, p.nombre, res.password_temporal, 'Contraseña nueva');
      }
      if (b) { await api('PUT', `/api/usuarios/${b.dataset.baja}`, { activo: b.dataset.activo !== '1' }); pintar(); }
    });
  };
  main().innerHTML = `<div class="titulo-fila"><h2>Profesores</h2><div class="spacer"></div>
    <button class="btn btn-primario" id="nuevo">+ Nuevo profesor</button></div><div class="lista" id="lista"></div>`;
  $('#nuevo').onclick = async () => {
    const p = await formulario('Nuevo profesor',
      campo('Nombre', 'nombre', { extra: 'required' }) + campo('Usuario', 'usuario', { extra: 'required pattern="\\S+" autocapitalize="none"' }) +
      campo('Teléfono', 'telefono') + campo('Email', 'email'),
      { boton: 'Crear', alEnviar: d => api('POST', '/api/profesores', d) });
    if (p) { mostrarClave(p.usuario, p.nombre, p.password_temporal); pintar(); }
  };
  await pintar();
  ofrecerTour('profesores');
}

// ══ 6. Editor ═══════════════════════════════════════════════════════════════

const COLORES_DIA = ['#fce5cd', '#d9d2e9', '#c9daf8', '#d9ead3', '#fff2cc', '#f4cccc', '#d0e0e3'];
const BLOQUES_ESTANDAR = ['Entrada en calor', 'Trabajo del día', 'Elongación'];

async function catalogo() {
  if (!S.catalogo) S.catalogo = await api('GET', '/api/ejercicios');
  return S.catalogo;
}

/** Cómo se prescribe un ejercicio (espejo de app/services/prescripcion.py):
 * «reps» = series × repeticiones (o rango reps–reps_max), «tiempo» = series × segundos,
 * «libre» = texto tal cual (al fallo, 12-10-8…). por_lado = la cantidad es por cada lado. */
const MODALIDADES = [['reps', 'Series × repeticiones'], ['tiempo', 'Series × tiempo'], ['libre', 'Texto libre']];
const CAMPOS_PRESC = ['modalidad', 'series', 'reps', 'reps_max', 'segundos', 'por_lado', 'peso_kg'];
function duracionTexto(seg) {
  const m = Math.floor(seg / 60), s = seg % 60;
  return !m ? `${s} seg` : s ? `${m} min ${s} seg` : `${m} min`;
}
function textoPrescripcion(it) {
  const series = it.series || 1;
  let t;
  if (it.modalidad === 'reps' && it.reps) {
    const reps = it.reps_max ? `${it.reps}–${it.reps_max}` : `${it.reps}`;
    t = series > 1 ? `${series} × ${reps} reps` : `${reps} reps`;
  } else if (it.modalidad === 'tiempo' && it.segundos) {
    t = series > 1 ? `${series} × ${duracionTexto(it.segundos)}` : duracionTexto(it.segundos);
  } else return it.modalidad === 'libre' ? (it.prescripcion || '') : '';
  return t + (it.por_lado ? ' c/lado' : '');
}

/** La API guarda superserie como número de grupo; el editor la maneja como "unido al anterior". */
function aEditor(r) {
  for (const d of r.dias) for (const b of d.bloques) b.items.forEach((it, i) => {
    it._unido = i > 0 && it.superserie != null && b.items[i - 1].superserie === it.superserie;
    it.modalidad = it.modalidad || 'libre';
  });
  return r;
}
function aApi(dias) {
  let grupo = 0;
  return dias.map(d => ({
    id: d.id, nombre: d.nombre, color: d.color,
    bloques: d.bloques.map(b => {
      const items = b.items.map(it => ({ id: it.id, ejercicio_id: it.ejercicio_id || null, nombre_libre: it.ejercicio_id ? null : it.nombre_libre,
        prescripcion: it.modalidad === 'libre' ? it.prescripcion : null, comentario: it.comentario, superserie: null,
        ...Object.fromEntries(CAMPOS_PRESC.map(c => [c, it[c] ?? null])) }));
      b.items.forEach((it, i) => {
        if (it._unido && i > 0) {
          if (items[i - 1].superserie == null) items[i - 1].superserie = ++grupo;
          items[i].superserie = items[i - 1].superserie;
        }
      });
      return { id: b.id, nombre: b.nombre, detalle: b.detalle, prescripcion: b.prescripcion, comentario: b.comentario, items };
    }),
  }));
}

const etiquetaEjercicio = it => it.ejercicio_id ? `${it.ejercicio_numero ?? ''} · ${it.ejercicio_nombre}` : (it.nombre_libre || '');

async function vistaEditor(id) {
  const [r0, cat] = await Promise.all([api('GET', `/api/rutinas/${id}`), catalogo()]);
  let R = aEditor(r0);
  const catActivo = cat.filter(e => e.activo);
  const porId = Object.fromEntries(cat.map(e => [e.id, e]));
  const plantilla = R.alumno_id == null;
  const marcarSucio = () => { S.sucio = true; $('#estado-guardado').textContent = 'Cambios sin guardar'; };

  const vistaAlumno = it => [it.modalidad !== 'libre' ? textoPrescripcion(it) : it.prescripcion,
    it.peso_kg ? `con ${kg(it.peso_kg)}` : null].filter(Boolean).join(' · ');

  /** Prescripción del ítem: primero la modalidad, y según ella los números que pide. */
  const htmlPrescEd = (it, p) => {
    const num = (campo, ph, etiqueta, ancho = '') => `<input type="number" inputmode="numeric" min="1" step="1" class="num ${ancho}"
      data-n="${p}.${campo}" value="${it[campo] ?? ''}" placeholder="${ph}" aria-label="${etiqueta}" title="${etiqueta}">`;
    const lado = `<label class="lado" title="La cantidad es por cada lado (ejercicio unilateral)">
      <input type="checkbox" data-c="${p}.por_lado" ${it.por_lado ? 'checked' : ''}> c/lado</label>`;
    let campos;
    if (it.modalidad === 'reps') {
      campos = `${num('series', '3', 'Series')}<span class="x">×</span>${num('reps', '10', 'Repeticiones')}
        <span class="x" title="Rango opcional">a</span>${num('reps_max', '—', 'Repeticiones hasta (opcional, para un rango como 8 a 12)')}
        <span class="u">reps</span>${lado}`;
    } else if (it.modalidad === 'tiempo') {
      campos = `${num('series', '3', 'Series')}<span class="x">×</span>${num('segundos', '30', 'Segundos por serie', 'ancho')}
        <span class="u">seg</span>${lado}`;
    } else {
      campos = `<input type="text" data-f="${p}.prescripcion" value="${esc(it.prescripcion || '')}"
        placeholder="Al fallo, 12-10-8, AMRAP…" aria-label="Prescripción en texto libre">`;
    }
    const vista = vistaAlumno(it);
    const peso = `<label class="peso" title="Peso indicado (opcional). El alumno lo ve y lo puede cambiar al registrar.">Peso
      <input type="text" inputmode="decimal" class="num ancho" data-kg="${p}.peso_kg" value="${it.peso_kg != null ? String(it.peso_kg).replace('.', ',') : ''}"
        placeholder="—" aria-label="Peso indicado en kilos (opcional)"> kg</label>`;
    return `<div class="presc-ed" data-presc="${p}">
      <select data-m="${p}" aria-label="Cómo se prescribe">${MODALIDADES.map(([v, t]) =>
        `<option value="${v}" ${it.modalidad === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <div class="presc-campos">${campos}</div>
      <div class="presc-campos">${peso}</div>
      <div class="presc-vista sub" data-vista="${p}" aria-live="polite">${vista ? `El alumno ve: <b>${esc(vista)}</b>` : ''}</div>
    </div>`;
  };

  const htmlItemEd = (it, d, b, i) => `<div class="ed-item ${it._unido ? 'unido' : ''}">
    <span class="idx">${i + 1}</span>
    <div class="picker"><input type="text" class="sel" data-picker="${d}.${b}.${i}" value="${esc(etiquetaEjercicio(it))}"
      placeholder="N° o nombre del ejercicio" autocomplete="off"></div>
    ${htmlPrescEd(it, `${d}.${b}.${i}`)}
    <input type="text" data-f="${d}.${b}.${i}.comentario" value="${esc(it.comentario || '')}" placeholder="Comentario / técnica">
    <div class="acciones">
      ${i > 0 ? `<button class="btn-chico btn-sombra ${it._unido ? 'on' : ''}" data-a="unir" data-p="${d}.${b}.${i}" title="Superserie con el anterior">⛓</button>` : '<span style="width:30px"></span>'}
      <button class="btn-chico" data-a="item-subir" data-p="${d}.${b}.${i}" title="Subir">↑</button>
      <button class="btn-chico" data-a="item-bajar" data-p="${d}.${b}.${i}" title="Bajar">↓</button>
      <button class="btn-chico" data-a="item-quitar" data-p="${d}.${b}.${i}" title="Quitar">✕</button>
    </div></div>`;

  const htmlBloqueEd = (bl, d, b) => `<div class="ed-bloque">
    <div class="cab">
      <input type="text" data-f="${d}.${b}.nombre" value="${esc(bl.nombre)}" placeholder="Bloque (Entrada en calor…)">
      <input type="text" data-f="${d}.${b}.detalle" value="${esc(bl.detalle || '')}" placeholder="Detalle (Full body…)">
      <div class="acciones" style="display:flex;gap:3px">
        <button class="btn-chico" data-a="bloque-subir" data-p="${d}.${b}">↑</button>
        <button class="btn-chico" data-a="bloque-bajar" data-p="${d}.${b}">↓</button>
        <button class="btn-chico" data-a="bloque-quitar" data-p="${d}.${b}">✕</button></div>
    </div>
    <div class="extra">
      <input type="text" data-f="${d}.${b}.prescripcion" value="${esc(bl.prescripcion || '')}" placeholder="Tiempo (10´)">
      <input type="text" data-f="${d}.${b}.comentario" value="${esc(bl.comentario || '')}" placeholder="Indicación del bloque (opcional)">
    </div>
    ${bl.items.map((it, i) => htmlItemEd(it, d, b, i)).join('')}
    <button class="btn-chico" data-a="item-agregar" data-p="${d}.${b}" style="margin-top:6px">+ Ejercicio</button>
  </div>`;

  const htmlDiaEd = (dia, d) => `<div class="ed-dia">
    <div class="cab" style="border-left:6px solid ${esc(dia.color || 'transparent')};border-radius:10px 0 0 0">
      <input type="text" data-f="${d}.nombre" value="${esc(dia.nombre)}">
      <input type="color" data-f="${d}.color" value="${esc(dia.color || '#30363d')}" title="Color del día">
      <button class="btn-chico" data-a="dia-subir" data-p="${d}">↑</button>
      <button class="btn-chico" data-a="dia-bajar" data-p="${d}">↓</button>
      <button class="btn-chico" data-a="dia-copiar" data-p="${d}">Duplicar día</button>
      <button class="btn-chico" data-a="dia-quitar" data-p="${d}">Quitar día</button>
    </div>
    <div class="cuerpo">${dia.bloques.map((bl, b) => htmlBloqueEd(bl, d, b)).join('')}
      <button class="btn-chico" data-a="bloque-agregar" data-p="${d}">+ Bloque</button></div>
  </div>`;

  const pintarDias = () => {
    $('#ed-dias').innerHTML = R.dias.map(htmlDiaEd).join('') || '<div class="vacio">Agregá el primer día.</div>';
  };

  main().innerHTML = `<a class="volver" href="#/rutinas/${id}">← Vista previa</a>
    <div class="titulo-fila"><div><h2>Editar ${plantilla ? 'plantilla' : 'rutina'}
      ${plantilla ? '<span class="badge plantilla">plantilla</span>' : `<span class="badge ${R.estado}">${R.estado}</span>`}</h2>
      <div class="sub">${plantilla ? 'Sin alumno: se asigna copiándola' : `Para ${esc(R.alumno_nombre)}`} · <span id="estado-guardado">Guardado</span></div></div></div>
    <div class="panel">
      <div class="grid2">${campo('Título', 'titulo', { valor: R.titulo, extra: 'data-r="titulo"' })}
        ${plantilla ? '' : campo('Desde', 'fecha_inicio', { tipo: 'date', valor: R.fecha_inicio || '', extra: 'data-r="fecha_inicio"' })}</div>
      ${campo('Indicaciones generales para el alumno (descanso, hidratación, objetivo del mes…)', 'notas', { tipo: 'textarea', valor: R.notas || '', extra: 'data-r="notas" rows="5"' })}
    </div>
    <div id="ed-dias"></div>
    <button class="btn-ghost" data-a="dia-agregar">+ Agregar día</button>
    <div class="barra-guardar">
      ${!plantilla && R.estado !== 'publicada' ? '<button class="btn-ghost" id="publicar">Guardar y publicar</button>' : ''}
      <button class="btn btn-primario" id="guardar">Guardar</button></div>`;
  pintarDias();

  const ruta = p => p.split('.').map(Number);
  const mover = (arr, i, delta) => { const j = i + delta; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; };
  const nuevoBloque = nombre => ({ nombre, detalle: null, prescripcion: null, comentario: null, items: [] });
  const sinIds = o => JSON.parse(JSON.stringify(o, (k, v) => (k === 'id' ? undefined : v)));

  const itemDe = p => { const [d, b, i] = ruta(p); return R.dias[d].bloques[b].items[i]; };
  const refrescarVista = p => {
    const it = itemDe(p), v = $(`[data-vista="${p}"]`), txt = vistaAlumno(it);
    if (v) v.innerHTML = txt ? `El alumno ve: <b>${esc(txt)}</b>` : '';
  };

  main().oninput = e => {
    const t = e.target;
    if (t.dataset.r) { R[t.dataset.r] = t.value; marcarSucio(); return; }
    if (t.dataset.m) {  // cambio de modalidad: se redibuja para mostrar los campos que corresponden
      const it = itemDe(t.dataset.m);
      // Al pasar a texto libre se arranca con lo que ya estaba cargado («3 × 10 reps»), para retocarlo.
      if (t.value === 'libre' && !it.prescripcion) it.prescripcion = textoPrescripcion(it);
      it.modalidad = t.value;
      pintarDias(); marcarSucio();
      $(`[data-m="${t.dataset.m}"]`)?.focus();
      return;
    }
    if (t.dataset.n) {
      const partes = t.dataset.n.split('.'), campoN = partes.pop(), it = itemDe(partes.join('.'));
      it[campoN] = t.value === '' ? null : Math.max(1, Math.round(+t.value));
      refrescarVista(partes.join('.')); marcarSucio(); return;
    }
    if (t.dataset.kg) {  // peso: admite coma decimal; lo que no es un número queda vacío
      const partes = t.dataset.kg.split('.'), campoK = partes.pop(), it = itemDe(partes.join('.'));
      const n = parseFloat(t.value.replace(',', '.'));
      it[campoK] = Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
      refrescarVista(partes.join('.')); marcarSucio(); return;
    }
    if (t.dataset.c) {
      const partes = t.dataset.c.split('.'), campoC = partes.pop(), it = itemDe(partes.join('.'));
      it[campoC] = t.checked ? 1 : 0;
      refrescarVista(partes.join('.')); marcarSucio(); return;
    }
    if (t.dataset.f) {
      const partes = t.dataset.f.split('.'), campoF = partes.pop(), [d, b, i] = partes.map(Number);
      const obj = i != null ? R.dias[d].bloques[b].items[i] : b != null ? R.dias[d].bloques[b] : R.dias[d];
      obj[campoF] = t.value;
      if (campoF === 'color') t.closest('.cab').style.borderLeftColor = t.value;
      marcarSucio();
    }
  };

  main().onclick = e => {
    const btn = e.target.closest('[data-a]');
    if (!btn) return;
    const [d, b, i] = btn.dataset.p ? ruta(btn.dataset.p) : [];
    const dias = R.dias;
    switch (btn.dataset.a) {
      case 'dia-agregar': {
        const n = dias.length;
        dias.push({ nombre: `Día ${n + 1}`, color: COLORES_DIA[n % COLORES_DIA.length], bloques: BLOQUES_ESTANDAR.map(nuevoBloque) });
        break;
      }
      case 'dia-copiar': dias.splice(d + 1, 0, { ...sinIds(dias[d]), nombre: `${dias[d].nombre} (copia)` }); break;
      case 'dia-quitar':
        if (dias[d].bloques.some(x => x.items.length) && !window.confirm(`¿Quitar «${dias[d].nombre}» con todos sus ejercicios?`)) return;
        dias.splice(d, 1); break;
      case 'dia-subir': mover(dias, d, -1); break;
      case 'dia-bajar': mover(dias, d, 1); break;
      case 'bloque-agregar': dias[d].bloques.push(nuevoBloque('Bloque')); break;
      case 'bloque-quitar':
        if (dias[d].bloques[b].items.length && !window.confirm('¿Quitar el bloque con sus ejercicios?')) return;
        dias[d].bloques.splice(b, 1); break;
      case 'bloque-subir': mover(dias[d].bloques, b, -1); break;
      case 'bloque-bajar': mover(dias[d].bloques, b, 1); break;
      case 'item-agregar': {
        dias[d].bloques[b].items.push({ ejercicio_id: null, nombre_libre: null, prescripcion: '', comentario: '', _unido: false,
          modalidad: 'reps', series: null, reps: null, reps_max: null, segundos: null, por_lado: 0, peso_kg: null });
        pintarDias(); marcarSucio();
        $(`[data-picker="${d}.${b}.${dias[d].bloques[b].items.length - 1}"]`)?.focus();
        return;
      }
      case 'item-quitar': dias[d].bloques[b].items.splice(i, 1); break;
      case 'item-subir': mover(dias[d].bloques[b].items, i, -1); break;
      case 'item-bajar': mover(dias[d].bloques[b].items, i, 1); break;
      case 'unir': dias[d].bloques[b].items[i]._unido = !dias[d].bloques[b].items[i]._unido; break;
      default: return;
    }
    // El primer ítem de un bloque no puede estar "unido al anterior".
    for (const dd of dias) for (const bb of dd.bloques) if (bb.items[0]) bb.items[0]._unido = false;
    pintarDias(); marcarSucio();
  };

  // ── Selector de ejercicios: escribir el número (como en la planilla) o parte del nombre.
  let lista = null, foco = 0, opciones = [];
  const cerrarLista = () => { lista?.remove(); lista = null; };
  const elegir = (input, op) => {
    const [d, b, i] = ruta(input.dataset.picker);
    const it = R.dias[d].bloques[b].items[i];
    if (op.libre != null) { Object.assign(it, { ejercicio_id: null, nombre_libre: op.libre, ejercicio_numero: null, ejercicio_nombre: null }); }
    else { Object.assign(it, { ejercicio_id: op.id, nombre_libre: null, ejercicio_numero: op.numero, ejercicio_nombre: op.nombre, video_url: op.video_url }); }
    input.value = etiquetaEjercicio(it);
    cerrarLista(); marcarSucio();
    input.closest('.ed-item').querySelector('.presc-ed select')?.focus();
  };
  const pintarLista = input => {
    const q = input.value.trim(), nq = normalizar(q);
    opciones = !q ? [] : [
      ...catActivo.filter(e => String(e.numero) === q),
      ...catActivo.filter(e => String(e.numero) !== q && normalizar(e.nombre).includes(nq)),
    ].slice(0, 12);
    if (q && !/^\d+$/.test(q)) opciones.push({ libre: q });
    foco = 0;
    cerrarLista();
    if (!opciones.length) return;
    lista = document.createElement('div');
    lista.className = 'picker-lista';
    lista.innerHTML = opciones.map((o, k) => o.libre != null
      ? `<button type="button" data-k="${k}"><span class="n">✎</span>Usar «${esc(o.libre)}» como texto libre</button>`
      : `<button type="button" data-k="${k}" class="${k === 0 ? 'foco' : ''}"><span class="n">${o.numero ?? ''}</span>${esc(o.nombre)}<span class="g">${esc(o.grupo || '')}${o.video_url ? ' ▶' : ''}</span></button>`).join('');
    lista.onmousedown = ev => { ev.preventDefault(); const k = ev.target.closest('[data-k]'); if (k) elegir(input, opciones[+k.dataset.k]); };
    input.parentElement.appendChild(lista);
  };
  main().addEventListener('input', e => { if (e.target.dataset.picker) pintarLista(e.target); });
  main().addEventListener('focusin', e => { if (e.target.dataset.picker) e.target.select(); });
  main().addEventListener('focusout', e => {
    const t = e.target;
    if (!t.dataset.picker) return;
    cerrarLista();
    const [d, b, i] = ruta(t.dataset.picker);
    const it = R.dias[d]?.bloques[b]?.items[i];
    if (it) t.value = etiquetaEjercicio(it);  // texto a medio escribir → vuelve a lo elegido
  });
  main().addEventListener('keydown', e => {
    if (!e.target.dataset.picker || !lista) return;
    const botones = $$('button', lista);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      foco = (foco + (e.key === 'ArrowDown' ? 1 : -1) + botones.length) % botones.length;
      botones.forEach((x, k) => x.classList.toggle('foco', k === foco));
    } else if (e.key === 'Enter') { e.preventDefault(); elegir(e.target, opciones[foco]); }
  });

  const guardar = async ({ publicar = false } = {}) => {
    const btns = $$('#guardar, #publicar');
    btns.forEach(x => { x.disabled = true; });
    try {
      const r = await api('PUT', `/api/rutinas/${id}`, { titulo: R.titulo, notas: R.notas, fecha_inicio: R.fecha_inicio || null, dias: aApi(R.dias) });
      R = aEditor(r);  // ids nuevos de lo recién insertado
      S.sucio = false;
      if (publicar) {
        await api('POST', `/api/rutinas/${id}/estado`, { estado: 'publicada' });
        toast('Guardada y publicada');
        location.hash = `#/alumnos/${R.alumno_id}`;
        return;
      }
      pintarDias();
      $('#estado-guardado').textContent = 'Guardado';
      toast('Rutina guardada');
    } catch (err) { toast(err.message, true); }
    finally { btns.forEach(x => { x.disabled = false; }); }
  };
  $('#guardar').onclick = () => guardar();
  $('#publicar')?.addEventListener('click', async () => {
    if (await confirmar('¿Guardar y publicar? El alumno la va a ver y la que tenía publicada pasa a archivada.', { si: 'Publicar' })) guardar({ publicar: true });
  });
  // Ctrl+S guarda
  main().addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); guardar(); } });
  ofrecerTour('editor');
}

// ══ 7. Recorridos de cada pantalla ═══════════════════════════════════════════
// Motor en la sección 1b. Un paso cuyo elemento no está en pantalla se saltea
// solo, así que se pueden describir cosas que no siempre aparecen (superseries,
// la primera fila de una lista vacía).

const primerVisible = sel => $$(sel).find(el => el.offsetWidth) || null;

const TOURS = {
  // ── Alumno ──
  'mi-rutina': [
    { titulo: 'Esta es tu rutina',
      texto: 'Tu profe te armó un plan que se <b>repite</b>: cada día de la rutina lo vas a hacer varias veces (por ejemplo, 3 días por semana durante 4 semanas). Te muestro cómo usarla en un minuto.' },
    { sel: '.notas-profe', titulo: 'Indicaciones de tu profe',
      texto: 'Descansos, hidratación, el objetivo del mes… Leelas antes de empezar. Tocá el título para plegarlas o desplegarlas.' },
    { sel: '.tabs-dias', titulo: 'Los días de entrenamiento',
      texto: 'Cada pestaña es un día de la rutina. Elegí el que te toca hoy.' },
    { buscar: () => primerVisible('.dias-wrap .bloque-titulo'), titulo: 'Bloques',
      texto: 'Cada día se divide en bloques: <b>Entrada en calor</b>, <b>Trabajo del día</b> y <b>Elongación</b>. Hacelos en ese orden.' },
    { buscar: () => primerVisible('.dias-wrap .item'), titulo: 'Cada ejercicio',
      texto: 'El número es el del catálogo, abajo van las <b>series x repeticiones</b> (<b>´´</b> son segundos: 3x15´´ = 3 series de 15 segundos) y el comentario de tu profe. Acá los ves en gris: se activan cuando tocás <b>Empezar</b>, y ahí tenés el video y la ficha de cada uno.' },
    { buscar: () => primerVisible('.dias-wrap .superserie'), titulo: 'Superseries',
      texto: 'Los ejercicios dentro de este recuadro se hacen <b>seguidos, sin descanso</b> entre ellos, y recién ahí descansás. Todo el recuadro cuenta como una serie.' },
    { sel: '.barra-guardar', titulo: 'A entrenar',
      texto: 'Cuando estés en el gimnasio, tocá <b>Empezar</b>. Si lo dejás a medias, al volver dice <b>Continuar</b>. A la izquierda ves cuántas veces hiciste este día.' },
    { sel: '#nav', titulo: 'Tu historial',
      texto: 'Cada día que terminás queda guardado en <b>Historial</b>. Tu profe también lo ve, así puede ir ajustando la rutina.' },
  ],
  'entrenar': [
    { sel: '.progreso-entreno', titulo: 'Tu progreso de hoy',
      texto: 'Cuántos ejercicios llevás. Todo se guarda <b>al instante</b>: si se corta la señal o cerrás la app, no perdés nada.' },
    ...(ES_PC ? [
    { buscar: () => primerVisible('[data-comenzar]'), titulo: '▶ Comenzar',
      texto: 'Cuando vas a hacer un ejercicio, tocá <b>Comenzar</b>: se abre la ficha, el video arranca solo y arriba corre un <b>cronómetro</b> para que veas cuánto tiempo pasa (en los ejercicios de tiempo también te muestra el objetivo). Al terminar, tocá <b>✓ Registrar</b>.' },
    { buscar: () => primerVisible('#ejercicios .item'), titulo: 'Anotá cuánto hiciste',
      texto: 'La ventanita de registro ya trae lo que indicó tu profe (repeticiones o tiempo, y el peso): si lo hiciste así, solo marcá <b>cómo te sentiste</b> del 1 al 10 y tocá Registrar; si no, cambialo. Ahí también ves lo de la última vez, para comparar. Si te equivocaste, tocá <b>Editar registro</b>.' },
    ] : [
    { buscar: () => primerVisible('#ejercicios .item'), titulo: 'Deslizá a la derecha → comenzar',
      texto: 'Cuando vas a hacer un ejercicio, <b>deslizalo a la derecha</b>: se abre la ficha, el video arranca solo y arriba corre un <b>cronómetro</b>. Al terminar, tocá <b>✓ Registrar</b> y anotá cuánto hiciste y <b>cómo te sentiste</b> del 1 al 10. La pantalla baja sola al siguiente, que queda marcado en celeste.' },
    { buscar: () => primerVisible('#ejercicios .item'), titulo: 'Corregir',
      texto: 'Lo que anotes queda en la tarjeta. Si te equivocaste, deslizalo otra vez a la derecha: se abre el registro para corregirlo o desmarcarlo.' },
    ]),
    { sel: '#fecha', titulo: 'La fecha',
      texto: 'Si lo estás anotando después (por ejemplo, entrenaste ayer), cambiá la fecha acá.' },
    { sel: '#cierre', titulo: 'Al terminar',
      texto: 'Contale a tu profe cómo te fue (esfuerzo del 1 al 10 y un comentario si querés) y tocá <b>Terminar entrenamiento</b>. Queda en tu historial y el día vuelve a estar listo para la próxima vez.' },
  ],
  'historial': [
    { buscar: () => primerVisible('.entreno'), titulo: 'Tus entrenamientos',
      texto: 'Una entrada por cada día que entrenaste: la fecha, qué día de la rutina, cuántos ejercicios hiciste y el esfuerzo. Tocala para ver el detalle y las cargas que anotaste.' },
    { titulo: '¿“En curso”?',
      texto: 'Es un día que empezaste y todavía no terminaste. Si no tocás <b>Terminar</b>, se cierra solo a las 12 horas y queda guardado con lo que hayas hecho.' },
  ],

  // ── Profe ──
  'alumnos': [
    { sel: '#nuevo', titulo: 'Dar de alta un alumno',
      texto: 'Nombre y un usuario para entrar. La app genera una <b>contraseña temporal</b> y te arma el mensaje para mandárselo por WhatsApp.' },
    { sel: '#q', titulo: 'Buscar', texto: 'Filtrá por nombre o usuario.' },
    { buscar: () => primerVisible('#lista .fila'), titulo: 'Cada alumno',
      texto: 'Su rutina publicada (en amarillo si no tiene ninguna) y cuándo entrenó por última vez: así ves de un vistazo quién está colgado. Tocalo para abrir su ficha.' },
    { sel: '#nav', titulo: 'Plantillas y ejercicios',
      texto: '<b>Plantillas</b>: rutinas sin alumno que armás una vez y asignás a muchos. <b>Ejercicios</b>: el catálogo con los números y los videos.' },
  ],
  'alumno': [
    { sel: '#nueva', titulo: 'Nueva rutina',
      texto: 'Vacía, o partiendo de una plantilla. Arranca en <b>borrador</b>: el alumno no la ve hasta que la publiques.' },
    { sel: '#importar', titulo: 'Importar una planilla',
      texto: 'Si ya la tenés en Google Sheets: <b>Archivo → Descargar → Microsoft Excel (.xlsx)</b> y subila acá. Se respetan los días, los bloques, los comentarios y las <b>superseries sombreadas</b>; si trae la hoja “Datos”, también actualiza el catálogo y los videos.' },
    { buscar: () => primerVisible('#rutinas .fila'), titulo: 'Sus rutinas',
      texto: '<b>Borrador</b>: solo la ves vos. <b>Publicada</b>: la que el alumno tiene vigente (una sola a la vez: publicar otra archiva esta). <b>Archivada</b>: queda de historial. El alumno no puede archivar ni borrar nada.' },
    { buscar: () => primerVisible('#rutinas [data-acc="duplicar"]'), titulo: 'Duplicar',
      texto: 'Para el mes que viene: duplicá la actual, ajustala y publicala. También sirve para guardarla como plantilla.' },
    { buscar: () => primerVisible('.entreno'), titulo: 'Lo que entrenó',
      texto: 'Cada día que terminó, con el esfuerzo que marcó, su comentario y las cargas de cada ejercicio.' },
    { sel: '#reset', titulo: '¿Se olvidó la contraseña?',
      texto: 'Generale una nueva y mandásela; la anterior deja de funcionar al instante.' },
    { sel: '#editar', titulo: 'Sus datos',
      texto: 'Teléfono, <b>notas internas</b> (lesiones, objetivos: el alumno no las ve), pasárselo a otro profe o darlo de baja.' },
  ],
  'vista-previa': [
    { sel: '.dias-wrap', titulo: 'Así la ve el alumno',
      texto: 'Esta es la vista del alumno, con los videos y la última carga que anotó en cada ejercicio. Tocá el nombre de un ejercicio para ver su ficha.' },
    { buscar: () => primerVisible('#main .titulo-fila a.btn'), titulo: 'Editar', texto: 'Para cambiar algo, entrá al editor.' },
  ],
  'editor': [
    { sel: '#main .panel', titulo: 'Datos generales',
      texto: 'Título, desde cuándo rige, y las <b>indicaciones generales</b> que el alumno lee arriba de todo: descansos, hidratación, el objetivo del mes.' },
    { buscar: () => primerVisible('.ed-dia > .cab'), titulo: 'Cada día',
      texto: 'Nombre y color del día. Con las flechas lo reordenás, y <b>Duplicar día</b> te ahorra cargar dos veces un día parecido.' },
    { buscar: () => primerVisible('.ed-bloque .cab'), titulo: 'Bloques',
      texto: 'Entrada en calor, Trabajo del día, Elongación… El segundo campo es el detalle (“Full body”). Si el bloque no lleva ejercicios (una elongación de 10´), usá los campos de <b>tiempo</b> e <b>indicación</b> de abajo.' },
    { buscar: () => primerVisible('[data-picker]'), titulo: 'Elegir el ejercicio',
      texto: 'Escribí el <b>número</b> del catálogo, como en la planilla, o parte del nombre, y Enter. Si no está en el catálogo, podés usarlo como texto libre.' },
    { buscar: () => primerVisible('.ed-item .presc-ed'), titulo: 'Series, repeticiones o tiempo',
      texto: 'Opcional: un <b>peso indicado</b> en kg, que el alumno ve y puede cambiar al registrar. Primero elegí cómo se hace: <b>Series × repeticiones</b> (3 × 10, o un rango 3 × 8 a 12), <b>Series × tiempo</b> (3 × 15 seg, para planchas e isométricos) o <b>Texto libre</b> (al fallo, 12-10-8…). Marcá <b>c/lado</b> si es unilateral. Abajo ves cómo le va a quedar al alumno.' },
    { buscar: () => primerVisible('[data-a="unir"]'), titulo: 'Superseries ⛓',
      texto: 'Une el ejercicio con el de arriba: el alumno los ve en un recuadro y los hace seguidos sin descanso.' },
    { sel: '#guardar', titulo: 'Guardar',
      texto: 'Guardá seguido (también con <b>Ctrl+S</b>); si te vas con cambios sin guardar, te avisa. Editar una rutina publicada <b>no borra</b> lo que el alumno ya registró.' },
  ],
  'plantillas': [
    { titulo: 'Plantillas',
      texto: 'Una plantilla es una rutina <b>sin alumno</b>: la armás una vez (por ejemplo “Full body inicial”) y la asignás a quien quieras. Todos los profes las ven; cada uno edita solo las suyas.' },
    { sel: '#nueva', titulo: 'Nueva plantilla', texto: 'Desde cero o importando una planilla.' },
    { buscar: () => primerVisible('#lista [data-acc="duplicar"]'), titulo: 'Asignar a un alumno',
      texto: 'Crea una <b>copia</b> para ese alumno, en borrador, para que la ajustes antes de publicarla. La plantilla no cambia.' },
  ],
  'ejercicios': [
    { sel: '#q', titulo: 'Buscar',
      texto: 'Por <b>número</b> (el mismo de las planillas) o por parte del nombre.' },
    { sel: '#grupo', titulo: 'Grupos', texto: 'Lumbar, Planchas, Abdominales… para encontrar alternativas rápido.' },
    { buscar: () => primerVisible('#filas tr'), titulo: 'Cada ejercicio',
      texto: 'Con <b>Editar</b> cambiás el nombre, el grupo, la descripción de la técnica o el link del video (Drive o YouTube). Para que el video se vea dentro de la app, en Drive tiene que estar compartido como <b>“cualquier persona con el enlace”</b>.' },
    { buscar: () => primerVisible('#filas [data-miniatura]'), titulo: 'La miniatura',
      texto: 'La que ven los alumnos en cada ejercicio. Sale sola del video, pero tocándola la cambiás: <b>sacás un cuadro de un video</b> que tengas (elegís el momento con una barra) o <b>subís una imagen</b>.' },
    { sel: '#importar', titulo: 'Importar el catálogo',
      texto: 'Lee la hoja <b>“Datos”</b> de la planilla: grupo, número, nombre y el link del video. Actualiza por número y no pisa un video cargado a mano.' },
  ],
  'profesores': [
    { sel: '#nuevo', titulo: 'Profesores',
      texto: 'Cada profe ve <b>solo sus alumnos</b>. Al darlo de alta se genera una contraseña temporal.' },
    { buscar: () => primerVisible('#lista .fila'), titulo: 'Gestionar',
      texto: 'Resetearle la contraseña o darlo de baja. Antes de dar de baja a un profe, pasale sus alumnos a otro desde la ficha de cada alumno.' },
  ],
};

// ── Arranque ──
router();
