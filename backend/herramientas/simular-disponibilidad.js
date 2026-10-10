#!/usr/bin/env node
/**
 * Contesta el formulario de disponibilidad **en nombre de la plantilla**, para
 * poder correr el piloto sin esperar a que treinta personas respondan.
 *
 * Es una simulación y lo dice su nombre: la disponibilidad de alguien es un dato
 * que solo esa persona puede dar. Esto existe porque el sistema no se puede
 * medir con el banco que trae —sus declaraciones se capturaron cuando la tarde
 * empezaba a las 14:00— y porque hace falta ver qué pasa cuando la coordinación
 * recibe el formulario contestado de verdad, no sembrado por detrás.
 *
 * **El modelo, completo, para que se pueda discutir:**
 *
 * 1. **El turno no se re-inventa.** Se toma el que la persona ya tiene
 *    declarado: quien tenía mañanas declara mañanas. Lo que cambia es el borde,
 *    porque el corte real del plantel es a las 13:00 y no a las 14:00.
 * 2. **Quien tiene plaza declara su turno entero**, los cinco días. Está en el
 *    plantel la jornada completa: lo que no es clase son las otras funciones del
 *    artículo 27.
 * 3. **Quien es de asignatura declara una ventana**, no el turno: cobra por hora
 *    impartida y viene a dar sus horas. La ventana es `horasMax × holgura`
 *    repartida en los cinco días, acotada por la jornada de 8 h y por su turno.
 *    La holgura es un parámetro y no un supuesto escondido: con 1 la declaración
 *    *es* el horario y no deja nada que resolver.
 * 4. **Dónde cae la ventana lo decide la semilla**, no el orden de la lista.
 *    Arrancarlas todas al principio del turno inventaría una competencia por las
 *    primeras horas que nadie declaró.
 *
 * Va por la ruta pública del formulario —el enlace personal de cada quien—, así
 * que ejerce el mismo camino que una persona con su enlace, no un INSERT.
 *
 *   node herramientas/simular-disponibilidad.js                 # solo enseña
 *   node herramientas/simular-disponibilidad.js --aplicar
 *   node herramientas/simular-disponibilidad.js --aplicar --semilla=7 --holgura=2.5
 *   node herramientas/simular-disponibilidad.js --faltan=6       # seis sin contestar
 *   node herramientas/simular-disponibilidad.js --restaurar <archivo.json>
 *
 * Al aplicar guarda lo que había en `data/respaldos/disponibilidad-<fecha>.json`,
 * que es lo que `--restaurar` vuelve a poner.
 */

import fs from "node:fs";
import path from "node:path";
import { cliente, entrar } from "./acceso.js";

const BASE = (process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:8080").replace(/\/$/, "");
const API = `${BASE}/api`;

const bandera = (nombre, porOmision) => {
    const a = process.argv.find((x) => x.startsWith(`--${nombre}=`));
    return a ? a.slice(nombre.length + 3) : porOmision;
};
const APLICAR = process.argv.includes("--aplicar");
const SEMILLA = Number(bandera("semilla", 20261010));
const HOLGURA = Number(bandera("holgura", 2));
const FALTAN = Number(bandera("faltan", 0));
const RESTAURAR = bandera("restaurar", null);
const DESTINO = process.env.DATOS_DIR ?? path.join(import.meta.dirname, "..", "data");

/** Los dos turnos del plantel, con el corte real. Ver `problema.js`. */
const TURNOS = {
    matutino: { inicio: 7, fin: 13 },
    vespertino: { inicio: 13, fin: 22 }
};
const DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes"];
/** Jornada máxima de clase en un día. Ver `tecnm.MAX_HORAS_DIA_DOCENTE`. */
const MAX_DIA = 8;

/** Azar reproducible, sin dependencias: mulberry32. La semilla manda. */
function azar(semilla) {
    let s = semilla >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** El turno que la persona ya tenía declarado, por dónde caen sus bloques. */
function turnoDe(declarada) {
    if (!declarada?.length) return null;
    const temprano = declarada.filter((b) => b.inicio < 13).length;
    return temprano > declarada.length / 2 ? "matutino" : "vespertino";
}

/**
 * Lo que declara una persona. `null` si no se le puede deducir el turno: sin
 * nada declarado no hay de dónde sacarlo, y adivinarlo sería inventarlo.
 */
function declaracion(docente, declarada, dado) {
    const turno = turnoDe(declarada);
    if (!turno) return null;
    const { inicio, fin } = TURNOS[turno];
    const largoTurno = fin - inicio;

    const esPlaza = (docente.dedicacion ?? "") !== "asignatura";
    if (esPlaza) {
        return { turno, bloques: DIAS.map((dia) => ({ dia, inicio, fin })) };
    }

    // Asignatura: una ventana que le quepa, no el turno entero.
    const porDia = Math.min(
        largoTurno,
        MAX_DIA,
        Math.max(2, Math.ceil(((docente.horasMax ?? 0) * HOLGURA) / DIAS.length))
    );
    return {
        turno,
        bloques: DIAS.map((dia) => {
            // Dónde empieza su ventana ese día. El margen es lo que sobra del
            // turno; si no sobra nada, declara el turno completo.
            const margen = largoTurno - porDia;
            const desde = inicio + (margen > 0 ? Math.floor(dado() * (margen + 1)) : 0);
            return { dia, inicio: desde, fin: desde + porDia };
        })
    };
}

const horasDe = (bloques) => bloques.reduce((n, b) => n + (b.fin - b.inicio), 0);

async function main() {
    const s = await entrar(API, "depto");
    if (!s || s.perfil?.rol !== "departamento") {
        console.error("No se pudo entrar como departamento. Prueba CLAVE_DEPTO=... node ...");
        process.exit(1);
    }
    const anon = cliente(API);

    if (RESTAURAR) return restaurar(anon);

    const enlaces = (await s.c("/enlaces")).cuerpo ?? [];
    const docentes = (await s.c("/docentes")).cuerpo ?? [];
    const porId = new Map(docentes.map((d) => [d.id, d]));

    const dado = azar(SEMILLA);
    // Quiénes no contestan, si se piden. Se eligen con la semilla para que la
    // corrida sea repetible: un piloto a medias es el caso normal, no un error.
    const sinContestar = new Set(
        [...enlaces]
            .map((e) => ({ e, orden: dado() }))
            .sort((a, b) => a.orden - b.orden)
            .slice(0, Math.max(0, FALTAN))
            .map((x) => x.e.docenteId)
    );

    const previas = [];
    const plan = [];

    for (const e of enlaces) {
        const docente = porId.get(e.docenteId);
        const form = (await anon(`/disponibilidad/${e.token}`)).cuerpo;
        previas.push({
            docenteId: e.docenteId,
            token: e.token,
            declarada: form?.declarada ?? [],
            evitar: form?.evitar ?? [],
            // Quién había contestado de verdad. Devolver el contenido no basta:
            // sin esto, deshacer la simulación dejaba a los treinta marcados
            // como que habían contestado, y el avance del piloto mentía.
            contestado: e.contestado ?? null
        });

        if (sinContestar.has(e.docenteId)) {
            plan.push({ docente, estado: "no contesta" });
            continue;
        }
        const d = declaracion(docente, form?.declarada, dado);
        if (!d) {
            plan.push({ docente, estado: "sin turno deducible" });
            continue;
        }
        plan.push({ docente, estado: "declara", ...d });
    }

    console.log(`${APLICAR ? "Aplicando" : "Así quedaría"} · semilla ${SEMILLA} · holgura ${HOLGURA}` +
        (FALTAN ? ` · ${FALTAN} sin contestar` : ""));
    console.log("-".repeat(78));
    for (const p of plan) {
        const nombre = (p.docente?.nombre ?? p.docente?.id ?? "?").padEnd(28);
        const tipo = (p.docente?.dedicacion ?? "?").padEnd(16);
        if (p.estado !== "declara") {
            console.log(`${nombre} ${tipo} ${p.estado}`);
            continue;
        }
        const b = p.bloques[0];
        const iguales = p.bloques.every((x) => x.inicio === b.inicio && x.fin === b.fin);
        console.log(
            `${nombre} ${tipo} ${p.turno.padEnd(11)} ${String(horasDe(p.bloques)).padStart(2)} h · ` +
            (iguales ? `${b.inicio}-${b.fin} los cinco días`
                     : p.bloques.map((x) => `${x.inicio}-${x.fin}`).join(" "))
        );
    }

    const declaran = plan.filter((p) => p.estado === "declara");
    console.log("-".repeat(78));
    console.log(`${declaran.length} de ${plan.length} contestan · ` +
        `${declaran.reduce((n, p) => n + horasDe(p.bloques), 0)} h declaradas en total`);

    if (!APLICAR) {
        console.log("\nNada escrito. Con --aplicar se manda por el enlace de cada quien.");
        return;
    }

    const archivo = path.join(
        DESTINO, "respaldos",
        `disponibilidad-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, JSON.stringify(previas, null, 1));
    console.log(`\nLo que había queda en ${archivo}`);

    let puestos = 0;
    for (const p of declaran) {
        const e = enlaces.find((x) => x.docenteId === p.docente.id);
        const r = await anon(`/disponibilidad/${e.token}`, {
            metodo: "PUT", cuerpo: { declarada: p.bloques, evitar: [] }
        });
        if (r.estado === 200) puestos++;
        else console.log(`  ${p.docente.nombre}: HTTP ${r.estado} ${JSON.stringify(r.cuerpo).slice(0, 80)}`);
    }
    console.log(`${puestos} formularios contestados por su propio enlace.`);
}

/**
 * Deshace una corrida.
 *
 * El contenido vuelve por el formulario, que es donde vive la regla de qué es un
 * bloque válido. La **marca de contestado** no: el formulario la pone al día por
 * definición —alguien acaba de contestar— y deshacer no es contestar. Esa se
 * devuelve a mano, que es lo que hace de esto un deshacer y no otra corrida.
 */
async function restaurar(anon) {
    const previas = JSON.parse(fs.readFileSync(RESTAURAR, "utf8"));
    const { bd } = await import("../src/bd.js");
    const marca = bd().prepare("UPDATE docente_token SET contestado = ? WHERE token = ?");

    let vueltos = 0;
    let marcas = 0;
    for (const p of previas) {
        if (p.declarada.length > 0) {
            const r = await anon(`/disponibilidad/${p.token}`, {
                metodo: "PUT", cuerpo: { declarada: p.declarada, evitar: p.evitar }
            });
            if (r.estado === 200) vueltos++;
        }
        marca.run(p.contestado ?? null, p.token);
        marcas++;
    }
    console.log(`${vueltos} de ${previas.length} declaraciones devueltas a lo que decían.`);
    console.log(`${marcas} marcas de "contestado" como estaban antes de la corrida.`);
}

await main();
