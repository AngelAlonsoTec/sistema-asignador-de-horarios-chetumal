/**
 * Acceso a datos. Es el único módulo que sabe cómo están guardados; el resto del
 * backend trabaja con objetos.
 *
 * Desde la fase 2 el almacén es SQLite (`data/schedulai.db`) en vez de archivos
 * JSON. El cambio no es por tamaño sino por concurrencia: con varios
 * coordinadores tocando la misma plantilla docente, dos guardados sobre el mismo
 * archivo se pisaban y el último ganaba en silencio.
 *
 * Las funciones siguen siendo `async` aunque la base sea síncrona, para que las
 * rutas no tuvieran que cambiar al migrar.
 */

import { bd, enTransaccion } from "./bd.js";
import { MAX_MATERIAS } from "./tecnm.js";
import { ErrorHttp } from "./http.js";

/**
 * Una carrera o un id llegan desde la URL. Se restringen a un alfabeto conocido:
 * las consultas van parametrizadas, así que esto no es defensa contra inyección
 * sino contra identificadores absurdos que ensuciarían la base.
 */
const ID_VALIDO = /^[a-z0-9][a-z0-9_-]*$/i;

function validar(nombre, valor) {
    if (!ID_VALIDO.test(String(valor ?? ""))) {
        throw new ErrorHttp(400, `${nombre} inválido: "${valor}".`);
    }
    return valor;
}

const codigo = (carrera) => validar("Carrera", carrera).toUpperCase();

// ---------------------------------------------------------------- carreras

export async function listarCarreras() {
    return bd()
        .prepare("SELECT codigo FROM carreras ORDER BY codigo")
        .all()
        .map((r) => r.codigo);
}

// ---------------------------------------------------------------- docentes

/**
 * Plantilla docente del instituto. No depende de la carrera: es la misma
 * persona para todas, y ahí está el punto de haberla sacado del escenario.
 */
export async function leerDocentes() {
    const db = bd();
    const filas = db.prepare("SELECT * FROM docentes ORDER BY id").all();
    const horarios = db.prepare("SELECT * FROM docente_horario").all();
    const descargas = db.prepare("SELECT * FROM docente_descarga").all();
    const autorizadas = db.prepare("SELECT * FROM docente_materia ORDER BY materia_id").all();

    const porDocente = (lista) => {
        const mapa = new Map();
        for (const f of lista) {
            if (!mapa.has(f.docente_id)) mapa.set(f.docente_id, []);
            mapa.get(f.docente_id).push(f);
        }
        return mapa;
    };

    const h = porDocente(horarios);
    const d = porDocente(descargas);
    const a = porDocente(autorizadas);
    const bloque = ({ dia, inicio, fin }) => ({ dia, inicio, fin });

    return filas.map((f) => ({
        id: f.id,
        nombre: f.nombre,
        categoria: f.categoria,
        nivel: f.nivel,
        horasMin: f.horas_min,
        horasMax: f.horas_max,
        maxMaterias: f.max_materias,
        // Tiempo completo, tres cuartos, medio tiempo o asignatura. Ver
        // `tecnm.js`: es lo que dice cuántas horas de clase le tocan.
        dedicacion: f.dedicacion ?? null,
        maxGrupos: f.max_grupos,
        antiguedad: f.antiguedad,
        carreraBase: f.carrera_base,
        esDeOtraArea: Boolean(f.es_de_otra_area),
        disponibilidad: {
            declarada: (h.get(f.id) ?? []).filter((x) => x.tipo === "declarada").map(bloque),
            evitar: (h.get(f.id) ?? []).filter((x) => x.tipo === "evitar").map(bloque)
        },
        descargas: (d.get(f.id) ?? []).map(({ dia, inicio, fin, motivo }) => ({
            dia,
            inicio,
            fin,
            motivo
        })),
        materiasCapacitadas: (a.get(f.id) ?? []).map((x) => x.materia_id)
    }));
}

/**
 * Una baja no puede llevarse por delante lo que otras coordinaciones ya
 * apartaron.
 *
 * `saturacion` y `asignacion` cuelgan de `docentes(id)` con `ON DELETE CASCADE`,
 * y el cascade es correcto: si alguien se va, sus horas no pueden seguir
 * bloqueando a nadie. Lo que estaba mal era **quién se entera**. Medido sobre el
 * plantel completo, quitar a una persona de la lista borraba 45 horas apartadas
 * repartidas entre once carreras y tres clases del reparto, con un `200` y sin
 * una palabra; y los trece horarios ya guardados seguían nombrándola.
 *
 * Así que se hace como el cierre de una carrera, que ya se negaba por lo mismo:
 * primero se sueltan las horas —hablando con quien las tiene— y después se da
 * de baja. El mensaje dice cuántas son y de quiénes, que es lo que hace falta
 * para ir a pedirlas.
 */
function exigirQueNoDejeATodosColgados(db, id, nombre) {
    // Horas, no filas: cada fila es un bloque y puede valer tres. Quien lee el
    // aviso va a pedirlas en horas, que es como se apartan.
    const apartadas = db
        .prepare("SELECT coalesce(sum(fin - inicio), 0) n FROM saturacion WHERE docente_id = ?")
        .get(id).n;
    const carreras = db
        .prepare("SELECT DISTINCT carrera FROM saturacion WHERE docente_id = ? ORDER BY carrera")
        .all(id)
        .map((f) => f.carrera);
    const clases = db.prepare("SELECT count(*) n FROM asignacion WHERE docente_id = ?").get(id).n;
    if (apartadas === 0 && clases === 0) return;

    const partes = [];
    if (apartadas > 0) {
        partes.push(
            `${apartadas} ${apartadas === 1 ? "hora apartada" : "horas apartadas"} ` +
                `por ${carreras.join(", ")}`
        );
    }
    if (clases > 0) partes.push(`${clases} ${clases === 1 ? "clase asignada" : "clases asignadas"}`);
    throw new ErrorHttp(
        409,
        `${nombre} tiene ${partes.join(" y ")}. Antes de darle de baja hay que ` +
            "soltar eso: las coordinaciones liberan sus horas y el reparto se le pasa a alguien más."
    );
}

export async function guardarDocentes(docentes) {
    enTransaccion((db) => {
        // **No se borra la plantilla para reinsertarla.** `asignacion` y
        // `docente_prioridad` cuelgan de `docentes(id)` con `ON DELETE CASCADE`
        // y no viajan en este documento: un `DELETE FROM docentes` se llevaba
        // por delante todo el reparto del departamento y las prioridades de
        // cada coordinación, en silencio y en la acción más rutinaria que hay.
        // Es el mismo defecto que tenía `INSERT OR REPLACE INTO carreras`.
        const enviados = new Set(docentes.map((d) => d.id));
        const baja = db.prepare("DELETE FROM docentes WHERE id = ?");
        for (const { id, nombre } of db.prepare("SELECT id, nombre FROM docentes").all()) {
            if (enviados.has(id)) continue;
            exigirQueNoDejeATodosColgados(db, id, nombre);
            // Quien ya no está en la plantilla sí se va, y con él sus clases:
            // eso es darlo de baja, no un efecto colateral.
            baja.run(id);
        }

        const guardaDocente = db.prepare(`INSERT INTO docentes
            (id, nombre, categoria, nivel, horas_min, horas_max, max_materias, max_grupos,
             antiguedad, carrera_base, es_de_otra_area, dedicacion)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                dedicacion = excluded.dedicacion,
                nombre = excluded.nombre, categoria = excluded.categoria,
                nivel = excluded.nivel, horas_min = excluded.horas_min,
                horas_max = excluded.horas_max, max_materias = excluded.max_materias,
                max_grupos = excluded.max_grupos, antiguedad = excluded.antiguedad,
                carrera_base = excluded.carrera_base,
                es_de_otra_area = excluded.es_de_otra_area`);
        // Lo que sí es de este documento se reemplaza, pero por docente.
        const limpiaHorario = db.prepare("DELETE FROM docente_horario WHERE docente_id = ?");
        const limpiaDescarga = db.prepare("DELETE FROM docente_descarga WHERE docente_id = ?");
        const limpiaAutoriza = db.prepare("DELETE FROM docente_materia WHERE docente_id = ?");
        const insHorario = db.prepare(
            "INSERT INTO docente_horario (docente_id, tipo, dia, inicio, fin) VALUES (?, ?, ?, ?, ?)"
        );
        const insDescarga = db.prepare(
            "INSERT INTO docente_descarga (docente_id, dia, inicio, fin, motivo) VALUES (?, ?, ?, ?, ?)"
        );
        const insAutoriza = db.prepare(
            "INSERT OR IGNORE INTO docente_materia (docente_id, materia_id) VALUES (?, ?)"
        );

        for (const d of docentes) {
            guardaDocente.run(d.id, d.nombre, d.categoria, d.nivel ?? null, d.horasMin ?? 0,
                // El tope de materias por omisión es el del reglamento, no un
                // número grande: capturar un docente sin decirlo no debería
                // dejarle una carga que el artículo 155 no permite.
                d.horasMax ?? 40, d.maxMaterias ?? MAX_MATERIAS, d.maxGrupos ?? 99,
                d.antiguedad ?? null, d.carreraBase ?? null, d.esDeOtraArea ? 1 : 0,
                d.dedicacion ?? null);

            limpiaHorario.run(d.id);
            limpiaDescarga.run(d.id);
            limpiaAutoriza.run(d.id);

            for (const b of d.disponibilidad?.declarada ?? []) {
                insHorario.run(d.id, "declarada", b.dia, b.inicio, b.fin);
            }
            for (const b of d.disponibilidad?.evitar ?? []) {
                insHorario.run(d.id, "evitar", b.dia, b.inicio, b.fin);
            }
            for (const b of d.descargas ?? []) {
                insDescarga.run(d.id, b.dia, b.inicio, b.fin, b.motivo ?? null);
            }
            for (const m of d.materiasCapacitadas ?? []) insAutoriza.run(d.id, m);
        }
    });
}

/** Reemplaza las descargas de un docente. Ver la ruta: solo el departamento. */
export function guardarDescargas(docenteId, descargas) {
    return enTransaccion((db) => {
        db.prepare("DELETE FROM docente_descarga WHERE docente_id = ?").run(docenteId);
        const ins = db.prepare(
            "INSERT INTO docente_descarga (docente_id, dia, inicio, fin, motivo) VALUES (?, ?, ?, ?, ?)"
        );
        for (const b of descargas) ins.run(docenteId, b.dia, b.inicio, b.fin, b.motivo ?? null);
        return { guardadas: descargas.length };
    });
}

// ---------------------------------------------------------------- aulas

/**
 * Espacios del plantel. Ya no dependen de la carrera: el mismo salón lo usan
 * varias, y por eso la firma conserva el parámetro pero lo ignora — las rutas
 * siguen siendo por carrera y no valía la pena romperlas por esto.
 */
export async function leerAulas() {
    return bd().prepare("SELECT id, clave, tipo, capacidad FROM aulas ORDER BY rowid").all();
}

export async function guardarAulas(carrera, aulas) {
    enTransaccion((db) => {
        // Quitar un salón de la lista es darlo de baja, y por la misma razón que
        // con las personas no puede hacerse por encima de quien ya lo tiene
        // apartado. Aquí no hay cascade —`saturacion.aula_id` es texto suelto—
        // así que las horas no se borran: se quedan señalando a un salón que ya
        // no existe y desaparecen de la hoja de ocupación sin que nadie lo diga,
        // que para quien las apartó es lo mismo.
        const enviadas = new Set(aulas.map((a) => a.id));
        for (const { id, clave } of db.prepare("SELECT id, clave FROM aulas").all()) {
            if (enviadas.has(id)) continue;
            const fila = db
                .prepare(
                    `SELECT coalesce(sum(fin - inicio), 0) n, group_concat(DISTINCT carrera) quienes
                       FROM saturacion WHERE aula_id = ?`
                )
                .get(id);
            if (fila.n > 0) {
                throw new ErrorHttp(
                    409,
                    `${clave} tiene ${fila.n} ${fila.n === 1 ? "hora apartada" : "horas apartadas"} ` +
                        `por ${fila.quienes.split(",").join(", ")}. Hay que liberarlas antes de quitarlo.`
                );
            }
        }

        db.exec("DELETE FROM aulas");
        const ins = db.prepare(
            "INSERT INTO aulas (id, clave, tipo, capacidad) VALUES (?, ?, ?, ?)"
        );
        for (const a of aulas) ins.run(a.id, a.clave, a.tipo ?? "aula", a.capacidad ?? null);
    });
}

// ---------------------------------------------------------------- escenarios

export async function leerIndice(carrera) {
    return bd()
        .prepare("SELECT id, nombre, fecha, es_base, carrera FROM escenarios WHERE carrera = ?")
        .all(codigo(carrera))
        .map((f) => ({
            id: f.id,
            carrera: f.carrera,
            nombre: f.nombre,
            fecha: f.fecha,
            esBase: Boolean(f.es_base)
        }));
}

/** Registra o actualiza un escenario. */
export async function registrarEnIndice(carrera, meta) {
    const c = codigo(carrera);
    enTransaccion((db) => {
        db.prepare(
            `INSERT INTO escenarios (carrera, id, nombre, fecha, es_base) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(carrera, id) DO UPDATE SET
                 nombre = excluded.nombre, fecha = excluded.fecha, es_base = excluded.es_base`
        ).run(c, meta.id, meta.nombre, meta.fecha, meta.esBase ? 1 : 0);
    });
    return leerIndice(carrera);
}

export async function buscarMeta(carrera, id) {
    const meta = (await leerIndice(carrera)).find((e) => e.id === id);
    if (!meta) throw new ErrorHttp(404, `No existe el escenario "${id}".`);
    return meta;
}

/**
 * Los datos de un escenario más la plantilla institucional. El escenario define
 * qué se imparte; los docentes, quién puede impartirlo.
 */
export async function leerEscenario(carrera, id) {
    const c = codigo(carrera);
    validar("Escenario", id);
    const db = bd();

    const existe = db
        .prepare("SELECT 1 FROM escenarios WHERE carrera = ? AND id = ?")
        .get(c, id);
    if (!existe) throw new ErrorHttp(404, `No existe el escenario "${id}".`);

    const materias = db
        .prepare("SELECT * FROM materias WHERE carrera = ? AND escenario_id = ? ORDER BY rowid")
        .all(c, id)
        .map((f) => ({
            id: f.id,
            clave: f.clave,
            nombre: f.nombre,
            semestre: f.semestre,
            horasSemana: f.horas_semana,
            creditos: f.creditos,
            carrera: c,
            especialidadId: f.especialidad_id,
            requiereLaboratorio: Boolean(f.requiere_laboratorio)
        }));

    const especialidades = db
        .prepare("SELECT id, nombre FROM especialidades WHERE carrera = ? AND escenario_id = ? ORDER BY rowid")
        .all(c, id);

    const semestres = db
        .prepare("SELECT * FROM semestres WHERE carrera = ? AND escenario_id = ? ORDER BY rowid")
        .all(c, id)
        .map((f) => ({
            id: f.id,
            periodo: f.periodo,
            carrera: c,
            semanas: f.semanas,
            turnos: JSON.parse(f.turnos),
            estado: f.estado
        }));

    return { materias, docentes: await leerDocentes(), semestres, especialidades };
}

export async function guardarEscenario(carrera, id, datos) {
    const c = codigo(carrera);
    validar("Escenario", id);

    enTransaccion((db) => {
        for (const tabla of ["materias", "especialidades", "semestres"]) {
            db.prepare(`DELETE FROM ${tabla} WHERE carrera = ? AND escenario_id = ?`).run(c, id);
        }

        const insMateria = db.prepare(`INSERT INTO materias
            (carrera, escenario_id, id, clave, nombre, semestre, horas_semana, creditos,
             especialidad_id, requiere_laboratorio)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const m of datos.materias ?? []) {
            insMateria.run(c, id, m.id, m.clave, m.nombre, m.semestre, m.horasSemana,
                m.creditos ?? null, m.especialidadId ?? null, m.requiereLaboratorio ? 1 : 0);
        }

        const insEsp = db.prepare(
            "INSERT INTO especialidades (carrera, escenario_id, id, nombre) VALUES (?, ?, ?, ?)"
        );
        for (const e of datos.especialidades ?? []) insEsp.run(c, id, e.id, e.nombre);

        const insSem = db.prepare(`INSERT INTO semestres
            (carrera, escenario_id, id, periodo, semanas, turnos, estado) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const s of datos.semestres ?? []) {
            insSem.run(c, id, s.id, s.periodo, s.semanas ?? null,
                JSON.stringify(s.turnos ?? []), s.estado ?? null);
        }
    });
}

export async function eliminarEscenario(carrera, id) {
    const c = codigo(carrera);
    validar("Escenario", id);
    // Las materias, especialidades y semestres caen por ON DELETE CASCADE.
    enTransaccion((db) => {
        db.prepare("DELETE FROM saturacion WHERE carrera = ? AND escenario_id = ?").run(c, id);
        db.prepare("DELETE FROM escenarios WHERE carrera = ? AND id = ?").run(c, id);
    });
}

export async function existeEscenario(carrera, id) {
    return Boolean(
        bd()
            .prepare("SELECT 1 FROM escenarios WHERE carrera = ? AND id = ?")
            .get(codigo(carrera), validar("Escenario", id))
    );
}
