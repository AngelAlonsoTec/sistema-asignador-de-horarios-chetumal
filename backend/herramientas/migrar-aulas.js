/**
 * Migración: las aulas dejan de ser de una carrera y pasan a ser del plantel.
 *
 * Con una sola carrera daba igual. Con dos, que cada una tenga su propio juego
 * significa que nadie detecta cuando ambas ocupan el mismo salón a la misma
 * hora, que es el mismo problema que ya se resolvió con los docentes.
 *
 * De paso se añade `capacidad`, que la fusión necesita: al juntar dos grupos hay
 * que saber si caben.
 *
 *   node backend/herramientas/migrar-aulas.js [--escribir]
 */

import { bd, enTransaccion } from "../src/bd.js";

/** Capacidad típica por tipo, como punto de partida editable. */
const CAPACIDAD = { aula: 35, laboratorio: 25 };

const db = bd();
const escribir = process.argv.includes("--escribir");

const columnas = db.prepare("PRAGMA table_info(aulas)").all().map((c) => c.name);
const yaMigrada = !columnas.includes("carrera");

if (yaMigrada) {
    const sin = db.prepare("SELECT count(*) c FROM aulas WHERE capacidad IS NULL").get().c;
    console.log(`La tabla ya es del plantel. ${sin} aulas sin capacidad.`);
    if (sin > 0 && escribir) {
        enTransaccion((tx) => {
            tx.prepare("UPDATE aulas SET capacidad = ? WHERE tipo = 'aula' AND capacidad IS NULL")
                .run(CAPACIDAD.aula);
            tx.prepare("UPDATE aulas SET capacidad = ? WHERE tipo = 'laboratorio' AND capacidad IS NULL")
                .run(CAPACIDAD.laboratorio);
        });
        console.log("Capacidades por omisión asignadas.");
    }
    process.exit(0);
}

const viejas = db.prepare("SELECT carrera, id, clave, tipo FROM aulas ORDER BY carrera, rowid").all();
const porClave = new Map();
for (const a of viejas) {
    // La clave del salón es lo que lo identifica en el plantel: si dos carreras
    // listaban "V-1", es el mismo salón, no dos.
    if (!porClave.has(a.clave)) porClave.set(a.clave, a);
}

console.log(`Aulas por carrera: ${viejas.length}`);
console.log(`Aulas del plantel tras unificar por clave: ${porClave.size}`);
for (const [clave, a] of porClave) {
    console.log(`  ${clave} (${a.tipo}) — venía de ${a.carrera}`);
}

if (!escribir) {
    console.log("\n(simulación; usa --escribir para aplicar)");
    process.exit(0);
}

enTransaccion((tx) => {
    tx.exec(`
        CREATE TABLE aulas_nueva (
            id        TEXT PRIMARY KEY,
            clave     TEXT NOT NULL,
            tipo      TEXT NOT NULL DEFAULT 'aula',
            capacidad INTEGER
        )
    `);
    const ins = tx.prepare(
        "INSERT INTO aulas_nueva (id, clave, tipo, capacidad) VALUES (?, ?, ?, ?)"
    );
    for (const a of porClave.values()) {
        ins.run(a.id, a.clave, a.tipo, CAPACIDAD[a.tipo] ?? CAPACIDAD.aula);
    }
    tx.exec("DROP TABLE aulas");
    tx.exec("ALTER TABLE aulas_nueva RENAME TO aulas");
});

console.log(`\nEscrito: ${db.prepare("SELECT count(*) c FROM aulas").get().c} aulas del plantel.`);
