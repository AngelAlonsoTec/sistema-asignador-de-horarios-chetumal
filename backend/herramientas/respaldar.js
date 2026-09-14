#!/usr/bin/env node
/**
 * Respaldo de la base.
 *
 * Cuando los datos eran JSON, el respaldo era el historial de git. Ahora son un
 * binario dentro de un volumen de Docker, y no hay copia: perderlo es perder
 * los escenarios, la plantilla docente, la saturación y los horarios apartados
 * de todas las carreras.
 *
 * Usa `VACUUM INTO` y no `cp`. Copiar el archivo mientras alguien escribe deja
 * un respaldo roto sin avisar: en modo WAL los cambios recientes viven en un
 * archivo aparte, así que la copia del `.db` puede quedar a medias de una
 * transacción. `VACUUM INTO` escribe una base nueva, consistente y compactada,
 * desde dentro de la misma conexión.
 *
 *   node herramientas/respaldar.js                  # a data/respaldos/
 *   node herramientas/respaldar.js --destino /ruta  # a otra carpeta
 *   node herramientas/respaldar.js --conservar 30   # cuántos guardar
 *
 * En Docker:
 *   docker compose exec backend node herramientas/respaldar.js
 */

import fs from "node:fs";
import path from "node:path";
import { bd } from "../src/bd.js";
import { DATOS } from "../src/config.js";

/** Cuántos respaldos se conservan. Los más viejos se borran. */
const CONSERVAR_POR_OMISION = 14;

function argumento(nombre, porOmision) {
    const i = process.argv.indexOf(`--${nombre}`);
    return i === -1 ? porOmision : process.argv[i + 1];
}

/** `2026-09-12T06-29-15`: ordenable como texto, y sin `:` por Windows. */
function marca(fecha = new Date()) {
    return fecha.toISOString().slice(0, 19).replace(/:/g, "-");
}

export function respaldar({ destino, conservar = CONSERVAR_POR_OMISION } = {}) {
    const carpeta = destino ?? path.join(DATOS, "respaldos");
    fs.mkdirSync(carpeta, { recursive: true });

    const archivo = sinColision(carpeta, marca());
    // La ruta va entre comillas simples y no como parámetro: `VACUUM INTO` no
    // acepta ligaduras. Se duplica cualquier comilla del nombre.
    bd().exec(`VACUUM INTO '${archivo.replace(/'/g, "''")}'`);

    const borrados = rotar(carpeta, Number(conservar));
    return { archivo, bytes: fs.statSync(archivo).size, borrados };
}

/**
 * Nombre libre. La marca tiene resolución de segundo, así que dos respaldos
 * seguidos chocan; `VACUUM INTO` falla entonces con "output file already
 * exists", que no dice nada útil a quien corre el comando.
 */
function sinColision(carpeta, base) {
    for (let n = 0; ; n++) {
        const archivo = path.join(carpeta, `schedulai-${base}${n ? `-${n}` : ""}.db`);
        if (!fs.existsSync(archivo)) return archivo;
    }
}

/**
 * Deja solo los `conservar` más recientes. Sin esto el disco se llena solo.
 *
 * Ordena por fecha de escritura y no por nombre: el sufijo que evita la
 * colisión rompe el orden alfabético —`...25-1.db` va antes que `...25.db`
 * porque `-` pesa menos que `.`— y rotar con ese orden borraba justamente el
 * respaldo más nuevo.
 */
function rotar(carpeta, conservar) {
    if (!Number.isFinite(conservar) || conservar <= 0) return [];

    const previos = fs
        .readdirSync(carpeta)
        .filter((n) => /^schedulai-.*\.db$/.test(n))
        .map((n) => ({ n, t: fs.statSync(path.join(carpeta, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
        .map((x) => x.n);

    const sobran = previos.slice(conservar);
    for (const n of sobran) fs.unlinkSync(path.join(carpeta, n));
    return sobran;
}

// Solo al invocarlo directamente: importarlo desde una prueba no debe respaldar.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
    const r = respaldar({
        destino: argumento("destino", undefined),
        conservar: argumento("conservar", CONSERVAR_POR_OMISION)
    });
    const kb = (r.bytes / 1024).toFixed(0);
    console.log(`Respaldo: ${r.archivo} (${kb} kB)`);
    if (r.borrados.length > 0) {
        console.log(`Se borraron ${r.borrados.length} respaldos viejos.`);
    }
}
