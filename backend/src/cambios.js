/**
 * Peticiones de cambio de docente: de una coordinación al departamento.
 *
 * El modelo reparte la decisión en dos: el departamento dice **quién** imparte
 * cada clase y el coordinador decide **cuándo** cae en la semana. Eso está bien
 * repartido, pero dejaba al coordinador sin salida cuando el quién no le sirve
 * —la persona no tiene horas libres donde él las necesita, o el grupo pide otro
 * perfil—. El ajuste a mano le contesta que se lo pida al departamento; esto es
 * el sitio donde pedirlo.
 *
 * Es deliberadamente distinto de la conciliación entre coordinaciones. Aquella
 * negocia **horas** entre iguales y quien las tiene cede o no. Esta sube una
 * decisión a quien la tomó, y por eso no se "cede": se acepta diciendo a quién
 * se le da la clase, o se rechaza con un motivo.
 */

import crypto from "node:crypto";
import { bd, enTransaccion } from "./bd.js";
import { ErrorHttp } from "./http.js";
import * as catalogo from "./catalogo.js";

const CAMPOS = `p.id, p.creada, p.estado, p.carrera, p.materia_id AS materiaId,
                p.materia, p.grupo_clave AS grupoClave, p.de_usuario AS deUsuario,
                p.actual, p.propuesto, p.motivo, p.respuesta, p.respondida,
                a.nombre AS actualNombre, q.nombre AS propuestoNombre,
                u.nombre AS pedidaPor`;

const DESDE = `FROM peticion_cambio p
               LEFT JOIN docentes a ON a.id = p.actual
               LEFT JOIN docentes q ON q.id = p.propuesto
               LEFT JOIN usuarios u ON u.id = p.de_usuario`;

/**
 * Lo que ve cada quien: el departamento, todas; una coordinación, las de sus
 * carreras. La bandeja es la misma tabla mirada desde los dos lados, como en
 * conciliación.
 */
export function listar({ rol, carreras = [] }) {
    const db = bd();
    if (rol === "departamento") {
        return db.prepare(`SELECT ${CAMPOS} ${DESDE} ORDER BY p.creada DESC`).all();
    }
    const suyas = carreras.map((c) => String(c).toUpperCase());
    if (suyas.length === 0) return [];
    const huecos = suyas.map(() => "?").join(", ");
    return db
        .prepare(`SELECT ${CAMPOS} ${DESDE} WHERE p.carrera IN (${huecos}) ORDER BY p.creada DESC`)
        .all(...suyas);
}

/** Cuántas esperan respuesta. Es el número del aviso en la barra lateral. */
export function pendientes({ rol, carreras = [] }) {
    return listar({ rol, carreras }).filter((p) => p.estado === "pendiente").length;
}

/**
 * Pide un cambio. Se exige que la clase exista de verdad —materia y grupo del
 * catálogo— porque una petición sobre algo que no se imparte no la puede
 * resolver nadie, y se descubriría al intentar responderla.
 */
export async function crear({ carrera, materiaId, grupoClave, propuesto, motivo, usuarioId }) {
    const clave = String(carrera ?? "").toUpperCase();
    if (!clave) throw new ErrorHttp(400, "Falta la carrera.");
    if (!materiaId || !grupoClave) throw new ErrorHttp(400, "Falta la materia o el grupo.");
    if (!motivo?.trim()) {
        throw new ErrorHttp(400, "Hace falta un motivo: es lo que el departamento va a leer.");
    }

    const db = bd();
    const suyo = await catalogo.porCarrera(clave);
    const fila = suyo.filas.find((f) => f.materiaId === materiaId && f.grupoClave === grupoClave);
    if (!fila) {
        throw new ErrorHttp(404, `${clave} no imparte esa materia al grupo ${grupoClave}.`);
    }
    if (propuesto && !db.prepare("SELECT 1 FROM docentes WHERE id = ?").get(propuesto)) {
        throw new ErrorHttp(400, `No existe el docente ${propuesto}.`);
    }
    if (propuesto && propuesto === fila.docenteId) {
        throw new ErrorHttp(400, "Esa persona ya imparte esa clase.");
    }

    const repetida = db
        .prepare(
            `SELECT id FROM peticion_cambio
             WHERE carrera = ? AND materia_id = ? AND grupo_clave = ? AND estado = 'pendiente'`
        )
        .get(clave, materiaId, grupoClave);
    if (repetida) {
        throw new ErrorHttp(409, "Ya hay una petición pendiente sobre esa clase.");
    }

    const id = `pc-${crypto.randomUUID()}`;
    db.prepare(
        `INSERT INTO peticion_cambio
            (id, creada, carrera, materia_id, materia, grupo_clave, de_usuario,
             actual, propuesto, motivo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        id, new Date().toISOString(), clave, materiaId,
        `${fila.clave} · ${fila.nombre}`, grupoClave, usuarioId ?? null,
        fila.docenteId ?? null, propuesto ?? null, motivo.trim()
    );

    return db.prepare(`SELECT ${CAMPOS} ${DESDE} WHERE p.id = ?`).get(id);
}

/**
 * El departamento responde. Aceptar **aplica** el cambio: si aceptar no moviera
 * la asignación sería un gesto, y la petición seguiría teniendo razón. Por eso
 * hay que decir a quién se le da la clase —el propuesto, u otra persona— y no
 * basta con decir que sí.
 */
export function responder({ id, acepta, docenteId, respuesta, usuarioId }) {
    return enTransaccion((db) => {
        const fila = db.prepare(`SELECT ${CAMPOS} ${DESDE} WHERE p.id = ?`).get(id);
        if (!fila) throw new ErrorHttp(404, "Esa petición no existe.");
        if (fila.estado !== "pendiente") {
            throw new ErrorHttp(409, `Esa petición ya está ${fila.estado}.`);
        }

        let asignado = null;
        if (acepta) {
            asignado = docenteId ?? fila.propuesto;
            if (!asignado) {
                throw new ErrorHttp(
                    400,
                    "Para aceptar hay que decir quién imparte la clase: " +
                        "la coordinación no propuso a nadie."
                );
            }
            if (!db.prepare("SELECT 1 FROM docentes WHERE id = ?").get(asignado)) {
                throw new ErrorHttp(400, `No existe el docente ${asignado}.`);
            }
            // Aceptar dejando a la misma persona sería marcar como resuelto algo
            // que no cambió: la coordinación volvería a pedirlo mañana.
            const ahora = catalogo.mapaDe(fila.carrera).get(`${fila.materiaId}|${fila.grupoClave}`);
            if (asignado === ahora) {
                throw new ErrorHttp(
                    400,
                    "Esa persona ya imparte esa clase: aceptar sin cambiar nada dejaría la " +
                        "petición igual. Elige a otra o recházala."
                );
            }
            catalogo.asignar(db, {
                carrera: fila.carrera,
                materiaId: fila.materiaId,
                grupoClave: fila.grupoClave,
                docenteId: asignado,
                usuarioId,
                // La historia dice también por qué: un cambio pedido no es lo
                // mismo que uno que el departamento hizo por su cuenta.
                nota: `a petición de ${fila.carrera}: ${fila.motivo ?? ""}`.trim()
            });
        }

        db.prepare(
            `UPDATE peticion_cambio
             SET estado = ?, respuesta = ?, respondida = ?, propuesto = COALESCE(?, propuesto)
             WHERE id = ?`
        ).run(
            acepta ? "aceptada" : "rechazada",
            respuesta?.trim() || null,
            new Date().toISOString(),
            acepta ? asignado : null,
            id
        );

        return {
            ...db.prepare(`SELECT ${CAMPOS} ${DESDE} WHERE p.id = ?`).get(id),
            // Quién quedó al frente, para que quien responde vea el efecto y no
            // solo el acuse.
            asignado
        };
    });
}

/** Retirar una petición propia: se pidió y ya no hace falta. */
export function retirar({ id, carreras = [] }) {
    const db = bd();
    const fila = db.prepare("SELECT carrera, estado FROM peticion_cambio WHERE id = ?").get(id);
    if (!fila) throw new ErrorHttp(404, "Esa petición no existe.");
    if (fila.estado !== "pendiente") {
        throw new ErrorHttp(409, "Una petición respondida queda como registro.");
    }
    const suyas = carreras.map((c) => String(c).toUpperCase());
    if (!suyas.includes(fila.carrera)) {
        throw new ErrorHttp(403, `No coordinas ${fila.carrera}.`);
    }
    db.prepare("DELETE FROM peticion_cambio WHERE id = ?").run(id);
    return { retirada: true };
}
