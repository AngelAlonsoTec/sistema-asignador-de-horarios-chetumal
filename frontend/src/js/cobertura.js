/**
 * Regla de factibilidad más básica del sistema: toda materia necesita al
 * menos un docente capacitado para impartirla. Si alguna no lo tiene, el
 * motor nunca podrá generar un horario válido para ella.
 *
 * Funciones puras: no tocan el DOM ni leen archivos, así que se pueden
 * probar y reutilizar tal cual desde el motor.
 */

/**
 * @param {Array<{id: string, nombre: string}>} materias
 * @param {Array<{materiasCapacitadas: string[]}>} docentes
 * @returns {{totalMaterias: number, totalDocentes: number, sinDocente: Array, esCompleta: boolean}}
 */
export function calcularCobertura(materias, docentes) {
    const capacitadas = new Set(
        docentes.flatMap((docente) => docente.materiasCapacitadas)
    );
    const sinDocente = materias.filter((materia) => !capacitadas.has(materia.id));

    return {
        totalMaterias: materias.length,
        totalDocentes: docentes.length,
        sinDocente,
        esCompleta: sinDocente.length === 0
    };
}

/**
 * Cuántos docentes pueden impartir cada materia. Cero es un bloqueo; uno
 * solo es frágil, porque si ese docente se cae la materia se queda sin quién.
 *
 * @returns {Map<string, number>} id de materia → número de docentes
 */
export function contarDocentesPorMateria(materias, docentes) {
    const conteo = new Map(materias.map((materia) => [materia.id, 0]));

    for (const docente of docentes) {
        for (const id of docente.materiasCapacitadas) {
            if (conteo.has(id)) conteo.set(id, conteo.get(id) + 1);
        }
    }

    return conteo;
}
