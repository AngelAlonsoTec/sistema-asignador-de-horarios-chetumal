import { pintarCobertura, formatearFecha } from "./formato.js";

const MENSAJE_VACIO = "Sin escenarios para esta carrera todavía.";

/**
 * Dibuja la lista de escenarios. Reemplaza por completo lo que hubiera antes.
 *
 * @param {HTMLElement} contenedor - el <ul> de la lista
 * @param {HTMLTemplateElement} plantilla - <template> con la tarjeta de escenario
 * @param {Array<object>} escenarios - escenarios ya enriquecidos con cobertura
 */
export function renderEscenarios(contenedor, plantilla, escenarios) {
    if (escenarios.length === 0) {
        contenedor.replaceChildren(crearAviso(MENSAJE_VACIO, "empty-state"));
        return;
    }

    // Se arma en un fragmento para tocar el DOM una sola vez.
    const fragmento = document.createDocumentFragment();
    for (const escenario of escenarios) {
        fragmento.appendChild(crearTarjeta(plantilla, escenario));
    }
    contenedor.replaceChildren(fragmento);
}

/** Estado de error: la carrera tiene escenarios pero sus datos no se pudieron leer. */
export function renderError(contenedor, mensaje) {
    contenedor.replaceChildren(crearAviso(mensaje, "error-state"));
}

/** Ocupa el lugar de la lista mientras se leen los JSON. */
export function renderCargando(contenedor) {
    contenedor.replaceChildren(crearAviso("Cargando…", "loading-state"));
}

function crearTarjeta(plantilla, escenario) {
    const fragmento = plantilla.content.cloneNode(true);
    const tarjeta = fragmento.querySelector(".escenario-card");

    // Las acciones se resuelven por delegación desde main.js.
    tarjeta.dataset.escenarioId = escenario.id;

    tarjeta.querySelector(".escenario-nombre").textContent = escenario.nombre;
    tarjeta.querySelector(".escenario-fecha").textContent = formatearFecha(escenario.fecha);
    tarjeta.querySelector(".escenario-badge").hidden = !escenario.esBase;
    // El caso base no se puede borrar: sin él no queda de dónde partir para crear otros.
    tarjeta.querySelector(".escenario-menu").hidden = escenario.esBase;

    const { totalMaterias, totalDocentes } = escenario.cobertura;
    tarjeta.querySelector(".escenario-conteo").textContent =
        `${totalMaterias} materias · ${totalDocentes} docentes`;

    pintarCobertura(tarjeta.querySelector(".escenario-cobertura"), escenario.cobertura);
    return fragmento;
}

function crearAviso(mensaje, clase) {
    const aviso = document.createElement("li");
    aviso.className = clase;
    aviso.textContent = mensaje;
    return aviso;
}
