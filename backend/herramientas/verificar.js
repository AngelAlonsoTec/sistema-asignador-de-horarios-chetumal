#!/usr/bin/env node
/**
 * Verificación de aceptación: los casos que la aplicación tiene que cumplir.
 *
 * No sustituye a las pruebas unitarias —esas comprueban piezas sueltas— sino a
 * la revisión manual: recorre los caminos completos contra un despliegue
 * **vivo**, con HTTP real, sesiones reales y la base de verdad. Es lo que hay
 * que correr antes de decir que el sistema sirve.
 *
 *   node herramientas/verificar.js [http://localhost:8080]
 *
 * Entra como `depto`. Si esa cuenta ya no tiene la contraseña de arranque, se le
 * pasa la suya por entorno: `CLAVE_DEPTO=... node herramientas/verificar.js`.
 *
 * Trabaja sobre carreras y cuentas propias (`ZZ*`, `zz-*`) y las cierra al
 * terminar, así que no ensucia los datos del plantel. Lo único ajeno que toca es
 * el periodo, que cierra y vuelve a abrir.
 *
 * Dos residuos, a propósito: las cuentas `zz-*` quedan retiradas en vez de
 * borradas —el historial de saturación apunta a quién hizo cada cosa— y sus
 * movimientos siguen en ese historial, que es un apéndice y no se toca. La
 * siguiente pasada reutiliza las cuentas.
 */

import { CLAVES_CONOCIDAS, cliente as clienteHttp, entrar as acceder } from "./acceso.js";

const BASE = (process.argv[2] ?? "http://localhost:8080").replace(/\/$/, "");
const API = `${BASE}/api`;

const CLAVES_DEPTO = [process.env.CLAVE_DEPTO, ...CLAVES_CONOCIDAS].filter(Boolean);

let ok = 0;
const fallos = [];

function comprobar(caso, condicion, detalle = "") {
    if (condicion) {
        ok++;
        console.log(`  ok   ${caso}`);
    } else {
        fallos.push(caso);
        console.log(`  FALLA ${caso}${detalle ? `  -> ${String(detalle).slice(0, 120)}` : ""}`);
    }
}

const titulo = (t) => console.log(`\n-- ${t} ${"-".repeat(Math.max(0, 56 - t.length))}`);

/** Cliente con su propia cookie: cada actor es una sesión distinta. */
const cliente = () => clienteHttp(API);

const DURAS = new Set([
    "docenteNoCapacitado", "choqueDocente", "choqueGrupo", "choqueAula", "aulaInadecuada",
    "fueraDeAulaBase", "aulaInsuficiente", "aulaOcupadaPorOtros", "materiaRepetidaDia",
    "horaNoDisponible", "excesoMaterias", "excesoGrupos", "horasSobreMaximo",
    "horasDiaSobreMaximo"
]);
const durasDe = (d) => Object.entries(d ?? {}).filter(([k, v]) => v > 0 && DURAS.has(k));

/**
 * Clases repartidas entre varios docentes. Cinco horas se programan en tres
 * bloques, pero son una clase y la imparte una persona: si dos bloques de la
 * misma materia y grupo traen docentes distintos, el horario no es aplicable.
 */
function partidas(sesiones) {
    const porClase = new Map();
    for (const s of sesiones) {
        for (const grupo of s.grupoClaves ?? []) {
            const clave = `${grupo}|${s.materiaId}`;
            if (!porClase.has(clave)) porClase.set(clave, new Set());
            porClase.get(clave).add(s.docenteId);
        }
    }
    return [...porClase].filter(([, quienes]) => quienes.size > 1).map(([clave]) => clave);
}

/** Tronco común real del plantel: lo que de verdad comparten las carreras. */
const TRONCO = [
    { id: "aca_0907", clave: "ACA-0907", nombre: "Taller de Ética", semestre: 1, horasSemana: 4 },
    { id: "acc_0906", clave: "ACC-0906", nombre: "Fundamentos de Investigación", semestre: 1, horasSemana: 4 }
];

async function entrar(usuario, clave = "schedulai") {
    const sesion = await acceder(API, usuario, { extras: [clave] });
    // `estado` para que las comprobaciones sigan leyéndose como una respuesta.
    return sesion
        ? { ...sesion, estado: 200 }
        : { c: cliente(), perfil: null, estado: 401 };
}

/**
 * Alta o reasignación. Retirar una cuenta no la borra —el historial apunta a
 * quién hizo cada cosa— así que una segunda pasada se encuentra las de la
 * primera y tiene que reutilizarlas en vez de fallar.
 */
async function asegurarCoordinador(usuario, nombre, carreras) {
    const previo = (await depto("/usuarios")).cuerpo?.find?.((u) => u.usuario === usuario);
    if (!previo) {
        return await depto("/usuarios", {
            metodo: "POST", cuerpo: { nombre, usuario, clave: "schedulai", carreras }
        });
    }
    // Puede venir retirada de una corrida anterior: reactivarla es darle una
    // contraseña, que es justo lo que haría el departamento.
    if (previo.activo === false) {
        await depto(`/usuarios/${previo.id}/clave`, { metodo: "POST", cuerpo: { nueva: "schedulai" } });
    }
    const r = await depto(`/usuarios/${previo.id}/carreras`, { metodo: "PUT", cuerpo: { carreras } });
    return { estado: r.estado === 200 ? 201 : r.estado, cuerpo: r.cuerpo, reutilizada: true };
}

const depto = cliente();

/** Deja el terreno como estaba: sin carreras ni reservas de prueba. */
async function limpiar() {
    await depto("/periodos/impares/cerrar", { metodo: "DELETE" });
    for (const codigo of ["ZZ1", "ZZ2"]) {
        for (const e of (await depto(`/carreras/${codigo}/escenarios`)).cuerpo ?? []) {
            await depto(`/carreras/${codigo}/escenarios/${e.id}/reserva`, { metodo: "DELETE" });
        }
        await depto(`/plantel/carreras/${codigo}`, { metodo: "DELETE" });
    }
}

async function main() {
    console.log(`Verificando ${BASE}\n${"=".repeat(62)}`);

    // ---------------------------------------------------------------- salud
    titulo("Servicio en pie");
    const anon = cliente();
    const salud = await anon("/salud");
    comprobar("el backend responde", salud.estado === 200);
    comprobar("el motor responde", salud.cuerpo?.motor?.disponible === true, JSON.stringify(salud.cuerpo?.motor));
    comprobar("sin sesión no hay datos", (await anon("/carreras")).estado === 401);
    comprobar("una ruta inexistente da 404", (await anon("/no-existe")).estado === 404);
    comprobar("un verbo no soportado da 405", (await anon("/salud", { metodo: "DELETE" })).estado === 405);

    // ------------------------------------------------------- departamento
    titulo("Departamento académico");
    let sesion = { estado: 0 };
    for (const clave of CLAVES_DEPTO) {
        sesion = await depto("/sesion", { metodo: "POST", cuerpo: { usuario: "depto", clave } });
        if (sesion.estado === 200) break;
    }
    if (sesion.estado !== 200) {
        console.log("\n  No se pudo entrar como 'depto' con ninguna contraseña conocida.");
        console.log("  Pásala por entorno: CLAVE_DEPTO=... node herramientas/verificar.js");
        process.exit(1);
    }
    comprobar("entra el departamento", sesion.cuerpo?.rol === "departamento");

    if (sesion.cuerpo?.debeCambiarClave) {
        comprobar("con la contraseña de arranque no se usa nada más", (await depto("/usuarios")).estado === 403);
        const cambio = await depto("/sesion/clave", {
            metodo: "POST", cuerpo: { actual: "schedulai", nueva: "schedulai-verif" }
        });
        comprobar("cambiarla levanta el bloqueo", cambio.estado === 200);
        comprobar("no vale poner la misma",
            (await depto("/sesion/clave", { metodo: "POST", cuerpo: { actual: "x", nueva: "x" } })).estado >= 400);
        await depto("/sesion", { metodo: "POST", cuerpo: { usuario: "depto", clave: "schedulai-verif" } });
    }
    await limpiar();

    const plantel = (await depto("/plantel/carreras")).cuerpo ?? [];
    comprobar("el plantel tiene sus carreras", plantel.length >= 2, `${plantel.length}`);

    titulo("Alta de carreras y cuentas");
    comprobar("abrir una carrera",
        (await depto("/plantel/carreras", { metodo: "POST", cuerpo: { codigo: "ZZ1", nombre: "Prueba uno" } })).estado === 201);
    await depto("/plantel/carreras", { metodo: "POST", cuerpo: { codigo: "ZZ2", nombre: "Prueba dos" } });
    comprobar("un código inválido se rechaza",
        (await depto("/plantel/carreras", { metodo: "POST", cuerpo: { codigo: "1ZZ", nombre: "X" } })).estado === 400);

    const altaUno = await asegurarCoordinador("zz-uno", "Coord ZZ1", ["ZZ1"]);
    comprobar("alta de coordinador", altaUno.estado === 201, JSON.stringify(altaUno.cuerpo));
    await asegurarCoordinador("zz-dos", "Coord ZZ2", ["ZZ2"]);
    comprobar("una carrera inexistente da 400, no un fallo interno",
        (await depto("/usuarios", { metodo: "POST", cuerpo: { nombre: "X", usuario: "zz-mal", clave: "schedulai", carreras: ["NADA"] } })).estado === 400);
    comprobar("un usuario repetido da 409",
        (await depto("/usuarios", { metodo: "POST", cuerpo: { nombre: "X", usuario: "zz-uno", clave: "schedulai" } })).estado === 409);

    const uno = (await depto("/usuarios")).cuerpo.find((u) => u.usuario === "zz-uno");
    comprobar("no se puede dejar una carrera sin coordinador",
        (await depto(`/usuarios/${uno.id}/carreras`, { metodo: "PUT", cuerpo: { carreras: [] } })).estado === 409);

    // Se retira a alguien que no lleva nada, para no tocar las carreras de
    // prueba, y se le devuelve el acceso como lo haría el departamento.
    titulo("Retirar a alguien y traerlo de vuelta");
    await depto("/usuarios", {
        metodo: "POST", cuerpo: { nombre: "Coord suplente", usuario: "zz-tres", clave: "schedulai" }
    });
    const tres = (await depto("/usuarios")).cuerpo.find((u) => u.usuario === "zz-tres");
    // La corrida anterior la dejó retirada: se la reactiva como haría el
    // departamento, que es justo lo que esta sección comprueba más abajo.
    if (tres.activo === false) {
        await depto(`/usuarios/${tres.id}/clave`, { metodo: "POST", cuerpo: { nueva: "schedulai" } });
    }
    comprobar("entra antes de retirarla", (await entrar("zz-tres")).estado === 200);
    comprobar("se retira", (await depto(`/usuarios/${tres.id}`, { metodo: "DELETE" })).estado === 200);

    // Con la contraseña buena, para que el 403 sea por estar retirada y no por
    // fallarla: se prueban todas las que la cuenta pudo llegar a tener.
    const intentos = [];
    for (const clave of CLAVES_CONOCIDAS) {
        intentos.push(await cliente()("/sesion", { metodo: "POST", cuerpo: { usuario: "zz-tres", clave } }));
    }
    comprobar("y entonces ya no entra con ninguna",
        intentos.every((r) => r.estado !== 200), JSON.stringify(intentos.map((r) => r.estado)));
    const negada = intentos.find((r) => r.estado === 403);
    comprobar("se le dice por qué, no 'contraseña incorrecta'",
        /retirada/.test(negada?.cuerpo?.error ?? ""), negada?.cuerpo?.error);
    comprobar("la lista del departamento la marca",
        (await depto("/usuarios")).cuerpo.find((u) => u.usuario === "zz-tres")?.activo === false);
    comprobar("darla de alta otra vez no es la salida: manda a reactivarla",
        /retirada/.test(
            (await depto("/usuarios", {
                metodo: "POST", cuerpo: { nombre: "X", usuario: "zz-tres", clave: "schedulai" }
            })).cuerpo?.error ?? ""
        ));
    comprobar("ni darle una carrera mientras sigue retirada",
        (await depto(`/usuarios/${tres.id}/carreras`, { metodo: "PUT", cuerpo: { carreras: ["ZZ2"] } })).estado === 409);

    comprobar("se reactiva con una contraseña nueva",
        (await depto(`/usuarios/${tres.id}/clave`, { metodo: "POST", cuerpo: { nueva: "schedulai" } })).estado === 200);
    comprobar("y vuelve a entrar", (await entrar("zz-tres")).estado === 200);
    await depto(`/usuarios/${tres.id}`, { metodo: "DELETE" });

    // ------------------------------------------------------- coordinadores
    titulo("Aislamiento entre coordinaciones");
    const a = await entrar("zz-uno");
    const b = await entrar("zz-dos");
    comprobar("entra el coordinador nuevo", a.estado === 200 && a.perfil?.carreras?.[0] === "ZZ1");
    comprobar("solo ve su carrera", JSON.stringify((await a.c("/carreras")).cuerpo) === '["ZZ1"]');
    comprobar("no abre la carrera de otro", (await a.c("/carreras/ZZ2/escenarios")).estado === 403);
    comprobar("no administra cuentas", (await a.c("/usuarios")).estado === 403);
    comprobar("no cierra el periodo",
        (await a.c("/periodos/impares/cerrar", { metodo: "POST" })).estado === 403);

    // ---------------------------------------------------------- escenario
    titulo("Datos del escenario");
    for (const [cli, carrera] of [[a.c, "ZZ1"], [b.c, "ZZ2"]]) {
        await cli(`/carreras/${carrera}/escenarios`, {
            metodo: "POST", cuerpo: { nombre: "Base", esBase: true }
        });
        const escs = (await cli(`/carreras/${carrera}/escenarios`)).cuerpo;
        const id = escs[0].id;
        await cli(`/carreras/${carrera}/escenarios/${id}`, {
            metodo: "PUT",
            cuerpo: {
                materias: TRONCO,
                especialidades: [],
                semestres: [{
                    id: `s-${carrera}`, periodo: "Agosto-Diciembre 2026", semanas: 16,
                    turnos: ["matutino"], estado: "activo"
                }]
            }
        });
        if (carrera === "ZZ1") global.escZZ1 = id;
        else global.escZZ2 = id;
    }
    const guardado = (await a.c(`/carreras/ZZ1/escenarios/${global.escZZ1}`)).cuerpo;
    comprobar("lo guardado se lee igual", guardado?.datos?.materias?.length === 2,
        JSON.stringify(guardado?.datos?.materias?.length));

    // --------------------------------------------------------- validación
    titulo("No se genera con datos incompletos");
    const E1 = `/carreras/ZZ1/escenarios/${global.escZZ1}`;
    const v = await a.c(`${E1}/horario/validacion`, { metodo: "POST", cuerpo: { paridad: "impares" } });
    comprobar("la validación responde", v.estado === 200, JSON.stringify(v.cuerpo).slice(0, 90));
    comprobar("dice si se puede generar", typeof v.cuerpo?.listo === "boolean");
    comprobar("sugiere los grupos del periodo", (v.cuerpo?.lineas ?? []).length > 0);
    if (!v.cuerpo?.listo) {
        comprobar("y el motor no se salta el portero",
            (await a.c(`${E1}/horario`, { metodo: "POST", cuerpo: { paridad: "impares" } })).estado === 422);
        comprobar("nombrando qué falta", (v.cuerpo?.bloqueos ?? []).length > 0,
            JSON.stringify(v.cuerpo?.bloqueos?.map((x) => x.codigo)));
    }

    // ----------------------------------------------------------- horario
    titulo("Generar, apartar, recuperar");
    const lineas = (v.cuerpo?.lineas ?? []).map((l) => ({ ...l, alumnos: 30 }));
    const gen = await a.c(`${E1}/horario`, {
        metodo: "POST",
        cuerpo: {
            paridad: "impares", grupos: lineas,
            parametros: { generaciones: 400, islas: 2, semilla: 11, busquedaLocal: 20 }
        }
    });
    const listo = v.cuerpo?.listo === true;
    if (listo) {
        comprobar("el horario sale", gen.estado === 200, JSON.stringify(gen.cuerpo).slice(0, 100));
        comprobar("sin restricciones duras", durasDe(gen.cuerpo?.diagnostico).length === 0,
            JSON.stringify(durasDe(gen.cuerpo?.diagnostico)));
        comprobar("y una clase la imparte una sola persona",
            partidas(gen.cuerpo?.sesiones ?? []).length === 0,
            partidas(gen.cuerpo?.sesiones ?? []).slice(0, 3).join(", "));
        comprobar("con bloques de la materia completa",
            (gen.cuerpo?.sesiones ?? []).length > 0 &&
            gen.cuerpo.sesiones.every((s) => s.horaFin > s.horaInicio));

        // El grupo viaja con lo que cursa, no solo con lo que le tocó: la hoja
        // impresa compara las dos cosas para avisar de lo que falta, y un hueco
        // en la rejilla de papel no se distingue de una hora libre.
        const conMaterias = (gen.cuerpo?.grupos ?? []).filter((g) => Array.isArray(g.materias));
        comprobar("cada grupo del horario dice qué cursa",
            conMaterias.length === (gen.cuerpo?.grupos ?? []).length &&
                conMaterias.every((g) => g.materias.length > 0),
            `${conMaterias.length} de ${(gen.cuerpo?.grupos ?? []).length}`);
        comprobar("y con los datos completos no falta ninguna clase",
            conMaterias.every((g) => {
                const puestas = new Set(
                    gen.cuerpo.sesiones
                        .filter((x) => (x.grupoIds ?? [x.grupoId]).includes(g.id))
                        .map((x) => x.materiaId)
                );
                return g.materias.every((m) => puestas.has(m));
            }));

        const res = await a.c(`${E1}/reserva`, {
            metodo: "PUT",
            cuerpo: { paridad: "impares", sesiones: gen.cuerpo.sesiones, horario: gen.cuerpo }
        });
        comprobar("apartar las horas", res.cuerpo?.reservadas === gen.cuerpo.sesiones.length);

        const vuelto = await a.c(`${E1}/reserva`);
        comprobar("el horario se recupera tal cual",
            vuelto.cuerpo?.horario?.sesiones?.length === gen.cuerpo.sesiones.length);
        comprobar("y al día con lo apartado", vuelto.cuerpo?.desfase?.alDia === true);

        // --------------------------------------------------- contención
        titulo("Contención entre carreras");
        const E2 = `/carreras/ZZ2/escenarios/${global.escZZ2}`;
        const v2 = await b.c(`${E2}/horario/validacion`, { metodo: "POST", cuerpo: { paridad: "impares" } });
        comprobar("la otra carrera ve las horas ya tomadas", (v2.cuerpo?.horasAjenas ?? 0) > 0,
            `${v2.cuerpo?.horasAjenas}`);

        const gen2 = await b.c(`${E2}/horario`, {
            metodo: "POST",
            cuerpo: {
                paridad: "impares",
                grupos: (v2.cuerpo?.lineas ?? []).map((l) => ({ ...l, alumnos: 30 })),
                parametros: { generaciones: 400, islas: 2, semilla: 11, busquedaLocal: 20 }
            }
        });
        if (gen2.estado === 200) {
            await b.c(`${E2}/reserva`, {
                metodo: "PUT",
                cuerpo: { paridad: "impares", sesiones: gen2.cuerpo.sesiones, horario: gen2.cuerpo }
            });
            const conf = await b.c(`${E2}/conflictos`, { metodo: "POST", cuerpo: { paridad: "impares" } });
            comprobar("se detectan los choques con otra carrera", Array.isArray(conf.cuerpo?.conflictos));

            // Si no chocaron es que el motor hizo su trabajo: prefiere las
            // horas libres. Para probar la conciliación hay que provocarlo,
            // apartando a propósito las mismas horas que la otra.
            let choque = conf.cuerpo?.conflictos?.find((c) => !c.propio);
            if (!choque) {
                const suyas = (await a.c(`${E1}/reserva`)).cuerpo?.horario?.sesiones ?? [];
                if (suyas.length > 0) {
                    await b.c(`${E2}/reserva`, {
                        metodo: "PUT",
                        cuerpo: {
                            paridad: "impares",
                            sesiones: [{ ...suyas[0], grupoClave: "forzado" }],
                            horario: { ...gen2.cuerpo, sesiones: [{ ...suyas[0], grupoClave: "forzado" }] }
                        }
                    });
                    const otra = await b.c(`${E2}/conflictos`, { metodo: "POST", cuerpo: { paridad: "impares" } });
                    choque = otra.cuerpo?.conflictos?.find((c) => !c.propio);
                }
            }
            comprobar("dos carreras sobre la misma hora se detectan", Boolean(choque));
            if (choque) {
                const otra = choque.contra[0];
                const sol = await b.c("/solicitudes", {
                    metodo: "POST",
                    cuerpo: {
                        de: { carrera: "ZZ2", escenarioId: global.escZZ2 },
                        a: { carrera: otra.carrera, escenarioId: otra.escenarioId },
                        docenteId: choque.docenteId, dia: choque.dia,
                        inicio: choque.inicio, fin: choque.fin, motivo: "verificación"
                    }
                });
                comprobar("se puede pedir la hora", sol.estado === 201, JSON.stringify(sol.cuerpo).slice(0, 80));
                comprobar("repetir la petición da 409",
                    (await b.c("/solicitudes", { metodo: "POST", cuerpo: {
                        de: { carrera: "ZZ2", escenarioId: global.escZZ2 },
                        a: { carrera: otra.carrera, escenarioId: otra.escenarioId },
                        docenteId: choque.docenteId, dia: choque.dia, inicio: choque.inicio, fin: choque.fin
                    } })).estado === 409);
                comprobar("quien pide no se la responde a sí mismo",
                    (await b.c(`/solicitudes/${sol.cuerpo.id}/responder`, { metodo: "POST", cuerpo: { acepta: true } })).estado === 403);

                const duenoDe = otra.carrera === "ZZ1" ? a.c : null;
                if (duenoDe) {
                    const ceder = await duenoDe(`/solicitudes/${sol.cuerpo.id}/responder`, {
                        metodo: "POST", cuerpo: { acepta: true, respuesta: "va" }
                    });
                    comprobar("ceder libera horas de verdad", (ceder.cuerpo?.bloquesLiberados ?? 0) > 0,
                        JSON.stringify(ceder.cuerpo?.bloquesLiberados));
                    const tras = await a.c(`${E1}/reserva`);
                    comprobar("y el horario de quien cedió queda desfasado",
                        tras.cuerpo?.desfase?.alDia === false);
                }
            }
        }

        // ----------------------------------------------------- historial
        titulo("Historial y hoja");
        const hist = await a.c("/saturacion/historial", { metodo: "POST", cuerpo: { limite: 5 } });
        comprobar("queda rastro de quién tomó y soltó",
            Array.isArray(hist.cuerpo) && hist.cuerpo.length > 0);
        comprobar("con acción reconocible",
            (hist.cuerpo ?? []).every((h) => ["apartada", "liberada", "cedida"].includes(h.accion)));

        const hoja = await a.c("/saturacion", { metodo: "POST", cuerpo: { paridad: "impares" } });
        comprobar("la hoja de saturación se arma", (hoja.cuerpo?.hojas ?? []).length > 0);
        const celdas = (hoja.cuerpo?.hojas ?? []).flatMap((d) => d.dias.flatMap((x) => x.horas));
        comprobar("con los cuatro estados posibles",
            new Set(celdas.map((c) => c.estado)).size >= 2,
            [...new Set(celdas.map((c) => c.estado))].join(","));
    } else {
        comprobar("(se omite el horario: la validación bloquea)", true);
    }

    // -------------------------------------------------- horario conjunto
    titulo("Horario conjunto entre coordinaciones");
    const sinPermiso = await a.c(`${E1}/horario/validacion`, {
        metodo: "POST",
        cuerpo: { paridad: "impares", invitadas: [{ carrera: "ZZ2", escenarioId: global.escZZ2 }] }
    });
    comprobar("sin invitación no se mete la carrera de otro", sinPermiso.estado === 403,
        JSON.stringify(sinPermiso.cuerpo).slice(0, 90));

    const inv = await a.c("/invitaciones", {
        metodo: "POST", cuerpo: { anfitriona: "ZZ1", invitada: "ZZ2", escenarioId: global.escZZ2 }
    });
    comprobar("se manda la invitación", inv.estado === 201, JSON.stringify(inv.cuerpo).slice(0, 80));
    comprobar("la anfitriona no se la acepta sola",
        (await a.c(`/invitaciones/${inv.cuerpo.id}/responder`, { metodo: "POST", cuerpo: { acepta: true } })).estado === 403);
    comprobar("le llega a la invitada",
        (await b.c("/invitaciones")).cuerpo?.recibidas?.some((x) => x.id === inv.cuerpo.id));
    comprobar("la invitada acepta",
        (await b.c(`/invitaciones/${inv.cuerpo.id}/responder`, { metodo: "POST", cuerpo: { acepta: true } })).cuerpo?.estado === "aceptada");

    const conPermiso = await a.c(`${E1}/horario/validacion`, {
        metodo: "POST",
        cuerpo: { paridad: "impares", invitadas: [{ carrera: "ZZ2", escenarioId: global.escZZ2 }] }
    });
    comprobar("ahora sí se programan juntas", conPermiso.estado === 200 && conPermiso.cuerpo?.conjunta === true);
    const cruzadas = conPermiso.cuerpo?.fusionesEntreCarreras ?? [];
    comprobar("y aparecen las materias que comparten", cruzadas.length > 0,
        JSON.stringify(cruzadas.map((f) => f.materiaClave)));

    if (cruzadas.length > 0 && conPermiso.cuerpo?.listo) {
        const conjunto = await a.c(`${E1}/horario`, {
            metodo: "POST",
            cuerpo: {
                paridad: "impares",
                invitadas: [{ carrera: "ZZ2", escenarioId: global.escZZ2 }],
                grupos: conPermiso.cuerpo.lineas,
                fusiones: cruzadas.map((f) => ({ materiaId: f.materiaId, grupos: f.grupos.map((g) => g.id) })),
                parametros: { generaciones: 400, islas: 2, semilla: 11, busquedaLocal: 20 }
            }
        });
        comprobar("el horario conjunto sale", conjunto.estado === 200, JSON.stringify(conjunto.cuerpo).slice(0, 90));
        comprobar("con clases fusionadas",
            (conjunto.cuerpo?.sesiones ?? []).some((s) => s.fusionada));
        comprobar("los grupos llevan su carrera",
            (conjunto.cuerpo?.grupos ?? []).every((g) => g.carrera));
    }
    comprobar("cualquiera de las dos retira el permiso",
        (await b.c(`/invitaciones/${inv.cuerpo.id}`, { metodo: "DELETE" })).cuerpo?.revocada === true);
    comprobar("y deja de poder programarlas juntas",
        (await a.c(`${E1}/horario/validacion`, { metodo: "POST", cuerpo: { paridad: "impares", invitadas: [{ carrera: "ZZ2", escenarioId: global.escZZ2 }] } })).estado === 403);

    // ------------------------------------------------ disponibilidad docente
    titulo("Formulario del docente");
    const enlaces = await depto("/enlaces");
    comprobar("hay enlaces personales", (enlaces.cuerpo ?? []).length > 0);
    const token = enlaces.cuerpo?.[0]?.token;
    if (token) {
        const form = await anon(`/disponibilidad/${token}`);
        comprobar("el docente abre el suyo sin sesión", form.estado === 200, `${form.estado}`);
        comprobar("y trae su nombre", Boolean(form.cuerpo?.nombre));
        comprobar("un token inventado no abre nada",
            (await anon("/disponibilidad/inventado123")).estado >= 400);
    }

    // El enlace es la credencial del docente: con él se reescribe lo que
    // declaró. Una coordinación solo debe recibir los de su propia gente.
    comprobar("el departamento ve los enlaces de toda la plantilla",
        (enlaces.cuerpo ?? []).length === ((await depto("/docentes")).cuerpo ?? []).length,
        `${(enlaces.cuerpo ?? []).length}`);
    comprobar("y cada enlace dice en qué carreras puede dar clase",
        (enlaces.cuerpo ?? []).every((e) => Array.isArray(e.carreras)));

    const deLaCoordinacion = (await a.c("/enlaces")).cuerpo ?? [];
    comprobar("una coordinación solo recibe los de quien puede dar sus materias",
        deLaCoordinacion.length > 0 &&
            deLaCoordinacion.length <= (enlaces.cuerpo ?? []).length &&
            deLaCoordinacion.every((e) => e.carreras.some((c) => a.perfil.carreras.includes(c))),
        `${deLaCoordinacion.length} de ${(enlaces.cuerpo ?? []).length}`);
    // Lo que cierra el hueco: no basta con que la lista sea más corta, hace
    // falta que el token de alguien ajeno no venga en ella.
    const ajenos = (enlaces.cuerpo ?? []).filter(
        (e) => !e.carreras.some((c) => a.perfil.carreras.includes(c))
    );
    comprobar("y ninguno de los ajenos, que son los que podría sobrescribir",
        ajenos.length === 0 ||
            !deLaCoordinacion.some((e) => ajenos.some((x) => x.token === e.token)),
        `${ajenos.length} ajenos en la plantilla`);

    // ------------------------------------------------------ cierre de periodo
    titulo("Cierre de periodo");
    comprobar("lo cierra el departamento",
        (await depto("/periodos/impares/cerrar", { metodo: "POST" })).estado === 200);
    comprobar("con el periodo cerrado no se apartan horas",
        (await a.c(`${E1}/reserva`, { metodo: "PUT", cuerpo: { paridad: "impares", sesiones: [] } })).estado === 409);
    comprobar("ni se sueltan",
        (await a.c(`${E1}/reserva`, { metodo: "DELETE" })).estado === 409);
    comprobar("y se reabre", (await depto("/periodos/impares/cerrar", { metodo: "DELETE" })).estado === 200);

    // ------------------------------------------------------------ respaldo
    titulo("Respaldo");
    const antes = (await depto("/salud")).estado;
    comprobar("el servicio sigue en pie tras todo lo anterior", antes === 200);

    // --------------------------------------------------- lo que faltaba tocar
    //
    // Medido con REGISTRAR_PETICIONES: estas rutas existían y ninguna prueba
    // las ejercitaba. Una ruta que nadie llama es una que se rompe en silencio.
    titulo("Catálogos compartidos");
    comprobar("los espacios del plantel se leen", ((await a.c("/plantel/aulas")).cuerpo ?? []).length > 0);
    comprobar("y una coordinación no los escribe",
        (await a.c("/plantel/aulas", { metodo: "PUT", cuerpo: [{ id: "x", clave: "X" }] })).estado === 403);
    comprobar("la ruta vieja por carrera también se niega",
        (await a.c("/carreras/ZZ1/aulas", { metodo: "PUT", cuerpo: [] })).estado === 403);
    comprobar("pero se leen desde la carrera", (await a.c("/carreras/ZZ1/aulas")).estado === 200);

    const plantilla = (await a.c("/docentes")).cuerpo ?? [];
    comprobar("la plantilla docente se lee", plantilla.length > 0);

    /**
     * Quiénes están autorizados para esa materia, en el mismo orden en que la
     * pantalla del departamento los ofrece. La API tampoco acepta a otros:
     * fijar a quien no puede darla deja el horario infactible y el motor no lo
     * puede arreglar.
     */
    const autorizados = (materiaId) =>
        plantilla.filter((d) => (d.materiasCapacitadas ?? []).includes(materiaId));
    const autorizadoPara = (materiaId) => autorizados(materiaId)[0];
    comprobar("y una coordinación no la reescribe",
        (await a.c("/docentes", { metodo: "PUT", cuerpo: plantilla })).estado === 403);
    comprobar("ni un nombramiento suelto",
        (await a.c(`/docentes/${plantilla[0].id}`, {
            metodo: "PUT", cuerpo: { maxGrupos: 1, materiasCapacitadas: [] }
        })).estado === 403);
    comprobar("el departamento sí",
        (await depto("/docentes", { metodo: "PUT", cuerpo: plantilla })).estado === 200);
    comprobar("vaciarla se niega",
        (await depto("/docentes", { metodo: "PUT", cuerpo: [] })).estado === 400);
    comprobar("las descargas las carga el departamento",
        (await a.c(`/docentes/${plantilla[0].id}/descargas`, { metodo: "PUT", cuerpo: [] })).estado === 403);
    comprobar("y las guarda",
        (await depto(`/docentes/${plantilla[0].id}/descargas`, {
            metodo: "PUT", cuerpo: plantilla[0].descargas ?? []
        })).estado === 200);

    titulo("Importación de disponibilidad");
    const csv = `id,lunes\n${plantilla[0].id},7-14`;
    const importado = await depto("/docentes/importar", { metodo: "POST", cuerpo: { csv } });
    comprobar("un CSV de disponibilidad se importa", importado.estado === 200,
        JSON.stringify(importado.cuerpo).slice(0, 80));
    comprobar("y dice a quién aplicó y qué ignoró",
        Array.isArray(importado.cuerpo?.aplicados) && Array.isArray(importado.cuerpo?.ignorados),
        JSON.stringify(importado.cuerpo).slice(0, 80));
    const nadie = await depto("/docentes/importar", { metodo: "POST", cuerpo: { csv: "id,lunes\nfantasma,7-14" } });
    comprobar("un docente que no existe se ignora, no revienta",
        nadie.estado === 200 && nadie.cuerpo.ignorados.length === 1,
        JSON.stringify(nadie.cuerpo).slice(0, 80));

    titulo("El docente guarda lo suyo");
    const conEnlace = (await depto("/enlaces")).cuerpo?.[0];
    if (conEnlace) {
        const suyo = (await anon(`/disponibilidad/${conEnlace.token}`)).cuerpo;
        const guardado = await anon(`/disponibilidad/${conEnlace.token}`, {
            metodo: "PUT",
            cuerpo: { declarada: suyo.declarada ?? [], evitar: suyo.evitar ?? [] }
        });
        comprobar("con su enlace guarda su horario, sin sesión", guardado.estado === 200,
            JSON.stringify(guardado.cuerpo).slice(0, 80));
        comprobar("un token inventado no guarda nada",
            (await anon("/disponibilidad/inventado", { metodo: "PUT", cuerpo: {} })).estado >= 400);
    }

    titulo("Prioridad docente");
    comprobar("se leen los niveles y lo puesto",
        Array.isArray((await a.c("/carreras/ZZ1/prioridades")).cuerpo?.niveles));
    comprobar("se pone una",
        (await a.c("/carreras/ZZ1/prioridades", {
            metodo: "PUT",
            cuerpo: { prioridades: [{ docenteId: plantilla[0].id, prioridad: 2 }] }
        })).estado === 200);
    comprobar("y vuelve leída",
        (await a.c("/carreras/ZZ1/prioridades")).cuerpo?.prioridades?.[0]?.prioridad === 2);
    comprobar("no se puede poner en la carrera de otro",
        (await a.c("/carreras/ZZ2/prioridades", {
            metodo: "PUT", cuerpo: { prioridades: [] }
        })).estado === 403);

    titulo("Lo elegido antes de generar");
    comprobar("se guarda la configuración",
        (await a.c(`${E1}/config`, {
            metodo: "PUT",
            cuerpo: { paridad: "impares", lineas, fusiones: [], invitadas: [] }
        })).estado === 200);
    const cfg = (await a.c(`${E1}/config`)).cuerpo;
    comprobar("y se recupera igual", cfg?.paridad === "impares" && cfg.lineas.length === lineas.length,
        JSON.stringify(cfg).slice(0, 80));

    titulo("Ajuste a mano");
    if (listo && gen.estado === 200) {
        const sinTocar = await a.c(`${E1}/horario/ajuste`, {
            metodo: "POST", cuerpo: { paridad: "impares", grupos: lineas, sesiones: gen.cuerpo.sesiones }
        });
        // La colocación, no la aptitud: entre generar y reevaluar, otra carrera
        // pudo apartar horas de esos docentes, y entonces las mismas clases en
        // el mismo sitio puntúan distinto. Eso es correcto, no un fallo.
        const mismas = (x, y) =>
            x.length === y.length &&
            x.every((s, i) => ["dia", "horaInicio", "docenteId", "aulaId"]
                .every((k) => s[k] === y[i][k]));
        comprobar("reevaluar sin cambiar nada deja las clases donde estaban",
            mismas(sinTocar.cuerpo?.sesiones ?? [], gen.cuerpo.sesiones),
            `${sinTocar.cuerpo?.sesiones?.length} vs ${gen.cuerpo.sesiones.length}`);
        // Comparar contra el momento de generar sería inestable: entre una cosa
        // y otra, otra carrera pudo apartar horas de esos docentes y entonces
        // las mismas clases puntúan distinto, incluso en restricciones duras.
        // Lo que sí tiene que cumplirse siempre es que evaluar dos veces lo
        // mismo dé lo mismo.
        const otraVez = await a.c(`${E1}/horario/ajuste`, {
            metodo: "POST", cuerpo: { paridad: "impares", grupos: lineas, sesiones: gen.cuerpo.sesiones }
        });
        comprobar("evaluar dos veces lo mismo da lo mismo",
            otraVez.cuerpo?.aptitud === sinTocar.cuerpo?.aptitud,
            `${otraVez.cuerpo?.aptitud} vs ${sinTocar.cuerpo?.aptitud}`);
        comprobar("y devuelve el resumen, como generar", Boolean(sinTocar.cuerpo?.resumen?.semestres));

        const fuera = await a.c(`${E1}/horario/ajuste`, {
            metodo: "POST",
            cuerpo: {
                paridad: "impares", grupos: lineas,
                sesiones: gen.cuerpo.sesiones.map((s, i) => (i === 0 ? { ...s, horaInicio: 23 } : s))
            }
        });
        comprobar("una hora imposible se rechaza nombrando el motivo",
            fuera.estado === 422 && /no cabe/.test(fuera.cuerpo?.error ?? ""),
            JSON.stringify(fuera.cuerpo).slice(0, 90));
        comprobar("un horario incompleto también",
            /incompleto/.test((await a.c(`${E1}/horario/ajuste`, {
                metodo: "POST",
                cuerpo: { paridad: "impares", grupos: lineas, sesiones: gen.cuerpo.sesiones.slice(0, 1) }
            })).cuerpo?.error ?? ""));
    }

    titulo("Sesión y periodos");
    comprobar("quién soy se consulta", (await a.c("/sesion")).cuerpo?.usuario === "zz-uno");
    comprobar("los periodos se listan", ((await a.c("/periodos")).cuerpo ?? []).length === 2);
    comprobar("la bandeja de solicitudes se lee",
        Array.isArray((await a.c("/solicitudes")).cuerpo?.recibidas));

    titulo("Catálogo: quién imparte qué");
    comprobar("una coordinación no lo ve", (await a.c("/plantel/catalogo")).estado === 403);
    const resumen = (await depto("/plantel/catalogo")).cuerpo ?? [];
    comprobar("el departamento ve una fila por carrera", resumen.length >= 2, `${resumen.length}`);
    comprobar("con su conteo de clases y de huecos",
        resumen.every((c) => typeof c.clases === "number" && typeof c.sinAsignar === "number"));

    // Lo que el plantel no cubre con su plantilla. Va aquí y no en la validación
    // de una carrera porque el déficit es del plantel: cada coordinación compara
    // su carga contra el tope de toda la plantilla y ninguna lo ve sola.
    comprobar("una coordinación no ve las necesidades del plantel",
        (await a.c("/plantel/necesidades")).estado === 403);
    const nec = (await depto("/plantel/necesidades")).cuerpo;
    comprobar("el departamento sí, con la cuenta completa",
        Number.isInteger(nec?.clases) && Number.isInteger(nec?.horas) &&
            Number.isInteger(nec?.capacidad),
        JSON.stringify(nec).slice(0, 110));
    // Las horas de lo que nadie puede dar no cuentan contra la capacidad: si no,
    // la misma hora saldría en las dos necesidades.
    comprobar("y las dos necesidades no se solapan",
        nec?.cubribles === nec?.horas - nec?.horasSinAutorizado,
        `${nec?.cubribles} = ${nec?.horas} - ${nec?.horasSinAutorizado}`);
    const falta = (nec?.necesidades ?? []).find((x) => x.codigo === "capacidad-docente");
    comprobar("y el déficit, si lo hay, es la resta exacta",
        falta ? falta.horas === nec.cubribles - nec.capacidad : nec.cubribles <= nec.capacidad,
        falta ? `${falta.horas} h` : "la plantilla alcanza");

    const deZZ1 = (await depto("/plantel/catalogo/ZZ1")).cuerpo;
    comprobar("el detalle trae una fila por materia y grupo",
        Array.isArray(deZZ1?.filas) &&
            deZZ1.filas.every((f) => f.materiaId && f.grupoClave && "docenteId" in f),
        JSON.stringify(deZZ1).slice(0, 90));

    comprobar("y todas sus materias tienen a alguien autorizado para darlas",
        (deZZ1?.filas ?? []).every((f) => autorizadoPara(f.materiaId)),
        (deZZ1?.filas ?? []).filter((f) => !autorizadoPara(f.materiaId))
            .map((f) => f.clave).join(", "));

    if (deZZ1?.filas?.length > 0) {
        const fila = deZZ1.filas[0];
        const alguien = autorizadoPara(fila.materiaId);
        const asignar = (docenteId, cliente = depto) =>
            cliente("/plantel/asignaciones", {
                metodo: "PUT",
                cuerpo: { carrera: "ZZ1", materiaId: fila.materiaId, grupoClave: fila.grupoClave, docenteId }
            });

        comprobar("una coordinación no asigna", (await asignar(alguien.id, a.c)).estado === 403);
        comprobar("un docente inventado se rechaza", (await asignar("fantasma")).estado === 400);

        // La pantalla solo ofrece a los autorizados; por la API tampoco vale.
        const ajeno = plantilla.find(
            (d) => !(d.materiasCapacitadas ?? []).includes(fila.materiaId)
        );
        comprobar("ni alguien que no esté autorizado para esa materia",
            (await asignar(ajeno?.id)).estado === 409,
            JSON.stringify((await asignar(ajeno?.id)).cuerpo).slice(0, 110));

        comprobar("el departamento pone a alguien al frente de la clase",
            (await asignar(alguien.id)).cuerpo?.docenteId === alguien.id);

        const traer = async () =>
            (await depto("/plantel/catalogo/ZZ1")).cuerpo.filas
                .find((f) => f.materiaId === fila.materiaId && f.grupoClave === fila.grupoClave);
        comprobar("y el catálogo lo devuelve con nombre",
            (await traer()).docenteNombre === alguien.nombre);

        // Otro grupo de la misma materia es otra decisión: la unidad es la
        // clase, no la materia.
        const hermana = deZZ1.filas.find(
            (f) => f.materiaId === fila.materiaId && f.grupoClave !== fila.grupoClave
        );
        if (hermana) {
            comprobar("otro grupo de la misma materia sigue sin asignar", !hermana.docenteId);
        }

        const carga = (await depto("/plantel/carga")).cuerpo ?? [];
        const suya = carga.find((c) => c.docenteId === alguien.id);
        comprobar("la carga acumulada lo cuenta", suya?.clases >= 1, JSON.stringify(suya ?? null).slice(0, 90));
        comprobar("y dice en qué carreras está", (suya?.carreras ?? []).includes("ZZ1"));
        comprobar("una coordinación no ve la carga del plantel",
            (await a.c("/plantel/carga")).estado === 403);

        // La plantilla se guarda entera desde la pantalla del departamento, y
        // es lo más rutinario que hace. Borraba en cascada todo el reparto.
        await depto("/docentes", { metodo: "PUT", cuerpo: plantilla });
        comprobar("guardar la plantilla docente no borra el reparto",
            (await traer()).docenteId === alguien.id);

        // Y quitar a alguien de esa lista es darlo de baja: no puede llevarse
        // por delante lo que otras coordinaciones ya apartaron.
        const baja = await depto("/docentes", {
            metodo: "PUT", cuerpo: plantilla.filter((d) => d.id !== alguien.id)
        });
        comprobar("dar de baja a quien tiene clases se niega", baja.estado === 409, `${baja.estado}`);
        comprobar("y el aviso dice qué hay que soltar antes",
            /clase[s]? asignada|hora[s]? apartada/.test(baja.cuerpo?.error ?? ""), baja.cuerpo?.error);
        comprobar("y no se fue a medias", (await traer()).docenteId === alguien.id);

        // --------------------------------------------- repartir en bloque
        // El caso más común: la misma persona en todos los grupos de una
        // materia. De uno en uno son tres diálogos para decir lo mismo.
        const deLaMateria = deZZ1.filas.filter((f) => f.materiaId === fila.materiaId);
        const enBloque = await depto("/plantel/asignaciones/materia", {
            metodo: "POST",
            cuerpo: { carrera: "ZZ1", materiaId: fila.materiaId, docenteId: alguien.id }
        });
        comprobar("una materia se asigna a todos sus grupos de una vez",
            enBloque.cuerpo?.grupos?.length === deLaMateria.length,
            JSON.stringify(enBloque.cuerpo));
        comprobar("y el catálogo los devuelve todos con esa persona",
            (await depto("/plantel/catalogo/ZZ1")).cuerpo.filas
                .filter((f) => f.materiaId === fila.materiaId)
                .every((f) => f.docenteId === alguien.id));
        comprobar("una coordinación no reparte en bloque",
            (await a.c("/plantel/asignaciones/materia", {
                metodo: "POST", cuerpo: { carrera: "ZZ1", materiaId: fila.materiaId, docenteId: alguien.id }
            })).estado === 403);
        comprobar("una materia que la carrera no imparte da 404",
            (await depto("/plantel/asignaciones/materia", {
                metodo: "POST", cuerpo: { carrera: "ZZ1", materiaId: "fantasma", docenteId: alguien.id }
            })).estado === 404);

        // ---------------------------------------------------- el historial
        // Las horas ya tenían su historia; las decisiones no, y "¿quién cambió
        // esto, y cuándo?" no lo contestaba nadie.
        const hist = await depto("/plantel/asignaciones/historial", {
            metodo: "POST",
            cuerpo: { carrera: "ZZ1", materiaId: fila.materiaId, grupoClave: fila.grupoClave }
        });
        comprobar("el reparto deja historia", (hist.cuerpo ?? []).length > 0,
            JSON.stringify(hist.cuerpo ?? []).slice(0, 110));
        comprobar("con quién la tenía, quién la tiene y quién lo hizo",
            hist.cuerpo.every((h) => h.momento && h.accion && h.quien !== undefined));
        comprobar("una coordinación no lee el historial del plantel",
            (await a.c("/plantel/asignaciones/historial", { metodo: "POST", cuerpo: {} })).estado === 403);

        // ------------------------------------------------------- vaciarlo
        // La asignación no lleva periodo: se hereda del anterior. Cuando no es
        // lo que se quiere, esto evita quitar setenta clases de una en una.
        const antesDeVaciar = (await depto("/plantel/catalogo/ZZ1")).cuerpo.filas
            .filter((f) => f.docenteId).length;
        comprobar("una coordinación no vacía el reparto",
            (await a.c("/plantel/asignaciones/ZZ1", { metodo: "DELETE" })).estado === 403);
        const vaciado = await depto("/plantel/asignaciones/ZZ1", { metodo: "DELETE" });
        comprobar("el departamento vacía el reparto de una carrera",
            vaciado.cuerpo?.quitadas === antesDeVaciar, JSON.stringify(vaciado.cuerpo));
        comprobar("y no queda ninguna clase asignada",
            (await depto("/plantel/catalogo/ZZ1")).cuerpo.filas.every((f) => !f.docenteId));
        comprobar("pero la historia de lo que había se queda",
            ((await depto("/plantel/asignaciones/historial", {
                metodo: "POST", cuerpo: { carrera: "ZZ1" }
            })).cuerpo ?? []).some((h) => h.accion === "retirada"));

        // Se deja como estaba para lo que sigue.
        await asignar(alguien.id);

        // El punto de todo el catálogo: lo que el departamento decide tiene que
        // aparecer en el horario. Si el motor eligiera por su cuenta, repartir
        // sería un trámite sin efecto.
        const capaz = plantilla.find((d) => (d.materiasCapacitadas ?? []).includes(fila.materiaId));
        if (capaz) {
            await asignar(capaz.id);
            const conAsignacion = await a.c(
                `/carreras/ZZ1/escenarios/${global.escZZ1}/horario`,
                {
                    metodo: "POST",
                    cuerpo: {
                        paridad: "impares",
                        parametros: { generaciones: 200, islas: 2, semilla: 5, busquedaLocal: 20 }
                    }
                }
            );
            // Con el plantel lleno, la carrera de prueba no consigue aula y la
            // validación la bloquea con razón. Eso no es una regresión y no
            // debe leerse como tal: dos FALLAs secas mandan a buscar el fallo
            // donde no está.
            if (conAsignacion.estado === 422) {
                console.log(
                    `  --   no se puede comprobar ahora: ${conAsignacion.cuerpo?.error}\n` +
                    "       (el plantel está lleno; suelta alguna reserva y repite)"
                );
            } else {
                const suyas = (conAsignacion.cuerpo?.sesiones ?? []).filter(
                    (x) => x.materiaId === fila.materiaId && (x.grupoClaves ?? []).includes(fila.grupoClave)
                );
                comprobar("el motor respeta a quien el departamento puso al frente",
                    suyas.length > 0 && suyas.every((x) => x.docenteId === capaz.id),
                    `${suyas.length} bloques, ${[...new Set(suyas.map((x) => x.docenteId))].join("/")}`);
                comprobar("y sin líneas en la petición usa los grupos configurados",
                    (conAsignacion.cuerpo?.grupos ?? []).length > 0);
            }
        }

        comprobar("y se puede dejar sin asignar otra vez",
            (await asignar(null)).cuerpo?.docenteId === null && !(await traer()).docenteId);
    }

    titulo("Pedir un cambio de docente");
    // El coordinador arma el horario y es quien descubre que la persona que le
    // pusieron no tiene huecos donde hace falta. Sin este canal el sistema le
    // decía que lo pidiera y no había dónde.
    const paraCambio = (await depto("/plantel/catalogo/ZZ1")).cuerpo;
    const clase = paraCambio?.filas?.[0];
    if (clase) {
        await depto("/plantel/asignaciones", {
            metodo: "PUT",
            cuerpo: {
                carrera: "ZZ1", materiaId: clase.materiaId,
                grupoClave: clase.grupoClave, docenteId: autorizadoPara(clase.materiaId)?.id
            }
        });

        comprobar("el coordinador ve el reparto de su carrera",
            ((await a.c("/plantel/catalogo/ZZ1")).cuerpo?.filas ?? []).some((f) => f.docenteId),
            JSON.stringify((await a.c("/plantel/catalogo/ZZ1")).cuerpo).slice(0, 90));
        comprobar("pero no el de otra", (await a.c("/plantel/catalogo/ZZ2")).estado === 403);
        comprobar("ni el resumen del plantel", (await a.c("/plantel/catalogo")).estado === 403);

        comprobar("sin motivo no se pide",
            (await a.c("/cambios", {
                metodo: "POST",
                cuerpo: { carrera: "ZZ1", materiaId: clase.materiaId, grupoClave: clase.grupoClave }
            })).estado === 400);

        // El relevo también tiene que estar autorizado, y ser otro: aceptar
        // dejando a la misma persona se rechaza con un 400.
        const relevo = autorizados(clase.materiaId)[1];
        const pet = await a.c("/cambios", {
            metodo: "POST",
            cuerpo: {
                carrera: "ZZ1", materiaId: clase.materiaId, grupoClave: clase.grupoClave,
                propuesto: relevo?.id, motivo: "sus horas no coinciden con las del grupo"
            }
        });
        comprobar("la coordinación pide el cambio", pet.estado === 201, JSON.stringify(pet.cuerpo).slice(0, 100));
        comprobar("repetirla sobre la misma clase da 409",
            (await a.c("/cambios", {
                metodo: "POST",
                cuerpo: {
                    carrera: "ZZ1", materiaId: clase.materiaId, grupoClave: clase.grupoClave,
                    motivo: "otra vez"
                }
            })).estado === 409);
        comprobar("le llega al departamento",
            ((await depto("/cambios")).cuerpo ?? []).some((x) => x.id === pet.cuerpo.id));
        comprobar("y una coordinación ajena no la ve",
            !((await b.c("/cambios")).cuerpo ?? []).some((x) => x.id === pet.cuerpo.id));
        comprobar("el coordinador no se la responde a sí mismo",
            (await a.c(`/cambios/${pet.cuerpo.id}/responder`, {
                metodo: "POST", cuerpo: { acepta: true }
            })).estado === 403);

        const acepta = await depto(`/cambios/${pet.cuerpo.id}/responder`, {
            metodo: "POST", cuerpo: { acepta: true, respuesta: "va" }
        });
        comprobar("el departamento acepta y reasigna de una vez",
            acepta.cuerpo?.estado === "aceptada" && acepta.cuerpo?.asignado === relevo?.id,
            JSON.stringify(acepta.cuerpo).slice(0, 110));
        comprobar("y el catálogo ya lo refleja",
            (await depto("/plantel/catalogo/ZZ1")).cuerpo.filas
                .find((f) => f.materiaId === clase.materiaId && f.grupoClave === clase.grupoClave)
                ?.docenteId === relevo?.id);
        comprobar("responder dos veces da 409",
            (await depto(`/cambios/${pet.cuerpo.id}/responder`, {
                metodo: "POST", cuerpo: { acepta: false }
            })).estado === 409);

        // Se retira una segunda para dejar la tabla limpia y de paso probarlo.
        const otra = await a.c("/cambios", {
            metodo: "POST",
            cuerpo: {
                carrera: "ZZ1", materiaId: clase.materiaId, grupoClave: clase.grupoClave,
                motivo: "me arrepiento"
            }
        });
        comprobar("una petición pendiente se puede retirar",
            (await a.c(`/cambios/${otra.cuerpo.id}`, { metodo: "DELETE" })).estado === 200);
        await depto("/plantel/asignaciones", {
            metodo: "PUT",
            cuerpo: {
                carrera: "ZZ1", materiaId: clase.materiaId,
                grupoClave: clase.grupoClave, docenteId: null
            }
        });
    }

    titulo("Ocupación de aulas");
    // Las aulas son el otro recurso compartido y no tenían hoja: los choques
    // entre carreras solo salían como violación dura después de generar.
    const ocup = await a.c("/saturacion/aulas", { metodo: "POST", cuerpo: { paridad: "impares" } });
    comprobar("la hoja de aulas sale", ocup.estado === 200 && Array.isArray(ocup.cuerpo?.hojas),
        JSON.stringify(ocup.cuerpo).slice(0, 90));
    comprobar("una por espacio del plantel",
        ocup.cuerpo.hojas.length === ((await depto("/plantel/aulas")).cuerpo ?? []).length);
    const conCeldas = ocup.cuerpo.hojas[0];
    comprobar("con la semana entera y una celda por hora",
        conCeldas.dias.length === ocup.cuerpo.rejilla.dias.length &&
            conCeldas.dias[0].horas.length ===
                Math.max(...ocup.cuerpo.rejilla.turnos.map((t) => t.horaFin)) -
                    Math.min(...ocup.cuerpo.rejilla.turnos.map((t) => t.horaInicio)));
    comprobar("y el resumen cuadra con las celdas",
        conCeldas.resumen.libres + conCeldas.resumen.ocupadas === conCeldas.resumen["hábiles"],
        JSON.stringify(conCeldas.resumen));

    // Un salón con horas encima tampoco se quita de la lista del plantel: sus
    // horas no se borran pero dejan de verse, que para quien las apartó es lo
    // mismo que perderlas.
    const espacios = (await depto("/plantel/aulas")).cuerpo ?? [];
    const usado = ocup.cuerpo.hojas.find((h) => h.resumen.ocupadas > 0);
    if (usado) {
        const quitar = await depto("/plantel/aulas", {
            metodo: "PUT", cuerpo: espacios.filter((x) => x.id !== usado.aulaId)
        });
        comprobar("quitar un salón apartado se niega", quitar.estado === 409, `${quitar.estado}`);
        comprobar("nombrándolo como en la puerta y diciendo de quién son las horas",
            new RegExp(`^${usado.clave} tiene \\d+ horas? apartadas? por `).test(quitar.cuerpo?.error ?? ""),
            quitar.cuerpo?.error);
        comprobar("y el plantel sigue completo",
            ((await depto("/plantel/aulas")).cuerpo ?? []).length === espacios.length);
    }

    // Lo que distingue esta hoja: quién tiene la hora. La propia se mueve
    // cambiando el horario; la ajena hay que ir a negociarla.
    const tomadas = ocup.cuerpo.hojas.flatMap((h) =>
        h.dias.flatMap((d) => d.horas.filter((c) => c.estado === "ocupada"))
    );
    if (tomadas.length > 0) {
        comprobar("cada hora tomada dice de quién es",
            tomadas.every((c) => c.carrera && c.grupo && typeof c.propia === "boolean"),
            JSON.stringify(tomadas[0]));
        // ZZ1 es de `a`, así que sus horas son propias para él y ajenas para b.
        const paraB = await b.c("/saturacion/aulas", { metodo: "POST", cuerpo: { paridad: "impares" } });
        const propiasDeA = tomadas.filter((c) => c.propia).length;
        const propiasDeB = paraB.cuerpo.hojas
            .flatMap((h) => h.dias.flatMap((d) => d.horas))
            .filter((c) => c.propia).length;
        comprobar("y 'propia' depende de quién mira",
            propiasDeA !== propiasDeB || propiasDeA === 0,
            `${propiasDeA} para ZZ1, ${propiasDeB} para ZZ2`);
    }

    titulo("Pedir un salón a otra coordinación");
    // Las horas de un docente ya se negociaban; las de un aula no, y era el
    // único recurso compartido sin forma de pedirlo. Con los docentes el choque
    // se detecta solo; un aula ocupada el motor no la usa, así que nadie choca
    // y hay que verlo en la hoja de ocupación para pedirlo.
    const hojaAulas = (await a.c("/saturacion/aulas", {
        metodo: "POST", cuerpo: { paridad: "impares" } })).cuerpo;
    const conAjena = hojaAulas.hojas
        .flatMap((h) => h.dias.flatMap((d, i) =>
            d.horas.map((c, j) => ({ h, dia: d.dia, hora: h.horaBase + j, c }))))
        .find((x) => x.c.estado === "ocupada" && !x.c.propia);

    if (!conAjena) {
        console.log("  --   ninguna otra carrera tiene horas de aula ahora mismo");
    } else {
        const { h, dia, hora, c } = conAjena;
        comprobar("se pide un aula o un docente, nunca los dos",
            (await a.c("/solicitudes", {
                metodo: "POST",
                cuerpo: {
                    de: { carrera: "ZZ1", escenarioId: global.escZZ1 },
                    a: { carrera: c.carrera, escenarioId: c.escenarioId },
                    aulaId: h.aulaId, docenteId: plantilla[0].id,
                    dia, inicio: hora, fin: hora + 1, motivo: "las dos"
                }
            })).estado === 400);
        comprobar("ni un espacio inventado",
            (await a.c("/solicitudes", {
                metodo: "POST",
                cuerpo: {
                    de: { carrera: "ZZ1", escenarioId: global.escZZ1 },
                    a: { carrera: c.carrera, escenarioId: c.escenarioId },
                    aulaId: "no-existe", dia, inicio: hora, fin: hora + 1, motivo: "x"
                }
            })).estado === 404);

        const pide = await a.c("/solicitudes", {
            metodo: "POST",
            cuerpo: {
                de: { carrera: "ZZ1", escenarioId: global.escZZ1 },
                a: { carrera: c.carrera, escenarioId: c.escenarioId },
                aulaId: h.aulaId, dia, inicio: hora, fin: hora + 1,
                motivo: "es el único salón con cupo a esa hora"
            }
        });
        comprobar("una coordinación pide el salón que tiene otra",
            pide.estado === 201 && pide.cuerpo.aulaClave === h.clave &&
                pide.cuerpo.docenteId === null,
            JSON.stringify(pide.cuerpo).slice(0, 110));
        comprobar("repetirla da 409",
            (await a.c("/solicitudes", {
                metodo: "POST",
                cuerpo: {
                    de: { carrera: "ZZ1", escenarioId: global.escZZ1 },
                    a: { carrera: c.carrera, escenarioId: c.escenarioId },
                    aulaId: h.aulaId, dia, inicio: hora, fin: hora + 1, motivo: "otra vez"
                }
            })).estado === 409);
        comprobar("y viaja por la misma bandeja que las de docente",
            ((await a.c("/solicitudes")).cuerpo?.enviadas ?? []).some((x) => x.id === pide.cuerpo.id));
        // La cierra quien la tiene, que es el único que puede: el departamento
        // no coordina ninguna carrera y su respuesta se rechaza con razón.
        // Dejarla pendiente hacía fallar la siguiente pasada con un 409.
        const dueño = ((await depto("/usuarios")).cuerpo ?? [])
            .find((u) => u.carreras.includes(c.carrera));
        const suyo = dueño ? await entrar(dueño.usuario) : null;
        const cerrada = suyo?.estado === 200
            ? await suyo.c(`/solicitudes/${pide.cuerpo.id}/responder`, {
                  metodo: "POST",
                  cuerpo: { acepta: false, respuesta: "cerrada por la verificación" }
              })
            : { cuerpo: {} };
        comprobar("solo quien tiene el salón puede responder",
            cerrada.cuerpo?.estado === "rechazada" &&
                (await depto(`/solicitudes/${pide.cuerpo.id}/responder`, {
                    metodo: "POST", cuerpo: { acepta: false }
                })).estado >= 400,
            JSON.stringify(cerrada.cuerpo).slice(0, 90));
    }

    titulo("Cuando algo desaparece por debajo");
    // El reparto del departamento apunta a materias y grupos que la coordinación
    // administra. Que uno cambie sin avisar al otro es la forma en que estos
    // sistemas se descuadran en silencio.
    const vivo = (await depto("/plantel/catalogo/ZZ1")).cuerpo;
    if (vivo?.filas?.length > 0) {
        const suya = vivo.filas[0];
        const suyo = autorizadoPara(suya.materiaId);
        await depto("/plantel/asignaciones", {
            metodo: "PUT",
            cuerpo: {
                carrera: "ZZ1", materiaId: suya.materiaId,
                grupoClave: suya.grupoClave, docenteId: suyo?.id
            }
        });
        const antes = ((await depto("/plantel/carga")).cuerpo ?? [])
            .find((c) => c.docenteId === suyo?.id)?.clases ?? 0;

        // La coordinación quita esa materia de la retícula.
        const escenario = (await a.c(`/carreras/ZZ1/escenarios/${global.escZZ1}`)).cuerpo.datos;
        await a.c(`/carreras/ZZ1/escenarios/${global.escZZ1}`, {
            metodo: "PUT",
            cuerpo: {
                ...escenario,
                materias: escenario.materias.filter((m) => m.id !== suya.materiaId)
            }
        });

        const roto = (await depto("/plantel/catalogo/ZZ1")).cuerpo;
        comprobar("la clase desaparece del catálogo",
            !roto.filas.some((f) => f.materiaId === suya.materiaId));
        comprobar("el resumen del plantel también la cuenta, sin abrir la carrera",
            ((await depto("/plantel/catalogo")).cuerpo ?? []).find((c) => c.carrera === "ZZ1")
                ?.huerfanas === 1);
        comprobar("pero la asignación se nombra como huérfana, no se borra en silencio",
            (roto.huerfanas ?? []).some((h) => h.materiaId === suya.materiaId),
            JSON.stringify(roto.huerfanas ?? []).slice(0, 110));
        const despues = ((await depto("/plantel/carga")).cuerpo ?? [])
            .find((c) => c.docenteId === suyo?.id)?.clases ?? 0;
        comprobar("y deja de contar para la carga: era una clase que ya no existe",
            despues === antes - 1, `${antes} -> ${despues}`);

        // Al reponer la materia, la decisión vuelve sola.
        await a.c(`/carreras/ZZ1/escenarios/${global.escZZ1}`, { metodo: "PUT", cuerpo: escenario });
        comprobar("si la clase vuelve, la decisión vuelve con ella",
            (await depto("/plantel/catalogo/ZZ1")).cuerpo.filas
                .find((f) => f.materiaId === suya.materiaId && f.grupoClave === suya.grupoClave)
                ?.docenteId === suyo?.id);
        await depto("/plantel/asignaciones", {
            metodo: "PUT",
            cuerpo: {
                carrera: "ZZ1", materiaId: suya.materiaId,
                grupoClave: suya.grupoClave, docenteId: null
            }
        });
    }

    titulo("La plantilla es del departamento, también en la interfaz");
    // El alta de docente vivía en el panel del coordinador y ya no guardaba
    // nada: se podía capturar a una persona entera y perderla al recargar,
    // porque `PUT /escenarios/:id` manda materias, semestres y especialidades.
    comprobar("una coordinación no da de alta docentes",
        (await a.c("/docentes", { metodo: "PUT", cuerpo: plantilla })).estado === 403);

    const nueva = {
        id: "doc-alta-zz", nombre: "Alta De Prueba", categoria: "Titular",
        dedicacion: "tiempo completo", nivel: "A", horasMin: 0, horasMax: 22,
        maxMaterias: 3, maxGrupos: 5, materiasCapacitadas: [], descargas: [],
        disponibilidad: { declarada: [], evitar: [] }
    };
    comprobar("el departamento sí",
        (await depto("/docentes", { metodo: "PUT", cuerpo: [...plantilla, nueva] })).estado === 200);
    const conNueva = (await depto("/docentes")).cuerpo ?? [];
    const puesta = conNueva.find((d) => d.id === nueva.id);
    comprobar("y el nombramiento se guarda entero",
        puesta?.dedicacion === "tiempo completo" && puesta?.horasMax === 22 &&
            puesta?.maxMaterias === 3, JSON.stringify(puesta ?? null).slice(0, 110));
    comprobar("nace con su enlace para declarar disponibilidad",
        ((await depto("/enlaces")).cuerpo ?? []).some((e) => e.docenteId === nueva.id));
    await depto("/docentes", { metodo: "PUT", cuerpo: plantilla });
    comprobar("y darla de baja la quita",
        !((await depto("/docentes")).cuerpo ?? []).some((d) => d.id === nueva.id));

    titulo("Cuál escenario es el bueno");
    // El departamento reparte contra el escenario base, así que cuál lo sea no
    // es una etiqueta: decide sobre qué grupos se reparte. Antes no se podía
    // mover y el catálogo lo adivinaba.
    const escsZZ1 = (await a.c("/carreras/ZZ1/escenarios")).cuerpo ?? [];
    comprobar("hay exactamente un escenario base",
        escsZZ1.filter((e) => e.esBase).length === 1, JSON.stringify(escsZZ1.map((e) => [e.id, e.esBase])));
    const otroEsc = await a.c("/carreras/ZZ1/escenarios", {
        metodo: "POST", cuerpo: { nombre: "Variante", basadoEn: global.escZZ1 }
    });
    comprobar("crear a partir de otro copia su retícula",
        otroEsc.estado === 201 &&
            ((await a.c(`/carreras/ZZ1/escenarios/${otroEsc.cuerpo.id}`)).cuerpo?.datos?.materias ?? [])
                .length === TRONCO.length,
        JSON.stringify(otroEsc.cuerpo).slice(0, 110));
    comprobar("un escenario nuevo no nace siendo base", otroEsc.cuerpo?.esBase === false);
    comprobar("configurar la variante no le roba el catálogo al base",
        (await a.c(`/carreras/ZZ1/escenarios/${otroEsc.cuerpo.id}/config`, {
            metodo: "PUT",
            cuerpo: { paridad: "impares", lineas: [], fusiones: [], invitadas: [] }
        })).estado === 200 &&
            (await depto("/plantel/catalogo/ZZ1")).cuerpo.escenarioId === global.escZZ1);
    // El departamento también puede, como en todo lo que administra: los
    // escenarios son de la coordinación, pero `exigirCarrera` le deja paso para
    // que pueda desatascar una carrera. Lo que no puede hacer nadie más es
    // tocar los de una carrera ajena.
    comprobar("una coordinación ajena no mueve el base de otra",
        (await b.c(`/carreras/ZZ1/escenarios/${otroEsc.cuerpo.id}/base`, { metodo: "PUT" })).estado === 403);
    comprobar("la coordinación decide, y el catálogo la sigue",
        (await a.c(`/carreras/ZZ1/escenarios/${otroEsc.cuerpo.id}/base`, { metodo: "PUT" })).estado === 200 &&
            (await depto("/plantel/catalogo/ZZ1")).cuerpo.escenarioId === otroEsc.cuerpo.id);
    comprobar("y sigue habiendo solo una",
        ((await a.c("/carreras/ZZ1/escenarios")).cuerpo ?? []).filter((e) => e.esBase).length === 1);
    await a.c(`/carreras/ZZ1/escenarios/${global.escZZ1}/base`, { metodo: "PUT" });
    await a.c(`/carreras/ZZ1/escenarios/${otroEsc.cuerpo.id}`, { metodo: "DELETE" });

    titulo("Reglamento del TecNM");
    // Los topes del sistema no son números elegidos a ojo: salen del Reglamento
    // Interior de Trabajo del Personal Docente. Esto comprueba que lo que el
    // sistema dice que son las reglas siga coincidiendo con lo que aplica.
    comprobar("una coordinación no revisa la plantilla del instituto",
        (await a.c("/plantel/normativa")).estado === 403);
    const norma = (await depto("/plantel/normativa")).cuerpo;
    comprobar("el tope de materias es el del artículo 155 y 156",
        norma?.reglas?.maxMaterias === 3, JSON.stringify(norma?.reglas?.maxMaterias));
    comprobar("la jornada es la del artículo 157: de 7 a 22, cinco días",
        norma?.reglas?.jornada?.horaInicio === 7 &&
        norma?.reglas?.jornada?.horaFin === 22 &&
        norma?.reglas?.jornada?.dias === 5);
    comprobar("el ajuste de horas es el del artículo 147", norma?.reglas?.ajusteMaximo === 2);
    comprobar("la tabla del artículo 143 está completa",
        norma?.reglas?.horasFrenteAGrupo?.titular?.["tiempo completo"] === 22 &&
        norma?.reglas?.horasFrenteAGrupo?.asistente?.["tiempo completo"] === 26);
    comprobar("y la revisión recorre la plantilla entera",
        norma?.revisados === ((await depto("/docentes")).cuerpo ?? []).length,
        `${norma?.revisados}`);

    // La dedicación es lo que hace aplicable la tabla del 143, y hasta ahora no
    // se podía capturar desde ninguna pantalla: venía sembrada y ahí se quedaba.
    const conDedicacion = plantilla.map((d) =>
        d.id === plantilla[0].id ? { ...d, dedicacion: "medio tiempo" } : d
    );
    await depto("/docentes", { metodo: "PUT", cuerpo: conDedicacion });
    comprobar("la dedicación se guarda y vuelve",
        ((await depto("/docentes")).cuerpo ?? []).find((d) => d.id === plantilla[0].id)
            ?.dedicacion === "medio tiempo");
    comprobar("y cambia las horas que le tocan según el 143",
        ((await depto("/plantel/normativa")).cuerpo?.observados ?? [])
            .find((o) => o.docenteId === plantilla[0].id)?.esperadas !==
            ((await depto("/plantel/normativa")).cuerpo?.reglas?.horasFrenteAGrupo
                ?.[String(plantilla[0].categoria).toLowerCase()]?.["tiempo completo"]));
    await depto("/docentes", { metodo: "PUT", cuerpo: plantilla });

    // Un docente que rompe el reglamento se nombra, no se impide: la plantilla
    // real tiene excepciones y un sistema que se niegue a programar no se usa.
    const cobaya = plantilla[0];
    await depto("/docentes", {
        metodo: "PUT",
        cuerpo: plantilla.map((d) => (d.id === cobaya.id ? { ...d, maxMaterias: 5 } : d))
    });
    const conFalta = (await depto("/plantel/normativa")).cuerpo;
    const suyo = (conFalta?.observados ?? []).find((o) => o.docenteId === cobaya.id);
    comprobar("cinco materias se señalan citando el artículo",
        suyo?.avisos?.some((x) => x.codigo === "materias-sobre-reglamento" && x.articulo),
        JSON.stringify(suyo ?? null).slice(0, 120));
    comprobar("pero se puede guardar igual: es un aviso, no un bloqueo",
        ((await depto("/docentes")).cuerpo ?? []).find((d) => d.id === cobaya.id)?.maxMaterias === 5);
    await depto("/docentes", { metodo: "PUT", cuerpo: plantilla });
    comprobar("y al dejarlo como estaba el aviso desaparece",
        !((await depto("/plantel/normativa")).cuerpo?.observados ?? [])
            .some((o) => o.docenteId === cobaya.id));

    titulo("El docente ve lo suyo");
    // Su enlace abría solo el formulario: la pregunta que hace primero —qué me
    // tocó— no la contestaba nadie, y quien da clase en tres carreras tenía tres
    // hojas parciales en poder de tres coordinadores.
    const susEnlaces = (await depto("/enlaces")).cuerpo ?? [];
    comprobar("cada docente tiene su enlace", susEnlaces.length > 0);
    if (susEnlaces.length > 0) {
        // Quien tenga horas apartadas: sirve para ver que la semana llega llena.
        const conHoras = new Set(
            ((await depto("/saturacion", { metodo: "POST", cuerpo: { paridad: "impares" } }))
                .cuerpo?.hojas ?? [])
                .filter((h) => h.dias.some((d) => d.horas.some((c) => c.estado === "ocupada")))
                .map((h) => h.docenteId)
        );
        const elegido = susEnlaces.find((e) => conHoras.has(e.docenteId)) ?? susEnlaces[0];
        const solo = cliente();
        const mio = await solo(`/mi-horario/${elegido.token}`);
        comprobar("con su token ve su horario",
            mio.estado === 200 && mio.cuerpo?.nombre === elegido.nombre,
            JSON.stringify(mio.cuerpo).slice(0, 90));
        comprobar("con la semana y sus periodos",
            Array.isArray(mio.cuerpo?.dias) && Array.isArray(mio.cuerpo?.periodos));
        if (conHoras.has(elegido.docenteId)) {
            const bloques = (mio.cuerpo.periodos[0]?.bloques ?? []);
            comprobar("y sus clases, con carrera, grupo y aula",
                bloques.length > 0 && bloques.every((b) => b.carrera && b.grupo && b.materia),
                JSON.stringify(bloques[0] ?? null));
            // La clave y no el id: esta hoja la lee quien tiene que llegar al
            // salón, y "v_3" no está escrito en ninguna puerta.
            const claves = new Set(
                ((await depto("/plantel/aulas")).cuerpo ?? []).map((x) => x.clave)
            );
            comprobar("con el aula nombrada como en la puerta, no con su id",
                bloques.filter((b) => b.aula).every((b) => claves.has(b.aula)),
                bloques.map((b) => b.aula).join(", "));
        }
        comprobar("y nada más: sin sesión no llega a la plantilla",
            (await solo("/docentes")).estado === 401);
        comprobar("un token inventado no abre nada",
            (await solo("/mi-horario/inventado")).estado === 404);
    }

    titulo("Cuando el motor no está");
    // Caso operativo: el motor se cae o lo están redesplegando y alguien pulsa
    // Generar. Se comprueba contra el estado real, sin tumbar nada.
    const saludMotor = (await depto("/salud")).cuerpo;
    if (saludMotor?.motor?.disponible === false) {
        const sin = await a.c(`${E1}/horario`, { metodo: "POST", cuerpo: { paridad: "impares" } });
        comprobar("generar sin motor da 503 y no 500", sin.estado === 503, `${sin.estado}`);
        comprobar("y el mensaje no le echa jerga encima a quien lo lee",
            !/ENOTFOUND|ECONNREFUSED|getaddrinfo|:\d{4}/.test(sin.cuerpo?.error ?? ""),
            sin.cuerpo?.error);
        comprobar("lo que no usa el motor sigue en pie",
            (await depto("/plantel/catalogo")).estado === 200);
    } else {
        console.log("  --   el motor está arriba: este caso se comprueba parándolo");
        comprobar("la salud lo reporta como disponible", saludMotor?.motor?.disponible === true);
    }

    titulo("Dos a la vez");
    // Todo lo demás de esta verificación es secuencial, y la concurrencia es
    // justo la razón por la que el almacenamiento es SQLite y no archivos.
    const deZZ1Ahora = (await depto("/plantel/catalogo/ZZ1")).cuerpo?.filas ?? [];
    if (deZZ1Ahora.length > 0) {
        const aLaVez = await Promise.all(
            deZZ1Ahora.slice(0, 4).map((f) =>
                depto("/plantel/asignaciones", {
                    metodo: "PUT",
                    cuerpo: {
                        carrera: "ZZ1", materiaId: f.materiaId,
                        grupoClave: f.grupoClave, docenteId: autorizadoPara(f.materiaId)?.id
                    }
                })
            )
        );
        comprobar("varias asignaciones simultáneas entran todas",
            aLaVez.every((r) => r.estado === 200),
            aLaVez.map((r) => r.estado).join(","));
        // Las cuatro exactas, no un conteo: cada una fue a una persona distinta
        // según quién estuviera autorizado para su materia.
        const cuatro = new Set(deZZ1Ahora.slice(0, 4).map((f) => `${f.materiaId}|${f.grupoClave}`));
        comprobar("y el catálogo las refleja todas",
            (await depto("/plantel/catalogo/ZZ1")).cuerpo.filas
                .filter((f) => cuatro.has(`${f.materiaId}|${f.grupoClave}`) && f.docenteId)
                .length === cuatro.size);

        // Dos personas del departamento editando a la vez a dos docentes
        // distintos. Con el documento completo la segunda en guardar devolvía
        // al otro a su estado anterior; por la ruta de un solo nombramiento los
        // dos cambios se quedan, y es el defecto que esto vino a cerrar.
        const [uno, dos] = plantilla;
        const aLaPar = await Promise.all([
            depto(`/docentes/${uno.id}`, { metodo: "PUT", cuerpo: { maxGrupos: 7 } }),
            depto(`/docentes/${dos.id}`, { metodo: "PUT", cuerpo: { maxGrupos: 8 } })
        ]);
        const tras = (id) => ((global.plantillaTras ?? []).find((d) => d.id === id));
        global.plantillaTras = (await depto("/docentes")).cuerpo ?? [];
        comprobar("dos nombramientos a la vez no se pisan",
            aLaPar.every((r) => r.estado === 200) &&
                tras(uno.id)?.maxGrupos === 7 && tras(dos.id)?.maxGrupos === 8,
            `${aLaPar.map((r) => r.estado).join(",")} · ` +
            `${tras(uno.id)?.maxGrupos}/${tras(dos.id)?.maxGrupos}`);
        // Y lo que el formulario no manda sigue donde estaba: la disponibilidad
        // la declara el docente, y guardarle la ficha no puede pisársela.
        comprobar("y guardar una ficha no borra lo que no venía en ella",
            tras(uno.id)?.materiasCapacitadas.length === uno.materiasCapacitadas.length &&
                tras(uno.id)?.disponibilidad.declarada.length ===
                    uno.disponibilidad.declarada.length,
            `${tras(uno.id)?.materiasCapacitadas.length} autorizadas, ` +
            `${tras(uno.id)?.disponibilidad.declarada.length} bloques`);

        // Guardar la plantilla entera a la vez: la base tiene que quedar
        // consistente. Lo que **no** se evita por aquí es que un cambio pise al
        // otro —el documento va completo— y para eso está la ruta de uno.
        const guardados = await Promise.all(
            ["A", "B", "C"].map((x) =>
                depto("/docentes", {
                    metodo: "PUT",
                    cuerpo: plantilla.map((d, i) => (i === 0 ? { ...d, carreraBase: x } : d))
                })
            )
        );
        comprobar("guardar la plantilla entera a la vez no la rompe",
            guardados.every((r) => r.estado === 200) &&
                ((await depto("/docentes")).cuerpo ?? []).length === plantilla.length,
            `${guardados.map((r) => r.estado).join(",")} · ${((await depto("/docentes")).cuerpo ?? []).length} docentes`);
        await depto("/docentes", { metodo: "PUT", cuerpo: plantilla });

        for (const f of deZZ1Ahora.slice(0, 4)) {
            await depto("/plantel/asignaciones", {
                metodo: "PUT",
                cuerpo: {
                    carrera: "ZZ1", materiaId: f.materiaId,
                    grupoClave: f.grupoClave, docenteId: null
                }
            });
        }
    }

    titulo("Contraseñas");
    const dos = (await depto("/usuarios")).cuerpo.find((u) => u.usuario === "zz-dos");
    comprobar("el departamento reinicia la de quien la olvidó",
        (await depto(`/usuarios/${dos.id}/clave`, { metodo: "POST", cuerpo: { nueva: "olvidada2026" } })).estado === 200);
    comprobar("una coordinación no reinicia la de otra",
        (await a.c(`/usuarios/${dos.id}/clave`, { metodo: "POST", cuerpo: { nueva: "otracosa1" } })).estado === 403);
    comprobar("el departamento no se la reinicia a sí mismo",
        (await depto(`/usuarios/${(await depto("/usuarios")).cuerpo.find((u) => u.rol === "departamento").id}/clave`,
            { metodo: "POST", cuerpo: { nueva: "loquesea1" } })).estado === 400);

    const reiniciado = cliente();
    const tras = await reiniciado("/sesion", { metodo: "POST", cuerpo: { usuario: "zz-dos", clave: "olvidada2026" } });
    comprobar("entra con la provisional y queda obligado a cambiarla",
        tras.estado === 200 && tras.cuerpo.debeCambiarClave === true);
    comprobar("y no puede usar el sistema hasta hacerlo",
        (await reiniciado("/carreras")).estado === 403);
    comprobar("no vale poner la misma",
        (await reiniciado("/sesion/clave", { metodo: "POST", cuerpo: { actual: "olvidada2026", nueva: "olvidada2026" } })).estado === 400);
    comprobar("la cambia y ya",
        (await reiniciado("/sesion/clave", { metodo: "POST", cuerpo: { actual: "olvidada2026", nueva: "schedulai-verif" } })).estado === 200);

    titulo("Salir");
    const efimera = cliente();
    await efimera("/sesion", { metodo: "POST", cuerpo: { usuario: "zz-dos", clave: "schedulai-verif" } });
    comprobar("con sesión abierta se ve quién es", (await efimera("/sesion")).cuerpo?.usuario === "zz-dos");
    comprobar("cerrarla responde", (await efimera("/sesion", { metodo: "DELETE" })).estado === 200);
    comprobar("y después ya no se es nadie", (await efimera("/sesion")).cuerpo === null);

    titulo("Choque consigo mismo");
    // Un coordinador puede llevar varias carreras y chocar con él mismo. Ahí no
    // hay a quién pedirle nada, así que la resolución es directa.
    const bDos = (await depto("/usuarios")).cuerpo.find((u) => u.usuario === "zz-dos");
    await depto(`/usuarios/${bDos.id}/carreras`, { metodo: "PUT", cuerpo: { carreras: ["ZZ1", "ZZ2"] } });
    const ambas = await entrar("zz-dos");
    const suyos = (await ambas.c(`/carreras/ZZ2/escenarios/${global.escZZ2}/conflictos`, {
        metodo: "POST", cuerpo: { paridad: "impares" }
    })).cuerpo.conflictos;
    const propio = suyos.find((c) => c.propio);
    comprobar("un choque entre dos carreras propias se marca como propio",
        Boolean(propio) || suyos.length === 0,
        `${suyos.length} choques, propios ${suyos.filter((c) => c.propio).length}`);
    if (propio) {
        const otra = propio.contra[0];
        const r = await ambas.c("/conflictos/propio", {
            metodo: "POST",
            cuerpo: {
                cede: { carrera: otra.carrera, escenarioId: otra.escenarioId },
                bloque: { docenteId: propio.docenteId, dia: propio.dia, inicio: propio.inicio, fin: propio.fin }
            }
        });
        comprobar("y se resuelve soltando, sin solicitud", (r.cuerpo?.liberadas ?? 0) > 0,
            JSON.stringify(r.cuerpo));
    }
    comprobar("no se resuelve un choque de una carrera ajena",
        (await a.c("/conflictos/propio", {
            metodo: "POST",
            cuerpo: { cede: { carrera: "ZZ2", escenarioId: global.escZZ2 }, bloque: {} }
        })).estado === 403);
    await depto(`/usuarios/${bDos.id}/carreras`, { metodo: "PUT", cuerpo: { carreras: ["ZZ2"] } });

    titulo("Borrar un escenario");
    const extra = await a.c("/carreras/ZZ1/escenarios", {
        metodo: "POST", cuerpo: { nombre: "De prueba" }
    });
    comprobar("se crea uno más", extra.estado === 201, JSON.stringify(extra.cuerpo).slice(0, 70));
    comprobar("y se borra",
        (await a.c(`/carreras/ZZ1/escenarios/${extra.cuerpo.id}`, { metodo: "DELETE" })).estado === 200);

    // ------------------------------------------------------------ limpieza
    titulo("Limpieza");
    // Sesiones nuevas: reiniciar una contraseña cierra las del usuario, así que
    // a estas alturas las de `a` y `b` pueden estar muertas y liberar habría
    // fallado en silencio, dejando horas apartadas que impiden cerrar.
    for (const [usuario, carrera] of [["zz-uno", "ZZ1"], ["zz-dos", "ZZ2"]]) {
        const suyo = await entrar(usuario);
        if (suyo.estado !== 200) continue;
        // Todos sus escenarios, no solo el que creó esta pasada: una corrida
        // anterior pudo dejar horas en otro.
        for (const e of (await suyo.c(`/carreras/${carrera}/escenarios`)).cuerpo ?? []) {
            await suyo.c(`/carreras/${carrera}/escenarios/${e.id}/reserva`, { metodo: "DELETE" });
        }
    }
    // Antes de cerrar hay que quitarles la carrera, o la baja se niega por
    // dejarla sin coordinador — que es justo lo que debe hacer.
    for (const u of ["zz-uno", "zz-dos"]) {
        const fila = (await depto("/usuarios")).cuerpo?.find((x) => x.usuario === u);
        if (fila) await depto(`/usuarios/${fila.id}`, { metodo: "DELETE" });
    }
    const cierre = await depto("/plantel/carreras/ZZ1", { metodo: "DELETE" });
    comprobar("se cierra la carrera de prueba", cierre.estado === 200, JSON.stringify(cierre.cuerpo));
    await depto("/plantel/carreras/ZZ2", { metodo: "DELETE" });
    const quedan = (await depto("/plantel/carreras")).cuerpo?.filter((c) => c.codigo.startsWith("ZZ"));
    comprobar("no quedan carreras de prueba", (quedan ?? []).length === 0, JSON.stringify(quedan));
    // Las cuentas `zz-*` se quedan retiradas: el historial de saturación apunta
    // a quién hizo cada cosa y borrarlas lo dejaría sin autor. La siguiente
    // pasada las reutiliza.
    const cuentas = (await depto("/usuarios")).cuerpo?.filter((u) => u.usuario.startsWith("zz-"));
    comprobar("las cuentas de prueba quedan sin carreras",
        (cuentas ?? []).every((u) => u.carreras.length === 0));
}

try {
    await main();
} catch (e) {
    console.log(`\n  ERROR no controlado: ${e.message}`);
    fallos.push("la verificación reventó");
}

console.log(`\n${"=".repeat(62)}`);
console.log(`${ok} correctas, ${fallos.length} fallidas`);
if (fallos.length > 0) console.log(`\nFallaron:\n${fallos.map((f) => `  - ${f}`).join("\n")}`);
process.exit(fallos.length > 0 ? 1 : 0);
