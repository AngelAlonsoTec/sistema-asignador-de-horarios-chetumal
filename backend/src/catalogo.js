/**
 * El catálogo visto por carrera: qué materias tiene y quién puede impartirlas.
 *
 * Es el mismo dato que la ficha del docente, del revés. La ficha sirve para
 * "qué puede dar esta persona"; esto sirve para la pregunta que el jefe de
 * departamento se hace al sentarse a repartir: **"qué le estoy dando a esta
 * coordinación"**. Sin esta vista había que abrir treinta fichas para saberlo.
 *
 * No hay horas por ninguna parte, a propósito. El departamento dice quién puede
 * impartir qué; cuántas horas y cuándo lo resuelve el coordinador con el motor.
 */

import { bd, enTransaccion } from "./bd.js";
import { ErrorHttp } from "./http.js";
import { construirGrupos, construirRejilla, lineasSugeridas } from "./problema.js";
import * as almacen from "./almacen.js";
import * as configEscenario from "./config-escenario.js";

/**
 * Los grupos de una carrera, tal como quedaron configurados.
 *
 * No se guardan como entidad: se derivan de las líneas del escenario —cuántos
 * grupos abre cada semestre y turno—, que sí se guardan. Si nadie ha
 * configurado nada todavía se usa la sugerencia, que es un grupo por semestre.
 */
function gruposDe(carrera, escenarioId, datos, config) {
    const rejilla = construirRejilla(datos.semestres, {});
    const turnos = rejilla.turnos.map((t) => t.id);
    const paridades = ["impares", "pares"];
    const salida = new Map();

    for (const paridad of paridades) {
        const lineas =
            config?.paridad === paridad && config.lineas?.length > 0
                ? config.lineas
                : lineasSugeridas(datos.materias, datos.especialidades, paridad, turnos);
        for (const g of construirGrupos(datos.materias, datos.especialidades, rejilla, paridad, {
            grupos: lineas
        })) {
            salida.set(g.clave, { clave: g.clave, semestre: g.semestre, turno: g.turno, materias: g.materias });
        }
    }
    return [...salida.values()].sort((a, b) => a.semestre - b.semestre || a.clave.localeCompare(b.clave));
}

/**
 * El escenario del que salen los grupos que el departamento reparte: **el
 * base**, sin heurística.
 *
 * El departamento asigna para el periodo, no para un "qué pasaría si", y cuál
 * de los escenarios va a producción lo dice la coordinación marcándolo como
 * base. Antes se adivinaba —el base si estaba configurado, si no el último
 * configurado— y eso dejaba que un borrador de prueba se llevara el catálogo
 * por delante en cuanto alguien le guardaba una configuración.
 *
 * Si el base no tiene grupos declarados se usa la sugerencia, que es un grupo
 * por semestre: repartir sobre eso es peor que no repartir, pero el sitio donde
 * se arregla es la configuración del escenario, no aquí.
 */
function escenarioDeReferencia(db, carrera) {
    const escenarios = db
        .prepare("SELECT id, es_base AS esBase FROM escenarios WHERE carrera = ? ORDER BY fecha DESC")
        .all(carrera);
    if (escenarios.length === 0) return null;
    return (escenarios.find((e) => e.esBase) ?? escenarios[0]).id;
}

/**
 * Qué imparte cada grupo de una carrera y quién se lo da.
 *
 * Una fila por (materia, grupo): es la unidad que el departamento decide. Una
 * materia con tres grupos puede llevarlos la misma persona o repartirse entre
 * varias, y las dos cosas se ven aquí igual de claras.
 */
export async function porCarrera(carrera) {
    const db = bd();
    const base = escenarioDeReferencia(db, carrera);
    if (!base) return { carrera, escenarioId: null, filas: [], huerfanas: [] };

    const datos = await almacen.leerEscenario(carrera, base);
    const config = configEscenario.leer({ carrera, escenarioId: base });
    const grupos = gruposDe(carrera, base, datos, config);

    const porMateria = new Map(datos.materias.map((m) => [m.id, m]));
    const nombres = new Map(
        db.prepare("SELECT id, nombre FROM docentes").all().map((d) => [d.id, d.nombre])
    );
    const asignado = new Map(
        db
            .prepare(
                `SELECT materia_id AS materiaId, grupo_clave AS grupoClave, docente_id AS docenteId
                 FROM asignacion WHERE carrera = ?`
            )
            .all(carrera)
            .map((a) => [`${a.materiaId}|${a.grupoClave}`, a.docenteId])
    );

    const filas = [];
    for (const g of grupos) {
        for (const materiaId of g.materias) {
            const m = porMateria.get(materiaId);
            if (!m) continue;
            const docenteId = asignado.get(`${materiaId}|${g.clave}`) ?? null;
            filas.push({
                materiaId,
                clave: m.clave,
                nombre: m.nombre,
                semestre: m.semestre,
                horasSemana: m.horasSemana,
                grupoClave: g.clave,
                turno: g.turno,
                docenteId,
                docenteNombre: docenteId ? nombres.get(docenteId) ?? docenteId : null
            });
        }
    }
    filas.sort(
        (a, b) => a.semestre - b.semestre || a.clave.localeCompare(b.clave) ||
                  a.grupoClave.localeCompare(b.grupoClave)
    );

    // Asignaciones que ya no corresponden a ninguna clase: el coordinador
    // cerró el grupo o quitó la materia de la retícula después de repartir.
    // No se borran —si el grupo vuelve a abrirse, la decisión sigue valiendo—
    // pero tampoco se callan: invisibles y contadas era lo peor de los dos
    // mundos, y es justo lo que hacía la carga acumulada.
    const vivas = new Set(filas.map((f) => `${f.materiaId}|${f.grupoClave}`));
    const huerfanas = [...asignado.keys()]
        .filter((k) => !vivas.has(k))
        .map((k) => {
            const [materiaId, grupoClave] = k.split("|");
            return {
                materiaId,
                grupoClave,
                docenteId: asignado.get(k),
                docenteNombre: nombres.get(asignado.get(k)) ?? asignado.get(k)
            };
        });

    return { carrera, escenarioId: base, filas, huerfanas };
}

/**
 * Las asignaciones de un escenario, como `materiaId|grupoClave -> docenteId`.
 * Es la forma en que `construirGrupos` las necesita.
 */
export function mapaDe(carrera) {
    return new Map(
        bd()
            .prepare(
                `SELECT materia_id AS materiaId, grupo_clave AS grupoClave, docente_id AS docenteId
                 FROM asignacion WHERE carrera = ?`
            )
            .all(carrera)
            .map((a) => [`${a.materiaId}|${a.grupoClave}`, a.docenteId])
    );
}

/** Un resumen por carrera, para ver de un vistazo dónde falta asignar. */
export async function resumen() {
    const salida = [];
    for (const c of bd().prepare("SELECT codigo, nombre FROM carreras ORDER BY codigo").all()) {
        const suyo = await porCarrera(c.codigo);
        salida.push({
            carrera: c.codigo,
            nombre: c.nombre,
            // Clases, no materias: una materia con tres grupos son tres
            // decisiones distintas, y es lo que hay que repartir.
            clases: suyo.filas.length,
            sinAsignar: suyo.filas.filter((f) => !f.docenteId).length,
            huerfanas: suyo.huerfanas.length
        });
    }
    return salida;
}

/**
 * Que esa persona pueda dar esa materia.
 *
 * La autorización materia-docente y el reparto los decide el mismo
 * departamento, así que esto no es pedirle permiso a nadie: es el orden.
 * Primero autorizar, luego repartir. Al revés, el motor respeta lo que el
 * departamento fija y no lo puede cambiar, así que la clase sale marcada como
 * "docente no capacitado" y el horario entero queda infactible por una decisión
 * que nadie recuerda haber tomado. La pantalla del departamento ya solo ofrece
 * a los autorizados; esto es lo que lo hace cierto también por la API.
 */
function exigirAutorizacion(db, docenteId, materiaId) {
    // Dejar la clase sin nadie es legítimo: es el estado normal a medio repartir.
    if (!docenteId) return;
    if (db.prepare("SELECT 1 FROM docente_materia WHERE docente_id = ? AND materia_id = ?")
        .get(docenteId, materiaId)) return;

    const nombre =
        db.prepare("SELECT nombre FROM docentes WHERE id = ?").get(docenteId)?.nombre ?? docenteId;
    throw new ErrorHttp(
        409,
        `${nombre} no está autorizado para esa materia. Hay que autorizárselo primero en ` +
            "su ficha, o darle la clase a alguien que ya lo esté."
    );
}

/**
 * Asigna quién imparte una materia a un grupo. `docenteId` nulo la deja sin
 * asignar, que es un estado legítimo mientras el departamento reparte.
 *
 * Es el único sitio por donde pasa una asignación —la pantalla, el reparto en
 * bloque y la aceptación de una petición acaban aquí—, y por eso la
 * autorización se exige aquí y no en cada ruta.
 */
export function asignar(db, { carrera, materiaId, grupoClave, docenteId, usuarioId, nota }) {
    exigirAutorizacion(db, docenteId, materiaId);

    const antes =
        db
            .prepare(
                `SELECT docente_id AS docenteId FROM asignacion
                 WHERE carrera = ? AND materia_id = ? AND grupo_clave = ?`
            )
            .get(carrera, materiaId, grupoClave)?.docenteId ?? null;

    if (!docenteId) {
        db.prepare(
            "DELETE FROM asignacion WHERE carrera = ? AND materia_id = ? AND grupo_clave = ?"
        ).run(carrera, materiaId, grupoClave);
    } else {
        db.prepare(
            `INSERT INTO asignacion (carrera, materia_id, grupo_clave, docente_id)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(carrera, materia_id, grupo_clave)
             DO UPDATE SET docente_id = excluded.docente_id`
        ).run(carrera, materiaId, grupoClave, docenteId);
    }

    // Solo lo que cambió. Guardar un "cambio" de alguien por sí mismo llenaría
    // la historia de ruido y escondería los cambios de verdad.
    if (antes !== (docenteId ?? null)) {
        anotar(db, { carrera, materiaId, grupoClave, antes, despues: docenteId ?? null, usuarioId, nota });
    }
    return docenteId ?? null;
}

/**
 * Deja constancia de un cambio de asignación, en la misma transacción que lo
 * provoca: no debe existir un estado donde la clase cambió de manos y su
 * historia no lo diga.
 */
function anotar(db, { carrera, materiaId, grupoClave, antes, despues, usuarioId, nota }) {
    const accion = !antes ? "asignada" : !despues ? "retirada" : "cambiada";
    db.prepare(
        `INSERT INTO asignacion_historial
            (momento, accion, carrera, materia_id, grupo_clave, antes, despues, usuario_id, nota)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        new Date().toISOString(), accion, carrera, materiaId, grupoClave,
        antes, despues, usuarioId ?? null, nota ?? null
    );
}

/**
 * Quién ha tenido cada clase. Sin filtros, lo último de todo el plantel; con
 * ellos, la historia de una clase concreta, que es como se consulta cuando
 * alguien pregunta "¿y esto desde cuándo?".
 */
export function historial({ carrera, materiaId, grupoClave, limite = 100 } = {}) {
    const donde = [];
    const valores = [];
    if (carrera) {
        donde.push("h.carrera = ?");
        valores.push(String(carrera).toUpperCase());
    }
    if (materiaId) {
        donde.push("h.materia_id = ?");
        valores.push(materiaId);
    }
    if (grupoClave) {
        donde.push("h.grupo_clave = ?");
        valores.push(grupoClave);
    }
    return bd()
        .prepare(
            `SELECT h.momento, h.accion, h.carrera, h.materia_id AS materiaId,
                    h.grupo_clave AS grupoClave, h.antes, h.despues, h.nota,
                    a.nombre AS antesNombre, d.nombre AS despuesNombre,
                    u.nombre AS quien
             FROM asignacion_historial h
             LEFT JOIN docentes a ON a.id = h.antes
             LEFT JOIN docentes d ON d.id = h.despues
             LEFT JOIN usuarios u ON u.id = h.usuario_id
             ${donde.length ? `WHERE ${donde.join(" AND ")}` : ""}
             ORDER BY h.momento DESC, h.id DESC
             LIMIT ?`
        )
        .all(...valores, Math.min(Number(limite) || 100, 500));
}

/**
 * Pone a la misma persona en **todos** los grupos que cursan una materia.
 *
 * Repartir son ciento cincuenta decisiones y el caso más común es que la misma
 * persona lleve todos los grupos de una materia: hacerlo de uno en uno son tres
 * diálogos idénticos para decir lo mismo. Sigue siendo una decisión por clase
 * —cada una deja su propia constancia— solo que se toman juntas.
 */
export async function asignarMateria({ carrera, materiaId, docenteId, usuarioId, nota }) {
    // El catálogo se lee **antes** de abrir la transacción: leerlo es asíncrono
    // y dentro no cabe un await sin dejarla abierta más de la cuenta.
    const suyo = await porCarrera(carrera);
    const grupos = suyo.filas.filter((f) => f.materiaId === materiaId);
    if (grupos.length === 0) {
        throw new ErrorHttp(404, `${carrera} no imparte esa materia en ningún grupo.`);
    }
    // Y las escrituras van juntas: son una decisión tomada de una vez, y a
    // medias —la mitad de los grupos con una persona y la otra mitad con
    // otra— es peor que no haberla tomado.
    enTransaccion((tx) => {
        for (const g of grupos) {
            asignar(tx, { carrera, materiaId, grupoClave: g.grupoClave, docenteId, usuarioId, nota });
        }
    });
    return { grupos: grupos.map((g) => g.grupoClave), docenteId: docenteId ?? null };
}

/**
 * Vacía el reparto de una carrera.
 *
 * La asignación no lleva periodo a propósito —el departamento reparte para el
 * que está en curso— así que al abrir el siguiente se hereda lo del anterior.
 * Casi siempre es lo que se quiere; cuando no, hasta ahora había que quitar las
 * clases de una en una. Queda la historia de lo que había.
 */
export async function vaciar({ carrera, usuarioId, nota }) {
    const suyo = await porCarrera(carrera);
    const conDocente = suyo.filas.filter((f) => f.docenteId);
    enTransaccion((tx) => {
        for (const f of conDocente) {
            asignar(tx, {
                carrera, materiaId: f.materiaId, grupoClave: f.grupoClave,
                docenteId: null, usuarioId, nota
            });
        }
    });
    return { quitadas: conDocente.length };
}

export async function cargaPorDocente() {
    const db = bd();
    const perfiles = new Map(
        db
            .prepare(
                `SELECT id, nombre, horas_max AS horasMax, max_materias AS maxMaterias,
                        max_grupos AS maxGrupos FROM docentes`
            )
            .all()
            .map((d) => [d.id, d])
    );

    // Del catálogo y no de la tabla: `asignacion` guarda decisiones que pueden
    // haber quedado sin clase —el coordinador cerró el grupo o quitó la materia
    // después de repartir— y contarlas daba una carga que incluía clases que ya
    // no existen. El catálogo es el que sabe qué se imparte de verdad.
    const filas = [];
    for (const { codigo } of db.prepare("SELECT codigo FROM carreras").all()) {
        const suyo = await porCarrera(codigo);
        for (const f of suyo.filas) {
            if (!f.docenteId) continue;
            filas.push({
                docenteId: f.docenteId,
                carrera: codigo,
                materiaId: f.materiaId,
                grupoClave: f.grupoClave,
                horasSemana: f.horasSemana,
                ...perfiles.get(f.docenteId)
            });
        }
    }

    const porDocente = new Map();
    for (const f of filas) {
        if (!porDocente.has(f.docenteId)) {
            porDocente.set(f.docenteId, {
                docenteId: f.docenteId,
                nombre: f.nombre,
                horasMax: f.horasMax,
                maxMaterias: f.maxMaterias,
                maxGrupos: f.maxGrupos,
                carreras: new Set(),
                materias: new Set(),
                clases: 0,
                horas: 0
            });
        }
        const d = porDocente.get(f.docenteId);
        d.carreras.add(f.carrera);
        d.materias.add(f.materiaId);
        d.clases++;
        d.horas += f.horasSemana ?? 0;
    }

    return [...porDocente.values()]
        .map((d) => ({
            ...d,
            carreras: [...d.carreras].sort(),
            materias: d.materias.size,
            // Lo que hay que mirar: quién se pasó de lo que puede.
            sobreHoras: d.horas > d.horasMax,
            sobreMaterias: d.materias.size > d.maxMaterias,
            sobreGrupos: d.clases > d.maxGrupos
        }))
        .sort((a, b) => b.horas - a.horas);
}
