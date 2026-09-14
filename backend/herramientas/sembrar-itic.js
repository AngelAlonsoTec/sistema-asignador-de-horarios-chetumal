/**
 * Retícula de ITIC.
 *
 * ADVERTENCIA: **es sintética.** Está armada con materias típicas de una
 * ingeniería en TIC del TecNM para que la contención entre carreras se pruebe
 * con volumen realista, pero no es el plan de estudios oficial. Cuando exista
 * el real, se sustituye este archivo.
 *
 * Lo que sí es deliberado: las materias de tronco común **comparten id** con
 * las de ISIC. Ahí está la gracia — son las mismas materias, las imparten los
 * mismos docentes, y por eso las dos carreras se pelean sus horas.
 *
 *   node backend/herramientas/sembrar-itic.js
 */

import { bd, enTransaccion, guardarCarrera } from "../src/bd.js";
import { crearUsuario } from "../src/auth.js";

// Compartidas con ISIC: mismo id, mismos docentes autorizados.
const COMPARTIDAS = [
    ["acf_0901", "ACF-0901", "Cálculo Diferencial", 1, 5, 5],
    ["aed_1285", "AED-1285", "Fundamentos de Programación", 1, 5, 5],
    ["aef_1041", "AEF-1041", "Matemáticas Discretas", 1, 5, 5],
    ["aca_0907", "ACA-0907", "Taller de Ética", 1, 4, 4],
    ["acc_0906", "ACC-0906", "Fundamentos de Investigación", 1, 4, 4],
    ["aec_1008", "AEC-1008", "Contabilidad Financiera", 1, 4, 4],

    ["acf_0902", "ACF-0902", "Cálculo Integral", 2, 5, 5],
    ["aed_1286", "AED-1286", "Programación Orientada a Objetos", 2, 5, 5],
    ["acf_0903", "ACF-0903", "Álgebra Lineal", 2, 5, 5],
    ["aec_1058", "AEC-1058", "Química", 2, 4, 4],
    ["aef_1052", "AEF-1052", "Probabilidad y Estadística", 2, 5, 5],
    ["sch_1024", "SCH-1024", "Taller de Administración", 2, 4, 4],

    ["acf_0904", "ACF-0904", "Cálculo Vectorial", 3, 5, 5],
    ["aed_1026", "AED-1026", "Estructura de Datos", 3, 5, 5],
    ["acd_0908", "ACD-0908", "Desarrollo Sustentable", 3, 5, 5],
    ["scc_1013", "SCC-1013", "Investigación de Operaciones", 3, 4, 4],
    ["scf_1006", "SCF-1006", "Física General", 3, 5, 5],
    ["scc_1005", "SCC-1005", "Cultura Empresarial", 3, 4, 4],

    ["acf_0905", "ACF-0905", "Ecuaciones Diferenciales", 4, 5, 5],
    ["aef_1031", "AEF-1031", "Fundamentos de Base de Datos", 4, 5, 5],
    ["scc_1017", "SCC-1017", "Métodos Numéricos", 4, 4, 4],
    ["scd_1021", "SCD-1021", "Redes de Computadoras", 4, 5, 5],
    ["aec_1061", "AEC-1061", "Sistemas Operativos", 4, 4, 4],
    ["scd_1027", "SCD-1027", "Tópicos Avanzados de Programación", 4, 5, 5],

    ["sca_1025", "SCA-1025", "Taller de Base de Datos", 5, 4, 4],
    ["scc_1007", "SCC-1007", "Fundamentos de Ingeniería de Software", 5, 4, 4],
    ["aec_1034", "AEC-1034", "Fundamentos de Telecomunicaciones", 5, 4, 4],
    ["scd_1003", "SCD-1003", "Arquitectura de Computadoras", 5, 4, 4],
    ["scc_1010", "SCC-1010", "Graficación", 5, 4, 4],
    ["sca_1002", "SCA-1002", "Administración de Redes", 5, 4, 4],

    ["aeb_1055", "AEB-1055", "Programación Web", 6, 5, 5],
    ["scd_1011", "SCD-1011", "Ingeniería de Software", 6, 5, 5],
    ["scb_1001", "SCB-1001", "Administración de Base de Datos", 6, 5, 5],
    ["scd_1004", "SCD-1004", "Conmutación y Enrutamiento en Redes de Datos", 6, 5, 5],
    ["scc_1012", "SCC-1012", "Inteligencia Artificial", 6, 4, 4],
    ["sca_1026", "SCA-1026", "Taller de Sistemas Operativos", 6, 4, 4],

    ["aca_0909", "ACA-0909", "Taller de Investigación I", 7, 4, 4],
    ["scg_1009", "SCG-1009", "Gestión de Proyectos de Software", 7, 6, 6],
    ["aca_0910", "ACA-0910", "Taller de Investigación II", 8, 4, 4]
];

// Propias de TIC: no existen en ISIC, así que nadie más se las disputa.
const PROPIAS = [
    ["tic_1001", "TIC-1001", "Seguridad de la Información", 7, 5, 5],
    ["tic_1002", "TIC-1002", "Cómputo en la Nube", 7, 4, 4],
    ["tic_1003", "TIC-1003", "Desarrollo de Aplicaciones Móviles", 7, 5, 5],
    ["tic_1004", "TIC-1004", "Auditoría en Tecnologías de la Información", 8, 4, 4],
    ["tic_1005", "TIC-1005", "Minería de Datos", 8, 5, 5],
    ["tic_1006", "TIC-1006", "Sistemas Distribuidos", 8, 5, 5],
    ["tic_1007", "TIC-1007", "Administración de Servidores", 8, 4, 4],
    ["tic_1008", "TIC-1008", "Interacción Humano-Computadora", 9, 4, 4],
    ["tic_1009", "TIC-1009", "Gobierno de TI", 9, 4, 4],
    ["tic_1010", "TIC-1010", "Taller de Innovación Tecnológica", 9, 5, 5]
];

const AULAS = [
    ["t_1", "T-1", "aula", 40],
    ["t_2", "T-2", "aula", 40],
    ["t_3", "T-3", "aula", 35],
    ["t_4", "T-4", "aula", 35],
    ["tn_1", "TN-1", "laboratorio", 25]
];

const db = bd();

enTransaccion((tx) => {
    guardarCarrera(tx, "ITIC", "Ing. en Tecnologías de la Información y Comunicaciones");

    const insAula = tx.prepare(
        `INSERT INTO aulas (id, clave, tipo, capacidad) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET clave = excluded.clave, tipo = excluded.tipo,
                                       capacidad = excluded.capacidad`
    );
    for (const a of AULAS) insAula.run(...a);

    tx.prepare("DELETE FROM materias WHERE carrera = 'ITIC'").run();
    tx.prepare("DELETE FROM semestres WHERE carrera = 'ITIC'").run();
    tx.prepare("DELETE FROM escenarios WHERE carrera = 'ITIC'").run();

    tx.prepare(
        "INSERT INTO escenarios (carrera, id, nombre, fecha, es_base) VALUES (?, ?, ?, ?, 1)"
    ).run("ITIC", "caso-base", "Caso base", new Date().toISOString().slice(0, 10));

    const insMateria = tx.prepare(`INSERT INTO materias
        (carrera, escenario_id, id, clave, nombre, semestre, horas_semana, creditos,
         especialidad_id, requiere_laboratorio)
        VALUES ('ITIC', 'caso-base', ?, ?, ?, ?, ?, ?, NULL, 0)`);
    for (const m of [...COMPARTIDAS, ...PROPIAS]) insMateria.run(...m);

    tx.prepare(`INSERT INTO semestres
        (carrera, escenario_id, id, periodo, semanas, turnos, estado)
        VALUES ('ITIC', 'caso-base', ?, ?, ?, ?, ?)`).run(
        "sem-2026-ago-dic-itic",
        "Agosto-Diciembre 2026",
        16,
        JSON.stringify(["matutino", "vespertino"]),
        "activo"
    );

    // Las propias de TIC necesitan quién las imparta: se autorizan a los
    // docentes de ISIC del área afín, que es como funciona en el instituto.
    const afinidad = {
        tic_1001: ["doc009", "doc011", "doc023"],
        tic_1002: ["doc009", "doc011", "doc026"],
        tic_1003: ["doc013", "doc019", "doc020"],
        tic_1004: ["doc010", "doc008", "doc021"],
        tic_1005: ["doc002", "doc026", "doc003"],
        tic_1006: ["doc011", "doc009", "doc024"],
        tic_1007: ["doc011", "doc023", "doc009"],
        tic_1008: ["doc013", "doc030", "doc007"],
        tic_1009: ["doc010", "doc005", "doc021"],
        tic_1010: ["doc006", "doc026", "doc029"]
    };
    const insAutoriza = tx.prepare(
        "INSERT OR IGNORE INTO docente_materia (docente_id, materia_id) VALUES (?, ?)"
    );
    for (const [materia, docentes] of Object.entries(afinidad)) {
        for (const d of docentes) insAutoriza.run(d, materia);
    }
});

if (!db.prepare("SELECT 1 FROM usuarios WHERE usuario = 'itic'").get()) {
    crearUsuario({
        id: "u-itic",
        nombre: "Coordinación TI",
        usuario: "itic",
        clave: "schedulai",
        carreras: ["ITIC"]
    });
} else {
    // La asignación pudo perderse si alguna vez se reemplazó la carrera.
    db.prepare(
        "INSERT OR IGNORE INTO usuario_carrera (usuario_id, carrera) VALUES (?, ?)"
    ).run("u-itic", "ITIC");
}

const c = (q, ...v) => db.prepare(q).get(...v);
console.log("ITIC:");
console.log("  materias:", c("SELECT count(*) n FROM materias WHERE carrera='ITIC'").n,
    `(${COMPARTIDAS.length} compartidas con ISIC, ${PROPIAS.length} propias)`);
console.log("  semestres:", c("SELECT count(DISTINCT semestre) n FROM materias WHERE carrera='ITIC'").n);
console.log("  horas/semana:", c("SELECT sum(horas_semana) n FROM materias WHERE carrera='ITIC'").n);
console.log("  sin docente autorizado:",
    c(`SELECT count(*) n FROM materias m WHERE m.carrera='ITIC'
       AND NOT EXISTS (SELECT 1 FROM docente_materia dm WHERE dm.materia_id = m.id)`).n);
