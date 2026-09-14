#!/usr/bin/env node
/**
 * Pruebas de decisiones: de una sola hasta varias que se contradicen.
 *
 * `verificar.js` comprueba que cada cosa funcione y `simular.js` cuenta cómo se
 * usan juntas. Falta un tercer eje, que es donde de verdad se rompen los
 * sistemas de coordinación: **qué pasa cuando dos decisiones legítimas no caben
 * a la vez**. El departamento asigna a alguien que no da esa materia; el mismo
 * docente queda con más horas de las que tiene; dos carreras lo quieren a la
 * misma hora; el coordinador fusiona dos grupos que el departamento repartió
 * entre dos personas; y edita a mano lo que el departamento decidió.
 *
 *   node herramientas/decisiones.js [http://localhost:8080]
 *
 * Sube por niveles: una decisión, varias del mismo actor, decisiones que se
 * contradicen, y dos coordinaciones más el departamento. Cada nivel supone el
 * anterior.
 *
 * Monta su propio plantel mínimo —dos carreras `DD*`, dos cuentas `dd-*` y tres
 * docentes de prueba— porque forzar una contradicción exige control sobre la
 * disponibilidad y la autorización. Restaura la plantilla docente al terminar,
 * pase lo que pase.
 */

import { CLAVES_CONOCIDAS, cliente as clienteHttp, entrar as acceder } from "./acceso.js";

const BASE = (process.argv[2] ?? "http://localhost:8080").replace(/\/$/, "");
const API = `${BASE}/api`;
const CLAVES_DEPTO = [process.env.CLAVE_DEPTO, ...CLAVES_CONOCIDAS].filter(Boolean);

let ok = 0;
const fallos = [];
let nivelActual = "";

function comprobar(caso, condicion, detalle = "") {
    if (condicion) {
        ok++;
        console.log(`  ok   ${caso}`);
    } else {
        fallos.push(`${nivelActual}: ${caso}`);
        console.log(`  FALLA ${caso}${detalle ? `  -> ${String(detalle).slice(0, 150)}` : ""}`);
    }
}

/** Lo que se observa pero no se juzga: comportamiento que conviene dejar escrito. */
function anotar(texto) {
    console.log(`  ·    ${texto}`);
}

function nivel(n, titulo) {
    nivelActual = `Nivel ${n}`;
    console.log(`\n${"═".repeat(62)}\n NIVEL ${n} — ${titulo}\n${"═".repeat(62)}`);
}

const paso = (t) => console.log(`\n-- ${t} ${"-".repeat(Math.max(0, 56 - t.length))}`);

const cliente = () => clienteHttp(API);
const depto = cliente();

/** El cuerpo cuando es una lista. Un 403 devuelve `{error}`, que no se recorre. */
const lista = (r) => (Array.isArray(r?.cuerpo) ? r.cuerpo : []);

const DURAS = new Set([
    "docenteNoCapacitado", "choqueDocente", "choqueGrupo", "choqueAula", "aulaInadecuada",
    "fueraDeAulaBase", "aulaInsuficiente", "aulaOcupadaPorOtros", "materiaRepetidaDia",
    "horaNoDisponible", "excesoMaterias", "excesoGrupos", "horasSobreMaximo"
]);
const durasDe = (d) => Object.entries(d ?? {}).filter(([k, v]) => v > 0 && DURAS.has(k));

/** Quién imparte cada clase en un horario, como `grupo|materia -> [docentes]`. */
function quienImparte(sesiones) {
    const porClase = new Map();
    for (const s of sesiones ?? []) {
        for (const grupo of s.grupoClaves ?? []) {
            const clave = `${grupo}|${s.materiaId}`;
            if (!porClase.has(clave)) porClase.set(clave, new Set());
            porClase.get(clave).add(s.docenteId);
        }
    }
    return porClase;
}

const partidas = (sesiones) =>
    [...quienImparte(sesiones)].filter(([, q]) => q.size > 1).map(([c]) => c);

// ---------------------------------------------------------------- los datos

/**
 * Tres materias cortas y un solo semestre: el motor tarda segundos y cada
 * contradicción se puede provocar a mano sin que el ruido la tape.
 */
const MATERIAS = [
    { id: "dd_m1", clave: "DD-001", nombre: "Materia Uno", semestre: 1, horasSemana: 4 },
    { id: "dd_m2", clave: "DD-002", nombre: "Materia Dos", semestre: 1, horasSemana: 4 },
    { id: "dd_m3", clave: "DD-003", nombre: "Materia Tres", semestre: 1, horasSemana: 2 }
];

const SEMANA = ["lunes", "martes", "miércoles", "jueves", "viernes"];
const todaLaSemana = (inicio, fin) => SEMANA.map((dia) => ({ dia, inicio, fin }));

/**
 * Tres docentes con diferencias a propósito:
 * - Ana puede con todo y tiene la semana entera.
 * - Beto puede con dos y tiene la semana entera: sirve para repartir.
 * - Caro solo puede con una y **solo tiene dos horas el lunes**: asignarle una
 *   materia de cuatro es una decisión legítima del departamento que el motor no
 *   puede cumplir, y ese choque es lo que se quiere ver.
 */
const DOCENTES = [
    {
        id: "dd-ana", nombre: "Ana de Prueba", categoria: "Titular",
        horasMin: 0, horasMax: 40, maxMaterias: 9, maxGrupos: 9,
        materiasCapacitadas: ["dd_m1", "dd_m2", "dd_m3"],
        disponibilidad: { declarada: todaLaSemana(7, 14), evitar: [] }, descargas: []
    },
    {
        id: "dd-beto", nombre: "Beto de Prueba", categoria: "Titular",
        horasMin: 0, horasMax: 40, maxMaterias: 9, maxGrupos: 9,
        materiasCapacitadas: ["dd_m1", "dd_m2"],
        disponibilidad: { declarada: todaLaSemana(7, 14), evitar: [] }, descargas: []
    },
    {
        id: "dd-caro", nombre: "Caro de Prueba", categoria: "Asignatura",
        horasMin: 0, horasMax: 6, maxMaterias: 2, maxGrupos: 2,
        materiasCapacitadas: ["dd_m1"],
        disponibilidad: { declarada: [{ dia: "lunes", inicio: 7, fin: 9 }], evitar: [] }, descargas: []
    }
];

const PARAMETROS = { generaciones: 250, islas: 2, semilla: 9, busquedaLocal: 20 };

/** Dos grupos matutinos en primero: el mínimo para que repartir signifique algo. */
const LINEAS = [{ semestre: 1, especialidadId: null, porTurno: { matutino: 2 }, alumnos: 25 }];

let plantillaOriginal = null;

async function entrar(usuario) {
    const s = await acceder(API, usuario, { extras: ["schedulai"] });
    return s ? { ...s, estado: 200 } : { c: cliente(), perfil: null, estado: 401 };
}

async function asignar(carrera, materiaId, grupoClave, docenteId) {
    return depto("/plantel/asignaciones", {
        metodo: "PUT", cuerpo: { carrera, materiaId, grupoClave, docenteId }
    });
}

async function generar(cli, carrera, escenarioId, extra = {}) {
    return cli(`/carreras/${carrera}/escenarios/${escenarioId}/horario`, {
        metodo: "POST",
        cuerpo: { paridad: "impares", grupos: LINEAS, parametros: PARAMETROS, ...extra }
    });
}

const nombresDe = (ids) =>
    [...ids].map((id) => DOCENTES.find((d) => d.id === id)?.nombre?.split(" ")[0] ?? id).sort();

// ------------------------------------------------------------------ montaje

async function montar() {
    paso("Montaje");
    for (const clave of CLAVES_DEPTO) {
        const r = await depto("/sesion", { metodo: "POST", cuerpo: { usuario: "depto", clave } });
        if (r.estado === 200) {
            if (r.cuerpo.debeCambiarClave) {
                await depto("/sesion/clave", {
                    metodo: "POST", cuerpo: { actual: clave, nueva: "decisiones2026" }
                });
                await depto("/sesion", {
                    metodo: "POST", cuerpo: { usuario: "depto", clave: "decisiones2026" }
                });
            }
            break;
        }
    }
    comprobar("entra el departamento", (await depto("/sesion")).cuerpo?.rol === "departamento");

    await limpiar();

    for (const [codigo, nombre] of [["DD1", "Decisiones uno"], ["DD2", "Decisiones dos"]]) {
        await depto("/plantel/carreras", { metodo: "POST", cuerpo: { codigo, nombre } });
    }

    for (const [usuario, nombre, carreras] of [
        ["dd-uno", "Coord DD1", ["DD1"]],
        ["dd-dos", "Coord DD2", ["DD2"]]
    ]) {
        const previo = lista(await depto("/usuarios")).find((u) => u.usuario === usuario);
        // El desmontaje de la pasada anterior las retira; reactivarlas es darles
        // una contraseña, como haría el departamento.
        if (previo?.activo === false) {
            await depto(`/usuarios/${previo.id}/clave`, { metodo: "POST", cuerpo: { nueva: "schedulai" } });
        }
        if (previo) await depto(`/usuarios/${previo.id}/carreras`, { metodo: "PUT", cuerpo: { carreras } });
        else await depto("/usuarios", { metodo: "POST", cuerpo: { nombre, usuario, clave: "schedulai", carreras } });
    }

    // La plantilla es del instituto: se le añaden los tres de prueba y se
    // devuelve tal cual estaba al terminar.
    // Sin el filtro, una pasada anterior interrumpida deja los `dd-*` dentro de
    // lo que se considera "original" y el desmontaje los devolvería a la
    // plantilla del instituto.
    plantillaOriginal = lista(await depto("/docentes")).filter(
        (d) => !d.id.startsWith("dd-")
    );
    const conPrueba = [...plantillaOriginal, ...DOCENTES];
    comprobar("se añaden los tres docentes de prueba",
        (await depto("/docentes", { metodo: "PUT", cuerpo: conPrueba })).estado === 200);

    const uno = await entrar("dd-uno");
    const dos = await entrar("dd-dos");
    comprobar("entran las dos coordinaciones", uno.estado === 200 && dos.estado === 200);

    const escenarios = {};
    for (const [cli, carrera] of [[uno.c, "DD1"], [dos.c, "DD2"]]) {
        await cli(`/carreras/${carrera}/escenarios`, {
            metodo: "POST", cuerpo: { nombre: "Base", esBase: true }
        });
        const id = (await cli(`/carreras/${carrera}/escenarios`)).cuerpo[0].id;
        await cli(`/carreras/${carrera}/escenarios/${id}`, {
            metodo: "PUT",
            cuerpo: {
                materias: MATERIAS,
                especialidades: [],
                semestres: [{
                    id: `s-${carrera}`, periodo: "Agosto-Diciembre 2026", semanas: 16,
                    turnos: ["matutino"], estado: "activo"
                }]
            }
        });
        // Los grupos configurados: el departamento reparte contra ellos.
        await cli(`/carreras/${carrera}/escenarios/${id}/config`, {
            metodo: "PUT", cuerpo: { paridad: "impares", lineas: LINEAS, fusiones: [], invitadas: [] }
        });
        escenarios[carrera] = id;
    }
    return { uno, dos, escenarios };
}

async function limpiar() {
    for (const [usuario, carrera] of [["dd-uno", "DD1"], ["dd-dos", "DD2"]]) {
        const suyo = await entrar(usuario);
        if (suyo.estado !== 200) continue;
        for (const e of lista(await suyo.c(`/carreras/${carrera}/escenarios`))) {
            await suyo.c(`/carreras/${carrera}/escenarios/${e.id}/reserva`, { metodo: "DELETE" });
        }
    }
    for (const u of ["dd-uno", "dd-dos"]) {
        const fila = lista(await depto("/usuarios")).find((x) => x.usuario === u);
        if (fila) await depto(`/usuarios/${fila.id}`, { metodo: "DELETE" });
    }
    for (const codigo of ["DD1", "DD2"]) {
        await depto(`/plantel/carreras/${codigo}`, { metodo: "DELETE" });
    }
}

async function desmontar() {
    paso("Desmontaje");
    await limpiar();
    if (plantillaOriginal) {
        const r = await depto("/docentes", { metodo: "PUT", cuerpo: plantillaOriginal });
        comprobar("la plantilla del instituto queda como estaba",
            r.estado === 200 &&
            lista(await depto("/docentes")).every((d) => !d.id.startsWith("dd-")));
    }
    const quedan = lista(await depto("/plantel/carreras")).filter((c) => c.codigo.startsWith("DD"));
    comprobar("no quedan carreras de prueba", quedan.length === 0, JSON.stringify(quedan));
}

// =========================================================== nivel 1

/** Una decisión suelta: el departamento pone a alguien y eso se ve. */
async function nivelUno({ uno, escenarios }) {
    nivel(1, "una decisión");
    const E = escenarios.DD1;

    paso("El catálogo antes de repartir");
    const vacio = (await depto("/plantel/catalogo/DD1")).cuerpo;
    comprobar("hay una fila por materia y grupo, no por materia",
        vacio.filas.length === 6, `${vacio?.filas?.length} filas`);
    comprobar("los dos grupos configurados salen",
        [...new Set(vacio.filas.map((f) => f.grupoClave))].sort().join(",") === "1A,1B");
    comprobar("todas empiezan sin nadie", vacio.filas.every((f) => !f.docenteId));

    paso("Asignar una clase");
    const r = await asignar("DD1", "dd_m1", "1A", "dd-ana");
    comprobar("la asignación responde con quién quedó", r.cuerpo?.docenteId === "dd-ana");
    const tras = (await depto("/plantel/catalogo/DD1")).cuerpo.filas
        .find((f) => f.materiaId === "dd_m1" && f.grupoClave === "1A");
    comprobar("y el catálogo la devuelve con nombre", tras.docenteNombre === "Ana de Prueba");
    comprobar("solo cambió esa clase",
        (await depto("/plantel/catalogo/DD1")).cuerpo.filas.filter((f) => f.docenteId).length === 1);

    paso("El motor la respeta");
    const g = await generar(uno.c, "DD1", E);
    comprobar("el horario sale", g.estado === 200, JSON.stringify(g.cuerpo).slice(0, 120));
    const quien = quienImparte(g.cuerpo?.sesiones);
    comprobar("la clase asignada la da quien el departamento dijo",
        [...(quien.get("1A|dd_m1") ?? [])].join() === "dd-ana",
        nombresDe(quien.get("1A|dd_m1") ?? []).join());
    comprobar("sin restricciones duras", durasDe(g.cuerpo?.diagnostico).length === 0,
        JSON.stringify(durasDe(g.cuerpo?.diagnostico)));

    paso("Lo que nadie asignó");
    comprobar("el motor elige para las demás",
        [...quien].filter(([c]) => c !== "1A|dd_m1").every(([, q]) => q.size === 1));
    comprobar("y ninguna clase queda partida entre dos personas",
        partidas(g.cuerpo?.sesiones).length === 0, partidas(g.cuerpo?.sesiones).join());

    await asignar("DD1", "dd_m1", "1A", null);
    comprobar("dejarla sin asignar es un estado legítimo",
        !(await depto("/plantel/catalogo/DD1")).cuerpo.filas.some((f) => f.docenteId));
}

// =========================================================== nivel 2

/** Varias decisiones del mismo actor, que conviven sin contradecirse. */
async function nivelDos({ uno, dos, escenarios }) {
    nivel(2, "varias decisiones del mismo actor");

    paso("La misma persona en los dos grupos");
    await asignar("DD1", "dd_m1", "1A", "dd-ana");
    await asignar("DD1", "dd_m1", "1B", "dd-ana");
    let g = await generar(uno.c, "DD1", escenarios.DD1);
    let quien = quienImparte(g.cuerpo?.sesiones);
    comprobar("Ana da la materia en 1A y en 1B",
        [...(quien.get("1A|dd_m1") ?? [])].join() === "dd-ana" &&
        [...(quien.get("1B|dd_m1") ?? [])].join() === "dd-ana");
    comprobar("y sus dos clases no se pisan", durasDe(g.cuerpo?.diagnostico).length === 0,
        JSON.stringify(durasDe(g.cuerpo?.diagnostico)));

    paso("Una persona distinta en cada grupo");
    await asignar("DD1", "dd_m1", "1B", "dd-beto");
    g = await generar(uno.c, "DD1", escenarios.DD1);
    quien = quienImparte(g.cuerpo?.sesiones);
    comprobar("cada grupo con la suya",
        [...(quien.get("1A|dd_m1") ?? [])].join() === "dd-ana" &&
        [...(quien.get("1B|dd_m1") ?? [])].join() === "dd-beto",
        `1A=${nombresDe(quien.get("1A|dd_m1") ?? [])} 1B=${nombresDe(quien.get("1B|dd_m1") ?? [])}`);

    paso("La carga acumulada");
    const carga = (await depto("/plantel/carga")).cuerpo ?? [];
    const ana = carga.find((c) => c.docenteId === "dd-ana");
    comprobar("suma las horas de las clases de Ana", ana?.horas === 4, JSON.stringify(ana));
    comprobar("y dice en qué carrera están", ana?.carreras?.join() === "DD1");

    paso("La misma persona en dos carreras");
    await asignar("DD2", "dd_m1", "1A", "dd-ana");
    const conDos = ((await depto("/plantel/carga")).cuerpo ?? []).find((c) => c.docenteId === "dd-ana");
    comprobar("las dos decisiones son independientes y la carga las junta",
        conDos.horas === 8 && conDos.clases === 2, JSON.stringify(conDos));
    comprobar("y nombra las dos carreras", conDos.carreras.sort().join() === "DD1,DD2");

    const soloDD2 = (await depto("/plantel/catalogo/DD2")).cuerpo.filas
        .filter((f) => f.docenteId).length;
    comprobar("asignarla en DD2 no tocó el reparto de DD1", soloDD2 === 1 &&
        (await depto("/plantel/catalogo/DD1")).cuerpo.filas.filter((f) => f.docenteId).length === 2);

    paso("Pasarse de lo que alguien puede");
    // Caro tiene un tope de 6 h y solo puede con `dd_m1`: dos clases de cuatro
    // la dejan en ocho.
    await asignar("DD1", "dd_m1", "1A", "dd-caro");
    await asignar("DD2", "dd_m1", "1A", "dd-caro");
    const caro = ((await depto("/plantel/carga")).cuerpo ?? []).find((c) => c.docenteId === "dd-caro");
    comprobar("la carga marca a quien se pasó de horas",
        caro?.sobreHoras === true && caro.horas === 8, JSON.stringify(caro));
    comprobar("el departamento puede hacerlo: se avisa, no se impide", caro.clases === 2);

    await asignar("DD2", "dd_m1", "1A", null);
    await asignar("DD1", "dd_m1", "1A", "dd-ana");
}

// =========================================================== nivel 3

/** Decisiones legítimas que no caben a la vez. Aquí es donde se decide algo. */
async function nivelTres({ uno, escenarios }) {
    nivel(3, "decisiones que se contradicen");
    const E = escenarios.DD1;

    paso("Asignar a quien no está autorizado");
    // El departamento decide las dos cosas —quién puede y quién imparte— así
    // que esto es una incoherencia suya, no un permiso que falte. Se deja
    // hacer, y el motor la nombra en vez de callarla.
    comprobar("se permite: el departamento manda sobre su propio registro",
        (await asignar("DD1", "dd_m2", "1A", "dd-caro")).cuerpo?.docenteId === "dd-caro");
    let g = await generar(uno.c, "DD1", E);
    let duras = Object.fromEntries(durasDe(g.cuerpo?.diagnostico));
    comprobar("el horario lo marca como no capacitado",
        (duras.docenteNoCapacitado ?? 0) > 0, JSON.stringify(duras));
    comprobar("y el horario no es factible", g.cuerpo?.factible === false);
    comprobar("aun así respeta la decisión: la clase es de Caro",
        [...(quienImparte(g.cuerpo?.sesiones).get("1A|dd_m2") ?? [])].join() === "dd-caro");
    await asignar("DD1", "dd_m2", "1A", null);

    paso("Asignar a quien no tiene horas");
    // Caro declaró dos horas el lunes. Una materia de cuatro no cabe, por mucho
    // que el motor la mueva: la contradicción es entre lo que el departamento
    // decidió y lo que el docente declaró.
    await asignar("DD1", "dd_m1", "1A", "dd-caro");
    g = await generar(uno.c, "DD1", E);
    duras = Object.fromEntries(durasDe(g.cuerpo?.diagnostico));
    comprobar("el motor lo reporta como horas no disponibles",
        (duras.horaNoDisponible ?? 0) > 0, JSON.stringify(duras));
    comprobar("y dice que no es factible", g.cuerpo?.factible === false);
    const suyas = (g.cuerpo?.sesiones ?? []).filter((s) => s.docenteId === "dd-caro");
    comprobar("no inventa otro docente para salir del paso", suyas.length > 0);
    anotar(`Caro queda con ${suyas.length} bloques y ${duras.horaNoDisponible} horas imposibles: ` +
        "el aviso es para ir a cambiar la asignación o la disponibilidad.");
    await asignar("DD1", "dd_m1", "1A", "dd-ana");

    paso("La misma persona en todo");
    // Tres materias de los dos grupos a una sola persona: 20 h de clase que
    // además no pueden solaparse entre sí. Cabe —la semana tiene 35 ranuras— y
    // que quepa es el resultado que importa: el motor tiene que ordenarlo, no
    // rendirse.
    for (const m of ["dd_m1", "dd_m2", "dd_m3"]) {
        for (const grupo of ["1A", "1B"]) await asignar("DD1", m, grupo, "dd-ana");
    }
    g = await generar(uno.c, "DD1", E);
    duras = Object.fromEntries(durasDe(g.cuerpo?.diagnostico));
    comprobar("todo el horario es de Ana",
        [...quienImparte(g.cuerpo?.sesiones).values()].every((q) => [...q].join() === "dd-ana"));
    comprobar("y el motor la cuadra sin que choque consigo misma",
        (duras.choqueDocente ?? 0) === 0, JSON.stringify(duras));
    comprobar("las veinte horas de los dos grupos salen enteras",
        (g.cuerpo?.sesiones ?? []).reduce((n, x) => n + (x.horaFin - x.horaInicio), 0) === 20,
        `${(g.cuerpo?.sesiones ?? []).reduce((n, x) => n + (x.horaFin - x.horaInicio), 0)} h`);

    paso("Más horas de las que esa persona tiene contratadas");
    // El mismo reparto, con el contrato de Ana bajado a doce horas: la decisión
    // del departamento choca ahora con un límite del propio departamento.
    const conTope = (horas) => [
        ...plantillaOriginal,
        ...DOCENTES.map((d) => (d.id === "dd-ana" ? { ...d, horasMax: horas } : d))
    ];
    await depto("/docentes", { metodo: "PUT", cuerpo: conTope(12) });
    g = await generar(uno.c, "DD1", E);
    duras = Object.fromEntries(durasDe(g.cuerpo?.diagnostico));
    comprobar("el motor lo reporta como horas sobre el máximo",
        (duras.horasSobreMaximo ?? 0) > 0, JSON.stringify(duras));
    comprobar("y el horario no es factible", g.cuerpo?.factible === false);
    anotar("Veinte horas repartidas a quien tiene doce: el motor no reparte de menos ni " +
        "cambia de docente, entrega el horario y dice por dónde no cuadra.");
    await depto("/docentes", { metodo: "PUT", cuerpo: conTope(40) });

    paso("Fusionar lo que se repartió entre dos");
    await asignar("DD1", "dd_m1", "1A", "dd-ana");
    await asignar("DD1", "dd_m1", "1B", "dd-beto");
    for (const m of ["dd_m2", "dd_m3"]) {
        for (const grupo of ["1A", "1B"]) await asignar("DD1", m, grupo, null);
    }
    const val = await uno.c(`/carreras/DD1/escenarios/${E}/horario/validacion`, {
        metodo: "POST", cuerpo: { paridad: "impares", grupos: LINEAS }
    });
    const candidata = (val.cuerpo?.fusionesPosibles ?? []).find((f) => f.materiaId === "dd_m1");
    comprobar("la fusión de esa materia se propone", Boolean(candidata));
    comprobar("y avisa de que los grupos tienen docentes distintos",
        candidata?.docentesDistintos === true, JSON.stringify(candidata));

    const otra = (val.cuerpo?.fusionesPosibles ?? []).find((f) => f.materiaId === "dd_m2");
    comprobar("una materia que nadie repartió no lleva ese aviso",
        otra?.docentesDistintos === false);

    const fusionada = await generar(uno.c, "DD1", E, {
        fusiones: [{ materiaId: "dd_m1", grupos: candidata.grupos.map((x) => x.id) }]
    });
    const juntos = quienImparte(fusionada.cuerpo?.sesiones);
    const quienQuedo = [...new Set([...(juntos.get("1A|dd_m1") ?? []), ...(juntos.get("1B|dd_m1") ?? [])])];
    comprobar("fusionada, la clase la imparte una sola persona", quienQuedo.length === 1,
        nombresDe(quienQuedo).join());
    anotar(`Manda la del grupo principal (${nombresDe(quienQuedo).join()}): ` +
        "la otra decisión del departamento se pierde, y por eso se avisa antes de marcar la casilla.");

    paso("El coordinador edita a mano lo que el departamento decidió");
    const base = await generar(uno.c, "DD1", E);
    const sesiones = base.cuerpo?.sesiones ?? [];
    const deAna = sesiones.find((s) => s.materiaId === "dd_m1" && (s.grupoClaves ?? []).includes("1A"));
    comprobar("de partida, esa clase es de quien el departamento puso",
        deAna?.docenteId === "dd-ana", deAna?.docenteId);

    const cambiadas = sesiones.map((s) => (s.indice === deAna.indice ? { ...s, docenteId: "dd-beto" } : s));
    const ajuste = await uno.c(`/carreras/DD1/escenarios/${E}/horario/ajuste`, {
        metodo: "POST",
        cuerpo: { paridad: "impares", grupos: LINEAS, sesiones: cambiadas, parametros: PARAMETROS }
    });
    comprobar("cambiar de docente una clase asignada se rechaza",
        ajuste.estado >= 400, `${ajuste.estado} ${JSON.stringify(ajuste.cuerpo).slice(0, 110)}`);
    comprobar("y el motivo nombra al departamento",
        /departamento/i.test(JSON.stringify(ajuste.cuerpo ?? "")),
        JSON.stringify(ajuste.cuerpo).slice(0, 130));

    paso("Y partir una clase a mano entre dos personas");
    const bloques = sesiones.filter((s) => s.materiaId === "dd_m2" && (s.grupoClaves ?? []).includes("1A"));
    if (bloques.length > 1) {
        const partida = sesiones.map((s) =>
            s.indice === bloques[0].indice ? { ...s, docenteId: "dd-ana" }
            : s.indice === bloques[1].indice ? { ...s, docenteId: "dd-beto" } : s);
        const r = await uno.c(`/carreras/DD1/escenarios/${E}/horario/ajuste`, {
            metodo: "POST",
            cuerpo: { paridad: "impares", grupos: LINEAS, sesiones: partida, parametros: PARAMETROS }
        });
        comprobar("dar el martes a otra persona se rechaza",
            r.estado >= 400, `${r.estado} ${JSON.stringify(r.cuerpo).slice(0, 110)}`);
    } else {
        anotar("esa materia cabe en un bloque: no hay martes que dar a otro");
    }

    paso("Mover la hora sí es cosa del coordinador");
    const movible = sesiones.find((s) => s.horaInicio < 12);
    const movidas = sesiones.map((s) =>
        s.indice === movible.indice ? { ...s, dia: s.dia === "viernes" ? "jueves" : "viernes" } : s);
    const mover = await uno.c(`/carreras/DD1/escenarios/${E}/horario/ajuste`, {
        metodo: "POST",
        cuerpo: { paridad: "impares", grupos: LINEAS, sesiones: movidas, parametros: PARAMETROS }
    });
    comprobar("cambiar el día de una clase se acepta", mover.estado === 200,
        JSON.stringify(mover.cuerpo).slice(0, 110));
    comprobar("y vuelve con el mismo docente que puso el departamento",
        (mover.cuerpo?.sesiones ?? []).find((s) => s.indice === deAna.indice)?.docenteId === "dd-ana");
}

// =========================================================== nivel 4

/** Dos coordinaciones y el departamento sobre la misma persona. */
async function nivelCuatro({ uno, dos, escenarios }) {
    nivel(4, "dos coordinaciones y el departamento");

    paso("Las dos carreras con la misma persona");
    // Ana entera en DD1 y en DD2: diez horas por carrera y una sola semana.
    for (const carrera of ["DD1", "DD2"]) {
        for (const m of ["dd_m1", "dd_m2", "dd_m3"]) {
            for (const grupo of ["1A", "1B"]) await asignar(carrera, m, grupo, null);
        }
    }
    for (const m of ["dd_m1", "dd_m2"]) {
        await asignar("DD1", m, "1A", "dd-ana");
        await asignar("DD2", m, "1A", "dd-ana");
    }
    const carga = ((await depto("/plantel/carga")).cuerpo ?? []).find((c) => c.docenteId === "dd-ana");
    comprobar("la carga la ve venir antes de que nadie genere",
        carga.horas === 16 && carga.carreras.length === 2, JSON.stringify(carga));

    paso("La primera aparta");
    const g1 = await generar(uno.c, "DD1", escenarios.DD1);
    const res1 = await uno.c(`/carreras/DD1/escenarios/${escenarios.DD1}/reserva`, {
        metodo: "PUT",
        cuerpo: { paridad: "impares", sesiones: g1.cuerpo.sesiones, horario: g1.cuerpo }
    });
    comprobar("DD1 aparta sus horas", res1.cuerpo?.reservadas === g1.cuerpo.sesiones.length,
        JSON.stringify(res1.cuerpo));

    paso("La segunda se encuentra con lo apartado");
    const val2 = await dos.c(`/carreras/DD2/escenarios/${escenarios.DD2}/horario/validacion`, {
        metodo: "POST", cuerpo: { paridad: "impares", grupos: LINEAS }
    });
    const aviso = (val2.cuerpo?.advertencias ?? []).find((x) => x.codigo === "horas-comprometidas");
    comprobar("DD2 ve que otra carrera ya pretende horas de sus docentes", Boolean(aviso),
        JSON.stringify(val2.cuerpo?.advertencias));
    const sinAsignar = (val2.cuerpo?.advertencias ?? []).find((x) => x.codigo === "clases-sin-asignar");
    comprobar("y cuántas de sus clases decidirá el motor y no el departamento",
        Boolean(sinAsignar), JSON.stringify(sinAsignar ?? null));

    const g2 = await generar(dos.c, "DD2", escenarios.DD2);
    comprobar("DD2 genera igual: nadie queda bloqueado por el otro", g2.estado === 200);
    const disputa = g2.cuerpo?.diagnostico?.horaEnDisputa ?? 0;
    comprobar("las horas que se pisan salen como disputa, no como imposibles",
        durasDe(g2.cuerpo?.diagnostico).every(([k]) => k !== "horaNoDisponible"),
        JSON.stringify(durasDe(g2.cuerpo?.diagnostico)));
    anotar(`Horas en disputa para DD2: ${disputa}. No cuentan para la factibilidad porque ` +
        "se pueden pedir: el horario se aplica si la otra coordinación cede.");

    await dos.c(`/carreras/DD2/escenarios/${escenarios.DD2}/reserva`, {
        metodo: "PUT",
        cuerpo: { paridad: "impares", sesiones: g2.cuerpo.sesiones, horario: g2.cuerpo }
    });

    paso("Pedir y ceder");
    const conf = await dos.c(`/carreras/DD2/escenarios/${escenarios.DD2}/conflictos`, {
        metodo: "POST", cuerpo: { paridad: "impares" }
    });
    let choque = (conf.cuerpo?.conflictos ?? []).find((c) => !c.propio);

    // Si el motor no chocó es que hizo su trabajo: prefiere las horas libres.
    // Para probar la conciliación hay que provocarlo, igual que en la
    // verificación — sin esto el nivel pasaba unas veces y otras no, que es
    // peor que no tenerlo.
    if (!choque) {
        const deDD1 = (await uno.c(`/carreras/DD1/escenarios/${escenarios.DD1}/reserva`))
            .cuerpo?.horario?.sesiones ?? [];
        if (deDD1.length > 0) {
            await dos.c(`/carreras/DD2/escenarios/${escenarios.DD2}/reserva`, {
                metodo: "PUT",
                cuerpo: {
                    paridad: "impares",
                    sesiones: [{ ...deDD1[0], grupoClave: "forzado" }],
                    horario: { ...g2.cuerpo, sesiones: [{ ...deDD1[0], grupoClave: "forzado" }] }
                }
            });
            const otra = await dos.c(`/carreras/DD2/escenarios/${escenarios.DD2}/conflictos`, {
                metodo: "POST", cuerpo: { paridad: "impares" }
            });
            choque = (otra.cuerpo?.conflictos ?? []).find((c) => !c.propio);
            anotar("El motor no chocó por su cuenta —prefiere horas libres— así que se " +
                "provoca apartando a propósito una hora que DD1 ya tenía.");
        }
    }
    comprobar("el choque entre las dos coordinaciones se detecta y no es propio",
        Boolean(choque), JSON.stringify(conf.cuerpo?.conflictos ?? []).slice(0, 140));

    if (choque) {
        const contra = choque.contra[0];
        const sol = await dos.c("/solicitudes", {
            metodo: "POST",
            cuerpo: {
                de: { carrera: "DD2", escenarioId: escenarios.DD2 },
                a: { carrera: contra.carrera, escenarioId: contra.escenarioId },
                docenteId: choque.docenteId, dia: choque.dia,
                inicio: choque.inicio, fin: choque.fin, motivo: "prueba de decisiones"
            }
        });
        comprobar("DD2 pide la hora", sol.estado === 201, JSON.stringify(sol.cuerpo).slice(0, 100));

        const bandeja = (await uno.c("/solicitudes")).cuerpo?.recibidas ?? [];
        comprobar("le llega a DD1, que es quien la tiene", bandeja.some((s) => s.id === sol.cuerpo.id));

        // Cuántas horas de Ana tiene apartadas DD1 antes y después: "ceder" que
        // no libera nada sería un gesto, y el conflicto seguiría ahí.
        const horasDeDD1 = async () => {
            const r = await depto("/saturacion", { metodo: "POST", cuerpo: { paridad: "impares" } });
            const suya = (r.cuerpo?.hojas ?? []).find((h) => h.docenteId === choque.docenteId);
            return (suya?.dias ?? []).reduce(
                (n, d) => n + d.horas.filter((c) => c.estado === "ocupada" && c.carrera === "DD1").length,
                0
            );
        };
        const antes = await horasDeDD1();

        comprobar("rechazar no es lo mismo que ceder: hace falta decir que sí",
            (await uno.c(`/solicitudes/${sol.cuerpo.id}/responder`, {
                metodo: "POST", cuerpo: { respuesta: "lo siento" }
            })).cuerpo?.estado === "rechazada");

        const otraSol = await dos.c("/solicitudes", {
            metodo: "POST",
            cuerpo: {
                de: { carrera: "DD2", escenarioId: escenarios.DD2 },
                a: { carrera: contra.carrera, escenarioId: contra.escenarioId },
                docenteId: choque.docenteId, dia: choque.dia,
                inicio: choque.inicio, fin: choque.fin, motivo: "segunda"
            }
        });
        const ceder = await uno.c(`/solicitudes/${otraSol.cuerpo.id}/responder`, {
            metodo: "POST", cuerpo: { acepta: true, respuesta: "toda tuya" }
        });
        comprobar("DD1 cede", ceder.cuerpo?.estado === "aceptada", JSON.stringify(ceder.cuerpo).slice(0, 110));

        const despues = await horasDeDD1();
        comprobar("ceder libera horas de verdad, no solo responde",
            despues < antes, `${antes} h -> ${despues} h`);
        anotar("La clase cedida sigue dibujada en el horario guardado de DD1 y el panel la " +
            "nombra como perdida: es el aviso de que hay que volver a generar.");

        const otra = await dos.c(`/carreras/DD2/escenarios/${escenarios.DD2}/conflictos`, {
            metodo: "POST", cuerpo: { paridad: "impares" }
        });
        const sigue = (otra.cuerpo?.conflictos ?? []).some(
            (c) => c.docenteId === choque.docenteId && c.dia === choque.dia && c.inicio === choque.inicio
        );
        comprobar("el choque que se cedió desaparece", !sigue,
            `cedido ${choque.dia} ${choque.inicio}-${choque.fin}; quedan ` +
            (otra.cuerpo?.conflictos ?? []).map((c) => `${c.dia} ${c.inicio}-${c.fin}`).join(", "));
        anotar(`Ceder resuelve una hora, no la pelea: quedan ${(otra.cuerpo?.conflictos ?? []).length} ` +
            "choques porque Ana está asignada a las dos carreras en dos materias.");
    }

    paso("El reparto no depende de quién programe");
    comprobar("DD1 conserva su reparto tras toda la negociación",
        (await depto("/plantel/catalogo/DD1")).cuerpo.filas.filter((f) => f.docenteId).length === 2);
    comprobar("y DD2 el suyo, que es otro",
        (await depto("/plantel/catalogo/DD2")).cuerpo.filas.filter((f) => f.docenteId).length === 2);

    paso("Con el periodo cerrado");
    await depto("/periodos/impares/cerrar", { metodo: "POST" });
    const tarde = await uno.c(`/carreras/DD1/escenarios/${escenarios.DD1}/reserva`, { metodo: "DELETE" });
    comprobar("ya no se sueltan horas", tarde.estado === 409, `${tarde.estado}`);
    comprobar("pero el departamento sigue pudiendo repartir el siguiente periodo",
        (await asignar("DD1", "dd_m3", "1A", "dd-beto")).estado === 200);
    anotar("Cerrar el periodo congela las horas, no las decisiones: quién imparte qué se " +
        "sigue administrando, porque es lo que se hereda al abrir el siguiente.");
    await depto("/periodos/impares/cerrar", { metodo: "DELETE" });
}

// ------------------------------------------------------------------ arranque

async function principal() {
    console.log(`\nPruebas de decisiones contra ${BASE}`);
    let montaje = null;
    try {
        montaje = await montar();
        await nivelUno(montaje);
        await nivelDos(montaje);
        await nivelTres(montaje);
        await nivelCuatro(montaje);
    } catch (e) {
        fallos.push(`excepción: ${e.message}`);
        console.error(`\n  ERROR ${e.stack}`);
    } finally {
        nivelActual = "Desmontaje";
        try {
            await desmontar();
        } catch (e) {
            console.error(`  ERROR al desmontar: ${e.message}`);
        }
    }

    console.log(`\n${"=".repeat(62)}`);
    console.log(`${ok} correctas, ${fallos.length} fallidas`);
    if (fallos.length) {
        console.log("\nFallaron:");
        for (const f of fallos) console.log(`  - ${f}`);
    }
    process.exit(fallos.length ? 1 : 0);
}

principal();
