const CLASE_ACTIVA = "is-active";

/**
 * Conecta una barra de tabs. Sirve para cualquier barra: el valor de cada
 * tab se lee del data-attribute que se indique.
 *
 * Usa delegación de eventos: un solo listener en el contenedor, así los
 * tabs se pueden agregar o quitar del HTML sin tocar este archivo.
 *
 * @param {HTMLElement} contenedor - elemento que agrupa los .tab
 * @param {string} clave - nombre del data-attribute (ej. "carrera" → data-carrera)
 * @param {(valor: string) => void} alCambiar
 */
export function iniciarTabs(contenedor, clave, alCambiar) {
    contenedor.addEventListener("click", (evento) => {
        const tab = evento.target.closest(".tab");
        if (!tab || tab.classList.contains(CLASE_ACTIVA)) return;

        marcarActivo(contenedor, tab);
        alCambiar(tab.dataset[clave]);
    });
}

/** Deja seleccionado el primer tab, sin disparar el callback. */
export function reiniciarTabs(contenedor) {
    const tabs = contenedor.querySelectorAll(".tab");
    marcarActivo(contenedor, tabs[0]);
}

/** Selecciona un tab por su valor, sin disparar el callback. */
export function activarTab(contenedor, clave, valor) {
    const tab = contenedor.querySelector(`[data-${clave}="${valor}"]`);
    if (tab) marcarActivo(contenedor, tab);
}

function marcarActivo(contenedor, tabActivo) {
    for (const tab of contenedor.querySelectorAll(".tab")) {
        const activo = tab === tabActivo;
        tab.classList.toggle(CLASE_ACTIVA, activo);
        // El color por sí solo no comunica el estado a un lector de pantalla.
        tab.setAttribute("aria-selected", String(activo));
    }
}
