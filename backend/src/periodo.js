/**
 * Paridad del periodo escolar.
 *
 * Un periodo no ofrece los nueve semestres a la vez: agosto-diciembre imparte
 * los impares y enero-junio los pares. Programar los nueve juntos duplicaría la
 * demanda de aulas y docentes contra una realidad que nunca ocurre, y volvería
 * infactible un horario que sí se puede armar.
 */

export const PARIDADES = {
    impares: { etiqueta: "Semestres impares", semestres: [1, 3, 5, 7, 9] },
    pares: { etiqueta: "Semestres pares", semestres: [2, 4, 6, 8] }
};

export function esParidadValida(paridad) {
    return Object.hasOwn(PARIDADES, paridad);
}

export function semestresDe(paridad) {
    return PARIDADES[paridad]?.semestres ?? [];
}

export function paridadDeSemestre(semestre) {
    return semestre % 2 === 1 ? "impares" : "pares";
}

/**
 * Deduce la paridad del nombre del periodo del escenario. Es solo la opción
 * preseleccionada en la interfaz: quien programa siempre puede cambiarla, y si
 * el nombre no dice nada se asume agosto-diciembre, que es el periodo con el
 * que se trabaja al capturar para el siguiente ciclo.
 */
export function paridadSugerida(semestres) {
    const periodo = (semestres[0]?.periodo ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    if (/^\s*(enero|febrero)/.test(periodo)) return "pares";
    return "impares";
}

// ---------------------------------------------------------------- cierre

/**
 * Cierre de periodo: lo conciliado deja de ser borrador.
 *
 * Mientras el periodo está abierto, cada coordinador aparta y suelta horas
 * libremente. Al cerrarlo, lo que quedó apartado es el horario del semestre y
 * nadie lo mueve. Lo cierra el departamento académico, que es quien puede dar
 * por terminada la negociación entre carreras.
 */
export function estadoDelPeriodo(db, paridad) {
    return db.prepare("SELECT * FROM periodos_cerrados WHERE paridad = ?").get(paridad) ?? null;
}

export function cerrarPeriodo(db, paridad, usuario) {
    db.prepare("INSERT OR REPLACE INTO periodos_cerrados (paridad, cerrado, por) VALUES (?, ?, ?)")
        .run(paridad, new Date().toISOString(), usuario ?? null);
}

export function reabrirPeriodo(db, paridad) {
    db.prepare("DELETE FROM periodos_cerrados WHERE paridad = ?").run(paridad);
}
