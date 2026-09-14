/**
 * Saturación de horas catedrático: el recurso que las carreras se reparten.
 *
 * Es la hoja electrónica que hoy viaja por correo entre coordinadores, pero con
 * dueño y con historia. Cada ocupación dice quién tomó qué hora de qué docente,
 * para qué grupo y en qué periodo.
 *
 * La regla que ordena todo: al armar el horario de un escenario se descuentan
 * las horas que **otros** escenarios ya pretenden. Las propias no, porque se
 * están reemplazando. Así, quien programa después ve menos huecos grises, que
 * es exactamente lo que pasa hoy con la hoja compartida.
 */

import { bd, enTransaccion } from "./bd.js";
import { ErrorHttp } from "./http.js";
import { estadoDelPeriodo } from "./periodo.js";
import * as horario from "./horario.js";

export { anotar as anotarHistorial };

/** Un periodo cerrado no se toca: lo apartado ya es el horario del semestre. */
function exigirAbierto(db, paridad) {
    const cerrado = estadoDelPeriodo(db, paridad);
    if (cerrado) {
        throw new ErrorHttp(
            409,
            `El periodo de ${paridad} se cerró el ${cerrado.cerrado.slice(0, 10)}. ` +
                "Para cambiar horas hay que reabrirlo desde el departamento académico."
        );
    }
}

const COLUMNAS = `carrera, escenario_id AS escenarioId, periodo, paridad,
                  docente_id AS docenteId, dia, inicio, fin,
                  grupo_clave AS grupoClave, materia_clave AS materiaClave,
                  aula_id AS aulaId`;

/**
 * Anota un movimiento. Se llama dentro de la misma transacción que lo provoca,
 * para que no exista un estado donde la hora cambió pero su historia no.
 */
function anotar(db, accion, filas, extra = {}) {
    const ins = db.prepare(`INSERT INTO saturacion_historial
        (momento, accion, carrera, escenario_id, paridad, docente_id, dia, inicio, fin,
         grupo_clave, materia_clave, usuario_id, nota)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const momento = new Date().toISOString();

    for (const f of filas) {
        ins.run(momento, accion, f.carrera, f.escenarioId ?? f.escenario_id,
            f.paridad ?? null, f.docenteId ?? f.docente_id, f.dia, f.inicio, f.fin,
            f.grupoClave ?? f.grupo_clave ?? null, f.materiaClave ?? f.materia_clave ?? null,
            extra.usuarioId ?? null, extra.nota ?? null);
    }
}

/**
 * Qué pasó con las horas de un docente, de lo más reciente a lo más antiguo.
 * Es lo que convierte "yo tenía esa hora" en una afirmación comprobable.
 */
export async function historial({ docenteId, limite = 60 } = {}) {
    const donde = docenteId ? "WHERE docente_id = ?" : "";
    const valores = docenteId ? [docenteId, limite] : [limite];

    return bd()
        .prepare(
            `SELECT h.momento, h.accion, h.carrera, h.escenario_id AS escenarioId, h.paridad,
                    h.docente_id AS docenteId, d.nombre AS docenteNombre,
                    h.dia, h.inicio, h.fin, h.grupo_clave AS grupoClave,
                    h.materia_clave AS materiaClave, h.nota
             FROM saturacion_historial h
             LEFT JOIN docentes d ON d.id = h.docente_id
             ${donde}
             ORDER BY h.id DESC LIMIT ?`
        )
        .all(...valores);
}

/** Ocupaciones de un periodo, opcionalmente solo las ajenas a un escenario. */
export async function consultar({ periodo, paridad, excepto } = {}) {
    const condiciones = [];
    const valores = [];

    if (periodo) {
        condiciones.push("periodo = ?");
        valores.push(periodo);
    }
    if (paridad) {
        condiciones.push("paridad = ?");
        valores.push(paridad);
    }
    if (excepto) {
        condiciones.push("NOT (carrera = ? AND escenario_id = ?)");
        valores.push(excepto.carrera, excepto.escenarioId);
    }

    const donde = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";
    return bd().prepare(`SELECT ${COLUMNAS} FROM saturacion ${donde}`).all(...valores);
}

/**
 * Registra lo que un escenario pretende, reemplazando lo que pretendía antes.
 * Reservar dos veces el mismo escenario no acumula: sustituye. Va en una
 * transacción porque borrar y volver a insertar no puede quedar a medias con
 * otro coordinador leyendo.
 */
export async function reservar({
    carrera, escenarioId, periodo, paridad, sesiones, usuarioId, documento
}) {
    if (!carrera || !escenarioId) throw new ErrorHttp(400, "Falta carrera o escenario.");
    if (!Array.isArray(sesiones)) throw new ErrorHttp(400, "Se esperaba un arreglo de sesiones.");

    return enTransaccion((db) => {
        exigirAbierto(db, paridad);
        const previas = db
            .prepare(`SELECT ${COLUMNAS} FROM saturacion WHERE carrera = ? AND escenario_id = ?`)
            .all(carrera, escenarioId);

        // Reservar sustituye: lo anterior se suelta, y eso también es historia.
        if (previas.length > 0) anotar(db, "liberada", previas, { usuarioId, nota: "reemplazada" });
        db.prepare("DELETE FROM saturacion WHERE carrera = ? AND escenario_id = ?")
            .run(carrera, escenarioId);

        const ins = db.prepare(`INSERT INTO saturacion
            (carrera, escenario_id, periodo, paridad, docente_id, dia, inicio, fin,
             grupo_clave, materia_clave, aula_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

        for (const s of sesiones) {
            ins.run(carrera, escenarioId, periodo ?? null, paridad ?? null, s.docenteId,
                s.dia, s.horaInicio, s.horaFin, s.grupoClave ?? null, s.materiaClave ?? null,
                s.aulaId ?? null);
        }
        anotar(
            db,
            "apartada",
            sesiones.map((s) => ({
                carrera,
                escenarioId,
                paridad,
                docenteId: s.docenteId,
                dia: s.dia,
                inicio: s.horaInicio,
                fin: s.horaFin,
                grupoClave: s.grupoClave,
                materiaClave: s.materiaClave
            })),
            { usuarioId }
        );

        // Apartar las horas y guardar el horario que las explica son el mismo
        // acto. Van en la misma transacción para que no quede uno sin el otro.
        if (documento) {
            horario.guardar(db, { carrera, escenarioId, paridad, documento, usuarioId });
        }

        return { reservadas: sesiones.length, reemplazadas: previas.length };
    });
}

export async function liberar({ carrera, escenarioId, usuarioId }) {
    if (!carrera || !escenarioId) throw new ErrorHttp(400, "Falta carrera o escenario.");
    return enTransaccion((db) => {
        const suya = db
            .prepare("SELECT paridad FROM saturacion WHERE carrera = ? AND escenario_id = ? LIMIT 1")
            .get(carrera, escenarioId);
        if (suya) exigirAbierto(db, suya.paridad);

        const antes = db
            .prepare(`SELECT ${COLUMNAS} FROM saturacion WHERE carrera = ? AND escenario_id = ?`)
            .all(carrera, escenarioId);

        anotar(db, "liberada", antes, { usuarioId });
        db.prepare("DELETE FROM saturacion WHERE carrera = ? AND escenario_id = ?")
            .run(carrera, escenarioId);
        horario.borrar(db, { carrera, escenarioId });
        return { liberadas: antes.length };
    });
}

/**
 * La hoja de un docente: una fila por día y una celda por hora, con el estado
 * de cada una. Es la vista que sustituye al Excel.
 */
export function armarHoja(docente, ocupaciones, rejilla) {
    const [base, tope] = rangoHoras(rejilla);
    const suyas = ocupaciones.filter((o) => o.docenteId === docente.id);

    const dias = rejilla.dias.map((dia) => {
        const horas = [];
        for (let h = base; h < tope; h++) {
            horas.push(estadoDe(docente, suyas, dia, h));
        }
        return { dia, horas };
    });

    const cuenta = (estado) =>
        dias.reduce((n, d) => n + d.horas.filter((c) => c.estado === estado).length, 0);

    return {
        docenteId: docente.id,
        nombre: docente.nombre,
        horaBase: base,
        dias,
        resumen: {
            declaradas: cuenta("libre") + cuenta("ocupada") + cuenta("descarga"),
            libres: cuenta("libre"),
            ocupadas: cuenta("ocupada"),
            descarga: cuenta("descarga")
        }
    };
}

/**
 * La hoja de un aula: la misma rejilla, el otro recurso compartido.
 *
 * Los docentes tenían su hoja y las aulas no, y son igual de compartidas: la que
 * ocupa 1A por la mañana la quiere otro grupo por la tarde. El dato ya viajaba
 * al motor —por eso sabe marcar `aulaOcupadaPorOtros`— pero solo se veía como
 * violación **después** de generar, cuando lo útil es mirarlo antes.
 *
 * Un aula no declara disponibilidad: existe todo el día hábil. Así que sus
 * estados son dos, libre u ocupada, y lo que importa de una ocupada es **quién**
 * la tiene: la propia coordinación puede moverla, la ajena hay que negociarla.
 */
export function armarHojaDeAula(aula, ocupaciones, rejilla, propias = []) {
    const [base, tope] = rangoHoras(rejilla);
    const suyas = ocupaciones.filter((o) => o.aulaId === aula.id);
    const mias = new Set(propias.map((c) => String(c).toUpperCase()));

    const dias = rejilla.dias.map((dia) => {
        const horas = [];
        for (let h = base; h < tope; h++) {
            const tomada = suyas.find((o) => o.dia === dia && o.inicio <= h && h < o.fin);
            horas.push(
                tomada
                    ? {
                          estado: "ocupada",
                          propia: mias.has(tomada.carrera),
                          carrera: tomada.carrera,
                          escenarioId: tomada.escenarioId,
                          grupo: tomada.grupoClave,
                          materia: tomada.materiaClave
                      }
                    : { estado: "libre" }
            );
        }
        return { dia, horas };
    });

    const celdas = dias.flatMap((d) => d.horas);
    return {
        aulaId: aula.id,
        clave: aula.clave,
        tipo: aula.tipo,
        capacidad: aula.capacidad ?? null,
        horaBase: base,
        dias,
        resumen: {
            hábiles: celdas.length,
            libres: celdas.filter((c) => c.estado === "libre").length,
            ocupadas: celdas.filter((c) => c.estado === "ocupada").length,
            propias: celdas.filter((c) => c.propia).length,
            // Carreras que la usan, para saber con quién habría que hablar.
            carreras: [...new Set(celdas.filter((c) => c.carrera).map((c) => c.carrera))].sort()
        }
    };
}

function estadoDe(docente, ocupaciones, dia, hora) {
    const dentro = (b) => b.dia === dia && b.inicio <= hora && hora < b.fin;

    if (!(docente.disponibilidad?.declarada ?? []).some(dentro)) {
        return { estado: "no_declarada" };
    }
    const descarga = (docente.descargas ?? []).find(dentro);
    if (descarga) return { estado: "descarga", motivo: descarga.motivo };

    const ocupada = ocupaciones.find(dentro);
    if (ocupada) {
        return {
            estado: "ocupada",
            carrera: ocupada.carrera,
            escenarioId: ocupada.escenarioId,
            grupo: ocupada.grupoClave,
            materia: ocupada.materiaClave
        };
    }
    const evitada = (docente.disponibilidad?.evitar ?? []).some(dentro);
    return { estado: "libre", evitada };
}

function rangoHoras(rejilla) {
    return [
        Math.min(...rejilla.turnos.map((t) => t.horaInicio)),
        Math.max(...rejilla.turnos.map((t) => t.horaFin))
    ];
}
