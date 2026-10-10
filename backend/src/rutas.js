/**
 * Tabla de rutas. Cada entrada declara método, patrón y manejador; el patrón
 * usa `:nombre` para los tramos variables (ver `coincide` en http.js).
 */

import * as almacen from "./almacen.js";
import * as escenarios from "./escenarios.js";
import * as motor from "./motor.js";
import {
    asignarAulasBase,
    construirGrupos,
    construirProblema,
    construirRejilla,
    lineasSugeridas,
    resolverParidad
} from "./problema.js";
import { validarParaHorario } from "./validacion.js";
import * as saturacion from "./saturacion.js";
import * as auth from "./auth.js";
import * as conciliacion from "./conciliacion.js";
import * as disponibilidad from "./disponibilidad.js";
import { importarCsv } from "./importar.js";
import { candidatas, depurar } from "./fusiones.js";
import * as prioridad from "./prioridad.js";
import * as configEscenario from "./config-escenario.js";
import * as conjunto from "./conjunto.js";
import * as invitaciones from "./invitaciones.js";
import * as catalogo from "./catalogo.js";
import * as cambios from "./cambios.js";
import * as tecnm from "./tecnm.js";
import { PARIDADES, paridadSugerida, estadoDelPeriodo, cerrarPeriodo, reabrirPeriodo } from "./periodo.js";
import * as horario from "./horario.js";
import { bd, enTransaccion, guardarCarrera } from "./bd.js";
import { ErrorHttp, coincide, leerCuerpo, responder } from "./http.js";

/** Rutas que no exigen sesión: el estado del servicio y el propio inicio. */
export const ABIERTAS = new Set(["GET /api/salud", "POST /api/sesion", "GET /api/sesion"]);

/**
 * Lo que el docente abre con su enlace no exige sesión: el token **es** la
 * credencial. Se comprueba por patrón porque el token va en la ruta, y son solo
 * dos cosas —su disponibilidad y su horario—, las dos suyas.
 */
export const PUBLICAS = [
    /^\/api\/disponibilidad\/[A-Za-z0-9_-]+$/,
    /^\/api\/mi-horario\/[A-Za-z0-9_-]+$/
];

export const RUTAS = [
    ["GET", "/api/salud", salud],
    ["POST", "/api/sesion", iniciarSesion],
    ["DELETE", "/api/sesion", terminarSesion],
    ["GET", "/api/sesion", verSesion],
    ["GET", "/api/carreras", listarCarreras],
    ["GET", "/api/plantel/carreras", listarPlantel],
    ["GET", "/api/plantel/catalogo", verCatalogo],
    ["GET", "/api/plantel/catalogo/:carrera", verCatalogoDe],
    ["PUT", "/api/plantel/asignaciones", guardarAsignacion],
    ["GET", "/api/plantel/carga", verCarga],
    ["GET", "/api/plantel/normativa", verNormativa],
    ["POST", "/api/plantel/asignaciones/materia", asignarMateriaCompleta],
    ["POST", "/api/plantel/asignaciones/historial", verHistorialReparto],
    ["DELETE", "/api/plantel/asignaciones/:carrera", vaciarReparto],
    ["GET", "/api/plantel/aulas", listarAulasDelPlantel],
    ["PUT", "/api/plantel/aulas", guardarAulasDelPlantel],
    ["POST", "/api/plantel/carreras", altaCarrera],
    ["DELETE", "/api/plantel/carreras/:codigo", bajaCarrera],
    ["POST", "/api/sesion/clave", cambiarClave],
    ["GET", "/api/usuarios", listarUsuarios],
    ["POST", "/api/usuarios", crearUsuarioRuta],
    ["PUT", "/api/usuarios/:id/carreras", asignarCarreras],
    ["POST", "/api/usuarios/:id/clave", reiniciarClave],
    ["DELETE", "/api/usuarios/:id", retirarUsuario],
    ["GET", "/api/docentes", listarDocentes],
    ["PUT", "/api/docentes", guardarDocentes],
    ["PUT", "/api/docentes/:id", guardarDocente],
    ["POST", "/api/docentes/importar", importarDisponibilidad],
    ["PUT", "/api/docentes/:id/descargas", guardarDescargas],
    ["GET", "/api/enlaces", listarEnlaces],
    ["GET", "/api/disponibilidad/:token", abrirFormulario],
    ["PUT", "/api/disponibilidad/:token", guardarFormulario],
    ["GET", "/api/mi-horario/:token", horarioDelDocente],
    ["GET", "/api/cambios", listarCambios],
    ["POST", "/api/cambios", pedirCambio],
    ["POST", "/api/cambios/:id/responder", responderCambio],
    ["DELETE", "/api/cambios/:id", retirarCambio],
    ["GET", "/api/carreras/:carrera/prioridades", listarPrioridades],
    ["PUT", "/api/carreras/:carrera/prioridades", guardarPrioridades],
    ["GET", "/api/carreras/:carrera/aulas", listarAulas],
    ["PUT", "/api/carreras/:carrera/aulas", guardarAulas],
    ["GET", "/api/carreras/:carrera/escenarios", listarEscenarios],
    ["POST", "/api/carreras/:carrera/escenarios", crearEscenario],
    ["GET", "/api/carreras/:carrera/escenarios/:id", obtenerEscenario],
    ["PUT", "/api/carreras/:carrera/escenarios/:id", guardarEscenario],
    ["DELETE", "/api/carreras/:carrera/escenarios/:id", eliminarEscenario],
    ["PUT", "/api/carreras/:carrera/escenarios/:id/base", marcarEscenarioBase],
    ["POST", "/api/carreras/:carrera/escenarios/:id/horario", generarHorario],
    ["POST", "/api/carreras/:carrera/escenarios/:id/horario/validacion", validarHorario],
    ["POST", "/api/carreras/:carrera/escenarios/:id/horario/ajuste", ajustarHorario],
    ["POST", "/api/saturacion", verSaturacion],
    ["POST", "/api/saturacion/aulas", verOcupacionDeAulas],
    ["POST", "/api/saturacion/historial", verHistorial],
    ["GET", "/api/periodos", verPeriodos],
    ["POST", "/api/periodos/:paridad/cerrar", cerrar],
    ["DELETE", "/api/periodos/:paridad/cerrar", reabrir],
    ["GET", "/api/solicitudes", listarSolicitudes],
    ["POST", "/api/solicitudes", crearSolicitud],
    ["POST", "/api/solicitudes/:id/responder", responderSolicitud],
    ["POST", "/api/conflictos/propio", resolverPropio],
    ["GET", "/api/invitaciones", listarInvitaciones],
    ["POST", "/api/invitaciones", crearInvitacion],
    ["POST", "/api/invitaciones/:id/responder", responderInvitacion],
    ["DELETE", "/api/invitaciones/:id", revocarInvitacion],
    ["POST", "/api/carreras/:carrera/escenarios/:id/conflictos", verConflictos],
    ["GET", "/api/carreras/:carrera/escenarios/:id/config", verConfig],
    ["PUT", "/api/carreras/:carrera/escenarios/:id/config", guardarConfig],
    ["GET", "/api/carreras/:carrera/escenarios/:id/reserva", horarioApartado],
    ["PUT", "/api/carreras/:carrera/escenarios/:id/reserva", reservarHoras],
    ["DELETE", "/api/carreras/:carrera/escenarios/:id/reserva", liberarHoras]
];

export function resolverRuta(metodo, ruta) {
    // Se recorren *todas* las rutas antes de decidir: varias comparten camino y
    // se distinguen solo por el verbo (`/escenarios` es GET y POST). Cortar en
    // la primera coincidencia de camino dejaría inalcanzable a la segunda.
    const delCamino = RUTAS.filter(([, patron]) => coincide(patron, ruta) !== null);
    if (delCamino.length === 0) return null;

    const exacta = delCamino.find(([verbo]) => verbo === metodo);
    if (exacta) {
        return { manejador: exacta[2], params: coincide(exacta[1], ruta), patron: exacta[1] };
    }

    // El camino existe pero el verbo no: es 405, no 404. La diferencia le dice
    // al cliente que la ruta está bien y el método no.
    return { manejador: null, permitido: delCamino.map(([verbo]) => verbo).join(", ") };
}

// ---------------------------------------------------------------- sesión

async function iniciarSesion(req, res) {
    const { usuario, clave } = await leerCuerpo(req);
    const sesion = auth.autenticar(usuario, clave);
    responder(res, 200, sesion.usuario, { "Set-Cookie": auth.cabeceraDeSesion(sesion.token) });
}

async function terminarSesion(req, res) {
    auth.cerrarSesion(auth.tokenDe(req));
    responder(res, 200, { cerrada: true }, { "Set-Cookie": auth.cabeceraDeCierre() });
}

/** Quién soy. Devuelve `null` sin sesión, en vez de 401: no es un error. */
async function verSesion(req, res) {
    responder(res, 200, auth.usuarioDe(req));
}

async function listarPrioridades(req, res, { carrera }) {
    auth.exigirCarrera(req.usuario, carrera);
    responder(res, 200, {
        niveles: prioridad.NIVELES,
        prioridades: prioridad.listar(carrera.toUpperCase())
    });
}

async function guardarPrioridades(req, res, { carrera }) {
    auth.exigirCarrera(req.usuario, carrera);
    const cuerpo = await leerCuerpo(req);
    responder(res, 200, prioridad.guardar(carrera.toUpperCase(), cuerpo.prioridades ?? []));
}

/**
 * Lo compartido lo administra el departamento: cuentas, carreras y espacios.
 * El `qué` va en el mensaje porque un 403 que habla de cuentas en una ruta de
 * aulas manda a buscar el problema donde no está.
 */
function exigirDepartamento(req, motivo = "Eso lo administra el departamento académico.") {
    if (req.usuario.rol !== "departamento") throw new ErrorHttp(403, motivo);
}

async function cambiarClave(req, res) {
    const { actual, nueva } = await leerCuerpo(req);
    // Cambiar la contraseña cierra las sesiones, incluida esta: la cookie que
    // trae el navegador ya no vale, y dejarla puesta simula una sesión viva.
    responder(res, 200, auth.cambiarClave({ usuarioId: req.usuario.id, actual, nueva }), {
        "Set-Cookie": auth.cabeceraDeCierre()
    });
}

async function listarUsuarios(req, res) {
    exigirDepartamento(req, "Las cuentas las administra el departamento académico.");
    responder(res, 200, auth.listarUsuarios());
}

async function crearUsuarioRuta(req, res) {
    exigirDepartamento(req, "Las cuentas las administra el departamento académico.");
    responder(res, 201, auth.altaUsuario(await leerCuerpo(req)));
}

async function asignarCarreras(req, res, { id }) {
    exigirDepartamento(req, "Las cuentas las administra el departamento académico.");
    const { carreras } = await leerCuerpo(req);
    responder(res, 200, auth.asignarCarreras(id, carreras));
}

async function reiniciarClave(req, res, { id }) {
    exigirDepartamento(req, "Las cuentas las administra el departamento académico.");
    if (id === req.usuario.id) {
        throw new ErrorHttp(400, "La tuya se cambia desde tu sesión, dando la actual.");
    }
    const { nueva } = await leerCuerpo(req);
    responder(res, 200, auth.reiniciarClave({ usuarioId: id, nueva }));
}

async function retirarUsuario(req, res, { id }) {
    exigirDepartamento(req, "Las cuentas las administra el departamento académico.");
    if (id === req.usuario.id) throw new ErrorHttp(409, "No puedes retirarte a ti mismo.");
    responder(res, 200, auth.retirarUsuario(id));
}

// ---------------------------------------------------------------- manejadores

async function salud(req, res) {
    responder(res, 200, {
        estado: "ok",
        servicio: "backend",
        motor: await motor.estadoDelMotor()
    });
}

/** Solo las carreras que este coordinador lleva. */
async function listarCarreras(req, res) {
    const usuario = auth.usuarioDe(req);
    const todas = await almacen.listarCarreras();
    if (!usuario || usuario.rol === "departamento") return responder(res, 200, todas);
    responder(res, 200, todas.filter((c) => usuario.carreras.includes(c)));
}

/**
 * Todas las del plantel, sin sus datos.
 *
 * `GET /api/carreras` devuelve solo las que el coordinador lleva, que es lo
 * correcto para navegar. Pero para invitar a otra coordinación hay que poder
 * nombrarla, y el código de una carrera no es información reservada.
 */
async function listarPlantel(req, res) {
    responder(
        res,
        200,
        bd().prepare("SELECT codigo, nombre FROM carreras ORDER BY codigo").all()
    );
}

/**
 * Abrir una carrera. Solo el departamento: es una decisión de la institución,
 * no de una coordinación.
 */
async function altaCarrera(req, res) {
    exigirDepartamento(req, "Abrir una carrera es decisión del departamento académico.");
    const { codigo, nombre } = await leerCuerpo(req);
    // Letras y dígitos, empezando por letra: las siglas del plantel son
    // ISIC, IDAP, CPUB…, pero nada impide que una lleve número.
    if (!/^[A-Za-z][A-Za-z0-9]{1,7}$/.test(codigo ?? "")) {
        throw new ErrorHttp(400, "El código son de 2 a 8 letras o dígitos, empezando por letra.");
    }
    if (!nombre?.trim()) throw new ErrorHttp(400, "Falta el nombre de la carrera.");

    const clave = codigo.toUpperCase();
    const db = bd();
    const previa = db.prepare("SELECT nombre FROM carreras WHERE codigo = ?").get(clave);
    guardarCarrera(db, clave, nombre.trim());
    responder(res, previa ? 200 : 201, { codigo: clave, nombre: nombre.trim(), creada: !previa });
}

/**
 * Cerrar una carrera. Se lleva por delante sus escenarios y su horario, así que
 * se niega mientras tenga horas apartadas: eso significa que alguien está
 * trabajando con ella, y borrarla dejaría a las demás creyendo libres unas horas
 * que no lo están.
 */
async function bajaCarrera(req, res, { codigo }) {
    exigirDepartamento(req, "Cerrar una carrera es decisión del departamento académico.");
    const clave = codigo.toUpperCase();
    const db = bd();
    if (!db.prepare("SELECT 1 FROM carreras WHERE codigo = ?").get(clave)) {
        throw new ErrorHttp(404, `No existe la carrera ${clave}.`);
    }
    // Horas y no filas: cada fila es un bloque que puede valer hasta tres.
    const apartadas = db
        .prepare("SELECT coalesce(sum(fin - inicio), 0) n FROM saturacion WHERE carrera = ?")
        .get(clave).n;
    if (apartadas > 0) {
        throw new ErrorHttp(
            409,
            `${clave} tiene ${apartadas} horas apartadas. Hay que liberarlas antes de cerrarla.`
        );
    }

    // Las tablas que cuelgan de `carreras` se van en cascada; las que solo
    // guardan el código se limpian aquí.
    for (const sql of [
        "DELETE FROM docente_prioridad WHERE carrera = ?",
        "DELETE FROM escenario_config WHERE carrera = ?",
        "DELETE FROM horario WHERE carrera = ?",
        "DELETE FROM aulas WHERE 0",
        "DELETE FROM invitacion_conjunta WHERE anfitriona = ? OR invitada = ?"
    ]) {
        db.prepare(sql).run(...new Array(sql.split("?").length - 1).fill(clave));
    }
    db.prepare("DELETE FROM carreras WHERE codigo = ?").run(clave);
    responder(res, 200, { cerrada: clave });
}

/**
 * La plantilla docente es del instituto, no de la carrera: la misma persona da
 * clase en varias, y por eso vive fuera de los escenarios.
 */
async function listarDocentes(req, res) {
    responder(res, 200, await almacen.leerDocentes());
}

/**
 * La plantilla es del instituto y la administra el **departamento**.
 *
 * Guardar reemplaza la lista entera, así que mientras esto estuvo abierto
 * cualquier coordinación podía reescribir quién imparte qué —el punto uno de
 * los requisitos, que es justamente lo que el departamento decide— o borrar
 * docentes de las demás carreras sin querer.
 */
async function guardarDocentes(req, res) {
    exigirDepartamento(
        req,
        "La plantilla docente es del instituto: la administra el departamento académico."
    );
    const docentes = await leerCuerpo(req);
    if (!Array.isArray(docentes)) throw new ErrorHttp(400, "Se esperaba un arreglo de docentes.");
    if (docentes.length === 0) {
        throw new ErrorHttp(400, "El instituto no puede quedarse sin plantilla docente.");
    }
    await almacen.guardarDocentes(docentes);
    responder(res, 200, { guardados: docentes.length });
}

/**
 * Un nombramiento, el suyo y nada más.
 *
 * La ruta de arriba manda la plantilla completa, y eso está bien para un alta
 * masiva o una baja —quien no viene se va— pero no para corregirle las horas a
 * una persona: el documento lleva a los otros veintinueve tal como estaban en
 * la pantalla de quien guarda, y si alguien más editó mientras tanto, su cambio
 * se pierde sin aviso. Por aquí se escribe solo el docente de la ruta.
 *
 * Lo que **no** se toca es su disponibilidad, que la declara él, ni sus
 * descargas, que tienen su propia ruta. Las materias autorizadas sí: son del
 * departamento, y van juntas porque se deciden en el mismo diálogo.
 *
 * Y lo que no venga en el cuerpo se queda como estaba, porque ningún formulario
 * edita un nombramiento completo. Ver `almacen.guardarDocente`.
 */
async function guardarDocente(req, res, { id }) {
    exigirDepartamento(
        req,
        "La plantilla docente es del instituto: la administra el departamento académico."
    );
    const cuerpo = await leerCuerpo(req);
    if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo)) {
        throw new ErrorHttp(400, "Se esperaba el nombramiento de un docente.");
    }
    if (cuerpo.nombre !== undefined && !String(cuerpo.nombre).trim()) {
        throw new ErrorHttp(400, "El nombre no puede quedar vacío.");
    }
    // El id manda el de la ruta: así un cuerpo con otro id no renombra a nadie.
    responder(res, 200, almacen.guardarDocente({ ...cuerpo, id }));
}

/**
 * La hoja de saturación de cada docente para un periodo: qué horas declaró, qué
 * le ocupa una comisión y qué carrera pretende el resto.
 */
async function verSaturacion(req, res) {
    const opciones = await leerCuerpo(req);
    const [docentes, ocupaciones] = await Promise.all([
        almacen.leerDocentes(),
        saturacion.consultar({ paridad: opciones.paridad })
    ]);

    const rejilla = construirRejilla([], opciones);
    responder(res, 200, {
        rejilla,
        hojas: docentes.map((docente) => saturacion.armarHoja(docente, ocupaciones, rejilla))
    });
}

// ---------------------------------------------------------------- periodos

async function verPeriodos(req, res) {
    responder(
        res,
        200,
        Object.keys(PARIDADES).map((paridad) => ({
            paridad,
            ...PARIDADES[paridad],
            cerrado: estadoDelPeriodo(bd(), paridad)
        }))
    );
}

/**
 * Cerrar da por terminada la negociación: lo apartado pasa a ser el horario del
 * semestre. Lo hace el departamento académico, no un coordinador, porque afecta
 * a todas las carreras a la vez.
 */
async function cerrar(req, res, { paridad }) {
    if (req.usuario.rol !== "departamento") {
        throw new ErrorHttp(403, "El periodo lo cierra el departamento académico.");
    }
    cerrarPeriodo(bd(), paridad, req.usuario.id);
    responder(res, 200, { paridad, cerrado: estadoDelPeriodo(bd(), paridad) });
}

async function reabrir(req, res, { paridad }) {
    if (req.usuario.rol !== "departamento") {
        throw new ErrorHttp(403, "El periodo lo reabre el departamento académico.");
    }
    reabrirPeriodo(bd(), paridad);
    responder(res, 200, { paridad, cerrado: null });
}

// ---------------------------------------------------------------- conciliación

/** Horas que este escenario pretende y otra carrera también. */
async function verConflictos(req, res, { carrera, id }) {
    const { paridad } = await leerCuerpo(req);
    responder(res, 200, {
        conflictos: conciliacion.detectarConflictos({
            carrera: carrera.toUpperCase(),
            escenarioId: id,
            paridad,
            // Para distinguir el choque con otro coordinador del choque
            // consigo mismo, que no se negocia: se decide.
            misCarreras: req.usuario.carreras
        })
    });
}

async function listarSolicitudes(req, res) {
    responder(res, 200, conciliacion.listarSolicitudes({ carreras: req.usuario.carreras }));
}

async function crearSolicitud(req, res) {
    const c = await leerCuerpo(req);
    auth.exigirCarrera(req.usuario, c.de?.carrera);
    responder(res, 201, conciliacion.crear({ ...c, usuario: req.usuario.id }));
}

async function listarInvitaciones(req, res) {
    responder(res, 200, invitaciones.listar(req.usuario.carreras));
}

async function crearInvitacion(req, res) {
    const c = await leerCuerpo(req);
    auth.exigirCarrera(req.usuario, c.anfitriona);
    responder(res, 201, invitaciones.crear({
        anfitriona: String(c.anfitriona).toUpperCase(),
        invitada: String(c.invitada).toUpperCase(),
        escenarioId: c.escenarioId,
        usuario: req.usuario.id
    }));
}

async function responderInvitacion(req, res, { id }) {
    const { acepta, respuesta } = await leerCuerpo(req);
    responder(res, 200, invitaciones.responder({
        id,
        acepta: Boolean(acepta),
        respuesta,
        carreras: req.usuario.carreras,
        usuarioId: req.usuario.id
    }));
}

async function revocarInvitacion(req, res, { id }) {
    responder(res, 200, invitaciones.revocar({ id, carreras: req.usuario.carreras }));
}

/** Choque entre dos carreras del mismo coordinador: se decide, no se pide. */
async function resolverPropio(req, res) {
    const { cede, bloque } = await leerCuerpo(req);
    responder(
        res,
        200,
        conciliacion.resolverPropio({
            cede,
            bloque,
            carreras: req.usuario.carreras,
            usuarioId: req.usuario.id
        })
    );
}

async function responderSolicitud(req, res, { id }) {
    const { acepta, respuesta } = await leerCuerpo(req);
    responder(
        res,
        200,
        conciliacion.responder({
            id,
            acepta: Boolean(acepta),
            respuesta,
            carreras: req.usuario.carreras,
            usuarioId: req.usuario.id
        })
    );
}

/**
 * Traduce los ids que el motor nombra en sus errores.
 *
 * El motor es deliberadamente ignorante del dominio —recibe ids y devuelve
 * ids—, lo cual está bien hasta que uno de esos mensajes llega a una pantalla.
 * "esa clase la imparte doc016" no le dice nada a nadie; el nombre sí.
 */
async function conNombres(accion, docentes) {
    try {
        return await accion();
    } catch (e) {
        if (!(e instanceof ErrorHttp) || typeof e.message !== "string") throw e;
        const nombres = new Map(
            bd().prepare("SELECT id, nombre FROM docentes").all().map((d) => [d.id, d.nombre])
        );
        const legible = e.message.replace(/\b[\w-]+\b/g, (t) => nombres.get(t) ?? t);
        throw legible === e.message ? e : new ErrorHttp(e.codigo, legible);
    }
}

/**
 * La misma hoja, para el otro recurso compartido.
 *
 * Las aulas son del plantel igual que los docentes: la que ocupa 1A por la
 * mañana la quiere otro grupo por la tarde. El motor ya recibía esas horas —por
 * eso sabe marcar `aulaOcupadaPorOtros`— pero solo se veían como violación
 * después de generar, cuando lo útil es mirarlas antes de colocar nada.
 */
async function verOcupacionDeAulas(req, res) {
    const opciones = await leerCuerpo(req);
    const [aulas, ocupaciones] = await Promise.all([
        almacen.leerAulas(),
        saturacion.consultar({ paridad: opciones.paridad })
    ]);
    const rejilla = construirRejilla([], opciones);
    responder(res, 200, {
        rejilla,
        hojas: aulas.map((aula) =>
            saturacion.armarHojaDeAula(aula, ocupaciones, rejilla, req.usuario.carreras)
        )
    });
}

/** Quién tuvo cada hora antes de quien la tiene ahora. */
async function verHistorial(req, res) {
    const { docenteId, limite } = await leerCuerpo(req);
    responder(res, 200, await saturacion.historial({ docenteId, limite }));
}

/** Lo que se eligió antes de generar: paridad, grupos y fusiones. */
async function verConfig(req, res, { carrera, id }) {
    auth.exigirCarrera(req.usuario, carrera);
    responder(res, 200, configEscenario.leer({ carrera: carrera.toUpperCase(), escenarioId: id }));
}

async function guardarConfig(req, res, { carrera, id }) {
    auth.exigirCarrera(req.usuario, carrera);
    const cuerpo = await leerCuerpo(req);
    responder(
        res,
        200,
        configEscenario.guardar({ carrera: carrera.toUpperCase(), escenarioId: id, ...cuerpo })
    );
}

/** El horario que este escenario tiene apartado, para volver a dibujarlo. */
async function horarioApartado(req, res, { carrera, id }) {
    auth.exigirCarrera(req.usuario, carrera);
    responder(res, 200, horario.leer({ carrera: carrera.toUpperCase(), escenarioId: id }) ?? null);
}

/** Registra lo que este escenario pretende, reemplazando su reserva anterior. */
async function reservarHoras(req, res, { carrera, id }) {
    const cuerpo = await leerCuerpo(req);
    const sesiones = cuerpo.sesiones ?? [];

    // Un horario conjunto trae sesiones de varias carreras, distinguibles por
    // el prefijo del grupo. Cada una aparta las suyas: una fusionada es una
    // hora catedrático y se le carga a la carrera del grupo principal, que es
    // la dueña del aula donde se imparte.
    const porCarrera = conjunto.repartirPorCarrera(sesiones, carrera.toUpperCase());
    const destinos = (cuerpo.invitadas ?? []).map((x) => ({
        carrera: String(x.carrera).toUpperCase(),
        escenarioId: x.escenarioId
    }));

    // Apartar en nombre de otra carrera exige el mismo permiso que generar:
    // si no, bastaría con fabricar la petición para escribir en su reserva.
    for (const otra of destinos) {
        const puede = invitaciones.autorizada({
            anfitriona: carrera.toUpperCase(),
            invitada: otra.carrera,
            escenarioId: otra.escenarioId,
            carreras: req.usuario.carreras
        });
        if (!puede) throw new ErrorHttp(403, `${otra.carrera} no autorizó el horario conjunto.`);
    }
    const sinDestino = [...porCarrera.keys()].filter(
        (c) => c && c !== carrera.toUpperCase() && !destinos.some((d) => d.carrera === c)
    );
    if (sinDestino.length > 0) {
        throw new ErrorHttp(400, `Hay sesiones de ${sinDestino.join(", ")} sin escenario destino.`);
    }

    const comun = {
        periodo: cuerpo.periodo ?? null,
        paridad: cuerpo.paridad ?? null,
        usuarioId: req.usuario.id,
        documento: cuerpo.horario ?? null
    };

    let reservadas = 0;
    let reemplazadas = 0;
    for (const destino of [{ carrera: carrera.toUpperCase(), escenarioId: id }, ...destinos]) {
        const suyas = porCarrera.get(destino.carrera) ?? [];
        // Las sesiones van sin prefijar a `saturacion`: ahí lo que identifica es
        // la carrera, que ya va en su columna.
        const r = await saturacion.reservar({
            ...comun,
            ...destino,
            sesiones: suyas.map((x) => ({ ...x, grupoClave: x.grupoClave })),
            documento: comun.documento ? { ...comun.documento, deCarrera: destino.carrera } : null
        });
        reservadas += r.reservadas;
        reemplazadas += r.reemplazadas;
    }
    responder(res, 200, { reservadas, reemplazadas });
}

async function liberarHoras(req, res, { carrera, id }) {
    responder(
        res,
        200,
        await saturacion.liberar({
            carrera: carrera.toUpperCase(),
            escenarioId: id,
            usuarioId: req.usuario.id
        })
    );
}

// ---------------------------------------------------------------- disponibilidad

/** Enlaces personales para repartir a la plantilla. */
async function listarEnlaces(req, res) {
    responder(res, 200, disponibilidad.enlaces());
}

async function abrirFormulario(req, res, { token }) {
    responder(res, 200, disponibilidad.abrir(token));
}

async function guardarFormulario(req, res, { token }) {
    responder(res, 200, disponibilidad.guardar(token, await leerCuerpo(req)));
}

/**
 * El horario del docente, por su propio enlace. Mismo token y mismo alcance que
 * el formulario: lo suyo y nada más.
 */
async function horarioDelDocente(req, res, { token }) {
    responder(res, 200, disponibilidad.horarioDe(token));
}

/**
 * Peticiones de cambio de docente. La bandeja es la misma para los dos lados:
 * el departamento ve todas y cada coordinación las de sus carreras.
 */
async function listarCambios(req, res) {
    responder(res, 200, cambios.listar({ rol: req.usuario.rol, carreras: req.usuario.carreras }));
}

async function pedirCambio(req, res) {
    const cuerpo = await leerCuerpo(req);
    if (req.usuario.rol === "departamento") {
        throw new ErrorHttp(
            400,
            "El departamento no se pide a sí mismo: la asignación se cambia desde el catálogo."
        );
    }
    auth.exigirCarrera(req.usuario, cuerpo.carrera ?? "");
    responder(res, 201, await cambios.crear({ ...cuerpo, usuarioId: req.usuario.id }));
}

async function responderCambio(req, res, { id }) {
    exigirDepartamento(req, "Las peticiones de cambio las responde el departamento académico.");
    const { acepta, docenteId, respuesta } = await leerCuerpo(req);
    responder(
        res,
        200,
        cambios.responder({
            id,
            acepta: Boolean(acepta),
            docenteId,
            respuesta,
            usuarioId: req.usuario.id
        })
    );
}

async function retirarCambio(req, res, { id }) {
    responder(res, 200, cambios.retirar({ id, carreras: req.usuario.carreras }));
}

/** Carga masiva desde una hoja de cálculo exportada a CSV. */
async function importarDisponibilidad(req, res) {
    const { csv } = await leerCuerpo(req);
    responder(res, 200, importarCsv(csv));
}

/**
 * Descargas administrativas. Solo el departamento académico: ni el coordinador
 * ni el docente disponen de esas horas.
 */
async function guardarDescargas(req, res, { id }) {
    if (req.usuario.rol !== "departamento") {
        throw new ErrorHttp(403, "Las descargas las carga el departamento académico.");
    }
    const descargas = await leerCuerpo(req);
    if (!Array.isArray(descargas)) throw new ErrorHttp(400, "Se esperaba un arreglo de descargas.");
    responder(res, 200, almacen.guardarDescargas(id, descargas));
}

async function listarAulas(req, res, { carrera }) {
    responder(res, 200, await almacen.leerAulas(carrera));
}

/**
 * Los espacios son del plantel: una sola lista para todas las carreras.
 *
 * La ruta por carrera existía y guardaba reemplazando la lista **entera**, así
 * que cualquier coordinación podía dejar al resto sin aulas con un guardado.
 * Ahora quien las administra es el departamento, igual que la plantilla docente:
 * un recurso compartido no lo edita quien compite por él.
 */
/** Resumen por carrera: cuántas materias y dónde falta quien las imparta. */
async function verCatalogo(req, res) {
    exigirDepartamento(req, "El catálogo lo administra el departamento académico.");
    responder(res, 200, await catalogo.resumen());
}

/**
 * El reparto de una carrera. Lo **administra** el departamento, pero el
 * coordinador tiene que poder leer el suyo: sin saber a quién le pusieron
 * delante de cada grupo no puede ni revisar el horario ni pedir un cambio.
 * Escribir sigue siendo del departamento, en `PUT /plantel/asignaciones`.
 */
async function verCatalogoDe(req, res, { carrera }) {
    if (req.usuario.rol !== "departamento") {
        auth.exigirCarrera(req.usuario, carrera);
    }
    responder(res, 200, await catalogo.porCarrera(carrera.toUpperCase()));
}

/**
 * La carga que cada docente acumula en todo el instituto. Asignarlo en dos
 * carreras son decisiones independientes; la persona no lo es.
 */
async function verCarga(req, res) {
    exigirDepartamento(req, "El catálogo lo administra el departamento académico.");
    responder(res, 200, await catalogo.cargaPorDocente());
}

/**
 * Lo que el reglamento dice y lo que la plantilla capturada no cumple.
 *
 * Son avisos, no bloqueos: un plantel real tiene excepciones y un sistema que se
 * niegue a programar por eso no se usa. Lo que no puede es que los topes del
 * sistema sean números inventados, y esto es lo que los ata a su fuente.
 */
async function verNormativa(req, res) {
    exigirDepartamento(req, "La plantilla docente la administra el departamento académico.");
    const docentes = await almacen.leerDocentes();
    responder(res, 200, {
        reglas: {
            maxMaterias: tecnm.MAX_MATERIAS,
            ajusteMaximo: tecnm.AJUSTE_MAXIMO,
            jornada: tecnm.JORNADA,
            maxHorasDiaDocente: tecnm.MAX_HORAS_DIA_DOCENTE,
            asignatura: tecnm.ASIGNATURA,
            horasFrenteAGrupo: tecnm.HORAS_FRENTE_A_GRUPO,
            dedicaciones: tecnm.DEDICACIONES
        },
        revisados: docentes.length,
        observados: tecnm.revisarPlantilla(docentes)
    });
}

/**
 * Asigna quién imparte una materia a un grupo. Es **la** decisión del jefe de
 * departamento: no un permiso, una persona con nombre frente a un grupo.
 */
async function guardarAsignacion(req, res) {
    exigirDepartamento(req, "Las asignaciones las decide el departamento académico.");
    const { carrera, materiaId, grupoClave, docenteId } = await leerCuerpo(req);
    if (!carrera) throw new ErrorHttp(400, "Falta la carrera.");
    if (!materiaId || !grupoClave) throw new ErrorHttp(400, "Falta la materia o el grupo.");

    const db = bd();
    if (docenteId && !db.prepare("SELECT 1 FROM docentes WHERE id = ?").get(docenteId)) {
        throw new ErrorHttp(400, `No existe el docente ${docenteId}.`);
    }
    const clave = String(carrera).toUpperCase();
    if (!db.prepare("SELECT 1 FROM carreras WHERE codigo = ?").get(clave)) {
        throw new ErrorHttp(404, `No existe la carrera ${clave}.`);
    }

    responder(res, 200, {
        materiaId,
        grupoClave,
        docenteId: enTransaccion((tx) =>
            catalogo.asignar(tx, {
                carrera: clave, materiaId, grupoClave, docenteId, usuarioId: req.usuario.id
            })
        )
    });
}

/**
 * La misma persona en todos los grupos de una materia. Es el caso más común al
 * repartir, y de uno en uno son tres diálogos para decir lo mismo.
 */
async function asignarMateriaCompleta(req, res) {
    exigirDepartamento(req, "Las asignaciones las decide el departamento académico.");
    const { carrera, materiaId, docenteId, nota } = await leerCuerpo(req);
    if (!carrera || !materiaId) throw new ErrorHttp(400, "Falta la carrera o la materia.");

    const db = bd();
    if (docenteId && !db.prepare("SELECT 1 FROM docentes WHERE id = ?").get(docenteId)) {
        throw new ErrorHttp(400, `No existe el docente ${docenteId}.`);
    }
    const clave = String(carrera).toUpperCase();
    if (!db.prepare("SELECT 1 FROM carreras WHERE codigo = ?").get(clave)) {
        throw new ErrorHttp(404, `No existe la carrera ${clave}.`);
    }
    responder(
        res,
        200,
        await catalogo.asignarMateria({
            carrera: clave, materiaId, docenteId, usuarioId: req.usuario.id, nota
        })
    );
}

/** Quién ha tenido cada clase antes de quien la tiene ahora. */
async function verHistorialReparto(req, res) {
    exigirDepartamento(req, "El reparto lo administra el departamento académico.");
    const { carrera, materiaId, grupoClave, limite } = await leerCuerpo(req);
    responder(res, 200, catalogo.historial({ carrera, materiaId, grupoClave, limite }));
}

/**
 * Vacía el reparto de una carrera. La asignación se hereda de un periodo al
 * siguiente porque no lleva periodo; cuando no es lo que se quiere, esto es lo
 * que evita quitar setenta clases de una en una.
 */
async function vaciarReparto(req, res, { carrera }) {
    exigirDepartamento(req, "El reparto lo administra el departamento académico.");
    const clave = carrera.toUpperCase();
    if (!bd().prepare("SELECT 1 FROM carreras WHERE codigo = ?").get(clave)) {
        throw new ErrorHttp(404, `No existe la carrera ${clave}.`);
    }
    responder(res, 200, await catalogo.vaciar({ carrera: clave, usuarioId: req.usuario.id }));
}

async function listarAulasDelPlantel(req, res) {
    responder(res, 200, await almacen.leerAulas());
}

async function guardarAulasDelPlantel(req, res) {
    exigirDepartamento(req, "Los espacios son del plantel: los administra el departamento académico.");
    const aulas = await leerCuerpo(req);
    if (!Array.isArray(aulas)) throw new ErrorHttp(400, "Se esperaba un arreglo de aulas.");
    if (aulas.length === 0) {
        throw new ErrorHttp(400, "El plantel no puede quedarse sin aulas.");
    }
    await almacen.guardarAulas(null, aulas);
    responder(res, 200, { guardadas: aulas.length });
}

async function guardarAulas(req, res) {
    throw new ErrorHttp(
        403,
        "Los espacios son del plantel: los administra el departamento académico."
    );
}

async function listarEscenarios(req, res, { carrera }) {
    responder(res, 200, await escenarios.listarConCobertura(carrera));
}

async function crearEscenario(req, res, { carrera }) {
    const meta = await escenarios.crear(carrera, await leerCuerpo(req));
    responder(res, 201, meta);
}

async function obtenerEscenario(req, res, { carrera, id }) {
    responder(res, 200, await escenarios.obtener(carrera, id));
}

async function guardarEscenario(req, res, { carrera, id }) {
    const datos = await leerCuerpo(req);
    for (const clave of ["materias", "semestres", "especialidades"]) {
        if (datos[clave] !== undefined && !Array.isArray(datos[clave])) {
            throw new ErrorHttp(400, `"${clave}" debe ser un arreglo.`);
        }
    }
    await escenarios.guardar(carrera, id, datos);
    responder(res, 200, { guardado: true });
}

async function eliminarEscenario(req, res, { carrera, id }) {
    await escenarios.eliminar(carrera, id);
    responder(res, 200, { eliminado: id });
}

/**
 * Estado de preparación del escenario para un periodo y una configuración de
 * grupos. La interfaz la consulta antes de dejar generar, y devuelve además las
 * líneas de grupo sugeridas para poder dibujar el formulario sin duplicar aquí
 * la regla de qué grupos existen.
 */
/**
 * Ajuste a mano: el coordinador movió una clase y hay que decirle qué se rompió.
 *
 * Se reconstruye el mismo problema que al generar y se manda al motor, que
 * reevalúa con sus propias reglas. Devuelve lo mismo que generar, así que lo
 * ajustado se aparta, se imprime y se recupera igual que lo generado.
 *
 * El motor decide, no la interfaz: una comprobación escrita en el navegador se
 * separaría de las reglas del evaluador en cuanto una cambie, y diría que un
 * horario está bien cuando no lo está.
 */
async function ajustarHorario(req, res, { carrera, id }) {
    const opciones = await leerCuerpo(req);
    const { datos, aulas, grupos, partes } = await cargarConjunto(req, carrera, id, opciones);

    const ocupadas = (
        await saturacion.consultar({ paridad: resolverParidad(datos, opciones) })
    ).filter((o) => !partes.some((p) => o.carrera === p.carrera && o.escenarioId === p.escenarioId));

    const problema = construirProblema({
        datos,
        aulas,
        grupos,
        ocupadas,
        opciones: {
            ...opciones,
            prioridades: prioridad.mapaDe(carrera.toUpperCase())
        }
    });

    // El motor solo conoce ids: sus mensajes dicen "doc016", y eso es lo que
    // acababa leyendo el coordinador en pantalla. Los nombres los tiene el
    // backend, así que los pone antes de devolver el error.
    const { advertencias: avisosDelMotor, ...solucion } = await conNombres(
        () => motor.evaluar({ ...problema, sesiones: opciones.sesiones ?? [] }),
        problema.docentes
    );

    // El mismo resumen que al generar. La interfaz lo dibuja igual, y sin él
    // rompía al leer `resumen.semestres`: un horario ajustado tiene que ser
    // indistinguible de uno generado para todo lo que viene después.
    const validacion = validarParaHorario({
        datos,
        aulas,
        rejilla: problema.rejilla,
        grupos: problema.grupos,
        paridad: problema.paridad,
        ocupadas
    });

    responder(res, 200, {
        ...solucion,
        escenarioId: id,
        generadoEn: new Date().toISOString(),
        ajustado: true,
        resumen: validacion.resumen,
        necesidades: validacion.necesidades,
        paridad: problema.paridad,
        rejilla: problema.rejilla,
        grupos: problema.grupos.map(({ id: gid, clave, semestre, especialidad, turno, aulaClave, carrera: c }) => ({
            id: gid, clave, semestre, especialidad, turno, aulaClave, carrera: c
        })),
        parametros: problema.parametros,
        avisosDelMotor
    });
}

async function validarHorario(req, res, { carrera, id }) {
    const opciones = await leerCuerpo(req);
    const { datos, aulas, grupos: unidos, conjunta } = await cargarConjunto(req, carrera, id, opciones);

    const paridad = resolverParidad(datos, opciones);
    const rejilla = construirRejilla(datos.semestres, opciones);
    const ocupadasPrevias = await saturacion.consultar({
        paridad,
        excepto: { carrera: carrera.toUpperCase(), escenarioId: id }
    });
    // Los grupos llegan construidos —con las líneas pedidas o las guardadas, y
    // con el reparto del departamento pegado—: lo que se valida tiene que ser
    // exactamente lo que se va a generar.
    const grupos = asignarAulasBase(unidos, aulas, ocupadasPrevias, rejilla);
    const ocupadas = ocupadasPrevias;

    responder(res, 200, {
        ...validarParaHorario({ datos, aulas, rejilla, grupos, paridad, ocupadas }),
        // Horas que otras carreras ya pretenden de estos docentes.
        horasAjenas: ocupadas.length,
        paridadSugerida: paridadSugerida(datos.semestres),
        paridades: Object.entries(PARIDADES).map(([id, p]) => ({ id, ...p })),
        // La rejilla viaja también aquí: la interfaz dibuja una columna de
        // grupos por turno y necesita saber cuáles hay antes de generar nada.
        rejilla,
        // Materias que más de un grupo cursa en el mismo turno: fusionarlas
        // ahorra impartir la misma clase dos veces.
        fusionesPosibles: candidatas(datos.materias, grupos),
        // Entre carreras se listan aparte: juntar a 7A con 7B es cosa de un
        // coordinador, juntar a ISIC con ITIC toca dos planes de estudio.
        fusionesEntreCarreras: conjunta
            ? conjunto.candidatasEntreCarreras(datos.materias, grupos)
            : [],
        conjunta,
        lineas: lineasSugeridas(
            datos.materias,
            datos.especialidades,
            paridad,
            rejilla.turnos.map((t) => t.id)
        ),
        grupos: grupos.map(({ id, clave, semestre, especialidad, turno, aulaClave, materias, carrera }) => ({
            id,
            clave,
            semestre,
            especialidad,
            turno,
            aulaClave,
            carrera,
            materias: materias.length
        }))
    });
}

/**
 * Genera un horario. El backend arma el problema, el motor lo resuelve y la
 * respuesta se devuelve tal cual, más el problema que se usó — sin eso el
 * resultado no es reproducible ni auditable desde la interfaz.
 */
/**
 * Cuál de los escenarios es el que va a producción. Lo decide la coordinación
 * —es su carrera— y el departamento reparte contra él.
 */
async function marcarEscenarioBase(req, res, { carrera, id }) {
    auth.exigirCarrera(req.usuario, carrera);
    responder(res, 200, await escenarios.marcarBase(carrera.toUpperCase(), id));
}

async function generarHorario(req, res, { carrera, id }) {
    const opciones = await leerCuerpo(req);
    const { datos, aulas, grupos, conjunta, partes } = await cargarConjunto(req, carrera, id, opciones);

    // Lo que pretenden los demás. En un horario conjunto, "los demás" no incluye
    // a ninguna de las carreras que se están programando: sus horas se están
    // reemplazando, igual que las propias en el caso de una sola.
    const ocupadas = (
        await saturacion.consultar({ paridad: resolverParidad(datos, opciones) })
    ).filter((o) => !partes.some((p) => o.carrera === p.carrera && o.escenarioId === p.escenarioId));

    const problema = construirProblema({
        datos,
        aulas,
        grupos,
        ocupadas,
        opciones: {
            ...opciones,
            prioridades: prioridad.mapaDe(carrera.toUpperCase())
        }
    });

    // La misma validación que consulta la interfaz, repetida aquí. No es
    // redundancia: la interfaz guía, pero es este punto el que garantiza que no
    // salga un horario de datos incompletos, venga la petición de donde venga.
    const validacion = validarParaHorario({
        datos,
        aulas,
        rejilla: problema.rejilla,
        grupos: problema.grupos,
        paridad: problema.paridad,
        ocupadas
    });

    if (!validacion.listo) {
        throw new ErrorHttp(422, validacion.bloqueos.map((b) => b.mensaje).join(" "));
    }

    const { advertencias: avisosDelMotor, ...solucion } = await motor.resolver(problema);
    const { descartadas } = depurar(opciones.fusiones, problema.grupos);

    responder(res, 200, {
        ...solucion,
        // Fusiones pedidas que ya no tienen sentido con estos grupos. No son un
        // error —se ignoran y el horario sale igual— pero callarlas dejaría al
        // coordinador creyendo que fusionó algo que no se fusionó.
        fusionesDescartadas: descartadas,
        escenarioId: id,
        generadoEn: new Date().toISOString(),
        paridad: problema.paridad,
        rejilla: problema.rejilla,
        grupos: problema.grupos.map(({ id, clave, semestre, especialidad, turno, aulaClave, carrera }) => ({
            id,
            clave,
            semestre,
            especialidad,
            turno,
            aulaClave,
            // Solo en un horario conjunto: es lo que distingue al 1A de una
            // carrera del 1A de la otra.
            carrera
        })),
        parametros: problema.parametros,
        resumen: validacion.resumen,
        // Lo que falta por contratar viaja con el horario, no solo antes de
        // generarlo: es parte del resultado. Un horario al que le faltan clases
        // porque nadie puede darlas tiene que decirlo donde se lee el horario.
        necesidades: validacion.necesidades,
        // Las del backend son objetos con detalle; las del motor, texto suelto.
        // Se separan en vez de mezclarlas para que la interfaz no tenga que
        // adivinar de qué tipo es cada elemento.
        advertencias: validacion.advertencias,
        avisosDelMotor
    });
}

/**
 * Carga el escenario principal y los invitados, y los une en un solo problema.
 *
 * Los invitados llegan en `opciones.invitadas`. Se exige coordinar todos:
 * generar un horario multi-carrera es decidir el de todas, y nadie debería
 * decidir el de una carrera ajena desde su propia pantalla.
 */
async function cargarConjunto(req, carrera, id, opciones) {
    const principal = { carrera: carrera.toUpperCase(), escenarioId: id };
    const invitadas = (opciones.invitadas ?? []).map((x) => ({
        carrera: String(x.carrera).toUpperCase(),
        escenarioId: x.escenarioId
    }));

    for (const otra of invitadas) {
        if (otra.carrera === principal.carrera) {
            throw new ErrorHttp(400, `${otra.carrera} ya es la carrera que estás programando.`);
        }
        // O la coordinas tú, o su coordinador aceptó la invitación. Generar un
        // horario conjunto es decidir el de las dos.
        const puede = invitaciones.autorizada({
            anfitriona: principal.carrera,
            invitada: otra.carrera,
            escenarioId: otra.escenarioId,
            carreras: req.usuario.carreras
        });
        if (!puede) {
            throw new ErrorHttp(
                403,
                `${otra.carrera} no ha aceptado programar en conjunto con ${principal.carrera}. ` +
                    "Mándale una invitación desde Conciliación."
            );
        }
    }

    const todas = [principal, ...invitadas];
    const aulas = await almacen.leerAulas(principal.carrera);
    const partes = [];

    for (const cual of todas) {
        const { datos } = await escenarios.obtener(cual.carrera, cual.escenarioId);
        const paridad = resolverParidad(datos, opciones);
        const rejilla = construirRejilla(datos.semestres, opciones);
        // Cada carrera trae sus propias líneas de grupo: las del principal
        // vienen en `grupos`, las de un invitado en su entrada de `invitadas`.
        const pedidas = cual === principal
            ? opciones.grupos
            : (opciones.invitadas ?? []).find((x) => String(x.carrera).toUpperCase() === cual.carrera)
                  ?.grupos;
        // Si la petición no trae líneas, se usan las guardadas antes de caer en
        // la sugerencia. El departamento reparte contra los grupos configurados;
        // generar contra "un grupo por semestre" dejaría fuera a la mitad de las
        // clases que ya tienen a alguien al frente.
        const guardada = configEscenario.leer({
            carrera: cual.carrera,
            escenarioId: cual.escenarioId
        });
        const suyas =
            pedidas ?? (guardada?.paridad === paridad ? guardada.lineas : undefined);

        partes.push({
            carrera: cual.carrera,
            escenarioId: cual.escenarioId,
            datos,
            grupos: construirGrupos(datos.materias, datos.especialidades, rejilla, paridad, {
                ...opciones,
                grupos: suyas,
                // Quién imparte cada clase lo decidió el departamento: el motor
                // no elige docente, solo coloca el bloque. Va aquí, por carrera,
                // porque en un horario conjunto cada una tiene su reparto: que
                // alguien dé Cálculo en ISIC no dice nada de quién lo da en ITIC.
                asignaciones: catalogo.mapaDe(cual.carrera)
            })
        });
    }

    if (partes.length === 1) {
        // Los grupos ya están construidos, con las líneas pedidas o las
        // guardadas. Devolver `null` hacía que se reconstruyeran desde las
        // opciones de la petición, y sin líneas ahí el escenario volvía a la
        // sugerencia de un grupo por semestre.
        return { aulas, datos: partes[0].datos, grupos: partes[0].grupos, conjunta: false, partes };
    }

    const unido = conjunto.unir(partes);
    return {
        aulas,
        // Los docentes y los semestres son del instituto y del periodo, no de
        // una carrera: se toman del principal y valen para todas.
        datos: {
            ...partes[0].datos,
            materias: unido.materias,
            especialidades: unido.especialidades
        },
        grupos: unido.grupos,
        conjunta: true,
        partes
    };
}

function cargarEscenarioYAulas(carrera, id) {
    return Promise.all([escenarios.obtener(carrera, id), almacen.leerAulas(carrera)]).then(
        ([{ datos }, aulas]) => ({ datos, aulas })
    );
}
