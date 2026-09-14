/**
 * Lo que el coordinador eligió antes de generar: paridad, cuántos grupos abre
 * cada semestre y turno, y qué materias fusiona.
 *
 * Se guardaba el resultado y no las entradas. Al volver, el horario apartado
 * aparecía —eso ya funciona— pero las casillas de fusión salían en cero y los
 * grupos volvían a la sugerencia: pulsar "Generar" daba algo distinto de lo
 * apartado sin decir por qué. Guardar el horario sin guardar lo que lo produjo
 * es media solución.
 *
 * No lleva los parámetros del algoritmo: esos ya viajan dentro del horario
 * guardado, que los devuelve el motor. Aquí va solo lo que se teclea.
 */

import { bd } from "./bd.js";

export function leer({ carrera, escenarioId }) {
    const fila = bd()
        .prepare(
            `SELECT guardada, documento FROM escenario_config
             WHERE carrera = ? AND escenario_id = ?`
        )
        .get(carrera, escenarioId);
    if (!fila) return null;

    return { guardada: fila.guardada, ...JSON.parse(fila.documento) };
}

export function guardar({ carrera, escenarioId, paridad, lineas, fusiones, invitadas }) {
    const documento = {
        paridad: paridad ?? null,
        lineas: Array.isArray(lineas) ? lineas : [],
        fusiones: Array.isArray(fusiones) ? fusiones : [],
        // Con qué otras carreras se programa en conjunto. Sin esto, al volver
        // el horario apartado sería conjunto y la pantalla mostraría una sola
        // carrera: "Generar" daría algo distinto sin decir por qué.
        invitadas: Array.isArray(invitadas) ? invitadas : []
    };

    bd()
        .prepare(
            `INSERT INTO escenario_config (carrera, escenario_id, guardada, documento)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(carrera, escenario_id) DO UPDATE SET
                 guardada = excluded.guardada, documento = excluded.documento`
        )
        .run(carrera, escenarioId, new Date().toISOString(), JSON.stringify(documento));

    return documento;
}
