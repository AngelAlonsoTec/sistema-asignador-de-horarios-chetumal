#!/usr/bin/env node
/**
 * Las carreras del plantel y sus coordinaciones.
 *
 * Los nombres y las siglas son los **reales** de la oferta escolarizada del
 * TecNM Campus Chetumal (chetumal.tecnm.mx). El reparto en coordinaciones sigue
 * la regla que dio el coordinador: una persona lleva las carreras de su área —la
 * de administración lleva también gestión empresarial, y así las demás—.
 *
 * Los **datos académicos son mínimos y sintéticos**: a cada carrera nueva se le
 * siembra solo el tronco común de primer semestre, con claves que ya existen en
 * el plantel (ACA-0907, ACC-0906, ACF-0901). No es su retícula: es lo justo para
 * que la hoja de saturación tenga a trece carreras compitiendo por los mismos
 * treinta docentes, que es el problema que el sistema resuelve. Las retículas
 * completas las captura cada coordinación.
 *
 *   node herramientas/sembrar-plantel.js
 */

import { bd, enTransaccion, guardarCarrera } from "../src/bd.js";
import { crearUsuario } from "../src/auth.js";

/** Oferta escolarizada del campus. ISIC e ITIC ya existían con datos propios. */
const CARRERAS = [
    ["ISIC", "Ingeniería en Sistemas Computacionales"],
    ["ITIC", "Ingeniería en Tecnologías de la Información y Comunicaciones"],
    ["IDAP", "Ingeniería en Desarrollo de Aplicaciones"],
    ["IADM", "Ingeniería en Administración"],
    ["IGEM", "Ingeniería en Gestión Empresarial"],
    ["ICIV", "Ingeniería Civil"],
    ["IELE", "Ingeniería Eléctrica"],
    ["IEME", "Ingeniería Electromecánica"],
    ["LADM", "Licenciatura en Administración"],
    ["LBIO", "Licenciatura en Biología"],
    ["LTUR", "Licenciatura en Turismo"],
    ["ARQU", "Arquitectura"],
    ["CPUB", "Contador Público"]
];

/**
 * Quién coordina qué. Una coordinación lleva las carreras de su área: la de
 * administración lleva la licenciatura, la ingeniería y gestión empresarial.
 */
const COORDINACIONES = [
    { usuario: "coordinador", nombre: "Coordinación de Sistemas y TI", carreras: ["ISIC", "ITIC", "IDAP"] },
    { usuario: "admon", nombre: "Coordinación de Administración", carreras: ["LADM", "IADM", "IGEM"] },
    { usuario: "contaduria", nombre: "Coordinación de Contaduría", carreras: ["CPUB"] },
    { usuario: "biologia", nombre: "Coordinación de Biología", carreras: ["LBIO"] },
    { usuario: "construccion", nombre: "Coordinación de Construcción", carreras: ["ARQU", "ICIV"] },
    { usuario: "electro", nombre: "Coordinación de Eléctrica y Electromecánica", carreras: ["IELE", "IEME"] },
    { usuario: "turismo", nombre: "Coordinación de Turismo", carreras: ["LTUR"] }
];

/**
 * Tronco común de primer semestre. Son materias que el TecNM imparte en
 * prácticamente todos sus programas, y por eso son las que de verdad se pueden
 * fusionar entre carreras. Cálculo solo va en las ingenierías.
 */
const TRONCO = [
    { id: "aca_0907", clave: "ACA-0907", nombre: "Taller de Ética", horasSemana: 4, todas: true },
    { id: "acc_0906", clave: "ACC-0906", nombre: "Fundamentos de Investigación", horasSemana: 4, todas: true },
    { id: "acf_0901", clave: "ACF-0901", nombre: "Cálculo Diferencial", horasSemana: 5, todas: false }
];

const esIngenieria = (codigo) => codigo.startsWith("I") || codigo === "ARQU";

const db = bd();
const yaTienen = new Set(
    db.prepare("SELECT DISTINCT carrera FROM escenarios").all().map((r) => r.carrera)
);

enTransaccion((tx) => {
    for (const [codigo, nombre] of CARRERAS) guardarCarrera(tx, codigo, nombre);

    const insEsc = tx.prepare(
        "INSERT OR IGNORE INTO escenarios (carrera, id, nombre, fecha, es_base) VALUES (?, ?, ?, ?, 1)"
    );
    const insMat = tx.prepare(
        `INSERT OR IGNORE INTO materias
           (carrera, escenario_id, id, clave, nombre, semestre, horas_semana, requiere_laboratorio)
         VALUES (?, ?, ?, ?, ?, 1, ?, 0)`
    );
    const insSem = tx.prepare(
        `INSERT OR IGNORE INTO semestres (carrera, escenario_id, id, periodo, semanas, turnos, estado)
         VALUES (?, ?, ?, 'Agosto-Diciembre 2026', 16, '["matutino","vespertino"]', 'activo')`
    );
    const hoy = new Date().toISOString().slice(0, 10);

    for (const [codigo] of CARRERAS) {
        // ISIC e ITIC ya tienen retícula propia: no se les toca.
        if (yaTienen.has(codigo)) continue;

        insEsc.run(codigo, "caso-base", "Caso base", hoy);
        insSem.run(codigo, "caso-base", `sem-2026-ago-dic-${codigo.toLowerCase()}`);
        for (const m of TRONCO) {
            if (!m.todas && !esIngenieria(codigo)) continue;
            insMat.run(codigo, "caso-base", m.id, m.clave, m.nombre, m.horasSemana);
        }
    }
});

// Las cuentas se crean fuera de la transacción: `crearUsuario` abre la suya.
for (const c of COORDINACIONES) {
    const fila = db.prepare("SELECT id FROM usuarios WHERE usuario = ?").get(c.usuario);
    const id = fila?.id ?? `u-${c.usuario}`;

    if (fila) {
        // El nombre también se corrige: la cuenta de Sistemas venía de antes y
        // se llamaba "Coordinación" a secas, que en la tabla de carreras no
        // dice de cuál.
        db.prepare("UPDATE usuarios SET nombre = ? WHERE id = ?").run(c.nombre, id);
    } else {
        crearUsuario({ id, nombre: c.nombre, usuario: c.usuario, clave: "schedulai", carreras: [] });
    }
    // Se reasigna siempre: es la razón de correr esto, y así una segunda
    // pasada corrige un reparto que se haya tocado a mano.
    db.prepare("DELETE FROM usuario_carrera WHERE usuario_id = ?").run(id);
    const liga = db.prepare("INSERT OR IGNORE INTO usuario_carrera (usuario_id, carrera) VALUES (?, ?)");
    for (const carrera of c.carreras) liga.run(id, carrera);
}

// La cuenta suelta de ITIC pierde su razón de ser: ahora la lleva Sistemas y TI.
const suelta = db.prepare("SELECT id FROM usuarios WHERE usuario = 'itic'").get();
if (suelta) {
    db.prepare("DELETE FROM usuario_carrera WHERE usuario_id = ?").run(suelta.id);
    db.prepare("DELETE FROM sesiones WHERE usuario_id = ?").run(suelta.id);
}

console.log(`Carreras del plantel: ${CARRERAS.length}`);
for (const c of COORDINACIONES) {
    console.log(`  ${c.usuario.padEnd(13)} ${c.carreras.join(", ")}`);
}
const huerfanas = db
    .prepare("SELECT codigo FROM carreras WHERE codigo NOT IN (SELECT carrera FROM usuario_carrera)")
    .all();
console.log(`Sin coordinador: ${huerfanas.map((c) => c.codigo).join(", ") || "ninguna"}`);
