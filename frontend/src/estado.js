/**
 * Estado compartido de la aplicación.
 *
 * Un objeto `reactive` y unas cuantas funciones, en lugar de Pinia: el estado
 * es un escenario abierto y una lista, y una librería de estado para eso sería
 * más ceremonia que ayuda.
 *
 * La regla que ordena todo esto: **editar es local, guardar es explícito.** Las
 * mutaciones tocan `estado.abierto.datos` en memoria y marcan `sucio`; nada
 * viaja al servidor hasta que se presiona "Guardar cambios". Así se puede
 * probar un cambio y descartarlo recargando, que es justo para lo que sirve un
 * escenario.
 */

import { reactive, computed } from "vue";
import { api, avisarSiCaduca } from "./api.js";
import { calcularCobertura } from "./dominio/cobertura.js";

export const estado = reactive({
    /** Coordinador con la sesión abierta, o `null` si nadie ha entrado. */
    usuario: null,
    /** Mientras se comprueba la sesión no se sabe qué pantalla mostrar. */
    comprobandoSesion: true,
    carrera: "ISIC",
    carreras: [],
    escenarios: [],
    /** Escenario abierto: metadatos + `datos` editables. `null` = vista de lista. */
    abierto: null,
    /** Sección visible del escenario abierto. La barra lateral la gobierna. */
    seccion: "docentes",
    /** Filtro que una sección recibe al llegar desde otra parte de la interfaz. */
    filtroPendiente: null,
    cargando: false,
    error: null,
    aviso: null,
    /** Hay cambios en memoria que aún no se han guardado en disco. */
    sucio: false,
    /** Solicitudes de horas que otra carrera te hizo y siguen sin responder. */
    solicitudesPendientes: 0
});

/** Cobertura del escenario abierto, recalculada en cuanto cambia cualquier dato. */
export const coberturaActual = computed(() => {
    if (!estado.abierto) return null;
    const { materias, docentes } = estado.abierto.datos;
    return calcularCobertura(materias, docentes);
});

/** Marca que hay cambios pendientes. La llaman todas las mutaciones. */
export function ensuciar() {
    estado.sucio = true;
}

/**
 * Envoltura para las operaciones que hablan con el servidor: apaga el error
 * anterior, enciende el indicador de carga y deja el mensaje si algo falla.
 * Sin esto, cada llamada repetiría el mismo try/catch/finally.
 */
async function conCarga(operacion) {
    estado.cargando = true;
    estado.error = null;
    try {
        return await operacion();
    } catch (e) {
        estado.error = e.message;
        return null;
    } finally {
        estado.cargando = false;
    }
}

export function anunciar(mensaje) {
    estado.aviso = mensaje;
    setTimeout(() => {
        if (estado.aviso === mensaje) estado.aviso = null;
    }, 3500);
}

// ---------------------------------------------------------------- carga

/** Comprueba si ya había sesión abierta. Se llama una vez al arrancar. */
export async function comprobarSesion() {
    try {
        estado.usuario = await api.sesion();
    } catch {
        estado.usuario = null;
    } finally {
        estado.comprobandoSesion = false;
    }
    if (estado.usuario) await iniciar();
}

export async function entrar(credenciales) {
    estado.error = null;
    try {
        estado.usuario = await api.iniciarSesion(credenciales);
        await iniciar();
        return true;
    } catch (e) {
        estado.error = e.message;
        return false;
    }
}

/**
 * La sesión caducó mientras se trabajaba. Se vuelve a la entrada en vez de
 * dejar la pantalla llena de datos que ya no se pueden guardar, y se dice lo
 * que pasó —incluido que lo no guardado se quedó sin guardar, si lo había—.
 */
avisarSiCaduca(() => {
    if (!estado.usuario) return;
    const perdido = estado.sucio;
    estado.usuario = null;
    estado.abierto = null;
    estado.escenarios = [];
    estado.sucio = false;
    estado.error = perdido
        ? "Tu sesión se cerró por tiempo y los cambios sin guardar se perdieron. Vuelve a entrar."
        : "Tu sesión se cerró por tiempo. Vuelve a entrar.";
});

export async function salir() {
    await api.cerrarSesion().catch(() => {});
    estado.usuario = null;
    estado.abierto = null;
    estado.escenarios = [];
}

export async function iniciar() {
    const carreras = await conCarga(() => api.carreras());
    if (carreras?.length) {
        estado.carreras = carreras;
        if (!carreras.includes(estado.carrera)) estado.carrera = carreras[0];
    }
    await cargarEscenarios();
}

export async function cargarEscenarios() {
    const escenarios = await conCarga(() => api.escenarios(estado.carrera));
    estado.escenarios = escenarios ?? [];
}

export async function cambiarCarrera(carrera) {
    estado.carrera = carrera;
    estado.abierto = null;
    await cargarEscenarios();
}

export async function abrirEscenario(id) {
    const resultado = await conCarga(async () => {
        // En paralelo: las aulas son de la carrera y el escenario del escenario,
        // no dependen entre sí.
        // Tres orígenes distintos: el escenario es de la carrera, las aulas del
        // plantel y los docentes del instituto.
        const [escenario, aulas, docentes] = await Promise.all([
            api.escenario(estado.carrera, id),
            api.aulas(estado.carrera),
            api.docentes()
        ]);
        return { escenario, aulas, docentes };
    });
    if (!resultado) return;

    estado.abierto = {
        ...resultado.escenario,
        datos: { ...resultado.escenario.datos, aulas: resultado.aulas, docentes: resultado.docentes }
    };
    estado.seccion = "docentes";
    estado.filtroPendiente = null;
    estado.sucio = false;
    revisarPendientes();
}

export function cerrarEscenario() {
    estado.abierto = null;
    estado.sucio = false;
}

/**
 * Cambia de sección, opcionalmente con un filtro. Lo usa el chip de cobertura
 * para llevar directo a las materias que provocaron la alerta.
 */
export function irASeccion(seccion, filtro = null) {
    estado.seccion = seccion;
    estado.filtroPendiente = filtro;
}

// ---------------------------------------------------------------- escritura

export async function guardarAbierto() {
    if (!estado.abierto) return;
    const { id, datos } = estado.abierto;

    const guardado = await conCarga(async () => {
        // Solo lo que es de la carrera. La plantilla docente y los espacios son
        // del instituto: los administra el departamento, y mandarlos desde aquí
        // reemplazaba la lista entera para todas las demás carreras.
        await api.guardarEscenario(estado.carrera, id, {
            materias: datos.materias,
            semestres: datos.semestres,
            especialidades: datos.especialidades
        });
        return true;
    });

    if (guardado) {
        estado.sucio = false;
        anunciar("Cambios guardados.");
        await cargarEscenarios();
    }
}

export async function crearEscenario(datos) {
    const meta = await conCarga(() => api.crearEscenario(estado.carrera, datos));
    if (!meta) return null;
    await cargarEscenarios();
    anunciar(`Escenario "${meta.nombre}" creado.`);
    return meta;
}

export async function eliminarEscenario(id) {
    const hecho = await conCarga(() => api.eliminarEscenario(estado.carrera, id));
    if (!hecho) return;
    if (estado.abierto?.id === id) cerrarEscenario();
    await cargarEscenarios();
    anunciar("Escenario eliminado.");
}

/**
 * Marca cuál escenario es el que va a producción.
 *
 * No es cosmética: el departamento reparte los docentes contra el escenario
 * base, así que decir cuál es también decide sobre qué grupos se reparte.
 */
export async function marcarBase(id) {
    const hecho = await conCarga(() => api.marcarBase(estado.carrera, id));
    if (!hecho) return;
    await cargarEscenarios();
    anunciar("Ese es ahora el escenario base.");
}

export function verConflictos(opciones) {
    return conCarga(() => api.conflictos(estado.carrera, estado.abierto.id, opciones));
}

export async function verSolicitudes() {
    const r = await conCarga(() => api.solicitudes());
    if (r) contarPendientes(r);
    return r;
}

function contarPendientes(solicitudes) {
    estado.solicitudesPendientes = solicitudes.recibidas.filter(
        (s) => s.estado === "pendiente"
    ).length;
}

/**
 * Refresca el contador sin encender el indicador de carga. Se llama al abrir un
 * escenario y después de cada respuesta, que son los momentos en que puede
 * haber cambiado; sondear cada pocos segundos sería gastar por nada.
 */
export async function revisarPendientes() {
    try {
        contarPendientes(await api.solicitudes());
    } catch {
        // Sin sesión o sin red: el contador se queda como estaba.
    }
}

export async function solicitarHoras(cuerpo) {
    const r = await conCarga(() => api.solicitar(cuerpo));
    if (r) anunciar("Solicitud enviada.");
    return r;
}

export async function responderSolicitud(id, acepta, respuesta) {
    const r = await conCarga(() => api.responderSolicitud(id, { acepta, respuesta }));
    if (r) {
        revisarPendientes();
        anunciar(
            acepta
                ? `Horas cedidas: se liberaron ${r.bloquesLiberados} bloques de tu horario.`
                : "Solicitud rechazada."
        );
    }
    return r;
}

export function verSaturacion(opciones) {
    return conCarga(() => api.saturacion(opciones));
}

/**
 * Aparta en la hoja compartida las horas que este escenario pretende. Reservar
 * de nuevo sustituye lo anterior: un escenario tiene una sola pretensión.
 */
export function configEscenario() {
    return api.config(estado.carrera, estado.abierto.id);
}

export function guardarConfigEscenario(cuerpo) {
    return api.guardarConfig(estado.carrera, estado.abierto.id, cuerpo).catch(() => null);
}

export function horarioApartado() {
    return api.horarioApartado(estado.carrera, estado.abierto.id);
}

export async function reservarHoras(cuerpo) {
    const r = await conCarga(() => api.reservarHoras(estado.carrera, estado.abierto.id, cuerpo));
    if (r) anunciar(`${r.reservadas} horas apartadas en la hoja de saturación.`);
    return r;
}

export async function liberarHoras() {
    const r = await conCarga(() => api.liberarHoras(estado.carrera, estado.abierto.id));
    if (r) anunciar(`${r.liberadas} horas liberadas.`);
    return r;
}

export function ajustarHorario(cuerpo) {
    return conCarga(() => api.ajustarHorario(estado.carrera, estado.abierto.id, cuerpo));
}

export function generarHorario(opciones) {
    return conCarga(() => api.generarHorario(estado.carrera, estado.abierto.id, opciones));
}

/**
 * Consulta qué falta para poder generar. No pasa por `conCarga`: se llama en
 * cada cambio de la configuración, y encender el indicador global de carga en
 * cada pulsación haría parpadear toda la pantalla.
 */
export async function validarHorario(opciones) {
    try {
        return await api.validarHorario(estado.carrera, estado.abierto.id, opciones);
    } catch (e) {
        estado.error = e.message;
        return null;
    }
}
