/**
 * Lectura de los datos base desde data/<carrera>/.
 * Es el único archivo que sabe que los datos viven en JSON servidos por HTTP.
 *
 * Cada escenario es autocontenido (su propia carpeta con materias/docentes/
 * semestres), porque la especialidad de la retícula cambia cada pocos años
 * y no hay una fuente única (SII) con la que mantenerlos sincronizados.
 * Las aulas sí son compartidas: son infraestructura física del plantel, no
 * algo que varíe por escenario.
 */

/**
 * Se guarda la promesa, no el resultado: si dos vistas piden lo mismo
 * al mismo tiempo, comparten una sola petición.
 */
const cache = new Map();

/** Manifiesto de escenarios de una carrera: qué escenarios existen y su metadata. */
export function cargarIndiceEscenarios(carrera) {
    return conCache(`indice:${carrera}`, () =>
        leerJson(`${carpeta(carrera)}/escenarios/index.json`)
    );
}

/** Catálogo de aulas de una carrera. Compartido entre todos sus escenarios. */
export function cargarAulas(carrera) {
    return conCache(`aulas:${carrera}`, () =>
        leerJson(`${carpeta(carrera)}/aulas.json`)
    );
}

/**
 * Datos base completos de un escenario: lo que el motor recibiría como insumo
 * si este escenario fuera el elegido. Los grupos no van aquí porque son su
 * salida, no su entrada.
 */
export function cargarDatosEscenario(carrera, escenarioId) {
    return conCache(`escenario:${carrera}:${escenarioId}`, () => leerDatosEscenario(carrera, escenarioId));
}

async function leerDatosEscenario(carrera, escenarioId) {
    const base = `${carpeta(carrera)}/escenarios/${escenarioId}`;
    const [materias, docentes, semestres, especialidades, aulas] = await Promise.all([
        leerJson(`${base}/materias.json`),
        leerJson(`${base}/docentes.json`),
        leerJson(`${base}/semestres.json`),
        // Un escenario guardado antes de que existieran las especialidades no
        // tiene el archivo; sin especialidades es un estado válido, no un error.
        leerJson(`${base}/especialidades.json`).catch(() => []),
        cargarAulas(carrera)
    ]);
    return { materias, docentes, semestres, especialidades, aulas };
}

/**
 * Olvida lo que se cacheó de una carrera. Después de escribir en disco (crear
 * o borrar un escenario) lo leído antes ya no describe la realidad: sin esto,
 * un escenario borrado sigue apareciendo en la lista hasta recargar la página.
 */
export function invalidarCache(carrera, escenarioId) {
    cache.delete(`indice:${carrera}`);
    if (escenarioId) cache.delete(`escenario:${carrera}:${escenarioId}`);
}

function conCache(clave, leer) {
    if (!cache.has(clave)) cache.set(clave, leer());
    return cache.get(clave);
}

function carpeta(carrera) {
    return `data/${carrera.toLowerCase()}`;
}

async function leerJson(ruta) {
    const respuesta = await fetch(ruta);
    if (!respuesta.ok) {
        throw new Error(`No se pudo leer ${ruta} (HTTP ${respuesta.status})`);
    }
    return respuesta.json();
}
