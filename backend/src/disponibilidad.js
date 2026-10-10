/**
 * Formulario de disponibilidad del docente.
 *
 * Hasta ahora el coordinador transcribía a mano lo que cada quien contestaba en
 * un Google Forms. Aquí el docente la declara él mismo, entrando por un enlace
 * personal: sin cuenta, sin contraseña y sin ver nada más que su propia hoja.
 *
 * El token **es** la credencial, así que es largo y aleatorio, y solo abre lo
 * suyo: su disponibilidad y el horario que le resultó. Ni la plantilla, ni los
 * horarios de los demás, ni las descargas, que son del departamento académico.
 */

import crypto from "node:crypto";
import { bd, enTransaccion } from "./bd.js";
import { ErrorHttp } from "./http.js";
import { estadoDelPeriodo } from "./periodo.js";

const DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes"];

/**
 * El horario que le tocó, juntando todas las carreras.
 *
 * Es la pregunta que un docente hace primero —*¿qué me tocó?*— y hasta ahora no
 * la contestaba nadie: su enlace solo abría el formulario, y la hoja imprimible
 * sale del horario de **una** carrera, así que quien da clase en tres nunca veía
 * una semana completa. Aquí se arma desde la saturación, que es justamente la
 * tabla donde confluyen todas.
 *
 * Sale lo **apartado**, que mientras el periodo esté abierto es un borrador y
 * puede cambiar. Se dice, en vez de dejar que lo parezca definitivo.
 */
export function horarioDe(token) {
    const db = bd();
    const fila = db
        .prepare(
            `SELECT t.docente_id AS docenteId, d.nombre
             FROM docente_token t JOIN docentes d ON d.id = t.docente_id
             WHERE t.token = ?`
        )
        .get(token);
    if (!fila) throw new ErrorHttp(404, "Este enlace no es válido o fue revocado.");

    const bloques = db
        .prepare(
            // La clave del aula y no su id: "V-3" es lo que dice la puerta,
            // "v_3" es lo que el sistema usa por dentro, y esta hoja la lee una
            // persona que tiene que llegar al salón.
            `SELECT s.paridad, s.carrera, c.nombre AS carreraNombre, s.dia, s.inicio, s.fin,
                    s.grupo_clave AS grupo, s.materia_clave AS materia,
                    COALESCE(a.clave, s.aula_id) AS aula
             FROM saturacion s
             LEFT JOIN carreras c ON c.codigo = s.carrera
             LEFT JOIN aulas a ON a.id = s.aula_id
             WHERE s.docente_id = ?
             ORDER BY s.paridad, s.inicio`
        )
        .all(fila.docenteId);

    const descargas = db
        .prepare("SELECT dia, inicio, fin, motivo FROM docente_descarga WHERE docente_id = ?")
        .all(fila.docenteId);

    // Un periodo por paridad: el docente ve el suyo, no una lista revuelta.
    const periodos = new Map();
    for (const b of bloques) {
        const clave = b.paridad ?? "sin-periodo";
        if (!periodos.has(clave)) {
            periodos.set(clave, {
                paridad: b.paridad ?? null,
                cerrado: b.paridad ? estadoDelPeriodo(db, b.paridad) : null,
                bloques: []
            });
        }
        periodos.get(clave).bloques.push({
            carrera: b.carrera,
            carreraNombre: b.carreraNombre ?? b.carrera,
            dia: b.dia,
            inicio: b.inicio,
            fin: b.fin,
            grupo: b.grupo,
            materia: b.materia,
            aula: b.aula
        });
    }

    return {
        nombre: fila.nombre,
        dias: DIAS,
        descargas,
        // Ordenados por horas: lo que más ocupa la semana va primero.
        periodos: [...periodos.values()].sort(
            (a, b) => horasDe(b.bloques) - horasDe(a.bloques)
        )
    };
}

const horasDe = (bloques) => bloques.reduce((n, b) => n + (b.fin - b.inicio), 0);

/** Crea el enlace de un docente, o devuelve el que ya tenía. */
export function enlaceDe(docenteId) {
    const db = bd();
    const existente = db.prepare("SELECT * FROM docente_token WHERE docente_id = ?").get(docenteId);
    if (existente) return existente;

    const token = crypto.randomBytes(24).toString("base64url");
    db.prepare("INSERT INTO docente_token (docente_id, token, creado) VALUES (?, ?, ?)").run(
        docenteId,
        token,
        new Date().toISOString()
    );
    return db.prepare("SELECT * FROM docente_token WHERE docente_id = ?").get(docenteId);
}

/**
 * Enlaces para repartir, con las carreras donde cada quien puede dar clase.
 *
 * **Acotados a quien pregunta.** El token *es* la credencial: con él se lee el
 * horario de esa persona y se escribe su disponibilidad. Devolver los treinta a
 * cualquier coordinación significaba que quien lleva Turismo podía sobrescribir
 * lo que declaró un docente que solo da clase en Sistemas. Una coordinación ve
 * los de quien puede impartir alguna de sus materias; el departamento, los de
 * toda la plantilla, porque la plantilla es del instituto.
 *
 * El criterio es la **autorización**, no el reparto: perseguir el formulario es
 * trabajo del coordinador y le hace falta antes de repartir, cuando todavía no
 * hay nadie asignado. Cuenta cualquier escenario de la carrera — si alguien
 * puede dar algo que esa carrera imparte, su disponibilidad le importa.
 */
export function enlaces({ carreras = null } = {}) {
    const db = bd();

    const porDocente = new Map();
    for (const f of db
        .prepare(
            `SELECT DISTINCT dm.docente_id AS docenteId, m.carrera
             FROM docente_materia dm JOIN materias m ON m.id = dm.materia_id
             ORDER BY m.carrera`
        )
        .all()) {
        if (!porDocente.has(f.docenteId)) porDocente.set(f.docenteId, []);
        porDocente.get(f.docenteId).push(f.carrera);
    }

    const suyas = carreras === null ? null : new Set(carreras);
    const docentes = db.prepare("SELECT id, nombre FROM docentes ORDER BY nombre").all();

    return docentes
        .map((d) => ({ ...d, carreras: porDocente.get(d.id) ?? [] }))
        .filter((d) => suyas === null || d.carreras.some((c) => suyas.has(c)))
        .map((d) => {
            const t = enlaceDe(d.id);
            return {
                docenteId: d.id,
                nombre: d.nombre,
                // Dónde puede dar clase. Con trece carreras, saber de quién es
                // cada enlace es lo que hace repartible la lista.
                carreras: d.carreras,
                token: t.token,
                contestado: t.contestado
            };
        });
}

/** Lo que ve el docente al abrir su enlace. Deliberadamente poco. */
export function abrir(token) {
    const db = bd();
    const fila = db
        .prepare(
            `SELECT t.docente_id AS docenteId, t.contestado, d.nombre
             FROM docente_token t JOIN docentes d ON d.id = t.docente_id
             WHERE t.token = ?`
        )
        .get(token);
    if (!fila) throw new ErrorHttp(404, "Este enlace no es válido o fue revocado.");

    const bloques = db
        .prepare("SELECT tipo, dia, inicio, fin FROM docente_horario WHERE docente_id = ?")
        .all(fila.docenteId);

    return {
        nombre: fila.nombre,
        contestado: fila.contestado,
        dias: DIAS,
        declarada: bloques.filter((b) => b.tipo === "declarada").map(sinTipo),
        evitar: bloques.filter((b) => b.tipo === "evitar").map(sinTipo)
    };
}

const sinTipo = ({ dia, inicio, fin }) => ({ dia, inicio, fin });

/**
 * Guarda lo que el docente declaró. Reemplaza su horario completo, nunca el de
 * otro: el token solo alcanza para su propia fila.
 */
export function guardar(token, { declarada = [], evitar = [] }) {
    return enTransaccion((db) => {
        const fila = db.prepare("SELECT docente_id FROM docente_token WHERE token = ?").get(token);
        if (!fila) throw new ErrorHttp(404, "Este enlace no es válido o fue revocado.");

        const limpios = validarBloques(declarada);
        if (limpios.length === 0) {
            throw new ErrorHttp(400, "Hay que declarar al menos un día con horario.");
        }

        db.prepare("DELETE FROM docente_horario WHERE docente_id = ?").run(fila.docente_id);
        const ins = db.prepare(
            "INSERT INTO docente_horario (docente_id, tipo, dia, inicio, fin) VALUES (?, ?, ?, ?, ?)"
        );
        for (const b of limpios) ins.run(fila.docente_id, "declarada", b.dia, b.inicio, b.fin);
        for (const b of validarBloques(evitar)) {
            ins.run(fila.docente_id, "evitar", b.dia, b.inicio, b.fin);
        }

        db.prepare("UPDATE docente_token SET contestado = ? WHERE token = ?").run(
            new Date().toISOString(),
            token
        );
        return { guardados: limpios.length };
    });
}

/**
 * Descarta lo que no tenga sentido en vez de rechazar el formulario entero: un
 * día mal escrito no debería obligar al docente a volver a empezar.
 */
function validarBloques(bloques) {
    const salida = [];
    for (const b of bloques ?? []) {
        if (!DIAS.includes(b?.dia)) continue;
        const inicio = Number(b.inicio);
        const fin = Number(b.fin);
        if (!Number.isInteger(inicio) || !Number.isInteger(fin)) continue;
        if (inicio < 0 || fin > 24 || fin <= inicio) continue;
        salida.push({ dia: b.dia, inicio, fin });
    }
    return salida;
}
