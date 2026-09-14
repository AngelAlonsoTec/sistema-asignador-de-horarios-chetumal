#!/usr/bin/env node
/**
 * Puebla el reparto del plantel para poder medirlo a escala.
 *
 * **No es una función del producto**: quién imparte cada clase lo decide una
 * persona, y un sistema que lo resolviera solo contradiría todo el modelo. Esto
 * es un sembrador de banco de pruebas, como `sembrar-plantel.js`: sirve para
 * responder "¿aguanta el sistema con las ciento cincuenta clases repartidas?"
 * sin pedirle a nadie ciento cincuenta decisiones a mano.
 *
 *   node herramientas/sembrar-reparto.js               # mide y no escribe
 *   node herramientas/sembrar-reparto.js --escribir
 *   node herramientas/sembrar-reparto.js --vaciar      # deja el plantel sin reparto
 *
 * Respeta lo mismo que respetaría una persona, y por eso sirve para medir:
 *
 * - **Artículos 155 y 156**: nunca más de tres materias diferentes.
 * - **Artículo 143**: no pasar de las horas frente a grupo de su nombramiento.
 * - `maxGrupos`, que es práctica del plantel y no del reglamento.
 * - Autorización para la materia.
 * - Y que **pueda de verdad**: horas suficientes en el turno del grupo y tantos
 *   días distintos como bloques tenga la materia, porque una materia no se
 *   repite el mismo día.
 *
 * Reparte del caso más difícil al más fácil —las clases con menos candidatos
 * primero— porque al revés se gastan las personas escasas en clases que
 * cualquiera podía dar.
 */

import { CLAVES_CONOCIDAS, cliente as clienteHttp } from "./acceso.js";

const BASE = (process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:8080").replace(/\/$/, "");
const API = `${BASE}/api`;
const ESCRIBIR = process.argv.includes("--escribir");
const VACIAR = process.argv.includes("--vaciar");

const TURNOS = { matutino: [7, 14], vespertino: [14, 22] };
const c = clienteHttp(API);

/** Lo que declaró dentro de un turno: horas y días distintos. */
function declarado(docente, turno) {
    const [ini, fin] = TURNOS[turno] ?? [];
    if (ini === undefined) return { horas: Infinity, dias: Infinity };
    const bloques = (docente.disponibilidad?.declarada ?? []).filter(
        (b) => Math.min(b.fin, fin) > Math.max(b.inicio, ini)
    );
    return {
        horas: bloques.reduce((n, b) => n + Math.min(b.fin, fin) - Math.max(b.inicio, ini), 0),
        dias: new Set(bloques.map((b) => b.dia)).size
    };
}

/** Si esa persona **puede** con esa clase, mirando solo lo suyo. */
function puede(docente, fila) {
    if (!(docente.materiasCapacitadas ?? []).includes(fila.materiaId)) return false;
    const { horas, dias } = declarado(docente, fila.turno);
    return horas >= fila.horasSemana && dias >= Math.ceil(fila.horasSemana / 2);
}

/** Y si le cabe, contando lo que ya lleva encima de todas las carreras. */
function cabe(docente, fila, lleva) {
    const suyo = lleva.get(docente.id);
    if (suyo.horas + fila.horasSemana > docente.horasMax) return false;
    if (suyo.grupos + 1 > docente.maxGrupos) return false;
    if (!suyo.materias.has(fila.materiaId) && suyo.materias.size + 1 > docente.maxMaterias) {
        return false;
    }
    return true;
}

async function entrar() {
    for (const clave of [process.env.CLAVE_DEPTO, ...CLAVES_CONOCIDAS].filter(Boolean)) {
        const r = await c("/sesion", { metodo: "POST", cuerpo: { usuario: "depto", clave } });
        if (r.estado !== 200) continue;
        if (r.cuerpo.debeCambiarClave) {
            await c("/sesion/clave", { metodo: "POST", cuerpo: { actual: clave, nueva: "reparto2026" } });
            await c("/sesion", { metodo: "POST", cuerpo: { usuario: "depto", clave: "reparto2026" } });
        }
        return true;
    }
    return false;
}

async function principal() {
    if (!(await entrar())) {
        console.error("No pude entrar como depto.");
        process.exit(1);
    }

    const carreras = (await c("/plantel/catalogo")).cuerpo ?? [];
    if (VACIAR) {
        let quitadas = 0;
        for (const x of carreras) {
            quitadas += ((await c(`/plantel/asignaciones/${x.carrera}`, { metodo: "DELETE" }))
                .cuerpo?.quitadas) ?? 0;
        }
        console.log(`\nReparto vaciado: ${quitadas} asignaciones quitadas.\n`);
        return;
    }

    const docentes = (await c("/docentes")).cuerpo ?? [];
    const filas = [];
    for (const x of carreras) {
        const suyo = (await c(`/plantel/catalogo/${x.carrera}`)).cuerpo;
        for (const f of suyo.filas) filas.push({ ...f, carrera: x.carrera });
    }

    // Lo que ya lleva cada quien, contando **todas** las carreras: la persona es
    // una aunque las decisiones sean independientes.
    const lleva = new Map(
        docentes.map((d) => [d.id, { horas: 0, grupos: 0, materias: new Set() }])
    );
    for (const f of filas.filter((x) => x.docenteId)) {
        const suyo = lleva.get(f.docenteId);
        if (!suyo) continue;
        suyo.horas += f.horasSemana;
        suyo.grupos += 1;
        suyo.materias.add(f.materiaId);
    }

    const pendientes = filas.filter((f) => !f.docenteId);
    const candidatos = new Map(
        pendientes.map((f) => [f, docentes.filter((d) => puede(d, f))])
    );
    // Las clases difíciles primero: gastar a quien es escaso en una clase que
    // cualquiera podía dar es como se atascan estos repartos.
    pendientes.sort(
        (a, b) => candidatos.get(a).length - candidatos.get(b).length || b.horasSemana - a.horasSemana
    );

    const puestas = [];
    const atascadas = [];
    for (const f of pendientes) {
        const posibles = candidatos.get(f).filter((d) => cabe(d, f, lleva));
        if (posibles.length === 0) {
            atascadas.push({
                fila: f,
                // Distinguir "nadie puede" de "a nadie le cabe" es lo que dice
                // si falta gente o faltan horas.
                motivo: candidatos.get(f).length === 0
                    ? "nadie autorizado puede con ella"
                    : "quienes pueden ya no tienen cupo"
            });
            continue;
        }
        // El menos cargado de los que caben, para repartir y no amontonar.
        const elegido = posibles.sort(
            (x, y) => lleva.get(x.id).horas - lleva.get(y.id).horas || x.nombre.localeCompare(y.nombre)
        )[0];
        const suyo = lleva.get(elegido.id);
        suyo.horas += f.horasSemana;
        suyo.grupos += 1;
        suyo.materias.add(f.materiaId);
        puestas.push({ fila: f, docente: elegido });
    }

    console.log(`\nReparto del plantel · ${BASE}\n`);
    console.log(`  ${filas.length} clases · ${filas.length - pendientes.length} ya repartidas · ` +
                `${pendientes.length} por repartir`);
    console.log(`  Se pueden colocar ${puestas.length}; se atascan ${atascadas.length}.\n`);

    if (atascadas.length > 0) {
        const porMotivo = new Map();
        for (const a of atascadas) {
            porMotivo.set(a.motivo, (porMotivo.get(a.motivo) ?? 0) + 1);
        }
        for (const [motivo, n] of porMotivo) console.log(`  ${n} porque ${motivo}`);
        const horas = atascadas.reduce((n, a) => n + a.fila.horasSemana, 0);
        console.log(`  Son ${horas} horas-clase que esta plantilla no puede cubrir.\n`);
        for (const a of atascadas.slice(0, 6)) {
            console.log(`    ${a.fila.carrera} ${a.fila.clave} ${a.fila.grupoClave} ` +
                        `(${a.fila.horasSemana} h, ${a.fila.turno})`);
        }
        if (atascadas.length > 6) console.log(`    … y ${atascadas.length - 6} más`);
        console.log("");
    }

    if (!ESCRIBIR) {
        console.log("  Simulación. Con --escribir se aplica lo que sí cabe.\n");
        return;
    }

    // Una llamada por clase, como las haría una persona: es también la medida
    // de si el sistema aguanta ciento cincuenta decisiones seguidas.
    const arranque = Date.now();
    let hechas = 0;
    for (const { fila, docente } of puestas) {
        const r = await c("/plantel/asignaciones", {
            metodo: "PUT",
            cuerpo: {
                carrera: fila.carrera, materiaId: fila.materiaId,
                grupoClave: fila.grupoClave, docenteId: docente.id
            }
        });
        if (r.estado === 200) hechas++;
        else console.log(`  falló ${fila.carrera} ${fila.clave} ${fila.grupoClave}: ${r.cuerpo?.error}`);
    }
    const ms = Date.now() - arranque;
    console.log(`  Aplicadas ${hechas} asignaciones en ${(ms / 1000).toFixed(1)} s ` +
                `(${(ms / Math.max(hechas, 1)).toFixed(0)} ms cada una).\n`);
}

principal();
