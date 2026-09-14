/**
 * El horario apartado, para poder volver a verlo.
 *
 * Generar produce un horario; apartar lo hace oficial frente a las demás
 * carreras. Hasta ahora solo se guardaba lo segundo, así que el coordinador
 * cerraba la pestaña y perdía el primero: las horas seguían tomadas, pero el
 * horario que las justificaba ya no se podía consultar. Regenerar no lo
 * recupera — otra semilla da otro horario, y el que está apartado es el viejo.
 *
 * Lo que se guarda es la respuesta del motor tal cual, porque es exactamente lo
 * que la interfaz dibuja. Lo que las demás carreras consultan sigue viviendo en
 * `saturacion`, que es la proyección consultable.
 */

import { bd } from "./bd.js";

/**
 * Guarda el horario de un escenario. Va dentro de la transacción de `reservar`:
 * apartar las horas y guardar el horario que las explica son el mismo acto, y
 * que uno quede sin el otro es justamente el estado que esto viene a evitar.
 */
export function guardar(db, { carrera, escenarioId, paridad, documento, usuarioId }) {
    db.prepare(
        `INSERT INTO horario (carrera, escenario_id, paridad, guardado, usuario_id, documento)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(carrera, escenario_id) DO UPDATE SET
             paridad = excluded.paridad, guardado = excluded.guardado,
             usuario_id = excluded.usuario_id, documento = excluded.documento`
    ).run(carrera, escenarioId, paridad ?? null, new Date().toISOString(),
        usuarioId ?? null, JSON.stringify(documento));
}

export function borrar(db, { carrera, escenarioId }) {
    db.prepare("DELETE FROM horario WHERE carrera = ? AND escenario_id = ?")
        .run(carrera, escenarioId);
}

/**
 * El horario apartado, más el desfase con lo que hoy se tiene apartado de
 * verdad.
 *
 * Los dos se separan cuando el coordinador cede horas en una conciliación: las
 * filas de `saturacion` desaparecen, pero el documento sigue mostrando esa
 * clase. No se corrige solo —reacomodar el horario es trabajo del motor— así
 * que lo que toca es decirlo: estas clases ya no tienen sus horas, hay que
 * regenerar.
 */
export function leer({ carrera, escenarioId }) {
    const db = bd();
    const fila = db
        .prepare(
            `SELECT paridad, guardado, usuario_id AS usuarioId, documento
             FROM horario WHERE carrera = ? AND escenario_id = ?`
        )
        .get(carrera, escenarioId);
    if (!fila) return null;

    const documento = JSON.parse(fila.documento);
    return {
        paridad: fila.paridad,
        guardado: fila.guardado,
        usuarioId: fila.usuarioId,
        horario: documento,
        // Un horario conjunto se guarda entero en cada carrera —su coordinador
        // necesita ver las clases fusionadas aunque las aparte la otra— pero el
        // desfase solo puede medirse sobre lo que ESTA carrera apartó.
        desfase: calcularDesfase(
            db,
            { carrera, escenarioId },
            (documento.sesiones ?? []).filter((s) => esDe(s, documento.deCarrera ?? carrera))
        )
    };
}

/**
 * Sesiones del documento cuyas horas ya no están apartadas.
 *
 * Se compara hora por hora y no sesión por sesión: ceder puede llevarse parte
 * de un bloque de dos horas, y una sesión a la que le falta una hora está tan
 * rota como una que perdió las dos.
 */
function calcularDesfase(db, { carrera, escenarioId }, sesiones) {
    const apartadas = new Set(
        db
            .prepare(
                `SELECT docente_id AS docenteId, dia, inicio, fin
                 FROM saturacion WHERE carrera = ? AND escenario_id = ?`
            )
            .all(carrera, escenarioId)
            .flatMap((o) => horasDe(o))
    );

    const perdidas = sesiones.filter((s) =>
        horasDe({ docenteId: s.docenteId, dia: s.dia, inicio: s.horaInicio, fin: s.horaFin })
            .some((h) => !apartadas.has(h))
    );

    return {
        alDia: perdidas.length === 0,
        sesionesPerdidas: perdidas.map((s) => ({
            grupoClave: s.grupoClave,
            materiaClave: s.materiaClave,
            materiaNombre: s.materiaNombre,
            docenteNombre: s.docenteNombre,
            dia: s.dia,
            horaInicio: s.horaInicio,
            horaFin: s.horaFin
        }))
    };
}

/** Una sesión es de la carrera de su grupo principal. Sin prefijo, es propia. */
function esDe(sesion, carrera) {
    const corte = String(sesion.grupoId ?? "").indexOf(":");
    return corte === -1 || sesion.grupoId.slice(0, corte) === carrera;
}

function horasDe({ docenteId, dia, inicio, fin }) {
    const horas = [];
    for (let h = inicio; h < fin; h++) horas.push(`${docenteId}|${dia}|${h}`);
    return horas;
}
