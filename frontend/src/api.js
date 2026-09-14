/**
 * Cliente del backend. Es el único módulo que sabe que los datos llegan por
 * HTTP; el resto del frontend trabaja con objetos.
 *
 * Todas las rutas son relativas: en desarrollo el proxy de Vite las reenvía y
 * en producción nginx hace lo mismo, así que no hay ninguna URL de servidor
 * escrita en el código.
 */

/**
 * A quién avisar cuando el servidor dice que ya no hay sesión.
 *
 * La sesión dura doce horas y caduca **mientras** se trabaja, no entre visitas:
 * hasta ahora cada acción fallaba con "Hay que iniciar sesión" escrito en un
 * hueco de la pantalla, con todos los datos delante y ninguno guardable, y sin
 * nada que llevara de vuelta a la entrada. Se avisa desde aquí porque es el
 * único sitio por el que pasan todas las peticiones.
 */
let alCaducar = null;

export function avisarSiCaduca(fn) {
    alCaducar = fn;
}

async function pedir(ruta, opciones = {}) {
    let respuesta;
    try {
        respuesta = await fetch(ruta, {
            headers: opciones.cuerpo ? { "Content-Type": "application/json" } : undefined,
            method: opciones.metodo ?? "GET",
            body: opciones.cuerpo ? JSON.stringify(opciones.cuerpo) : undefined,
            // La sesión viaja en cookie; sin esto el navegador no la manda.
            credentials: "include"
        });
    } catch (e) {
        throw new Error(`No se pudo contactar al servidor. ¿Está corriendo el backend? (${e.message})`);
    }

    const texto = await respuesta.text();
    const cuerpo = texto ? JSON.parse(texto) : null;

    // El backend explica sus errores; conviene mostrar ese mensaje y no uno
    // genérico, porque suele decir exactamente qué falta.
    if (!respuesta.ok) {
        // `GET /api/sesion` responde `null` sin sesión, no 401: si llega un 401
        // es que la sesión se cayó a media faena.
        if (respuesta.status === 401) alCaducar?.();
        const e = new Error(cuerpo?.error ?? `Error ${respuesta.status}`);
        e.codigo = respuesta.status;
        throw e;
    }
    return cuerpo;
}

export const api = {
    salud: () => pedir("/api/salud"),

    sesion: () => pedir("/api/sesion"),
    iniciarSesion: (cuerpo) => pedir("/api/sesion", { metodo: "POST", cuerpo }),
    cerrarSesion: () => pedir("/api/sesion", { metodo: "DELETE" }),
    carreras: () => pedir("/api/carreras"),

    /** La plantilla docente es del instituto, no de una carrera. */
    docentes: () => pedir("/api/docentes"),
    enlaces: () => pedir("/api/enlaces"),
    guardarDescargas: (id, descargas) =>
        pedir(`/api/docentes/${id}/descargas`, { metodo: "PUT", cuerpo: descargas }),

    periodos: () => pedir("/api/periodos"),
    cerrarPeriodo: (paridad) => pedir(`/api/periodos/${paridad}/cerrar`, { metodo: "POST", cuerpo: {} }),
    reabrirPeriodo: (paridad) => pedir(`/api/periodos/${paridad}/cerrar`, { metodo: "DELETE" }),
    importarDisponibilidad: (csv) =>
        pedir("/api/docentes/importar", { metodo: "POST", cuerpo: { csv } }),

    // Del formulario del docente: entra con su token, sin sesión.
    abrirDisponibilidad: (token) => pedir(`/api/disponibilidad/${token}`),
    guardarDisponibilidad: (token, cuerpo) =>
        pedir(`/api/disponibilidad/${token}`, { metodo: "PUT", cuerpo }),
    /** El horario que le tocó, de todas las carreras, por el mismo enlace. */
    miHorario: (token) => pedir(`/api/mi-horario/${token}`),

    /** Peticiones de cambio de docente entre una coordinación y el departamento. */
    cambios: () => pedir("/api/cambios"),
    pedirCambio: (cuerpo) => pedir("/api/cambios", { metodo: "POST", cuerpo }),
    responderCambio: (id, cuerpo) =>
        pedir(`/api/cambios/${id}/responder`, { metodo: "POST", cuerpo }),
    retirarCambio: (id) => pedir(`/api/cambios/${id}`, { metodo: "DELETE" }),

    guardarDocentes: (docentes) => pedir("/api/docentes", { metodo: "PUT", cuerpo: docentes }),

    aulas: (carrera) => pedir(`/api/carreras/${carrera}/aulas`),
    /** Los espacios del plantel. Solo el departamento los guarda. */
    aulasDelPlantel: () => pedir("/api/plantel/aulas"),
    guardarAulasDelPlantel: (aulas) => pedir("/api/plantel/aulas", { metodo: "PUT", cuerpo: aulas }),
    guardarAulas: (carrera, aulas) =>
        pedir(`/api/carreras/${carrera}/aulas`, { metodo: "PUT", cuerpo: aulas }),

    escenarios: (carrera) => pedir(`/api/carreras/${carrera}/escenarios`),
    escenario: (carrera, id) => pedir(`/api/carreras/${carrera}/escenarios/${id}`),
    crearEscenario: (carrera, datos) =>
        pedir(`/api/carreras/${carrera}/escenarios`, { metodo: "POST", cuerpo: datos }),
    guardarEscenario: (carrera, id, datos) =>
        pedir(`/api/carreras/${carrera}/escenarios/${id}`, { metodo: "PUT", cuerpo: datos }),
    eliminarEscenario: (carrera, id) =>
        pedir(`/api/carreras/${carrera}/escenarios/${id}`, { metodo: "DELETE" }),

    generarHorario: (carrera, id, opciones) =>
        pedir(`/api/carreras/${carrera}/escenarios/${id}/horario`, {
            metodo: "POST",
            cuerpo: opciones
        }),

    conflictos: (carrera, id, cuerpo) =>
        pedir(`/api/carreras/${carrera}/escenarios/${id}/conflictos`, { metodo: "POST", cuerpo }),

    solicitudes: () => pedir("/api/solicitudes"),
    historialSaturacion: (cuerpo) =>
        pedir("/api/saturacion/historial", { metodo: "POST", cuerpo }),
    solicitar: (cuerpo) => pedir("/api/solicitudes", { metodo: "POST", cuerpo }),
    responderSolicitud: (id, cuerpo) =>
        pedir(`/api/solicitudes/${id}/responder`, { metodo: "POST", cuerpo }),

    /** Permiso para meter la carrera de otro coordinador en un horario conjunto. */
    /** Todas las del plantel, para poder nombrar a quién se invita. */
    plantel: () => pedir("/api/plantel/carreras"),
    /** Catálogo por carrera: qué clases tiene y quién imparte cada una. */
    catalogo: () => pedir("/api/plantel/catalogo"),
    catalogoDe: (carrera) => pedir(`/api/plantel/catalogo/${carrera}`),
    /** Quién imparte una materia a un grupo. `docenteId` nulo la deja sin asignar. */
    asignar: (cuerpo) => pedir("/api/plantel/asignaciones", { metodo: "PUT", cuerpo }),
    /** Lo que cada docente acumula en todo el instituto. */
    cargaDocentes: () => pedir("/api/plantel/carga"),
    /** Pedirle a otra coordinación las horas de un docente o de un salón. */
    solicitar: (cuerpo) => pedir("/api/solicitudes", { metodo: "POST", cuerpo }),

    /** Qué carrera tiene tomada cada hora de cada aula. */
    ocupacionDeAulas: (cuerpo) => pedir("/api/saturacion/aulas", { metodo: "POST", cuerpo }),

    /** Las reglas del reglamento del TecNM y a quién no le cuadran. */
    normativa: () => pedir("/api/plantel/normativa"),
    /** La misma persona en todos los grupos que cursan una materia. */
    asignarMateria: (cuerpo) =>
        pedir("/api/plantel/asignaciones/materia", { metodo: "POST", cuerpo }),
    /** Quién ha tenido cada clase antes de quien la tiene ahora. */
    historialReparto: (cuerpo) =>
        pedir("/api/plantel/asignaciones/historial", { metodo: "POST", cuerpo }),
    /** Quita el reparto entero de una carrera. */
    vaciarReparto: (carrera) =>
        pedir(`/api/plantel/asignaciones/${carrera}`, { metodo: "DELETE" }),

    /** Cuál de los escenarios va a producción: contra él reparte el departamento. */
    marcarBase: (carrera, id) =>
        pedir(`/api/carreras/${carrera}/escenarios/${id}/base`, { metodo: "PUT", cuerpo: {} }),

    abrirCarrera: (cuerpo) => pedir("/api/plantel/carreras", { metodo: "POST", cuerpo }),
    cerrarCarreraDelPlantel: (codigo) =>
        pedir(`/api/plantel/carreras/${codigo}`, { metodo: "DELETE" }),
    invitaciones: () => pedir("/api/invitaciones"),
    invitar: (cuerpo) => pedir("/api/invitaciones", { metodo: "POST", cuerpo }),
    responderInvitacion: (id, cuerpo) =>
        pedir(`/api/invitaciones/${id}/responder`, { metodo: "POST", cuerpo }),
    revocarInvitacion: (id) => pedir(`/api/invitaciones/${id}`, { metodo: "DELETE" }),

    /** Choque entre dos carreras del mismo coordinador: se resuelve, no se pide. */
    resolverPropio: (cuerpo) => pedir("/api/conflictos/propio", { metodo: "POST", cuerpo }),

    /** Prioridad docente dentro de una carrera: la fija su coordinador. */
    prioridades: (carrera) => pedir(`/api/carreras/${carrera}/prioridades`),
    guardarPrioridades: (carrera, prioridades) =>
        pedir(`/api/carreras/${carrera}/prioridades`, { metodo: "PUT", cuerpo: { prioridades } }),

    // ---------------------------------------------------------------- cuentas

    cambiarClave: (cuerpo) => pedir("/api/sesion/clave", { metodo: "POST", cuerpo }),
    usuarios: () => pedir("/api/usuarios"),
    crearUsuario: (cuerpo) => pedir("/api/usuarios", { metodo: "POST", cuerpo }),
    asignarCarreras: (id, carreras) =>
        pedir(`/api/usuarios/${id}/carreras`, { metodo: "PUT", cuerpo: { carreras } }),
    reiniciarClave: (id, nueva) =>
        pedir(`/api/usuarios/${id}/clave`, { metodo: "POST", cuerpo: { nueva } }),
    retirarUsuario: (id) => pedir(`/api/usuarios/${id}`, { metodo: "DELETE" }),

    /** Hoja de saturación de todos los docentes para un periodo. */
    saturacion: (opciones) => pedir("/api/saturacion", { metodo: "POST", cuerpo: opciones }),

    /** Paridad, grupos y fusiones elegidos antes de generar. */
    config: (carrera, id) => pedir(`/api/carreras/${carrera}/escenarios/${id}/config`),
    guardarConfig: (carrera, id, cuerpo) =>
        pedir(`/api/carreras/${carrera}/escenarios/${id}/config`, { metodo: "PUT", cuerpo }),

    /** El horario que este escenario tiene apartado. `null` si no apartó nada. */
    horarioApartado: (carrera, id) =>
        pedir(`/api/carreras/${carrera}/escenarios/${id}/reserva`),

    reservarHoras: (carrera, id, cuerpo) =>
        pedir(`/api/carreras/${carrera}/escenarios/${id}/reserva`, { metodo: "PUT", cuerpo }),

    liberarHoras: (carrera, id) =>
        pedir(`/api/carreras/${carrera}/escenarios/${id}/reserva`, { metodo: "DELETE" }),

    /** Reevalúa un horario movido a mano. Las reglas las aplica el motor. */
    ajustarHorario: (carrera, id, cuerpo) =>
        pedir(`/api/carreras/${carrera}/escenarios/${id}/horario/ajuste`, {
            metodo: "POST",
            cuerpo
        }),

    /** Estado de preparación: qué falta antes de poder generar un horario. */
    validarHorario: (carrera, id, opciones) =>
        pedir(`/api/carreras/${carrera}/escenarios/${id}/horario/validacion`, {
            metodo: "POST",
            cuerpo: opciones
        })
};
