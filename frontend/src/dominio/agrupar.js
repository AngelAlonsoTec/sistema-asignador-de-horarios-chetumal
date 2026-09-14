/**
 * Agrupaciones para las tablas. Son funciones puras y sin estado: las vistas
 * las llaman dentro de `computed`, y Vue se encarga de recalcularlas cuando los
 * datos cambian.
 */

/** Materias por semestre, en orden ascendente. */
export function porSemestre(materias) {
    const grupos = new Map();
    for (const materia of materias) {
        if (!grupos.has(materia.semestre)) grupos.set(materia.semestre, []);
        grupos.get(materia.semestre).push(materia);
    }
    return [...grupos].sort((a, b) => a[0] - b[0]);
}

/**
 * Dentro de un semestre, separa el tronco común de cada especialidad. El tronco
 * común va primero (clave `null`) porque es lo que cursan todos; las materias
 * de especialidad son la excepción y se leen mejor agrupadas aparte que
 * intercaladas con una etiqueta.
 */
export function porEspecialidad(materias, especialidades) {
    const grupos = new Map([[null, []]]);
    for (const especialidad of especialidades) grupos.set(especialidad.id, []);

    for (const materia of materias) {
        const clave = grupos.has(materia.especialidadId) ? materia.especialidadId : null;
        grupos.get(clave).push(materia);
    }
    return [...grupos].filter(([, suyas]) => suyas.length > 0);
}

/** Materias de una especialidad, del semestre más bajo al más alto. */
export function materiasDeEspecialidad(materias, especialidadId) {
    return materias
        .filter((materia) => materia.especialidadId === especialidadId)
        .sort((a, b) => a.semestre - b.semestre || a.clave.localeCompare(b.clave));
}

/**
 * Sesiones de un horario organizadas para pintar la rejilla semanal:
 * `mapa.get(dia).get(hora)` da las sesiones que empiezan ahí.
 */
export function porDiaYHora(sesiones) {
    const mapa = new Map();
    for (const sesion of sesiones) {
        if (!mapa.has(sesion.diaIndice)) mapa.set(sesion.diaIndice, new Map());
        const delDia = mapa.get(sesion.diaIndice);
        if (!delDia.has(sesion.horaInicio)) delDia.set(sesion.horaInicio, []);
        delDia.get(sesion.horaInicio).push(sesion);
    }
    return mapa;
}
