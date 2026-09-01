/** Piezas de presentación compartidas entre la lista y el detalle. */

const FORMATO_FECHA = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium" });

export function formatearFecha(fechaIso) {
    return FORMATO_FECHA.format(new Date(`${fechaIso}T00:00:00`));
}

/**
 * El indicador que da sentido a la pantalla: ¿estos datos son viables?
 * Sin al menos un docente por materia, el motor no puede generar horario.
 */
export function pintarCobertura(elemento, cobertura) {
    const faltantes = cobertura.sinDocente.length;

    elemento.classList.toggle("is-ok", cobertura.esCompleta);
    elemento.classList.toggle("is-alerta", !cobertura.esCompleta);

    elemento.textContent = cobertura.esCompleta
        ? "Cobertura completa"
        : `${faltantes} ${faltantes === 1 ? "materia" : "materias"} sin docente`;
}
