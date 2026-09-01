/**
 * Filtros de las tablas del detalle. Funciones puras: reciben datos y
 * devuelven datos, sin tocar el DOM.
 */

/** Criterios del tab de materias, más allá de la búsqueda por texto. */
export const FILTROS_MATERIA = {
    todas: () => true,
    "sin-docente": (materia, conteo) => conteo.get(materia.id) === 0
};

/**
 * Busca el texto en los campos indicados, sin distinguir acentos ni
 * mayúsculas: el coordinador escribe "calculo" y espera "Cálculo".
 *
 * Un campo puede ser el nombre de una propiedad o una función que derive
 * el texto a buscar (ej. las materias que imparte un docente).
 *
 * @param {Array<object>} registros
 * @param {string} texto
 * @param {Array<string | ((registro: object) => string)>} campos
 */
export function buscar(registros, texto, campos) {
    const aguja = normalizar(texto);
    if (!aguja) return registros;

    return registros.filter((registro) =>
        campos.some((campo) => {
            const valor = typeof campo === "function" ? campo(registro) : registro[campo];
            return normalizar(valor).includes(aguja);
        })
    );
}

function normalizar(valor) {
    return String(valor ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}
