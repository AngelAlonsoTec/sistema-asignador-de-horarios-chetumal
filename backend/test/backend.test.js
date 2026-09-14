import test from "node:test";
import assert from "node:assert/strict";

import { coincide } from "../src/http.js";
import { resolverRuta } from "../src/rutas.js";
import { generarId } from "../src/escenarios.js";
import { calcularCobertura, contarDocentesPorMateria } from "../src/cobertura.js";
import {
    asignarAulasBase,
    construirGrupos,
    construirProblema,
    construirRejilla,
    lineasSugeridas,
    horasDisponibles,
    horasEnDisputa,
    materiasDelPeriodo,
    resolverParidad
} from "../src/problema.js";
import { paridadSugerida, semestresDe } from "../src/periodo.js";
import { validarParaHorario } from "../src/validacion.js";
import { armarHoja } from "../src/saturacion.js";
import { candidatas, depurar } from "../src/fusiones.js";
import * as tecnm from "../src/tecnm.js";
import { unir, carreraDe, candidatasEntreCarreras, repartirPorCarrera } from "../src/conjunto.js";

// ---------------------------------------------------------------- enrutador

test("coincide extrae los parámetros nombrados", () => {
    assert.deepEqual(
        coincide("/api/carreras/:carrera/escenarios/:id", "/api/carreras/ISIC/escenarios/caso-base"),
        { carrera: "ISIC", id: "caso-base" }
    );
});

test("coincide rechaza rutas de distinta longitud o texto distinto", () => {
    assert.equal(coincide("/api/carreras/:carrera", "/api/carreras/ISIC/escenarios"), null);
    assert.equal(coincide("/api/aulas", "/api/docentes"), null);
    assert.equal(coincide("/api/carreras/:carrera", "/api/carreras/"), null);
});

test("coincide decodifica los tramos con porcentaje", () => {
    assert.deepEqual(coincide("/x/:id", "/x/con%20espacio"), { id: "con espacio" });
});

// ---------------------------------------------------------------- resolución de rutas

test("un mismo camino resuelve a manejadores distintos según el verbo", () => {
    // Regresión: el enrutador cortaba en la primera coincidencia de camino, así
    // que POST y DELETE quedaban inalcanzables donde compartían ruta con GET.
    const lista = resolverRuta("GET", "/api/carreras/ISIC/escenarios");
    const alta = resolverRuta("POST", "/api/carreras/ISIC/escenarios");
    assert.ok(lista.manejador);
    assert.ok(alta.manejador);
    assert.notEqual(lista.manejador, alta.manejador);

    const borrado = resolverRuta("DELETE", "/api/carreras/ISIC/escenarios/x");
    const detalle = resolverRuta("GET", "/api/carreras/ISIC/escenarios/x");
    assert.ok(borrado.manejador);
    assert.notEqual(borrado.manejador, detalle.manejador);
});

test("un verbo no soportado da 405 y lista los que sí", () => {
    const r = resolverRuta("PATCH", "/api/carreras/ISIC/escenarios");
    assert.equal(r.manejador, null);
    assert.equal(r.permitido, "GET, POST");
});

test("una ruta inexistente no resuelve", () => {
    assert.equal(resolverRuta("GET", "/api/inventado"), null);
});

// ---------------------------------------------------------------- ids

test("generarId normaliza acentos y símbolos", () => {
    assert.equal(generarId("Añadir Créditos 2026", new Set()), "anadir-creditos-2026");
    assert.equal(generarId("  Especialidad IA  ", new Set()), "especialidad-ia");
});

test("generarId evita colisiones y nunca queda vacío", () => {
    assert.equal(generarId("IA", new Set(["ia", "ia-2"])), "ia-3");
    assert.equal(generarId("!!!", new Set()), "escenario");
});

// ---------------------------------------------------------------- cobertura

const MATERIAS = [{ id: "a" }, { id: "b" }, { id: "c" }];
const DOCENTES = [
    { id: "d1", materiasCapacitadas: ["a", "b"] },
    { id: "d2", materiasCapacitadas: ["a", "inexistente"] }
];

test("la cobertura cuenta las materias sin docente", () => {
    const cobertura = calcularCobertura(MATERIAS, DOCENTES);
    assert.equal(cobertura.total, 3);
    assert.equal(cobertura.cubiertas, 2);
    assert.deepEqual(cobertura.sinDocente, ["c"]);
    assert.equal(cobertura.completa, false);
});

test("una materia listada por un docente pero inexistente no infla el conteo", () => {
    const conteo = contarDocentesPorMateria(MATERIAS, DOCENTES);
    assert.equal(conteo.get("a"), 2);
    assert.equal(conteo.get("b"), 1);
    assert.equal(conteo.has("inexistente"), false);
});

test("sin docentes, nada está cubierto", () => {
    assert.deepEqual(calcularCobertura(MATERIAS, []).sinDocente, ["a", "b", "c"]);
});

// ---------------------------------------------------------------- rejilla

const SEMESTRES = [{ turnos: ["matutino", "vespertino"] }];

test("la rejilla pone horas a los turnos nombrados en el escenario", () => {
    const rejilla = construirRejilla(SEMESTRES);
    assert.deepEqual(rejilla.turnos, [
        { id: "matutino", horaInicio: 7, horaFin: 14 },
        { id: "vespertino", horaInicio: 14, horaFin: 22 }
    ]);
    assert.equal(rejilla.dias.length, 5);
});

test("un turno desconocido falla en vez de inventarse un horario", () => {
    assert.throws(() => construirRejilla([{ turnos: ["nocturno"] }]), /nocturno/);
});

test("una rejilla explícita gana sobre la deducida", () => {
    const rejilla = construirRejilla(SEMESTRES, {
        rejilla: { dias: ["lunes"], turnos: [{ id: "unico", horaInicio: 8, horaFin: 12 }] }
    });
    assert.deepEqual(rejilla.dias, ["lunes"]);
    assert.equal(rejilla.duracionMaximaBloque, 3);
});

test("una rejilla explícita mal formada se rechaza", () => {
    const mal = (rejilla) => () => construirRejilla(SEMESTRES, { rejilla });
    assert.throws(mal({ dias: [], turnos: [{ id: "a", horaInicio: 7, horaFin: 9 }] }), /día/);
    assert.throws(mal({ dias: ["lunes"], turnos: [] }), /turno/);
    assert.throws(mal({ dias: ["lunes"], turnos: [{ id: "a", horaInicio: 9, horaFin: 7 }] }), /antes de empezar/);
});

// ---------------------------------------------------------------- periodo

test("la paridad se deduce del nombre del periodo", () => {
    assert.equal(paridadSugerida([{ periodo: "Agosto-Diciembre 2026" }]), "impares");
    assert.equal(paridadSugerida([{ periodo: "Enero-Junio 2027" }]), "pares");
    // Sin dato utilizable se asume agosto-diciembre.
    assert.equal(paridadSugerida([]), "impares");
    assert.equal(paridadSugerida([{ periodo: "Periodo raro" }]), "impares");
});

test("cada paridad ofrece solo sus semestres", () => {
    assert.deepEqual(semestresDe("impares"), [1, 3, 5, 7, 9]);
    assert.deepEqual(semestresDe("pares"), [2, 4, 6, 8]);
});

test("materiasDelPeriodo descarta los semestres que no se imparten", () => {
    const materias = [
        { id: "a", semestre: 1 },
        { id: "b", semestre: 2 },
        { id: "c", semestre: 7 }
    ];
    assert.deepEqual(
        materiasDelPeriodo(materias, "impares").map((m) => m.id),
        ["a", "c"]
    );
    assert.deepEqual(
        materiasDelPeriodo(materias, "pares").map((m) => m.id),
        ["b"]
    );
});

test("una paridad desconocida se rechaza", () => {
    assert.throws(() => resolverParidad({ semestres: [] }, { paridad: "todos" }), /Paridad/);
});

// ---------------------------------------------------------------- grupos

const REJILLA = construirRejilla(SEMESTRES);

const ESPECIALIDADES = [
    { id: "web", nombre: "Desarrollo Web" },
    { id: "negocios", nombre: "Negocios Digitales" }
];

// Semestre 1 sin especialidad; semestre 7 con tronco común y dos módulos.
const RETICULA = [
    { id: "m1", clave: "M1", nombre: "Uno", semestre: 1, horasSemana: 4, especialidadId: null },
    { id: "m2", clave: "M2", nombre: "Dos", semestre: 1, horasSemana: 4, especialidadId: null },
    { id: "t7", clave: "T7", nombre: "Tronco 7", semestre: 7, horasSemana: 4, especialidadId: null },
    { id: "w7", clave: "W7", nombre: "Web 7", semestre: 7, horasSemana: 4, especialidadId: "web" },
    { id: "n7", clave: "N7", nombre: "Negocios 7", semestre: 7, horasSemana: 4, especialidadId: "negocios" },
    { id: "p8", clave: "P8", nombre: "Par 8", semestre: 8, horasSemana: 4, especialidadId: null }
];

test("las líneas sugeridas abren un grupo por especialidad donde las hay", () => {
    const lineas = lineasSugeridas(RETICULA, ESPECIALIDADES, "impares");
    assert.deepEqual(
        lineas.map((l) => [l.semestre, l.especialidadId]),
        [
            [1, null],
            [7, "web"],
            [7, "negocios"]
        ]
    );
    // El semestre 8 es par: no aparece en este periodo.
    assert.equal(lineas.some((l) => l.semestre === 8), false);
});

test("un grupo de especialidad cursa su módulo y el tronco común, nunca otro módulo", () => {
    const grupos = construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "impares");
    const web = grupos.find((g) => g.especialidadId === "web");
    const negocios = grupos.find((g) => g.especialidadId === "negocios");

    assert.deepEqual(web.materias.sort(), ["t7", "w7"]);
    assert.deepEqual(negocios.materias.sort(), ["n7", "t7"]);
    // Esta es la regla que se estaba incumpliendo: nadie cursa el módulo ajeno.
    assert.equal(web.materias.includes("n7"), false);
    assert.equal(negocios.materias.includes("w7"), false);
});

test("las letras se reparten por semestre, no por especialidad", () => {
    const grupos = construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "impares");
    const del7 = grupos.filter((g) => g.semestre === 7).map((g) => g.clave);
    assert.deepEqual(del7, ["7A", "7B"]);
});

test("los grupos solo cubren los semestres de la paridad elegida", () => {
    const impares = construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "impares");
    const pares = construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "pares");
    assert.deepEqual([...new Set(impares.map((g) => g.semestre))], [1, 7]);
    assert.deepEqual([...new Set(pares.map((g) => g.semestre))], [8]);
});

test("una línea sin grupos en ningún turno no abre nada", () => {
    const grupos = construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "impares", {
        grupos: [
            { semestre: 7, especialidadId: "web", porTurno: { vespertino: 2 } },
            { semestre: 7, especialidadId: "negocios", porTurno: { vespertino: 0 } }
        ]
    });
    assert.deepEqual(grupos.map((g) => g.clave), ["7A", "7B"]);
    assert.equal(grupos.every((g) => g.especialidadId === "web"), true);
});

test("un mismo semestre puede abrir grupos en los dos turnos", () => {
    const grupos = construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "impares", {
        grupos: [{ semestre: 1, especialidadId: null, porTurno: { matutino: 2, vespertino: 1 } }]
    });
    assert.deepEqual(
        grupos.map((g) => [g.clave, g.turno]),
        [
            ["1A", "matutino"],
            ["1B", "matutino"],
            ["1C", "vespertino"]
        ]
    );
});

test("las letras siguen el orden de la rejilla, no el del objeto recibido", () => {
    // vespertino primero en el objeto: las letras deben salir igual.
    const grupos = construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "impares", {
        grupos: [{ semestre: 1, especialidadId: null, porTurno: { vespertino: 1, matutino: 1 } }]
    });
    assert.deepEqual(
        grupos.map((g) => [g.clave, g.turno]),
        [
            ["1A", "matutino"],
            ["1B", "vespertino"]
        ]
    );
});

test("una especialidad o un turno inexistentes se rechazan", () => {
    const conLineas = (grupos) => () =>
        construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "impares", { grupos });

    assert.throws(
        conLineas([{ semestre: 7, especialidadId: "fantasma", porTurno: { matutino: 1 } }]),
        /fantasma/
    );
    assert.throws(
        conLineas([{ semestre: 1, especialidadId: null, porTurno: { nocturno: 1 } }]),
        /nocturno/
    );
});

test("el bloque diario nunca pasa de tres horas", () => {
    assert.equal(construirRejilla(SEMESTRES).duracionMaximaBloque, 3);
    // Pedir más se recorta: es el tope del reglamento, no una preferencia.
    assert.equal(construirRejilla(SEMESTRES, { duracionMaximaBloque: 5 }).duracionMaximaBloque, 3);
    assert.equal(construirRejilla(SEMESTRES, { duracionMaximaBloque: 1 }).duracionMaximaBloque, 1);
    assert.equal(
        construirRejilla(SEMESTRES, {
            rejilla: { dias: ["lunes"], turnos: [{ id: "matutino", horaInicio: 7, horaFin: 14 }], duracionMaximaBloque: 9 }
        }).duracionMaximaBloque,
        3
    );
});

test("una materia que no cabe en la semana bloquea", () => {
    // 18 h con tope de 3 son 6 bloques, y sólo hay 5 días hábiles.
    const materias = RETICULA.map((m) => (m.id === "m1" ? { ...m, horasSemana: 18 } : m));
    const r = validarParaHorario(escenario({ datos: { materias } }));
    const bloqueo = r.bloqueos.find((b) => b.codigo === "materia-no-cabe-en-la-semana");
    assert.ok(bloqueo, JSON.stringify(r.bloqueos));
    assert.ok(bloqueo.detalle[0].includes("6 días"));

    // 15 h son exactamente 5 bloques de tres: cabe, aunque apretado.
    const justas = RETICULA.map((m) => (m.id === "m1" ? { ...m, horasSemana: 15 } : m));
    const ok = validarParaHorario(escenario({ datos: { materias: justas } }));
    assert.equal(ok.bloqueos.some((b) => b.codigo === "materia-no-cabe-en-la-semana"), false);
});

// ---------------------------------------------------------------- aulas por grupo

const AULAS_TRES = [
    { id: "a1", clave: "V-1", tipo: "aula" },
    { id: "a2", clave: "V-2", tipo: "aula" },
    { id: "lab", clave: "N-1", tipo: "laboratorio" }
];

test("cada grupo recibe su propia aula dentro de su turno", () => {
    const grupos = asignarAulasBase(
        construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "impares", {
            grupos: [{ semestre: 1, especialidadId: null, porTurno: { matutino: 2 } }]
        }),
        AULAS_TRES
    );
    assert.deepEqual(grupos.map((g) => g.aulaClave), ["V-1", "V-2"]);
});

test("un aula se reutiliza entre turnos distintos", () => {
    const grupos = asignarAulasBase(
        construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "impares", {
            grupos: [{ semestre: 1, especialidadId: null, porTurno: { matutino: 2, vespertino: 2 } }]
        }),
        AULAS_TRES
    );
    // Los turnos no se solapan, así que V-1 y V-2 sirven para los cuatro.
    assert.deepEqual(
        grupos.map((g) => [g.turno, g.aulaClave]),
        [
            ["matutino", "V-1"],
            ["matutino", "V-2"],
            ["vespertino", "V-1"],
            ["vespertino", "V-2"]
        ]
    );
});

test("un aula la comparten dos grupos si entre los dos caben en el turno", () => {
    // La regla del plantel: los alumnos no se mueven de su salón, pero si un
    // grupo termina a media mañana, otro entra a esa hora. Tres grupos de 8 h
    // en dos aulas de 35 ranuras caben de sobra.
    const grupos = asignarAulasBase(
        construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "impares", {
            grupos: [{ semestre: 1, especialidadId: null, porTurno: { matutino: 3 } }]
        }),
        AULAS_TRES,
        [],
        REJILLA
    );
    assert.deepEqual(grupos.map((g) => g.aulaClave), ["V-1", "V-2", "V-1"]);
    // Primero los salones libres y solo después se comparte: nadie mete dos
    // grupos en un aula habiendo una vacía.
    assert.equal(grupos[1].aulaClave, "V-2");
    // Y el laboratorio nunca es aula base de nadie.
    assert.ok(!grupos.some((g) => g.aulaClave === "N-1"));
});

test("cuando las horas no caben, el grupo se queda sin aula y se bloquea", () => {
    // Grupos de 20 h en un turno de 35 ranuras: dos llenan el aula y el tercero
    // ya no cabe en ninguna de las dos.
    const pesadas = RETICULA.map((m) => ({ ...m, horasSemana: 10 }));
    const grupos = asignarAulasBase(
        construirGrupos(pesadas, ESPECIALIDADES, REJILLA, "impares", {
            grupos: [{ semestre: 1, especialidadId: null, porTurno: { matutino: 3 } }]
        }),
        AULAS_TRES,
        [],
        REJILLA
    );
    assert.deepEqual(grupos.map((g) => g.aulaClave), ["V-1", "V-2", null]);

    const r = validarParaHorario(escenario({ grupos, aulas: AULAS_TRES }));
    const bloqueo = r.bloqueos.find((b) => b.codigo === "faltan-aulas");
    assert.ok(bloqueo, JSON.stringify(r.bloqueos));
    assert.equal(bloqueo.seccion, "aulas");
    assert.ok(bloqueo.detalle[0].includes("matutino"));
});

test("no caber por cupo y no caber por horas se dicen distinto", () => {
    // Las dos causas mandan a sitios distintos: una pide salones más grandes y
    // la otra, más salones. Decir "faltan aulas" cuando lo que falta es cupo
    // manda a buscar lo que no arreglaría nada.
    const chicas = AULAS_TRES.map((a) => ({ ...a, capacidad: 20 }));
    const grandes = construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "impares", {
        grupos: [{ semestre: 1, especialidadId: null, porTurno: { matutino: 1 }, alumnos: 45 }]
    });
    const porCupo = validarParaHorario(
        escenario({ grupos: asignarAulasBase(grandes, chicas, [], REJILLA), aulas: chicas })
    );
    const cupo = porCupo.bloqueos.find((b) => b.codigo === "aulas-sin-cupo");
    assert.ok(cupo, JSON.stringify(porCupo.bloqueos.map((b) => b.codigo)));
    assert.match(cupo.mensaje, /no caben en ningún salón/);
    assert.match(cupo.detalle[0], /45 alumnos/);

    // Y con cupo de sobra pero sin horas libres, el otro mensaje.
    const pesadas = RETICULA.map((m) => ({ ...m, horasSemana: 10 }));
    const muchos = construirGrupos(pesadas, ESPECIALIDADES, REJILLA, "impares", {
        grupos: [{ semestre: 1, especialidadId: null, porTurno: { matutino: 3 } }]
    });
    const porHoras = validarParaHorario(
        escenario({ grupos: asignarAulasBase(muchos, AULAS_TRES, [], REJILLA), aulas: AULAS_TRES })
    );
    const horas = porHoras.bloqueos.find((b) => b.codigo === "faltan-aulas");
    assert.ok(horas, JSON.stringify(porHoras.bloqueos.map((b) => b.codigo)));
    assert.match(horas.mensaje, /horas libres suficientes/);
    assert.match(horas.detalle[0], /horas-aula/);
});

test("las horas que otra carrera ya tiene en un aula descuentan de su presupuesto", () => {
    // Antes bastaba con que otra carrera tuviera **una** hora para descartar el
    // aula entera; con trece carreras eso agotaba los salones enseguida.
    const ajenas = [{ aulaId: "a1", dia: "lunes", inicio: 7, fin: 12, carrera: "OTRA" }];
    const grupos = asignarAulasBase(
        construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "impares", {
            grupos: [{ semestre: 1, especialidadId: null, porTurno: { matutino: 1 } }]
        }),
        AULAS_TRES,
        ajenas,
        REJILLA
    );
    // V-1 queda ocupada por la otra carrera, así que el grupo va a V-2: se
    // prefiere una libre. Pero V-1 no está descartada, solo más llena.
    assert.equal(grupos[0].aulaClave, "V-2");
});

// ---------------------------------------------------------------- validación

const DOCENTES_OK = [
    {
        id: "d1",
        nombre: "Docente uno",
        horasMax: 40,
        materiasCapacitadas: ["m1", "m2", "t7", "w7", "n7"]
    },
    { id: "d2", nombre: "Docente dos", horasMax: 40, materiasCapacitadas: ["m1", "t7"] }
];

/** Aulas de sobra: los casos que prueban escasez las pasan explícitamente. */
const AULAS_SUFICIENTES = [
    { id: "a1", clave: "V-1", tipo: "aula" },
    { id: "a2", clave: "V-2", tipo: "aula" },
    { id: "a3", clave: "V-3", tipo: "aula" },
    { id: "a4", clave: "V-4", tipo: "aula" }
];

function escenario(cambios = {}) {
    return {
        datos: {
            materias: RETICULA,
            docentes: DOCENTES_OK,
            semestres: SEMESTRES,
            especialidades: ESPECIALIDADES,
            ...cambios.datos
        },
        aulas: cambios.aulas ?? AULAS_SUFICIENTES,
        rejilla: REJILLA,
        paridad: cambios.paridad ?? "impares",
        grupos: asignarAulasBase(
            cambios.grupos ??
                construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, cambios.paridad ?? "impares"),
            cambios.aulas ?? AULAS_SUFICIENTES
        )
    };
}

test("un escenario completo pasa la validación", () => {
    const r = validarParaHorario(escenario());
    assert.equal(r.listo, true, JSON.stringify(r.bloqueos));
    assert.deepEqual(r.bloqueos, []);
    assert.deepEqual(r.resumen.semestres, [1, 7]);
});

test("una materia sin docente bloquea la generación", () => {
    const r = validarParaHorario(
        escenario({ datos: { docentes: [{ id: "d1", horasMax: 40, materiasCapacitadas: ["m1"] }] } })
    );
    assert.equal(r.listo, false);
    const bloqueo = r.bloqueos.find((b) => b.codigo === "materias-sin-docente");
    assert.ok(bloqueo);
    assert.equal(bloqueo.seccion, "materias");
    // El detalle nombra exactamente cuáles, para poder ir a arreglarlas.
    assert.ok(bloqueo.detalle.some((d) => d.includes("M2")));
});

test("solo se exige cobertura de los semestres que se imparten", () => {
    // "p8" no tiene docente, pero es de octavo: en impares no debe bloquear.
    const sinP8 = validarParaHorario(escenario({ paridad: "impares" }));
    assert.equal(sinP8.listo, true);

    const conP8 = validarParaHorario(escenario({ paridad: "pares" }));
    assert.equal(conP8.listo, false);
    assert.ok(conP8.bloqueos.some((b) => b.codigo === "materias-sin-docente"));
});

test("sin aulas, sin docentes o sin grupos no se genera", () => {
    assert.ok(
        validarParaHorario(escenario({ aulas: [] })).bloqueos.some((b) => b.codigo === "sin-aulas")
    );
    assert.ok(
        validarParaHorario(escenario({ datos: { docentes: [] } })).bloqueos.some(
            (b) => b.codigo === "sin-docentes"
        )
    );
    assert.ok(
        validarParaHorario(escenario({ grupos: [] })).bloqueos.some((b) => b.codigo === "sin-grupos")
    );
});

test("una materia de laboratorio sin laboratorios registrados bloquea", () => {
    const materias = RETICULA.map((m) => (m.id === "m1" ? { ...m, requiereLaboratorio: true } : m));
    const r = validarParaHorario(escenario({ datos: { materias } }));
    assert.ok(r.bloqueos.some((b) => b.codigo === "sin-laboratorios"));

    const conLab = validarParaHorario(
        escenario({ datos: { materias }, aulas: [{ id: "l1", tipo: "laboratorio" }] })
    );
    assert.equal(conLab.bloqueos.some((b) => b.codigo === "sin-laboratorios"), false);
});

test("un grupo que no cabe en su turno bloquea", () => {
    const pesada = RETICULA.map((m) => (m.semestre === 1 ? { ...m, horasSemana: 30 } : m));
    const grupos = construirGrupos(pesada, ESPECIALIDADES, REJILLA, "impares");
    const r = validarParaHorario(escenario({ datos: { materias: pesada }, grupos }));
    const bloqueo = r.bloqueos.find((b) => b.codigo === "grupo-no-cabe");
    assert.ok(bloqueo, JSON.stringify(r.bloqueos));
    assert.ok(bloqueo.detalle[0].includes("1A"));
});

test("una carga mayor que la capacidad docente bloquea", () => {
    const flacos = DOCENTES_OK.map((d) => ({ ...d, horasMax: 2 }));
    const r = validarParaHorario(escenario({ datos: { docentes: flacos } }));
    assert.ok(r.bloqueos.some((b) => b.codigo === "capacidad-docente"));
});

test("una especialidad sin grupos avisa pero no bloquea", () => {
    const grupos = construirGrupos(RETICULA, ESPECIALIDADES, REJILLA, "impares", {
        grupos: [
            { semestre: 1, especialidadId: null, porTurno: { matutino: 1 } },
            { semestre: 7, especialidadId: "web", porTurno: { vespertino: 1 } }
        ]
    });
    const r = validarParaHorario(escenario({ grupos }));
    assert.equal(r.listo, true);
    const aviso = r.advertencias.find((a) => a.codigo === "materias-sin-grupo");
    assert.ok(aviso);
    assert.ok(aviso.detalle.some((d) => d.includes("N7")));
});

// ---------------------------------------------------------------- saturación

const DOCENTE_HOJA = {
    id: "d1",
    nombre: "Docente uno",
    disponibilidad: {
        declarada: [{ dia: "lunes", inicio: 7, fin: 12 }],
        evitar: [{ dia: "lunes", inicio: 11, fin: 12 }]
    },
    descargas: [{ dia: "lunes", inicio: 7, fin: 8, motivo: "Jefatura" }]
};

const REJILLA_HOJA = {
    dias: ["lunes", "martes"],
    turnos: [{ id: "matutino", horaInicio: 7, horaFin: 12 }]
};

test("la hoja marca cada hora con su estado", () => {
    const hoja = armarHoja(
        DOCENTE_HOJA,
        [
            {
                docenteId: "d1",
                dia: "lunes",
                inicio: 9,
                fin: 11,
                carrera: "ITIC",
                escenarioId: "x",
                grupoClave: "3A",
                materiaClave: "SCD-1021"
            }
        ],
        REJILLA_HOJA
    );

    const lunes = hoja.dias[0].horas.map((c) => c.estado);
    // 7 descarga · 8 libre · 9 y 10 ocupadas por ITIC · 11 libre pero evitada
    assert.deepEqual(lunes, ["descarga", "libre", "ocupada", "ocupada", "libre"]);
    assert.equal(hoja.dias[0].horas[2].carrera, "ITIC");
    assert.equal(hoja.dias[0].horas[2].grupo, "3A");
    assert.equal(hoja.dias[0].horas[4].evitada, true);

    // El martes no lo declaró: nada que repartir ahí.
    assert.equal(hoja.dias[1].horas.every((c) => c.estado === "no_declarada"), true);
});

test("el resumen de la hoja cuenta lo que queda libre", () => {
    const hoja = armarHoja(DOCENTE_HOJA, [], REJILLA_HOJA);
    assert.equal(hoja.resumen.declaradas, 5);
    assert.equal(hoja.resumen.descarga, 1);
    assert.equal(hoja.resumen.libres, 4);
    assert.equal(hoja.resumen.ocupadas, 0);
});

test("las descargas se descuentan de lo disponible; lo ajeno no", () => {
    const rejilla = construirRejilla(SEMESTRES);
    const docente = {
        id: "d1",
        disponibilidad: { declarada: [{ dia: "lunes", inicio: 7, fin: 14 }] },
        descargas: [{ dia: "lunes", inicio: 9, fin: 11 }]
    };

    // La descarga parte la franja: esa hora no existe para nadie.
    assert.deepEqual(horasDisponibles(docente, rejilla), [
        { dia: "lunes", inicio: 7, fin: 9 },
        { dia: "lunes", inicio: 11, fin: 14 }
    ]);
});

test("lo que otra carrera pretende viaja aparte, como disputa", () => {
    const rejilla = construirRejilla(SEMESTRES);
    const docente = {
        id: "d1",
        disponibilidad: { declarada: [{ dia: "lunes", inicio: 7, fin: 14 }] },
        descargas: []
    };

    // No se resta de lo disponible: todos trabajan en borrador y nadie bloquea.
    // Restarlo convertiría un desacuerdo en un horario imposible.
    assert.deepEqual(horasDisponibles(docente, rejilla), [{ dia: "lunes", inicio: 7, fin: 14 }]);

    const disputa = horasEnDisputa(docente, rejilla, [
        { docenteId: "d1", dia: "lunes", inicio: 9, fin: 11 },
        // De otro docente: no es asunto suyo.
        { docenteId: "d2", dia: "lunes", inicio: 12, fin: 14 }
    ]);
    assert.deepEqual(disputa, [{ dia: "lunes", inicio: 9, fin: 11 }]);
});

// ---------------------------------------------------------------- problema

test("el problema solo lleva las materias del periodo que algún grupo cursa", () => {
    const problema = construirProblema({
        datos: {
            materias: RETICULA,
            docentes: DOCENTES_OK,
            semestres: SEMESTRES,
            especialidades: ESPECIALIDADES
        },
        aulas: [{ id: "a1", tipo: "aula" }],
        opciones: { paridad: "impares" }
    });

    assert.equal(problema.paridad, "impares");
    assert.deepEqual(
        problema.materias.map((m) => m.id).sort(),
        ["m1", "m2", "n7", "t7", "w7"]
    );
    assert.equal(problema.materias.some((m) => m.id === "p8"), false);
    assert.equal(problema.materias.every((m) => typeof m.requiereLaboratorio === "boolean"), true);
});

test("requiereLaboratorio se toma del escenario o de la petición", () => {
    const base = {
        datos: {
            materias: RETICULA,
            docentes: DOCENTES_OK,
            semestres: SEMESTRES,
            especialidades: ESPECIALIDADES
        },
        aulas: [{ id: "a1", tipo: "aula" }]
    };

    const pedido = construirProblema({ ...base, opciones: { materiasLaboratorio: ["m1"] } });
    assert.equal(pedido.materias.find((m) => m.id === "m1").requiereLaboratorio, true);
    assert.equal(pedido.materias.find((m) => m.id === "m2").requiereLaboratorio, false);
});

// ---------------------------------------------------------------- reglamento

test("el tope de materias sale del reglamento, no de una suposición", () => {
    // Artículo 155 y 156: "en ningún caso se les asignarán más de tres materias
    // diferentes". Es el mismo para asignatura y para carrera.
    assert.equal(tecnm.MAX_MATERIAS, 3);
    const avisos = tecnm.revisar({
        categoria: "Titular", dedicacion: "tiempo completo", horasMax: 22, maxMaterias: 4
    });
    assert.equal(avisos.length, 1);
    assert.equal(avisos[0].codigo, "materias-sobre-reglamento");
    assert.equal(avisos[0].articulo, "156");
});

test("las horas frente a grupo se comparan con las de su categoría", () => {
    // Artículo 143. Y no al revés de lo que parece: el titular da menos clase
    // que el asistente, porque su tiempo restante va a las otras funciones.
    assert.equal(tecnm.horasDeReglamento("Titular", "tiempo completo"), 22);
    assert.equal(tecnm.horasDeReglamento("Asistente", "tiempo completo"), 26);
    assert.equal(tecnm.horasDeReglamento("Asociado", "medio tiempo"), 12);
    assert.equal(tecnm.horasDeReglamento("Asignatura", "tiempo completo"), null);
});

test("el ajuste de dos horas del artículo 147 no se marca", () => {
    const dentro = { categoria: "Titular", dedicacion: "tiempo completo", maxMaterias: 3 };
    // 22 ± 2 pasa; 25 ya no.
    assert.deepEqual(tecnm.revisar({ ...dentro, horasMax: 24 }), []);
    assert.deepEqual(tecnm.revisar({ ...dentro, horasMax: 20 }), []);
    assert.equal(tecnm.revisar({ ...dentro, horasMax: 25 })[0]?.codigo, "horas-fuera-de-reglamento");
});

test("un nombramiento de asignatura se mide por su rango, no por una tabla", () => {
    // Artículo 155: entre 1 y 19 horas.
    const base = { categoria: "Asignatura", dedicacion: "asignatura", maxMaterias: 3 };
    assert.deepEqual(tecnm.revisar({ ...base, horasMax: 19 }), []);
    assert.equal(tecnm.revisar({ ...base, horasMax: 20 })[0]?.codigo, "asignatura-fuera-de-rango");
});

test("sin dedicación no se inventa un número: se pide el dato", () => {
    const avisos = tecnm.revisar({ categoria: "Titular", horasMax: 30, maxMaterias: 3 });
    assert.equal(avisos[0]?.codigo, "sin-dedicacion");
});

test("la jornada del sistema es la del artículo 157", () => {
    // Las actividades docentes diarias van de las 7 a las 22, de lunes a viernes.
    assert.equal(tecnm.JORNADA.horaInicio, 7);
    assert.equal(tecnm.JORNADA.horaFin, 22);
    const rejilla = construirRejilla([{ turnos: ["matutino", "vespertino"] }], {});
    assert.equal(rejilla.dias.length, tecnm.JORNADA.dias);
    assert.equal(Math.min(...rejilla.turnos.map((t) => t.horaInicio)), tecnm.JORNADA.horaInicio);
    assert.equal(Math.max(...rejilla.turnos.map((t) => t.horaFin)), tecnm.JORNADA.horaFin);
});

// ---------------------------------------------------------------- fusiones

const GRUPOS_FUSION = [
    { id: "g7a", clave: "7A", turno: "vespertino", alumnos: 30, materias: ["tronco", "web"] },
    { id: "g7b", clave: "7B", turno: "vespertino", alumnos: 25, materias: ["tronco", "nego"] },
    { id: "g1a", clave: "1A", turno: "matutino", alumnos: 40, materias: ["tronco"] }
];
const MATERIAS_FUSION = [
    { id: "tronco", clave: "ACA-0909", nombre: "Taller de Investigación", semestre: 7, horasSemana: 4 },
    { id: "web", clave: "SCD-1", nombre: "Web", semestre: 7, horasSemana: 5 },
    { id: "nego", clave: "SCD-2", nombre: "Negocios", semestre: 7, horasSemana: 5 }
];

test("solo es candidata la materia que dos grupos cursan en el mismo turno", () => {
    const cs = candidatas(MATERIAS_FUSION, GRUPOS_FUSION);

    assert.equal(cs.length, 1, "1A la cursa, pero de mañana: no puede recibir la misma clase");
    assert.equal(cs[0].materiaId, "tronco");
    assert.deepEqual(cs[0].grupos.map((g) => g.clave), ["7A", "7B"]);
    assert.equal(cs[0].alumnos, 55, "la suma decide si caben en el aula");
    assert.equal(cs[0].horasAhorradas, 4, "cuatro horas impartidas una vez en lugar de dos");
});

test("se avisa cuando fusionar dejaría fuera una asignación del departamento", () => {
    // Una fusión es una clase y la imparte una sola persona: la del grupo
    // principal. Si el departamento puso a alguien distinto en cada grupo, la
    // decisión del otro se pierde, y eso se dice antes de marcar la casilla.
    const con = (a, b) => [
        { ...GRUPOS_FUSION[0], asignaciones: { tronco: a } },
        { ...GRUPOS_FUSION[1], asignaciones: { tronco: b } }
    ];
    assert.equal(candidatas(MATERIAS_FUSION, con("d1", "d2"))[0].docentesDistintos, true);
    assert.equal(candidatas(MATERIAS_FUSION, con("d1", "d1"))[0].docentesDistintos, false);
    // Sin repartir todavía no hay nada que perder.
    assert.equal(candidatas(MATERIAS_FUSION, GRUPOS_FUSION)[0].docentesDistintos, false);
});

test("una materia que cursa un solo grupo no se propone", () => {
    const cs = candidatas(MATERIAS_FUSION, [GRUPOS_FUSION[0]]);
    assert.deepEqual(cs, []);
});

test("tres grupos juntos ahorran el doble que dos", () => {
    const tres = [...GRUPOS_FUSION.slice(0, 2), { ...GRUPOS_FUSION[2], turno: "vespertino" }];
    const cs = candidatas(MATERIAS_FUSION, tres);
    assert.equal(cs[0].horasAhorradas, 8);
});

test("las candidatas salen por lo que ahorran", () => {
    const dos = [
        { id: "a", clave: "A", turno: "m", materias: ["tronco", "web"] },
        { id: "b", clave: "B", turno: "m", materias: ["tronco", "web"] }
    ];
    assert.deepEqual(
        candidatas(MATERIAS_FUSION, dos).map((f) => f.materiaId),
        ["web", "tronco"],
        "web son 5 h y tronco 4"
    );
});

test("una fusión que nombra un grupo inexistente se descarta sin tumbar el horario", () => {
    const { validas, descartadas } = depurar(
        [{ materiaId: "tronco", grupos: ["g7a", "fantasma"] }],
        GRUPOS_FUSION
    );
    assert.deepEqual(validas, []);
    assert.equal(descartadas[0].motivo, "ya no hay dos grupos que cursen esa materia");
});

test("una fusión entre turnos distintos se descarta y dice por qué", () => {
    const { validas, descartadas } = depurar(
        [{ materiaId: "tronco", grupos: ["g7a", "g1a"] }],
        GRUPOS_FUSION
    );
    assert.deepEqual(validas, []);
    assert.equal(descartadas[0].motivo, "los grupos quedaron en turnos distintos");
});

test("un grupo que dejó de cursar la materia sale de la fusión", () => {
    const sinTronco = GRUPOS_FUSION.map((g) =>
        g.id === "g7b" ? { ...g, materias: ["nego"] } : g
    );
    const { validas, descartadas } = depurar(
        [{ materiaId: "tronco", grupos: ["g7a", "g7b"] }],
        sinTronco
    );
    assert.deepEqual(validas, []);
    assert.equal(descartadas.length, 1);
});

test("una fusión válida pasa con sus grupos", () => {
    const { validas, descartadas } = depurar(
        [{ materiaId: "tronco", grupos: ["g7a", "g7b"] }],
        GRUPOS_FUSION
    );
    assert.deepEqual(validas, [{ materiaId: "tronco", grupos: ["g7a", "g7b"] }]);
    assert.deepEqual(descartadas, []);
});

// -------------------------------------------------- horario multi-carrera

const PARTES = [
    {
        carrera: "ISIC",
        datos: {
            materias: [
                { id: "comun", clave: "ACF-0901", nombre: "Cálculo", semestre: 1, horasSemana: 5 },
                { id: "propia", clave: "SCD-1", nombre: "Redes", semestre: 1, horasSemana: 4 }
            ],
            especialidades: [{ id: "web", nombre: "Desarrollo Web" }]
        },
        grupos: [
            { id: "g-1a", clave: "1A", semestre: 1, turno: "matutino", especialidadId: "web",
              materias: ["comun", "propia"] }
        ]
    },
    {
        carrera: "ITIC",
        datos: {
            materias: [{ id: "comun", clave: "ACF-0901", nombre: "Cálculo", semestre: 1, horasSemana: 5 }],
            especialidades: [{ id: "web", nombre: "Desarrollo Web" }]
        },
        grupos: [{ id: "g-1a", clave: "1A", semestre: 1, turno: "matutino", especialidadId: "web",
                   materias: ["comun"] }]
    }
];

test("los grupos de dos carreras se distinguen aunque compartan id", () => {
    // ISIC e ITIC generan las dos un `g-1a`: sin prefijo se pisarían y la
    // fusión no tendría forma de nombrar al grupo de la otra.
    const u = unir(PARTES);
    assert.deepEqual(u.grupos.map((g) => g.id), ["ISIC:g-1a", "ITIC:g-1a"]);
    assert.equal(carreraDe("ITIC:g-1a"), "ITIC");

    // La clave se queda limpia y de quién es lo dice `carrera`: meterlo también
    // en el texto producía "ITIC · 1A ITIC" en la hoja, que ya trae su columna.
    assert.deepEqual(u.grupos.map((g) => g.clave), ["1A", "1A"]);
    assert.deepEqual(u.grupos.map((g) => g.carrera), ["ISIC", "ITIC"]);
});

test("una materia compartida se une en una sola; las propias sobreviven", () => {
    const u = unir(PARTES);
    assert.deepEqual(u.materias.map((m) => m.id).sort(), ["comun", "propia"]);
});

test("dos especialidades homónimas de carreras distintas no se confunden", () => {
    const u = unir(PARTES);
    assert.deepEqual(u.especialidades.map((e) => e.id), ["ISIC:web", "ITIC:web"]);
    assert.deepEqual(u.especialidades.map((e) => e.nombre), ["Desarrollo Web (ISIC)", "Desarrollo Web (ITIC)"]);
    assert.equal(u.grupos[0].especialidadId, "ISIC:web");
});

test("una materia con distintas horas en cada carrera se rechaza y dice cuál", () => {
    // No puede ser una sola clase, y es un dato que hay que corregir, no algo
    // que el motor deba adivinar.
    const torcidas = structuredClone(PARTES);
    torcidas[1].datos.materias[0].horasSemana = 3;
    assert.throws(() => unir(torcidas), /ACF-0901.*5 h en ISIC.*3 h en ITIC/s);
});

test("con una sola carrera la especialidad no lleva sufijo", () => {
    const u = unir([PARTES[0]]);
    assert.equal(u.especialidades[0].nombre, "Desarrollo Web");
    assert.equal(u.grupos[0].id, "ISIC:g-1a", "el prefijo del id sí, siempre");
});

test("solo es candidata entre carreras la materia que las dos cursan", () => {
    const u = unir(PARTES);
    const cs = candidatasEntreCarreras(u.materias, u.grupos);

    assert.equal(cs.length, 1);
    assert.equal(cs[0].materiaId, "comun");
    assert.deepEqual(cs[0].carreras, ["ISIC", "ITIC"]);
    assert.equal(cs[0].horasAhorradas, 5, "la clase se imparte una vez en lugar de dos");
});

test("dos grupos de la MISMA carrera no salen como fusión entre carreras", () => {
    const mismas = [PARTES[0], { ...PARTES[0], grupos: [{ ...PARTES[0].grupos[0], id: "g-1b", clave: "1B" }] }];
    assert.deepEqual(candidatasEntreCarreras(unir(mismas).materias, unir(mismas).grupos), []);
});

test("las sesiones se reparten por la carrera de su grupo principal", () => {
    // Una fusionada es UNA hora catedrático: el docente entra una vez, y se le
    // carga a la carrera del aula donde se imparte.
    const reparto = repartirPorCarrera([
        { grupoId: "ISIC:g-1a" },
        { grupoId: "ISIC:g-3a" },
        { grupoId: "ITIC:g-1a", fusionada: true }
    ]);
    assert.deepEqual([...reparto.keys()].sort(), ["ISIC", "ITIC"]);
    assert.equal(reparto.get("ISIC").length, 2);
    assert.equal(reparto.get("ITIC").length, 1);
});

test("un horario de una sola carrera no prefija: sus sesiones son de la propia", () => {
    // Sin el respaldo, `repartirPorCarrera` las descartaba y apartar devolvía
    // cero reservadas tras haber borrado las anteriores.
    const reparto = repartirPorCarrera([{ grupoId: "g-1a" }, { grupoId: "g-3a" }], "ISIC");

    assert.deepEqual([...reparto.keys()], ["ISIC"]);
    assert.equal(reparto.get("ISIC").length, 2);
});

test("el prefijo manda sobre la carrera por omisión", () => {
    const reparto = repartirPorCarrera([{ grupoId: "ITIC:g-1a" }, { grupoId: "g-3a" }], "ISIC");
    assert.equal(reparto.get("ITIC").length, 1);
    assert.equal(reparto.get("ISIC").length, 1);
});
