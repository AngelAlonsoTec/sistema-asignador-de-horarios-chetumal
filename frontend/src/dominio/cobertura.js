/**
 * Cobertura materia-docente, calculada en el cliente.
 *
 * El backend también la calcula, pero para la lista de escenarios, donde no
 * manda los datos completos. Aquí hace falta la versión local porque mientras
 * se edita un escenario la cobertura tiene que actualizarse al instante: pedir
 * al servidor después de cada casilla marcada sería lento y además mostraría un
 * número que no corresponde a lo que se está viendo en pantalla.
 */

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
