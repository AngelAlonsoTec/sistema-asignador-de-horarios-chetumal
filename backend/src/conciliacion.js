/**
 * Conciliación entre coordinadores.
 *
 * Todos trabajan en borrador y nadie bloquea a nadie: dos carreras pueden
 * pretender la misma hora del mismo docente. Donde eso pasa hay un **conflicto**,
 * y el sistema lo nombra en vez de esconderlo.
 *
 * A partir de ahí, el protocolo es el que hoy ocurre de palabra: quien necesita
 * la hora la **solicita**, y quien la tiene **cede o rechaza**, con motivo. La
 * diferencia es que queda registrado, y nadie tiene que recordar quién dijo qué.
 */

import crypto from "node:crypto";
import { bd, enTransaccion } from "./bd.js";
import { ErrorHttp } from "./http.js";
import { anotarHistorial } from "./saturacion.js";

// El nombre del docente se une aquí: quien lee una solicitud quiere ver
// "Marisol Aguilar", no "doc005".
const CAMPOS = `s.id, s.creada, s.estado,
                s.de_carrera AS deCarrera, s.de_escenario AS deEscenario, s.de_usuario AS deUsuario,
                s.a_carrera AS aCarrera, s.a_escenario AS aEscenario,
                s.docente_id AS docenteId, d.nombre AS docenteNombre,
                s.aula_id AS aulaId, a.clave AS aulaClave,
                s.dia, s.inicio, s.fin, s.motivo, s.respuesta, s.respondida`;

const DESDE = `FROM solicitudes s
               LEFT JOIN docentes d ON d.id = s.docente_id
               LEFT JOIN aulas a ON a.id = s.aula_id`;

const seSolapan = (a, b) => a.dia === b.dia && a.inicio < b.fin && a.fin > b.inicio;

/**
 * Horas que este escenario pretende y otra carrera también.
 *
 * Se agrupan por (docente, día, rango) del lado propio: lo que el coordinador
 * ve es "esta clase mía choca con alguien", no una lista de horas sueltas.
 */
export function detectarConflictos({ carrera, escenarioId, paridad, misCarreras = [] }) {
    const db = bd();
    const todas = db
        .prepare(
            `SELECT carrera, escenario_id AS escenarioId, docente_id AS docenteId,
                    dia, inicio, fin, grupo_clave AS grupoClave, materia_clave AS materiaClave
             FROM saturacion WHERE paridad IS ? OR ? IS NULL`
        )
        .all(paridad ?? null, paridad ?? null);

    const mias = todas.filter((o) => o.carrera === carrera && o.escenarioId === escenarioId);
    const ajenas = todas.filter((o) => o.carrera !== carrera || o.escenarioId !== escenarioId);

    const mías = new Set(misCarreras.map((c) => String(c).toUpperCase()));

    const nombres = new Map(
        db.prepare("SELECT id, nombre FROM docentes").all().map((d) => [d.id, d.nombre])
    );

    const conflictos = [];
    for (const mia of mias) {
        const contra = ajenas.filter((o) => o.docenteId === mia.docenteId && seSolapan(mia, o));
        if (contra.length === 0) continue;

        conflictos.push({
            docenteId: mia.docenteId,
            docenteNombre: nombres.get(mia.docenteId) ?? mia.docenteId,
            dia: mia.dia,
            inicio: mia.inicio,
            fin: mia.fin,
            mio: { grupo: mia.grupoClave, materia: mia.materiaClave },
            contra: contra.map((o) => ({
                carrera: o.carrera,
                escenarioId: o.escenarioId,
                grupo: o.grupoClave,
                materia: o.materiaClave
            })),
            // Un coordinador puede llevar varias carreras y chocar consigo
            // mismo. Entonces no hay a quién pedirle nada: decide y ya. Pedirse
            // horas a uno mismo es ceremonia, y la bandeja diría "te piden
            // horas" por algo que escribió esa misma persona.
            propio: contra.every((o) => mías.has(o.carrera))
        });
    }
    return conflictos;
}

export function listarSolicitudes({ carreras }) {
    if (carreras.length === 0) return { enviadas: [], recibidas: [] };
    const huecos = carreras.map(() => "?").join(", ");
    // Quien lleva las dos carreras de una solicitud la vería en las dos listas,
    // y la bandeja diría "te piden horas" por algo que escribió esa persona. Se
    // cuenta como enviada: lo que importa es que no salga dos veces.
    const db = bd();

    return {
        enviadas: db
            .prepare(`SELECT ${CAMPOS} ${DESDE} WHERE s.de_carrera IN (${huecos}) ORDER BY s.creada DESC`)
            .all(...carreras),
        recibidas: db
            .prepare(
                `SELECT ${CAMPOS} ${DESDE}
                 WHERE s.a_carrera IN (${huecos}) AND s.de_carrera NOT IN (${huecos})
                 ORDER BY s.creada DESC`
            )
            .all(...carreras, ...carreras)
    };
}

/**
 * Pide unas horas. De un **docente** o de un **aula**: son los dos recursos que
 * el instituto comparte y la conversación es la misma —quien las tiene cede o
 * no—, así que van por el mismo sitio y no por dos paralelos.
 *
 * La diferencia está en cómo se llega aquí. Dos carreras pueden pretender la
 * misma hora de un docente a la vez —queda en disputa y el sistema lo nombra—;
 * un aula ocupada, en cambio, el motor simplemente no la usa, así que nadie
 * choca: el coordinador ve en la hoja de ocupación que el salón que necesita lo
 * tiene otra carrera, y lo pide.
 */
export function crear({ de, a, docenteId, aulaId, dia, inicio, fin, motivo, usuario }) {
    if (de.carrera === a.carrera && de.escenarioId === a.escenarioId) {
        throw new ErrorHttp(400, "No tiene sentido pedirte horas a ti mismo.");
    }
    if (Boolean(docenteId) === Boolean(aulaId)) {
        throw new ErrorHttp(400, "Se pide un docente o un aula, no las dos ni ninguna.");
    }

    const db = bd();
    const columna = docenteId ? "docente_id" : "aula_id";
    const cual = docenteId ?? aulaId;
    if (aulaId && !db.prepare("SELECT 1 FROM aulas WHERE id = ?").get(aulaId)) {
        throw new ErrorHttp(404, `No existe el espacio ${aulaId}.`);
    }

    const repetida = db
        .prepare(
            `SELECT 1 FROM solicitudes WHERE estado = 'pendiente'
             AND de_carrera = ? AND a_carrera = ? AND ${columna} = ? AND dia = ?
             AND inicio = ? AND fin = ?`
        )
        .get(de.carrera, a.carrera, cual, dia, inicio, fin);
    if (repetida) throw new ErrorHttp(409, "Ya hay una solicitud pendiente por esas horas.");

    const id = crypto.randomUUID();
    db.prepare(
        `INSERT INTO solicitudes
         (id, creada, estado, de_carrera, de_escenario, de_usuario, a_carrera, a_escenario,
          docente_id, aula_id, dia, inicio, fin, motivo)
         VALUES (?, ?, 'pendiente', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, new Date().toISOString(), de.carrera, de.escenarioId, usuario ?? null,
        a.carrera, a.escenarioId, docenteId ?? null, aulaId ?? null, dia, inicio, fin, motivo ?? null);

    return db.prepare(`SELECT ${CAMPOS} ${DESDE} WHERE s.id = ?`).get(id);
}

/**
 * Borra de la reserva de una carrera las ocupaciones que pisan `bloque`, y lo
 * anota. Se cede el bloque completo que cubre esas horas, no una fracción: lo
 * que se cede es una clase, no media.
 */
function soltarSolapadas(db, { carrera, escenarioId, bloque, usuarioId, nota }) {
    // Lo que se cede es el recurso que se pidió: las horas de esa persona, o las
    // de ese salón.
    const columna = bloque.aulaId ? "aula_id" : "docente_id";
    const suyas = db
        .prepare(
            `SELECT rowid, carrera, escenario_id AS escenarioId, paridad,
                    docente_id AS docenteId, dia, inicio, fin,
                    grupo_clave AS grupoClave, materia_clave AS materiaClave
             FROM saturacion
             WHERE carrera = ? AND escenario_id = ? AND ${columna} = ?`
        )
        .all(carrera, escenarioId, bloque.aulaId ?? bloque.docenteId);

    const borrar = db.prepare("DELETE FROM saturacion WHERE rowid = ?");
    const cedidas = [];
    for (const o of suyas) {
        if (seSolapan(o, bloque)) {
            borrar.run(o.rowid);
            cedidas.push(o);
        }
    }
    anotarHistorial(db, "cedida", cedidas, { usuarioId, nota });
    return cedidas.length;
}

/**
 * Resuelve un choque entre dos carreras que lleva la **misma** persona.
 *
 * Ahí no hay nada que negociar: pedirse horas a uno mismo es ceremonia, y la
 * bandeja acabaría diciendo "te piden horas" por algo que escribió quien la
 * lee. Se sueltan directamente las horas del lado que cede.
 */
export function resolverPropio({ cede, bloque, carreras, usuarioId }) {
    const mías = new Set(carreras.map((c) => String(c).toUpperCase()));
    if (!mías.has(String(cede.carrera).toUpperCase())) {
        throw new ErrorHttp(403, `No coordinas ${cede.carrera}.`);
    }

    return enTransaccion((db) => {
        const liberadas = soltarSolapadas(db, {
            carrera: cede.carrera,
            escenarioId: cede.escenarioId,
            bloque,
            usuarioId,
            nota: "resuelto por el mismo coordinador"
        });
        if (liberadas === 0) {
            throw new ErrorHttp(409, "Esas horas ya no están apartadas por esa carrera.");
        }
        return { liberadas };
    });
}

/**
 * Responde una solicitud. Aceptar **libera de verdad** las horas: borra de la
 * reserva de quien cede las ocupaciones que se solapan con lo pedido. Si no,
 * "aceptar" sería un gesto sin efecto y el conflicto seguiría ahí.
 *
 * Se cede el bloque completo que cubre esas horas, no una fracción: lo que se
 * cede es una clase, no media.
 */
export function responder({ id, acepta, respuesta, carreras, usuarioId }) {
    return enTransaccion((db) => {
        const solicitud = db.prepare(`SELECT ${CAMPOS} ${DESDE} WHERE s.id = ?`).get(id);
        if (!solicitud) throw new ErrorHttp(404, "No existe esa solicitud.");
        if (solicitud.estado !== "pendiente") {
            throw new ErrorHttp(409, `Esa solicitud ya está ${solicitud.estado}.`);
        }
        if (!carreras.includes(solicitud.aCarrera)) {
            throw new ErrorHttp(403, "Esa solicitud no es tuya para responderla.");
        }

        let liberadas = 0;
        if (acepta) {
            // Queda como "cedida" y no como "liberada": la diferencia es que
            // alguien la pidió, y eso es justo lo que hay que poder demostrar.
            liberadas = soltarSolapadas(db, {
                carrera: solicitud.aCarrera,
                escenarioId: solicitud.aEscenario,
                bloque: solicitud,
                usuarioId,
                nota: `cedida a ${solicitud.deCarrera}${respuesta ? ` — ${respuesta}` : ""}`
            });
        }

        db.prepare(
            "UPDATE solicitudes SET estado = ?, respuesta = ?, respondida = ? WHERE id = ?"
        ).run(acepta ? "aceptada" : "rechazada", respuesta ?? null, new Date().toISOString(), id);

        return {
            ...db.prepare(`SELECT ${CAMPOS} ${DESDE} WHERE s.id = ?`).get(id),
            bloquesLiberados: liberadas
        };
    });
}
