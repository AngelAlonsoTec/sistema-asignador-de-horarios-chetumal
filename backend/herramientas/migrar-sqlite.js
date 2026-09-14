/**
 * Migración fase 2: de archivos JSON a SQLite.
 *
 * Lee la estructura actual de `data/` y la vuelca en `data/schedulai.db`. No
 * borra nada: los JSON quedan como respaldo hasta que se compruebe que la base
 * responde igual.
 *
 *   node backend/herramientas/migrar-sqlite.js [--escribir]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bd, enTransaccion } from "../src/bd.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.resolve(AQUI, "..", "data");

const NOMBRES = {
    ISIC: "Ing. Sistemas Computacionales",
    ITIC: "Ing. en Tecnologías de la Información y Comunicaciones",
    IDAP: "Ing. en Desarrollo de Aplicaciones"
};

async function leer(ruta, porOmision) {
    try {
        return JSON.parse(await fs.readFile(ruta, "utf8"));
    } catch (e) {
        if (e.code === "ENOENT" && porOmision !== undefined) return porOmision;
        throw e;
    }
}

async function carpetasDeCarrera() {
    const entradas = await fs.readdir(DATOS, { withFileTypes: true });
    const salida = [];
    for (const entrada of entradas) {
        if (!entrada.isDirectory()) continue;
        try {
            await fs.access(path.join(DATOS, entrada.name, "escenarios"));
            salida.push(entrada.name);
        } catch {
            // No es una carrera.
        }
    }
    return salida;
}

async function main() {
    const escribir = process.argv.includes("--escribir");
    const docentes = await leer(path.join(DATOS, "docentes.json"), []);
    const saturacion = await leer(path.join(DATOS, "saturacion.json"), []);
    const carreras = await carpetasDeCarrera();

    const resumen = { carreras: carreras.length, docentes: docentes.length, escenarios: 0, materias: 0, saturacion: saturacion.length };
    const trabajo = [];

    for (const carpeta of carreras) {
        const codigo = carpeta.toUpperCase();
        const aulas = await leer(path.join(DATOS, carpeta, "aulas.json"), []);
        const indice = await leer(path.join(DATOS, carpeta, "escenarios", "index.json"), []);
        const escenarios = [];

        for (const meta of indice) {
            const base = path.join(DATOS, carpeta, "escenarios", meta.id);
            escenarios.push({
                meta,
                materias: await leer(path.join(base, "materias.json"), []),
                especialidades: await leer(path.join(base, "especialidades.json"), []),
                semestres: await leer(path.join(base, "semestres.json"), [])
            });
            resumen.materias += (await leer(path.join(base, "materias.json"), [])).length;
        }
        resumen.escenarios += escenarios.length;
        trabajo.push({ codigo, aulas, escenarios });
    }

    console.log("Por migrar:", resumen);

    if (!escribir) {
        console.log("\n(simulación; usa --escribir para aplicar)");
        return;
    }

    enTransaccion((db) => {
        // Se vacía primero: la migración es idempotente y se puede repetir.
        for (const tabla of [
            "saturacion", "docente_materia", "docente_descarga", "docente_horario",
            "materias", "especialidades", "semestres", "escenarios", "aulas",
            "docentes", "carreras"
        ]) {
            db.exec(`DELETE FROM ${tabla}`);
        }

        const insCarrera = db.prepare("INSERT INTO carreras (codigo, nombre) VALUES (?, ?)");
        const insDocente = db.prepare(`INSERT INTO docentes
            (id, nombre, categoria, nivel, horas_min, horas_max, max_materias, max_grupos,
             antiguedad, carrera_base, es_de_otra_area)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const insHorario = db.prepare(
            "INSERT INTO docente_horario (docente_id, tipo, dia, inicio, fin) VALUES (?, ?, ?, ?, ?)"
        );
        const insDescarga = db.prepare(
            "INSERT INTO docente_descarga (docente_id, dia, inicio, fin, motivo) VALUES (?, ?, ?, ?, ?)"
        );
        const insAutoriza = db.prepare(
            "INSERT OR IGNORE INTO docente_materia (docente_id, materia_id) VALUES (?, ?)"
        );
        const insAula = db.prepare("INSERT INTO aulas (carrera, id, clave, tipo) VALUES (?, ?, ?, ?)");
        const insEscenario = db.prepare(
            "INSERT INTO escenarios (carrera, id, nombre, fecha, es_base) VALUES (?, ?, ?, ?, ?)"
        );
        const insMateria = db.prepare(`INSERT INTO materias
            (carrera, escenario_id, id, clave, nombre, semestre, horas_semana, creditos,
             especialidad_id, requiere_laboratorio)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const insEspecialidad = db.prepare(
            "INSERT INTO especialidades (carrera, escenario_id, id, nombre) VALUES (?, ?, ?, ?)"
        );
        const insSemestre = db.prepare(`INSERT INTO semestres
            (carrera, escenario_id, id, periodo, semanas, turnos, estado) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        const insSaturacion = db.prepare(`INSERT INTO saturacion
            (carrera, escenario_id, periodo, paridad, docente_id, dia, inicio, fin,
             grupo_clave, materia_clave)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

        for (const { codigo, aulas, escenarios } of trabajo) {
            insCarrera.run(codigo, NOMBRES[codigo] ?? codigo);
            for (const a of aulas) insAula.run(codigo, a.id, a.clave, a.tipo ?? "aula");

            for (const { meta, materias, especialidades, semestres } of escenarios) {
                insEscenario.run(codigo, meta.id, meta.nombre, meta.fecha, meta.esBase ? 1 : 0);
                for (const m of materias) {
                    insMateria.run(codigo, meta.id, m.id, m.clave, m.nombre, m.semestre,
                        m.horasSemana, m.creditos ?? null, m.especialidadId ?? null,
                        m.requiereLaboratorio ? 1 : 0);
                }
                for (const e of especialidades) insEspecialidad.run(codigo, meta.id, e.id, e.nombre);
                for (const s of semestres) {
                    insSemestre.run(codigo, meta.id, s.id, s.periodo, s.semanas ?? null,
                        JSON.stringify(s.turnos ?? []), s.estado ?? null);
                }
            }
        }

        for (const d of docentes) {
            insDocente.run(d.id, d.nombre, d.categoria, d.nivel ?? null, d.horasMin ?? 0,
                d.horasMax ?? 40, d.maxMaterias ?? 99, d.maxGrupos ?? 99, d.antiguedad ?? null,
                d.carreraBase ?? null, d.esDeOtraArea ? 1 : 0);

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

        for (const o of saturacion) {
            insSaturacion.run(o.carrera, o.escenarioId, o.periodo ?? null, o.paridad ?? null,
                o.docenteId, o.dia, o.inicio, o.fin, o.grupoClave ?? null, o.materiaClave ?? null);
        }
    });

    const db = bd();
    const cuenta = (tabla) => db.prepare(`SELECT count(*) c FROM ${tabla}`).get().c;
    console.log("\nEscrito data/schedulai.db:");
    for (const t of ["carreras", "docentes", "docente_horario", "docente_materia",
                     "escenarios", "materias", "especialidades", "aulas", "saturacion"]) {
        console.log(`  ${t}: ${cuenta(t)}`);
    }
    console.log("\nLos JSON quedan intactos como respaldo.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
