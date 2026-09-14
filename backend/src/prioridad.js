/**
 * Prioridad docente: la herramienta con la que el coordinador decide a quién se
 * le respeta primero su disponibilidad.
 *
 * Cuando dos docentes evitan la misma hora y solo uno puede librarse, el motor
 * le quita la suya al de menos prioridad. No es una restricción dura —nadie
 * tiene derecho a una hora concreta— sino un desempate, y por eso vive aquí y
 * no en las reglas del motor: quién merece la consideración lo sabe quien
 * coordina, no un algoritmo.
 *
 * **Va por carrera.** Es un juicio del coordinador sobre su propio horario, así
 * que priorizar a alguien en ISIC no se lo impone a quien coordina ITIC. La
 * plantilla docente sigue siendo del instituto y no se toca.
 */

import { bd, enTransaccion } from "./bd.js";
import { ErrorHttp } from "./http.js";

/**
 * Niveles. Son tres y con nombre, no un número libre: el coordinador decide
 * "a este hay que cuidarlo", no cuánto exactamente, y una escala abierta acaba
 * con todos en el máximo, que equivale a que nadie lo tenga.
 */
export const NIVELES = [
    { valor: 0, nombre: "Normal" },
    { valor: 1, nombre: "Alta" },
    { valor: 2, nombre: "Máxima" }
];

const MAXIMO = Math.max(...NIVELES.map((n) => n.valor));

export function listar(carrera) {
    return bd()
        .prepare(
            `SELECT docente_id AS docenteId, prioridad, nota
             FROM docente_prioridad WHERE carrera = ?`
        )
        .all(carrera);
}

/** `docenteId -> prioridad`, para adjuntarla al problema que va al motor. */
export function mapaDe(carrera) {
    return new Map(listar(carrera).map((f) => [f.docenteId, f.prioridad]));
}

/**
 * Reemplaza las prioridades de una carrera. Se borra la fila cuando el nivel
 * vuelve a 0: la ausencia ya significa "normal", y guardarla llenaría la tabla
 * de filas que no dicen nada.
 */
export function guardar(carrera, filas) {
    if (!Array.isArray(filas)) throw new ErrorHttp(400, "Se esperaba un arreglo.");

    return enTransaccion((db) => {
        const existe = db.prepare("SELECT 1 FROM docentes WHERE id = ?");
        const borrar = db.prepare(
            "DELETE FROM docente_prioridad WHERE carrera = ? AND docente_id = ?"
        );
        const poner = db.prepare(
            `INSERT INTO docente_prioridad (carrera, docente_id, prioridad, nota)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(carrera, docente_id) DO UPDATE SET
                 prioridad = excluded.prioridad, nota = excluded.nota`
        );

        let guardadas = 0;
        for (const f of filas) {
            if (!existe.get(f.docenteId)) {
                throw new ErrorHttp(400, `No existe el docente ${f.docenteId}.`);
            }
            const nivel = Number(f.prioridad);
            if (!Number.isInteger(nivel) || nivel < 0 || nivel > MAXIMO) {
                throw new ErrorHttp(400, `Prioridad fuera de rango: ${f.prioridad}.`);
            }

            if (nivel === 0) borrar.run(carrera, f.docenteId);
            else {
                poner.run(carrera, f.docenteId, nivel, f.nota?.trim() || null);
                guardadas++;
            }
        }
        return { guardadas };
    });
}
