/**
 * Cobertura materia-docente: la validación central de la herramienta.
 *
 * Se calcula aquí y viaja ya resuelta al frontend. Podría hacerse en el cliente,
 * pero entonces las dos partes tendrían que estar de acuerdo en qué cuenta como
 * "cubierta", y esa es exactamente la clase de regla que no conviene duplicar.
 */

/** Cuántos docentes puede impartir cada materia: id de materia -> número. */
export function contarDocentesPorMateria(materias, docentes) {
    const conteo = new Map(materias.map((materia) => [materia.id, 0]));
    for (const docente of docentes) {
        for (const materiaId of docente.materiasCapacitadas ?? []) {
            if (conteo.has(materiaId)) conteo.set(materiaId, conteo.get(materiaId) + 1);
        }
    }
    return conteo;
}

export function calcularCobertura(materias, docentes) {
    const conteo = contarDocentesPorMateria(materias, docentes);
    const sinDocente = materias.filter((materia) => conteo.get(materia.id) === 0);

    return {
        total: materias.length,
        cubiertas: materias.length - sinDocente.length,
        sinDocente: sinDocente.map((materia) => materia.id),
        completa: sinDocente.length === 0
    };
}
