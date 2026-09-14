/**
 * Invitación a programar un horario conjunto.
 *
 * La fusión entre carreras exige generar las dos juntas, y eso es decidir el
 * horario de las dos. Cuando la misma persona las coordina no hay nada que
 * pedir. Cuando son dos, hace falta que la invitada diga que sí: es una decisión
 * sobre su propia carrera, no una hora suelta que se negocia.
 *
 * Es deliberadamente distinto de una solicitud de horas. Aquella se resuelve en
 * horas concretas y deja rastro en la hoja; esta es un permiso: mientras esté
 * aceptado, la anfitriona puede incluir ese escenario en sus corridas.
 */

import crypto from "node:crypto";
import { bd, enTransaccion } from "./bd.js";
import { ErrorHttp } from "./http.js";

const CAMPOS = `id, creada, estado, anfitriona, invitada, escenario_id AS escenarioId,
                de_usuario AS deUsuario, respondida, respuesta`;

/** Invitaciones que tocan a alguna de estas carreras, en los dos sentidos. */
export function listar(carreras) {
    if (carreras.length === 0) return { enviadas: [], recibidas: [] };
    const huecos = carreras.map(() => "?").join(", ");
    const db = bd();

    return {
        enviadas: db
            .prepare(`SELECT ${CAMPOS} FROM invitacion_conjunta
                      WHERE anfitriona IN (${huecos}) ORDER BY creada DESC`)
            .all(...carreras),
        // Quien lleva las dos no necesita invitarse: se excluye para que la
        // bandeja no diga "te invitan" por algo que escribió esa persona.
        recibidas: db
            .prepare(`SELECT ${CAMPOS} FROM invitacion_conjunta
                      WHERE invitada IN (${huecos}) AND anfitriona NOT IN (${huecos})
                      ORDER BY creada DESC`)
            .all(...carreras, ...carreras)
    };
}

export function crear({ anfitriona, invitada, escenarioId, usuario }) {
    if (anfitriona === invitada) {
        throw new ErrorHttp(400, "Una carrera no se invita a sí misma.");
    }
    const db = bd();
    if (!db.prepare("SELECT 1 FROM carreras WHERE codigo = ?").get(invitada)) {
        throw new ErrorHttp(404, `No existe la carrera ${invitada}.`);
    }
    if (!db.prepare("SELECT 1 FROM escenarios WHERE carrera = ? AND id = ?").get(invitada, escenarioId)) {
        throw new ErrorHttp(404, `${invitada} no tiene el escenario "${escenarioId}".`);
    }

    const viva = db
        .prepare(
            `SELECT ${CAMPOS} FROM invitacion_conjunta
             WHERE anfitriona = ? AND invitada = ? AND escenario_id = ?
               AND estado IN ('pendiente', 'aceptada')`
        )
        .get(anfitriona, invitada, escenarioId);
    if (viva) {
        throw new ErrorHttp(409, `Esa invitación ya está ${viva.estado}.`);
    }

    const id = crypto.randomUUID();
    db.prepare(
        `INSERT INTO invitacion_conjunta
           (id, creada, estado, anfitriona, invitada, escenario_id, de_usuario)
         VALUES (?, ?, 'pendiente', ?, ?, ?, ?)`
    ).run(id, new Date().toISOString(), anfitriona, invitada, escenarioId, usuario ?? null);

    return db.prepare(`SELECT ${CAMPOS} FROM invitacion_conjunta WHERE id = ?`).get(id);
}

export function responder({ id, acepta, respuesta, carreras, usuarioId }) {
    return enTransaccion((db) => {
        const inv = db.prepare(`SELECT ${CAMPOS} FROM invitacion_conjunta WHERE id = ?`).get(id);
        if (!inv) throw new ErrorHttp(404, "No existe esa invitación.");
        if (!carreras.includes(inv.invitada)) {
            throw new ErrorHttp(403, "Esa invitación no es tuya para responderla.");
        }
        if (inv.estado === "rechazada") {
            throw new ErrorHttp(409, "Esa invitación ya está rechazada.");
        }

        db.prepare(
            "UPDATE invitacion_conjunta SET estado = ?, respuesta = ?, respondida = ? WHERE id = ?"
        ).run(acepta ? "aceptada" : "rechazada", respuesta ?? null, new Date().toISOString(), id);

        return db.prepare(`SELECT ${CAMPOS} FROM invitacion_conjunta WHERE id = ?`).get(id);
    });
}

/**
 * ¿Puede `anfitriona` meter este escenario de `invitada` en su horario?
 *
 * Sí si quien lo pide coordina las dos —no hay a quién pedirle permiso— o si hay
 * una invitación aceptada y viva.
 */
export function autorizada({ anfitriona, invitada, escenarioId, carreras }) {
    if (carreras.includes(invitada)) return true;

    return Boolean(
        bd()
            .prepare(
                `SELECT 1 FROM invitacion_conjunta
                 WHERE anfitriona = ? AND invitada = ? AND escenario_id = ? AND estado = 'aceptada'`
            )
            .get(anfitriona, invitada, escenarioId)
    );
}

/** Retirar el permiso. Lo puede hacer cualquiera de las dos partes. */
export function revocar({ id, carreras }) {
    const db = bd();
    const inv = db.prepare(`SELECT ${CAMPOS} FROM invitacion_conjunta WHERE id = ?`).get(id);
    if (!inv) throw new ErrorHttp(404, "No existe esa invitación.");
    if (!carreras.includes(inv.invitada) && !carreras.includes(inv.anfitriona)) {
        throw new ErrorHttp(403, "Esa invitación no es tuya.");
    }

    db.prepare("UPDATE invitacion_conjunta SET estado = 'rechazada', respondida = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
    return { revocada: true };
}
