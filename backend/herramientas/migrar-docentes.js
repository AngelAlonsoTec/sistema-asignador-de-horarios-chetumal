/**
 * Migración fase 1: el docente sale del escenario y sube al instituto.
 *
 * Antes vivía en `data/<carrera>/escenarios/<id>/docentes.json`, así que dos
 * carreras que compartían un docente tenían dos copias distintas de la misma
 * persona. Ahora hay una sola plantilla en `data/docentes.json`.
 *
 * La disponibilidad también cambia de forma. Antes era `{turno, diasEvitar,
 * horasEvitar}`: tres conceptos sueltos que el motor traducía a tres
 * penalizaciones. Ahora son **bloques declarados**, que es lo que el docente
 * realmente contesta ("puedo lunes de 7 a 14"), y de ahí sale una máscara de
 * horas disponibles. El turno del docente desaparece: su horario ya lo dice.
 *
 *   node backend/herramientas/migrar-docentes.js [--escribir]
 *
 * Sin `--escribir` solo muestra lo que haría.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DATOS = path.resolve(AQUI, "..", "data");
const DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes"];

const RANGO_DE_TURNO = {
    matutino: { inicio: 7, fin: 14 },
    vespertino: { inicio: 14, fin: 22 }
};

/**
 * Descargas administrativas. Las carga el departamento académico: ni el
 * coordinador ni el docente las tocan. Aquí van como datos de ejemplo para que
 * la restricción se pueda probar; en producción entran por su propia vía.
 */
const DESCARGAS = {
    doc001: [{ dia: "lunes", inicio: 7, fin: 10, motivo: "Jefatura de academia" }],
    doc006: [{ dia: "jueves", inicio: 10, fin: 12, motivo: "Tutorías" }],
    doc007: [{ dia: "miercoles", inicio: 7, fin: 10, motivo: "Coordinación de tutorías" }],
    doc010: [{ dia: "martes", inicio: 14, fin: 17, motivo: "Gestión de vinculación" }],
    doc011: [{ dia: "viernes", inicio: 14, fin: 18, motivo: "Responsable de laboratorio" }],
    doc013: [{ dia: "lunes", inicio: 14, fin: 16, motivo: "Seguimiento de residencias" }]
};

/** `{turno, diasEvitar, horasEvitar}` -> bloques declarados y bloques a evitar. */
function convertirDisponibilidad(vieja) {
    const rango = RANGO_DE_TURNO[vieja?.turno] ?? RANGO_DE_TURNO.matutino;
    const declarada = DIAS.map((dia) => ({ dia, inicio: rango.inicio, fin: rango.fin }));

    const evitar = [];
    for (const dia of vieja?.diasEvitar ?? []) {
        if (DIAS.includes(dia)) evitar.push({ dia, inicio: rango.inicio, fin: rango.fin });
    }
    // Una hora suelta a evitar valía para todos los días; se expande a uno por día.
    for (const hora of vieja?.horasEvitar ?? []) {
        if (hora < rango.inicio || hora >= rango.fin) continue;
        for (const dia of DIAS) {
            if ((vieja?.diasEvitar ?? []).includes(dia)) continue;
            evitar.push({ dia, inicio: hora, fin: hora + 1 });
        }
    }
    return { declarada, evitar };
}

function migrarDocente(viejo) {
    const { disponibilidad, ...resto } = viejo;
    return {
        ...resto,
        disponibilidad: convertirDisponibilidad(disponibilidad),
        descargas: DESCARGAS[viejo.id] ?? []
    };
}

/**
 * Escenarios de una carrera, del más antiguo al más reciente según el
 * manifiesto. El orden importa: el último en procesarse es el que manda.
 */
async function ordenPorFecha(raiz) {
    let indice = [];
    try {
        indice = JSON.parse(await fs.readFile(path.join(raiz, "index.json"), "utf8"));
    } catch {
        // Sin manifiesto se usa el orden del sistema de archivos.
    }
    const fechas = new Map(indice.map((e) => [e.id, e.fecha ?? ""]));

    const carpetas = (await fs.readdir(raiz, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

    return carpetas.sort((a, b) => (fechas.get(a) ?? "").localeCompare(fechas.get(b) ?? ""));
}

async function carreras() {
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
    const plantilla = new Map();
    const origenes = [];

    for (const carrera of await carreras()) {
        const raiz = path.join(DATOS, carrera, "escenarios");
        for (const nombre of await ordenPorFecha(raiz)) {
            const archivo = path.join(raiz, nombre, "docentes.json");
            let docentes;
            try {
                docentes = JSON.parse(await fs.readFile(archivo, "utf8"));
            } catch {
                continue;
            }
            origenes.push({ archivo, cuantos: docentes.length });

            for (const docente of docentes) {
                // Gana el escenario más reciente, y por eso se recorren en orden
                // de fecha. El criterio obvio —"la versión que más materias
                // autoriza"— es incorrecto: un escenario viejo puede autorizar
                // más materias y aun así traer datos que ya se corrigieron.
                plantilla.set(docente.id, docente);
            }
        }
    }

    const migrados = [...plantilla.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(migrarDocente);

    console.log(`Origen: ${origenes.length} archivos de escenario`);
    for (const o of origenes) {
        console.log(`  ${path.relative(DATOS, o.archivo)} (${o.cuantos})`);
    }
    console.log(`\nPlantilla institucional: ${migrados.length} docentes`);
    console.log(`  con descarga administrativa: ${migrados.filter((d) => d.descargas.length).length}`);

    if (!escribir) {
        console.log("\n(simulación; usa --escribir para aplicar)");
        console.log(JSON.stringify(migrados[0], null, 2));
        return;
    }

    await fs.writeFile(
        path.join(DATOS, "docentes.json"),
        `${JSON.stringify(migrados, null, 2)}\n`,
        "utf8"
    );
    for (const o of origenes) await fs.rm(o.archivo);
    console.log(`\nEscrito data/docentes.json; eliminados ${origenes.length} archivos de escenario.`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
