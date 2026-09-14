#!/usr/bin/env node
/**
 * Volver a un respaldo.
 *
 * Los respaldos existían desde hace días y nadie había restaurado ninguno, que
 * es la forma habitual de descubrir en el peor momento que no servían. Esto es
 * la otra mitad: sin ella, `respaldar.js` era una promesa sin comprobar.
 *
 *   node herramientas/restaurar.js                     # lista lo que hay
 *   node herramientas/restaurar.js --ver <archivo>     # qué contiene, sin tocar nada
 *   node herramientas/restaurar.js --archivo <f> --escribir
 *
 * En Docker hay que **parar el backend** antes: mientras corre tiene la base
 * abierta en modo WAL, y cambiarle el archivo debajo es la receta para
 * corromperla.
 *
 *   docker compose stop backend
 *   docker compose run --rm backend node herramientas/restaurar.js --archivo … --escribir
 *   docker compose start backend
 *
 * Tres cosas que hace y que no son opcionales:
 *
 * - **Comprueba el respaldo antes de tocar nada.** Integridad, que sea una base
 *   de SchedulAI y no otra cosa, y qué trae dentro. Restaurar a ciegas un
 *   archivo ilegible es cambiar un problema por otro peor.
 * - **Respalda lo que va a reemplazar.** La restauración también se puede
 *   equivocar —archivo confundido, fecha mal leída— y volver atrás tiene que
 *   ser posible.
 * - **Borra el `-wal` y el `-shm`.** Son el diario de la base anterior; dejarlos
 *   junto a un archivo nuevo mezcla dos historias y corrompe la base. Es el
 *   error clásico de restaurar SQLite copiando solo el `.db`.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATOS, PUERTO } from "../src/config.js";

/** Tablas sin las que esto no es una base de SchedulAI. */
const IMPRESCINDIBLES = ["usuarios", "carreras", "escenarios", "docentes", "saturacion"];

/** Lo que se cuenta para poder comparar antes y después de un vistazo. */
const SE_CUENTAN = [
    "usuarios", "carreras", "escenarios", "materias", "docentes",
    "asignacion", "saturacion", "horario"
];

const archivoDe = () => path.join(DATOS, "schedulai.db");
const carpetaDe = () => path.join(DATOS, "respaldos");

function argumento(nombre) {
    const i = process.argv.indexOf(`--${nombre}`);
    return i === -1 ? null : process.argv[i + 1];
}

/** Los respaldos que hay, del más nuevo al más viejo. */
export function disponibles(carpeta = carpetaDe()) {
    if (!fs.existsSync(carpeta)) return [];
    return fs
        .readdirSync(carpeta)
        .filter((n) => /^schedulai-.*\.db$/.test(n))
        .map((n) => {
            const ruta = path.join(carpeta, n);
            const s = fs.statSync(ruta);
            return { nombre: n, ruta, bytes: s.size, fecha: s.mtime };
        })
        .sort((a, b) => b.fecha - a.fecha);
}

/**
 * Qué hay dentro de un archivo, sin modificarlo.
 *
 * Se abre de solo lectura a propósito: inspeccionar un respaldo no debe poder
 * cambiarlo, y abrirlo para escritura crearía un `-wal` junto a él.
 */
export function revisar(ruta) {
    if (!fs.existsSync(ruta)) throw new Error(`No existe ${ruta}.`);

    let db;
    try {
        db = new DatabaseSync(ruta, { readOnly: true });
    } catch (e) {
        throw new Error(`No se pudo abrir ${path.basename(ruta)}: ${e.message}`);
    }
    try {
        const integridad = db.prepare("PRAGMA integrity_check").get().integrity_check;
        const tablas = new Set(
            db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name)
        );
        const faltan = IMPRESCINDIBLES.filter((t) => !tablas.has(t));

        const conteos = {};
        for (const t of SE_CUENTAN) {
            conteos[t] = tablas.has(t)
                ? db.prepare(`SELECT count(*) n FROM ${t}`).get().n
                : null;
        }
        return {
            ruta,
            bytes: fs.statSync(ruta).size,
            fecha: fs.statSync(ruta).mtime,
            integridad,
            tablas: tablas.size,
            faltan,
            conteos,
            // Lo que decide si se puede restaurar. Con una tabla imprescindible
            // ausente no es una base de este sistema, y restaurarla dejaría el
            // servicio sin arrancar.
            servible: integridad === "ok" && faltan.length === 0
        };
    } finally {
        db?.close();
    }
}

/**
 * Si el servicio está corriendo, que es lo que de verdad importa.
 *
 * La comprobación evidente no sirve, y conviene dejarlo escrito para que nadie
 * la reintente: **`BEGIN EXCLUSIVE` pasa aunque el backend esté arriba**. En
 * modo WAL varias conexiones conviven, y una conexión inactiva no retiene
 * ningún candado, así que el bloqueo exclusivo se concede y la comprobación
 * dice "libre" mientras el servicio atiende peticiones. Los archivos `-wal` y
 * `-shm` tampoco valen: sobreviven a un contenedor detenido.
 *
 * Lo único fiable es preguntarle al servicio. Si contesta, está vivo y
 * reemplazarle el archivo debajo corrompe la base.
 */
export async function servicioVivo({ puerto = PUERTO, ms = 700 } = {}) {
    // `localhost` cubre ejecutarlo en el anfitrión; el nombre del servicio,
    // dentro de la red de Docker, que es como lo documenta el README.
    for (const maquina of ["localhost", "backend"]) {
        try {
            const r = await fetch(`http://${maquina}:${puerto}/api/salud`, {
                signal: AbortSignal.timeout(ms)
            });
            if (r.ok) return `http://${maquina}:${puerto}`;
        } catch {
            // No contesta: ni vivo ahí, ni razón para alarmarse.
        }
    }
    return null;
}

/**
 * Reemplaza la base por el respaldo. Devuelve dónde quedó guardada la anterior,
 * porque volver atrás tiene que seguir siendo posible.
 */
export function restaurar({ origen, destino = archivoDe(), carpetaPrevia = carpetaDe() }) {
    const revision = revisar(origen);
    if (!revision.servible) {
        throw new Error(
            `Ese respaldo no sirve: integridad "${revision.integridad}"` +
                (revision.faltan.length ? `, le faltan ${revision.faltan.join(", ")}` : "")
        );
    }

    // La anterior no se borra: se aparta con nombre propio. Una restauración
    // equivocada es tan posible como la pérdida que la motivó.
    let previa = null;
    if (fs.existsSync(destino)) {
        fs.mkdirSync(carpetaPrevia, { recursive: true });
        const marca = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
        // Con el prefijo de los demás a propósito: así entra en la rotación de
        // `respaldar.js` y no se acumula para siempre. Un deshacer más viejo que
        // los catorce últimos respaldos ya no lo va a usar nadie, y un disco que
        // se llena en silencio es peor.
        previa = path.join(carpetaPrevia, `schedulai-antes-de-restaurar-${marca}.db`);
        const db = new DatabaseSync(destino);
        try {
            db.exec(`VACUUM INTO '${previa.replace(/'/g, "''")}'`);
        } finally {
            db.close();
        }
    }

    fs.copyFileSync(origen, destino);
    // El diario de la base anterior. Dejarlo junto a un archivo nuevo mezcla dos
    // historias: es el error clásico al restaurar SQLite a mano.
    for (const sufijo of ["-wal", "-shm"]) {
        if (fs.existsSync(destino + sufijo)) fs.unlinkSync(destino + sufijo);
    }

    return { previa, revision, restaurado: revisar(destino) };
}

// ------------------------------------------------------------------ consola

const kb = (b) => `${(b / 1024).toFixed(0)} kB`;
const cuando = (d) => d.toISOString().slice(0, 19).replace("T", " ");

function pintarRevision(r, titulo) {
    console.log(`\n  ${titulo}`);
    console.log(`    ${path.basename(r.ruta)} · ${kb(r.bytes)} · ${cuando(r.fecha)}`);
    console.log(`    integridad ${r.integridad} · ${r.tablas} tablas` +
        (r.faltan.length ? ` · FALTAN ${r.faltan.join(", ")}` : ""));
    const filas = Object.entries(r.conteos)
        .map(([t, n]) => `${t} ${n ?? "—"}`)
        .join(" · ");
    console.log(`    ${filas}`);
}

async function principal() {
    const elegido = argumento("archivo") ?? argumento("ver");
    const lista = disponibles();

    if (!elegido) {
        console.log(`\nRespaldos en ${carpetaDe()}\n`);
        if (lista.length === 0) {
            console.log("  No hay ninguno. Se crean solos cada HORAS_ENTRE_RESPALDOS.\n");
            return;
        }
        for (const r of lista) {
            console.log(`  ${cuando(r.fecha)}  ${kb(r.bytes).padStart(8)}  ${r.nombre}`);
        }
        console.log(
            `\n  ${lista.length} respaldos. Para ver uno por dentro:\n` +
            `    node herramientas/restaurar.js --ver ${lista[0].nombre}\n`
        );
        return;
    }

    // Se admite el nombre suelto además de la ruta: es lo que se copia de la
    // lista de arriba.
    const ruta = fs.existsSync(elegido) ? elegido : path.join(carpetaDe(), elegido);
    const revision = revisar(ruta);
    pintarRevision(revision, "El respaldo");

    if (fs.existsSync(archivoDe())) {
        pintarRevision(revisar(archivoDe()), "Lo que hay ahora, y se reemplazaría");
    }
    if (!revision.servible) {
        console.log("\n  No se puede restaurar: ver arriba.\n");
        process.exit(1);
    }

    if (!process.argv.includes("--escribir")) {
        console.log(
            "\n  Simulación. Con --escribir se reemplaza la base por este respaldo.\n" +
            "  Para el backend antes: mientras corre tiene la base abierta.\n"
        );
        return;
    }
    const vivo = await servicioVivo();
    if (vivo && !process.argv.includes("--forzar")) {
        console.log(
            `\n  El backend sigue atendiendo en ${vivo}. Mientras corre tiene la base\n` +
            "  abierta, y cambiarle el archivo debajo la corrompe. Párala y repite:\n" +
            "    docker compose stop backend\n"
        );
        process.exit(1);
    }

    const hecho = restaurar({ origen: ruta });
    console.log(`\n  Restaurado. La base anterior quedó en:\n    ${hecho.previa}`);
    console.log("  Arranca el backend otra vez para que la tome.\n");
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
    principal();
}
