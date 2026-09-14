/**
 * Traducción de un escenario al problema que entiende el motor.
 *
 * Aquí vive el puente entre lo que la coordinación captura y lo que un
 * algoritmo de horarios necesita. Los archivos del escenario describen la
 * retícula y la plantilla docente, pero no dicen a qué horas se dan clases, qué
 * semestres se ofertan este periodo ni cuántos grupos abre cada uno. Ese vacío
 * se llena en este módulo.
 *
 * Se resuelve aquí y no en los archivos a propósito: el número de grupos
 * depende de la matrícula y la paridad depende del periodo, y ninguna de las
 * dos cosas pertenece a la definición de un escenario.
 */

import { ErrorHttp } from "./http.js";
import { depurar } from "./fusiones.js";
import { esParidadValida, paridadSugerida, semestresDe } from "./periodo.js";

/**
 * Turno matutino 07:00-14:00, vespertino 14:00-22:00.
 *
 * El día no se acota por costumbre: el **artículo 157** del Reglamento Interior
 * de Trabajo del Personal Docente fija las actividades docentes diarias de las
 * 7 a las 22 horas, de lunes a viernes. El corte entre los dos turnos sí es del
 * plantel.
 */
const HORARIO_DE_TURNO = {
    matutino: { horaInicio: 7, horaFin: 14 },
    vespertino: { horaInicio: 14, horaFin: 22 }
};

const DIAS_HABILES = ["lunes", "martes", "miercoles", "jueves", "viernes"];

const LETRAS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Los semestres altos se imparten en vespertino; es donde cabe su carga. */
const SEMESTRE_VESPERTINO_DESDE = 6;

// ---------------------------------------------------------------- rejilla

/**
 * Rejilla de tiempo. Toma los turnos declarados en `semestres.json` — que son
 * solo nombres — y les pone horas. Si un escenario nombra un turno que no está
 * en la tabla, hay que declararlo en la petición: inventarle un horario sería
 * peor que fallar.
 */
export function construirRejilla(semestres, opciones = {}) {
    if (opciones.rejilla) return normalizarRejilla(opciones.rejilla);

    // Sin semestres de referencia se asumen los dos turnos del plantel: es lo
    // que hace falta para dibujar una hoja de saturación completa, que no
    // pertenece a ningún escenario en particular.
    const nombres = [...new Set(semestres.flatMap((semestre) => semestre.turnos ?? []))];
    const turnos = (nombres.length > 0 ? nombres : Object.keys(HORARIO_DE_TURNO)).map((id) => {
        const horario = HORARIO_DE_TURNO[id];
        if (!horario) {
            throw new ErrorHttp(
                422,
                `El turno "${id}" no tiene horario conocido. Envíalo en "rejilla.turnos" con horaInicio y horaFin.`
            );
        }
        return { id, ...horario };
    });

    return {
        dias: opciones.dias ?? DIAS_HABILES,
        turnos,
        // Una materia no puede aparecer dos veces el mismo día (lo impide el
        // motor), así que el bloque es exactamente lo que se imparte en una
        // jornada y este tope es el de horas diarias.
        duracionMaximaBloque: topeDeBloque(opciones.duracionMaximaBloque)
    };
}

/**
 * Tope reglamentario de horas de una materia en un mismo día. Es el máximo, no
 * lo deseable: el motor reparte en bloques de dos horas mientras alcancen los
 * días de la semana y solo sube a tres cuando no alcanzan.
 */
const MAX_HORAS_POR_DIA = 3;

function topeDeBloque(pedido) {
    const valor = Number(pedido ?? MAX_HORAS_POR_DIA);
    if (!Number.isInteger(valor) || valor < 1) return MAX_HORAS_POR_DIA;
    return Math.min(valor, MAX_HORAS_POR_DIA);
}

function normalizarRejilla(rejilla) {
    if (!Array.isArray(rejilla.dias) || rejilla.dias.length === 0) {
        throw new ErrorHttp(422, "La rejilla necesita al menos un día.");
    }
    if (!Array.isArray(rejilla.turnos) || rejilla.turnos.length === 0) {
        throw new ErrorHttp(422, "La rejilla necesita al menos un turno.");
    }
    for (const turno of rejilla.turnos) {
        if (!turno.id || !Number.isInteger(turno.horaInicio) || !Number.isInteger(turno.horaFin)) {
            throw new ErrorHttp(422, "Cada turno necesita id, horaInicio y horaFin enteros.");
        }
        if (turno.horaFin <= turno.horaInicio) {
            throw new ErrorHttp(422, `El turno "${turno.id}" termina antes de empezar.`);
        }
    }
    return { ...rejilla, duracionMaximaBloque: topeDeBloque(rejilla.duracionMaximaBloque) };
}

// ---------------------------------------------------------------- paridad

export function resolverParidad(datos, opciones = {}) {
    const paridad = opciones.paridad ?? paridadSugerida(datos.semestres);
    if (!esParidadValida(paridad)) {
        throw new ErrorHttp(422, `Paridad desconocida: "${paridad}". Usa "impares" o "pares".`);
    }
    return paridad;
}

/** Materias del periodo. El motor no debe programar lo que no se imparte. */
export function materiasDelPeriodo(materias, paridad) {
    const activos = new Set(semestresDe(paridad));
    return materias.filter((materia) => activos.has(materia.semestre));
}

// ---------------------------------------------------------------- grupos

/**
 * Las líneas de configuración de grupos: una por cada combinación de semestre y
 * especialidad que exista en el periodo.
 *
 * Un grupo pertenece a una especialidad. Sus materias son el tronco común de su
 * semestre **más** las de su especialidad, nunca las de otra: en octavo, el
 * grupo de Desarrollo Web y el de Negocios Digitales comparten el tronco común
 * y difieren en el módulo. Darle a un grupo todas las materias de especialidad
 * del semestre le inventaría clases que sus alumnos no cursan.
 */
export function lineasSugeridas(materias, especialidades, paridad, turnosDisponibles = ["matutino", "vespertino"]) {
    const activas = materiasDelPeriodo(materias, paridad);
    const porSemestre = new Map();

    for (const materia of activas) {
        if (!porSemestre.has(materia.semestre)) porSemestre.set(materia.semestre, new Set());
        porSemestre.get(materia.semestre).add(materia.especialidadId ?? null);
    }

    const nombres = new Map(especialidades.map((e) => [e.id, e.nombre]));
    const lineas = [];

    // Un semestre puede abrir grupos en más de un turno a la vez, así que la
    // línea guarda una cantidad por turno en vez de un turno único. Sin esto,
    // pedir dos grupos de primero obligaba a ponerlos los dos en la mañana.
    const sinGrupos = Object.fromEntries(turnosDisponibles.map((turno) => [turno, 0]));
    const porOmision = (semestre) => ({
        ...sinGrupos,
        [semestre >= SEMESTRE_VESPERTINO_DESDE ? "vespertino" : "matutino"]: 1
    });

    for (const [semestre, presentes] of [...porSemestre].sort((a, b) => a[0] - b[0])) {
        const conEspecialidad = [...presentes].filter((id) => id !== null && nombres.has(id));

        if (conEspecialidad.length === 0) {
            lineas.push({
                semestre,
                especialidadId: null,
                especialidad: null,
                porTurno: porOmision(semestre)
            });
            continue;
        }

        // Donde hay especialidades, los grupos son de especialidad: el tronco
        // común de ese semestre lo cursan igual, dentro de su propio grupo.
        for (const id of conEspecialidad) {
            lineas.push({
                semestre,
                especialidadId: id,
                especialidad: nombres.get(id),
                porTurno: porOmision(semestre)
            });
        }
    }
    return lineas;
}

/** Materias que cursa un grupo: tronco común de su semestre más su módulo. */
function materiasDeLinea(materias, semestre, especialidadId) {
    return materias
        .filter((materia) => materia.semestre === semestre)
        .filter((materia) => materia.especialidadId == null || materia.especialidadId === especialidadId)
        .map((materia) => materia.id);
}

export function construirGrupos(materias, especialidades, rejilla, paridad, opciones = {}) {
    const activas = materiasDelPeriodo(materias, paridad);
    const lineas =
        opciones.grupos ??
        lineasSugeridas(materias, especialidades, paridad, rejilla.turnos.map((t) => t.id));
    const idsDeTurno = new Set(rejilla.turnos.map((turno) => turno.id));
    const nombres = new Map(especialidades.map((e) => [e.id, e.nombre]));
    const porId = new Map(activas.map((m) => [m.id, m]));

    const grupos = [];
    // Las letras se reparten por semestre, no por línea ni por turno: en
    // octavo, el grupo de Desarrollo Web es 8A y el de Negocios Digitales 8B,
    // no los dos "8A".
    const letraSiguiente = new Map();

    for (const linea of lineas) {
        const semestre = Number(linea.semestre);
        const especialidadId = linea.especialidadId ?? null;
        if (especialidadId !== null && !nombres.has(especialidadId)) {
            throw new ErrorHttp(422, `El grupo pide la especialidad "${especialidadId}", que no existe.`);
        }

        const suyas = materiasDeLinea(activas, semestre, especialidadId);
        if (suyas.length === 0) continue;

        const porTurno = linea.porTurno ?? {};
        for (const turno of Object.keys(porTurno)) {
            if (!idsDeTurno.has(turno)) {
                throw new ErrorHttp(422, `El semestre ${semestre} pide el turno "${turno}", que no está en la rejilla.`);
            }
        }

        // Se recorre en el orden de la rejilla y no el del objeto recibido,
        // para que las letras salgan siempre igual: primero los matutinos.
        for (const { id: turno } of rejilla.turnos) {
            const cantidad = Math.max(0, Math.trunc(Number(porTurno[turno] ?? 0)));

            for (let i = 0; i < cantidad; i++) {
                const indice = letraSiguiente.get(semestre) ?? 0;
                letraSiguiente.set(semestre, indice + 1);
                const letra = LETRAS[indice] ?? String(indice + 1);
                const clave = `${semestre}${letra}`;

                grupos.push({
                    id: `g-${semestre}${letra.toLowerCase()}`,
                    clave,
                    semestre,
                    especialidadId,
                    especialidad: especialidadId ? nombres.get(especialidadId) : null,
                    turno,
                    // Matrícula del grupo. Viene en la configuración porque
                    // depende del periodo, no de la definición del escenario.
                    alumnos: Number(linea.alumnos ?? 0),
                    // `materiaId -> docenteId` que el departamento asignó a
                    // este grupo. Sin asignar, el motor elige entre los
                    // capacitados, que es el estado normal a medio repartir.
                    asignaciones: Object.fromEntries(
                        suyas
                            .map((id) => [id, opciones.asignaciones?.get(`${id}|${clave}`)])
                            .filter(([, docente]) => docente)
                    ),
                    materias: suyas,
                    // Lo que el grupo ocupa en la semana. Es el presupuesto que
                    // consume del aula que le toque: dos grupos comparten salón
                    // si entre los dos caben en las horas del turno.
                    horasSemana: suyas.reduce(
                        (n, id) => n + (porId.get(id)?.horasSemana ?? 0),
                        0
                    )
                });
            }
        }
    }
    return grupos;
}

/**
 * Reparte un aula fija entre los grupos. El grupo se queda en su salón y el
 * docente es quien rota; solo las materias de laboratorio lo sacan de ahí.
 *
 * El contador se reinicia en cada turno, así que **un aula se reutiliza entre
 * turnos**: la que ocupa 1A por la mañana queda libre para un grupo vespertino.
 * Es correcto porque los turnos no se solapan, y es lo que hace que doce aulas
 * alcancen para más de doce grupos.
 *
 * Se resuelve aquí y no en el motor a propósito: repartir aulas entre grupos es
 * una decisión de la coordinación con solución directa, y dejarla al algoritmo
 * solo agrandaría el espacio de búsqueda sin mejorar el horario.
 */
export function asignarAulasBase(grupos, aulas, ocupadasPorOtros = [], rejilla = null) {
    const normales = aulas.filter((aula) => aula.tipo !== "laboratorio");

    // Cuántas horas caben en un aula durante un turno. Es el presupuesto que se
    // reparte: un aula de matutino tiene siete horas por cinco días.
    const dias = rejilla?.dias?.length ?? 5;
    const ranuras = new Map(
        (rejilla?.turnos ?? []).map((t) => [t.id, (t.horaFin - t.horaInicio) * dias])
    );
    const presupuesto = (turno) => ranuras.get(turno) ?? 35;

    // Lo que otras carreras ya ocupan de cada aula, por turno. Antes bastaba con
    // que otra carrera tuviera **una** hora para descartar el aula entera, y con
    // trece carreras eso agotaba los salones enseguida.
    const ajeno = new Map();
    for (const o of ocupadasPorOtros) {
        if (!o.aulaId) continue;
        const turno = (rejilla?.turnos ?? []).find((t) => o.inicio >= t.horaInicio && o.fin <= t.horaFin);
        const clave = `${turno?.id ?? "?"}|${o.aulaId}`;
        ajeno.set(clave, (ajeno.get(clave) ?? 0) + (o.fin - o.inicio));
    }

    const ocupado = new Map();
    const gastado = (turno, aulaId) =>
        (ocupado.get(`${turno}|${aulaId}`) ?? 0) + (ajeno.get(`${turno}|${aulaId}`) ?? 0);

    for (const grupo of grupos) {
        const suyas = grupo.horasSemana ?? 0;
        const cabe = (a) =>
            (a.capacidad == null || grupo.alumnos == null || a.capacidad >= grupo.alumnos) &&
            gastado(grupo.turno, a.id) + suyas <= presupuesto(grupo.turno);

        // Primero un aula que nadie use en ese turno; compartir solo cuando no
        // queda ninguna libre. Es lo que se hace de verdad —nadie mete dos
        // grupos en un salón habiendo uno vacío— y además le deja al motor el
        // problema más fácil: un aula con dos grupos hay que entrelazarla sin
        // que se pisen, y eso es una restricción dura más.
        //
        // Y al compartir, la **más vacía** y no la primera que quepa: meter un
        // grupo en el salón más lleno del plantel deja al motor sin margen y
        // acaba en horas encimadas, aunque en el papel cupieran.
        const holgura = (a) => presupuesto(grupo.turno) - gastado(grupo.turno, a.id);
        const aula =
            normales.find((a) => gastado(grupo.turno, a.id) === 0 && cabe(a)) ??
            normales.filter(cabe).sort((x, y) => holgura(y) - holgura(x))[0];

        // Sin aula disponible se deja en null; la validación lo bloquea con el
        // número exacto que falta, en vez de repetir un aula en silencio.
        if (aula) {
            ocupado.set(
                `${grupo.turno}|${aula.id}`,
                (ocupado.get(`${grupo.turno}|${aula.id}`) ?? 0) + suyas
            );
        }
        grupo.aulaId = aula?.id ?? null;
        grupo.aulaClave = aula?.clave ?? null;
    }
    return grupos;
}



/** Horas en que otra carrera usa cada espacio, para que el motor las evite. */
export function aulasConOcupacion(aulas, rejilla, ocupadasPorOtros = []) {
    return aulas.map((aula) => ({
        ...aula,
        ocupada: aBloques(
            porDia(ocupadasPorOtros.filter((o) => o.aulaId === aula.id), rejilla),
            rejilla
        )
    }));
}

// ---------------------------------------------------------------- disponibilidad

/**
 * Horas en que un docente puede dar clase: lo que declaró menos sus descargas
 * administrativas.
 *
 * Las descargas las carga el departamento académico y no las toca ni el
 * coordinador ni el docente; aquí simplemente se descuentan. El motor recibe el
 * resultado ya resuelto y no sabe de comisiones: solo de horas libres.
 */
export function horasDisponibles(docente, rejilla) {
    const declarada = porDia(docente.disponibilidad?.declarada ?? [], rejilla);
    for (const bloque of docente.descargas ?? []) {
        quitar(declarada, bloque, rejilla);
    }
    return aBloques(declarada, rejilla);
}

/**
 * Horas de este docente que otra carrera ya pretende.
 *
 * No se restan de las disponibles a propósito: todos trabajan en borrador y
 * nadie bloquea a nadie. El motor las evita porque pesan, pero si no hay
 * alternativa las toma y quedan como conflicto negociable. Restarlas
 * convertiría un desacuerdo en un horario imposible.
 */
export function horasEnDisputa(docente, rejilla, ocupadas = []) {
    const suyas = ocupadas.filter((o) => o.docenteId === docente.id);
    return aBloques(porDia(suyas, rejilla), rejilla);
}

export function horasEvitadas(docente, rejilla) {
    return aBloques(porDia(docente.disponibilidad?.evitar ?? [], rejilla), rejilla);
}

/** Un arreglo de horas marcadas por día, para poder sumar y restar bloques. */
function porDia(bloques, rejilla) {
    const [base, tope] = rangoHoras(rejilla);
    const mapa = new Map(rejilla.dias.map((dia) => [dia, new Array(tope - base).fill(false)]));

    for (const bloque of bloques) {
        const horas = mapa.get(bloque.dia);
        if (!horas) continue;
        for (let h = Math.max(bloque.inicio, base); h < Math.min(bloque.fin, tope); h++) {
            horas[h - base] = true;
        }
    }
    return mapa;
}

function quitar(mapa, bloque, rejilla) {
    const [base, tope] = rangoHoras(rejilla);
    const horas = mapa.get(bloque.dia);
    if (!horas) return;
    for (let h = Math.max(bloque.inicio, base); h < Math.min(bloque.fin, tope); h++) {
        horas[h - base] = false;
    }
}

/** Vuelve a bloques contiguos: restar deja huecos y no conviene mandar hora a hora. */
function aBloques(mapa, rejilla) {
    const [base] = rangoHoras(rejilla);
    const salida = [];

    for (const [dia, horas] of mapa) {
        let inicio = null;
        for (let i = 0; i <= horas.length; i++) {
            if (horas[i]) {
                inicio ??= i;
            } else if (inicio !== null) {
                salida.push({ dia, inicio: base + inicio, fin: base + i });
                inicio = null;
            }
        }
    }
    return salida;
}

function rangoHoras(rejilla) {
    return [
        Math.min(...rejilla.turnos.map((t) => t.horaInicio)),
        Math.max(...rejilla.turnos.map((t) => t.horaFin))
    ];
}

// ---------------------------------------------------------------- problema

/**
 * El documento completo que se le manda al motor. Los docentes viajan tal como
 * están guardados: el motor ignora los campos que no le interesan, y filtrarlos
 * aquí solo daría una cosa más que mantener sincronizada.
 */
export function construirProblema({ datos, aulas, opciones = {}, ocupadas = [], grupos: yaHechos }) {
    const paridad = resolverParidad(datos, opciones);
    const rejilla = construirRejilla(datos.semestres, opciones);
    // Con varias carreras los grupos llegan ya unidos y renombrados: aquí no se
    // pueden reconstruir porque harían falta las materias de cada una por
    // separado, y el conjunto ya las fundió.
    const grupos = asignarAulasBase(
        yaHechos ?? construirGrupos(datos.materias, datos.especialidades, rejilla, paridad, opciones),
        aulas,
        ocupadas,
        rejilla
    );

    // Qué materias necesitan laboratorio se lee del propio escenario. El motor
    // trata el campo ausente como `false`, así que los escenarios anteriores a
    // esta versión siguen funcionando sin migración.
    const laboratorios = new Set(opciones.materiasLaboratorio ?? []);
    const enGrupos = new Set(grupos.flatMap((grupo) => grupo.materias));
    const materias = materiasDelPeriodo(datos.materias, paridad)
        .filter((materia) => enGrupos.has(materia.id))
        .map((materia) => ({
            ...materia,
            requiereLaboratorio: laboratorios.has(materia.id) || materia.requiereLaboratorio === true
        }));

    return {
        paridad,
        parametros: opciones.parametros ?? {},
        rejilla,
        materias,
        // El docente viaja con su disponibilidad ya resuelta en bloques: el
        // motor no sabe de turnos, descargas ni formularios.
        docentes: datos.docentes.map((docente) => ({
            ...docente,
            // La pone el coordinador de esta carrera; sin fila es 0.
            prioridad: opciones.prioridades?.get(docente.id) ?? 0,
            disponible: horasDisponibles(docente, rejilla),
            evita: horasEvitadas(docente, rejilla),
            enDisputa: horasEnDisputa(docente, rejilla, ocupadas)
        })),
        aulas: aulasConOcupacion(aulas, rejilla, ocupadas),
        grupos,
        // Materias que varios grupos cursan juntos. Se depuran contra los grupos
        // de esta petición: una fusión que nombra un grupo que ya no se abre es
        // un dato viejo, no un error del coordinador, y tumbar el horario por
        // eso sería peor que ignorarla.
        fusiones: depurar(opciones.fusiones, grupos).validas
    };
}
