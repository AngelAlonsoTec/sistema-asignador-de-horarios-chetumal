#!/usr/bin/env node
/**
 * Un periodo completo, narrado.
 *
 * La verificación de aceptación comprueba que cada cosa funcione; esto muestra
 * cómo se usan **juntas**: qué hace cada persona, qué ve, y qué pasa cuando dos
 * coordinaciones quieren al mismo docente. Sirve para enseñar el sistema y para
 * notar comportamientos raros que ninguna prueba aislada delata.
 *
 *   node herramientas/simular.js [http://localhost:8080]
 *
 * Deja el sistema como lo encontró salvo por lo que el relato aparta a
 * propósito, que es el estado normal de un periodo en marcha.
 */

import { entrar as acceder, cliente as clienteHttp } from "./acceso.js";

const BASE = (process.argv[2] ?? "http://localhost:8080").replace(/\/$/, "");
const API = `${BASE}/api`;
const CLAVE = "simulacion2026";

const acto = (n, t) => console.log(`\n${"━".repeat(70)}\n ACTO ${n} · ${t}\n${"━".repeat(70)}`);
const dice = (quien, que) => console.log(`\n  ${quien}\n    ${que}`);
const ve = (que) => console.log(`      ${que}`);

const cliente = () => clienteHttp(API);

/** Entra, y si es la primera vez cambia la contraseña como haría una persona. */
async function entrar(usuario) {
    const sesion = await acceder(API, usuario, { nueva: CLAVE });
    if (!sesion) throw new Error(`no pude entrar como ${usuario}`);
    return sesion;
}

const DURAS = new Set(["docenteNoCapacitado","choqueDocente","choqueGrupo","choqueAula",
  "aulaInadecuada","fueraDeAulaBase","aulaInsuficiente","aulaOcupadaPorOtros",
  "materiaRepetidaDia","horaNoDisponible","excesoMaterias","excesoGrupos","horasSobreMaximo"]);
const durasDe = (d) => Object.entries(d ?? {}).filter(([k, v]) => v > 0 && DURAS.has(k));
const hhmm = (h) => `${String(h).padStart(2, "0")}:00`;
/** "1 clase" y no "1 clases": el relato se lee, no se parsea. */
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

const PARAMETROS = { generaciones: 1200, islas: 4, semilla: 2026, busquedaLocal: 40 };

const TURNOS = { matutino: [7, 14], vespertino: [14, 22] };

/**
 * Si esa persona puede con esa clase con lo que declaró. No basta con tener
 * horas en el turno: una materia no se repite el mismo día, así que hacen falta
 * tantos días distintos como bloques tenga. Es lo mismo que la pantalla enseña
 * al abrir el diálogo de asignación.
 */
function alcanza(docente, fila) {
    const [ini, fin] = TURNOS[fila.turno] ?? [];
    if (ini === undefined) return { puede: true };
    const bloques = (docente.disponibilidad?.declarada ?? []).filter(
        (b) => Math.min(b.fin, fin) > Math.max(b.inicio, ini)
    );
    const horas = bloques.reduce((n, b) => n + Math.min(b.fin, fin) - Math.max(b.inicio, ini), 0);
    const dias = new Set(bloques.map((b) => b.dia)).size;
    if (horas === 0) return { puede: false, motivo: `no declaró horas de ${fila.turno}` };
    if (horas < fila.horasSemana) {
        return { puede: false, motivo: `solo ${horas} h de ${fila.turno} y la materia son ${fila.horasSemana}` };
    }
    const necesarios = Math.ceil(fila.horasSemana / 2);
    if (dias < necesarios) {
        return { puede: false, motivo: `declara ${dias} día(s) y la materia necesita ${necesarios}` };
    }
    return { puede: true };
}

async function main() {
    console.log(`\nSIMULACIÓN DE UN PERIODO · ${BASE}`);

    // ------------------------------------------------------------- acto 1
    acto(1, "El departamento abre el periodo");
    const depto = await entrar("depto");
    dice("Jefatura del departamento académico", "Entra a preparar el semestre de impares.");
    if (depto.estrenada) ve("Le pidió cambiar la contraseña de arranque antes de dejarla pasar.");

    const periodos = (await depto.c("/periodos")).cuerpo;
    for (const p of periodos) {
        ve(`${p.etiqueta}: ${p.cerrado ? "cerrado" : "abierto"} · semestres ${p.semestres.join(", ")}`);
    }
    const docentes = (await depto.c("/docentes")).cuerpo;
    const conDisponibilidad = docentes.filter((d) => (d.disponibilidad?.declarada ?? []).length > 0);
    const conDescarga = docentes.filter((d) => (d.descargas ?? []).length > 0);
    ve(`Plantilla: ${docentes.length} docentes · ${conDisponibilidad.length} ya declararon horario`);
    ve(`${conDescarga.length} con horas de comisión, que nadie puede programar encima`);

    // ------------------------------------------------------------- acto 2
    acto(2, "Un docente declara su disponibilidad");
    const enlaces = (await depto.c("/enlaces")).cuerpo;
    const suyo = enlaces[0];
    dice(suyo.nombre, `Recibe su enlace personal y lo abre. No tiene cuenta ni contraseña.`);
    const anon = cliente();
    const form = (await anon(`/disponibilidad/${suyo.token}`)).cuerpo;
    ve(`Ve su formulario: ${(form.declarada ?? []).length} bloques declarados, ` +
       `${(form.evitar ?? []).length} horas que pidió evitar`);
    for (const b of (form.declarada ?? []).slice(0, 3)) {
        ve(`  ${b.dia} de ${hhmm(b.inicio)} a ${hhmm(b.fin)}`);
    }
    ve(`Un token inventado no abre nada: HTTP ${(await anon("/disponibilidad/inventado")).estado}`);

    // ------------------------------------------------------------- acto 3
    // Antes el relato pasaba de abrir el periodo a armar horarios, saltándose
    // lo primero que ocurre de verdad: repartir. Quien decide quién imparte cada
    // clase no es quien arma el horario.
    acto(3, "El departamento reparte: quién imparte cada clase");
    const resumenPlantel = (await depto.c("/plantel/catalogo")).cuerpo ?? [];
    const totalClases = resumenPlantel.reduce((n, c) => n + c.clases, 0);
    const sinRepartir = resumenPlantel.reduce((n, c) => n + c.sinAsignar, 0);
    dice("Jefatura", "Abre el catálogo antes de que nadie genere nada.");
    ve(`${totalClases} clases en las ${resumenPlantel.length} carreras · ` +
       `${sinRepartir} todavía sin nadie al frente`);

    const norma = (await depto.c("/plantel/normativa")).cuerpo;
    ve(`Las reglas salen del Reglamento Interior de Trabajo del TecNM: ` +
       `máximo ${norma.reglas.maxMaterias} materias por docente (art. 155 y 156), ` +
       `jornada de ${norma.reglas.jornada.horaInicio} a ${norma.reglas.jornada.horaFin} (art. 157)`);
    ve(norma.observados.length === 0
        ? `Los ${norma.revisados} nombramientos cuadran con el reglamento`
        : `${norma.observados.length} nombramientos no cuadran y están señalados`);

    const deISIC = (await depto.c("/plantel/catalogo/ISIC")).cuerpo;
    const librePorRepartir = deISIC.filas.find((f) => !f.docenteId);
    if (librePorRepartir) {
        const hermanos = deISIC.filas.filter((f) => f.materiaId === librePorRepartir.materiaId);
        dice("Jefatura", `Reparte ${librePorRepartir.clave} ${librePorRepartir.nombre}.`);

        // Quién puede darla de verdad: autorizado y con días suficientes en el
        // turno del grupo. Es lo que la pantalla enseña al abrir el diálogo.
        const candidatos = docentes
            .filter((d) => (d.materiasCapacitadas ?? []).includes(librePorRepartir.materiaId))
            .map((d) => ({ d, alcance: alcanza(d, librePorRepartir) }));
        const buenos = candidatos.filter((c) => c.alcance.puede);
        const malos = candidatos.filter((c) => !c.alcance.puede);
        ve(`${candidatos.length} autorizados para esa materia; ${buenos.length} pueden con ella`);
        for (const m of malos.slice(0, 2)) ve(`  ${m.d.nombre}: ${m.alcance.motivo}`);

        if (buenos.length > 0) {
            const elegido = buenos[0].d;
            const carga = ((await depto.c("/plantel/carga")).cuerpo ?? [])
                .find((c) => c.docenteId === elegido.id);
            ve(`Elige a ${elegido.nombre}` +
               (carga ? ` — ya lleva ${carga.horas} h en ${carga.clases} clases` : " — sin clases todavía"));

            if (hermanos.length > 1) {
                const enBloque = (await depto.c("/plantel/asignaciones/materia", {
                    metodo: "POST",
                    cuerpo: { carrera: "ISIC", materiaId: librePorRepartir.materiaId, docenteId: elegido.id }
                })).cuerpo;
                ve(`Como el semestre abre ${hermanos.length} grupos, se la da a todos de una vez: ` +
                   `${enBloque.grupos.join(", ")}`);
            } else {
                await depto.c("/plantel/asignaciones", {
                    metodo: "PUT",
                    cuerpo: {
                        carrera: "ISIC", materiaId: librePorRepartir.materiaId,
                        grupoClave: librePorRepartir.grupoClave, docenteId: elegido.id
                    }
                });
                ve(`Queda asignada a ${elegido.nombre}`);
            }
            const hist = (await depto.c("/plantel/asignaciones/historial", {
                metodo: "POST",
                cuerpo: { carrera: "ISIC", materiaId: librePorRepartir.materiaId, limite: 3 }
            })).cuerpo ?? [];
            ve(`Queda constancia: ${plural(hist.length, "movimiento", "movimientos")} ` +
               `en el historial de esa materia`);
        }
    }
    const trasRepartir = (await depto.c("/plantel/catalogo/ISIC")).cuerpo;
    ve(`ISIC: ${trasRepartir.filas.filter((f) => f.docenteId).length} de ` +
       `${trasRepartir.filas.length} clases con docente decidido; el resto lo elegirá el motor`);

    // ------------------------------------------------------------- acto 4
    acto(4, "Sistemas y TI arma el horario de sus tres carreras");
    const sis = await entrar("coordinador");
    dice("Coordinación de Sistemas y TI", `Lleva ${sis.perfil.carreras.join(", ")}.`);

    const E = "/carreras/ISIC/escenarios/especialidades-2026";
    const v = (await sis.c(`${E}/horario/validacion`, {
        metodo: "POST", cuerpo: { paridad: "impares" }
    })).cuerpo;
    ve(`Antes de generar: ${v.listo ? "todo listo" : "falta algo"} · ` +
       `${v.resumen.grupos} grupos, ${v.resumen.materias} materias, ` +
       `${v.resumen.horasTotales} h de ${v.resumen.capacidadDocente} disponibles`);
    for (const b of v.bloqueos ?? []) ve(`  BLOQUEA: ${b.mensaje}`);
    for (const a of (v.advertencias ?? []).slice(0, 2)) ve(`  aviso: ${a.mensaje.slice(0, 90)}`);
    if (v.horasAjenas > 0) ve(`Otras carreras ya pretenden ${v.horasAjenas} horas de esta plantilla`);

    const fus = v.fusionesPosibles ?? [];
    if (fus.length > 0) {
        ve(`El sistema propone ${fus.length} materias que dos grupos cursan a la vez:`);
        for (const f of fus.slice(0, 3)) {
            ve(`  ${f.materiaClave} ${f.materiaNombre} · ${f.grupos.map((g) => g.clave).join(" + ")}` +
               ` · ahorra ${f.horasAhorradas} h`);
        }
    }

    const gen = (await sis.c(`${E}/horario`, {
        metodo: "POST",
        cuerpo: {
            paridad: "impares",
            fusiones: fus.map((f) => ({ materiaId: f.materiaId, grupos: f.grupos.map((g) => g.id) })),
            parametros: PARAMETROS
        }
    })).cuerpo;
    ve(`Genera: ${gen.sesiones.length} bloques en ${gen.milisegundos} ms, ` +
       `${gen.generaciones} generaciones`);
    ve(`Resultado: ${gen.factible ? "factible" : "NO factible"} · ` +
       `duras ${durasDe(gen.diagnostico).map(([k, n]) => `${k}:${n}`).join(" ") || "ninguna"}`);
    const blandas = Object.entries(gen.diagnostico)
        .filter(([k, n]) => n > 0 && !DURAS.has(k))
        .map(([k, n]) => `${k}:${n}`);
    ve(`Lo que no es ideal pero se puede aplicar: ${blandas.join(" ") || "nada"}`);

    const res = (await sis.c(`${E}/reserva`, {
        metodo: "PUT",
        cuerpo: { paridad: "impares", sesiones: gen.sesiones, horario: gen }
    })).cuerpo;
    ve(`Aparta ${res.reservadas} horas en la hoja del instituto` +
       (res.reemplazadas ? ` (reemplaza ${res.reemplazadas} de un intento anterior)` : ""));

    // ------------------------------------------------------------- acto 5
    // Quien arma el horario descubre lo que no se ve al repartir. Antes el
    // sistema le decía que lo pidiera y no había dónde.
    acto(5, "El horario no cuadra con quien le pusieron");
    const suyoISIC = (await sis.c("/plantel/catalogo/ISIC")).cuerpo;
    const conDocente = suyoISIC.filas.filter((f) => f.docenteId);
    dice("Coordinación de Sistemas y TI",
         `Consulta el reparto: ${conDocente.length} de ${suyoISIC.filas.length} clases ya tienen ` +
         "a alguien, y las demás las elige el motor.");

    // Una clase para la que exista de verdad otra persona a quien proponer:
    // pedir un cambio sin alternativa no cuenta la historia, la insinúa.
    const relevo = conDocente
        .map((f) => ({
            fila: f,
            otros: docentes.filter(
                (d) => (d.materiasCapacitadas ?? []).includes(f.materiaId) &&
                       d.id !== f.docenteId && alcanza(d, f).puede
            )
        }))
        .find((c) => c.otros.length > 0);

    if (!relevo) {
        ve("Hoy no hay ninguna clase con un relevo posible: nadie más la puede dar.");
    } else {
        const { fila: molesta, otros } = relevo;
        const propuesto = otros[0];
        dice("Coordinación de Sistemas y TI",
             `${molesta.docenteNombre} tiene ${molesta.clave} en ${molesta.grupoClave}, y le viene ` +
             `mejor ${propuesto.nombre} por cómo le queda la semana.`);
        ve("No puede cambiarlo por su cuenta: eso lo decidió el departamento.");

        const intento = await sis.c(`${E}/horario/ajuste`, {
            metodo: "POST",
            cuerpo: {
                paridad: "impares",
                sesiones: gen.sesiones.map((x) =>
                    x.materiaId === molesta.materiaId && (x.grupoClaves ?? []).includes(molesta.grupoClave)
                        ? { ...x, docenteId: propuesto.id }
                        : x
                )
            }
        });
        ve(intento.estado >= 400
            ? `Lo intenta a mano y el motor lo rechaza: "${intento.cuerpo.error}"`
            : "  (el ajuste a mano lo aceptó, que no debería)");

        // Una pendiente de una corrida anterior impediría pedirla otra vez.
        for (const vieja of (await sis.c("/cambios")).cuerpo ?? []) {
            if (vieja.estado === "pendiente" && vieja.materiaId === molesta.materiaId &&
                vieja.grupoClave === molesta.grupoClave) {
                await sis.c(`/cambios/${vieja.id}`, { metodo: "DELETE" });
            }
        }

        const pedida = await sis.c("/cambios", {
            metodo: "POST",
            cuerpo: {
                carrera: "ISIC", materiaId: molesta.materiaId, grupoClave: molesta.grupoClave,
                propuesto: propuesto.id,
                motivo: "sus horas libres no coinciden con las que necesita el grupo"
            }
        });
        if (pedida.estado !== 201) {
            ve(`No pudo pedirlo: "${pedida.cuerpo?.error}"`);
        } else {
            ve(`Lo pide: "${pedida.cuerpo.motivo}" · propone a ${pedida.cuerpo.propuestoNombre}`);

            const pendientes = ((await depto.c("/cambios")).cuerpo ?? [])
                .filter((x) => x.estado === "pendiente");
            dice("Jefatura",
                 pendientes.length === 1
                     ? "Le llega una petición a la bandeja."
                     : `Le llegan ${pendientes.length} peticiones a la bandeja.`);
            ve(`"${pedida.cuerpo.motivo}" — la pide ${pedida.cuerpo.pedidaPor}`);

            const resuelta = await depto.c(`/cambios/${pedida.cuerpo.id}/responder`, {
                metodo: "POST", cuerpo: { acepta: true, respuesta: "de acuerdo, se la paso" }
            });
            ve(`Acepta, y aceptar es decir a quién: queda ${resuelta.cuerpo.propuestoNombre}. ` +
               "El cambio se aplica en el mismo gesto, no es un acuse.");
            const ahora = (await depto.c("/plantel/catalogo/ISIC")).cuerpo.filas
                .find((f) => f.materiaId === molesta.materiaId && f.grupoClave === molesta.grupoClave);
            ve(`El catálogo ya dice ${ahora.docenteNombre}: antes era ${molesta.docenteNombre}.`);
            const quien = ((await depto.c("/plantel/asignaciones/historial", {
                metodo: "POST",
                cuerpo: { carrera: "ISIC", materiaId: molesta.materiaId, grupoClave: molesta.grupoClave, limite: 1 }
            })).cuerpo ?? [])[0];
            if (quien) ve(`Y el historial dice quién lo hizo y por qué: ${quien.quien} — ${quien.nota}`);
        }
    }

    // ------------------------------------------------------------- acto 6
    acto(6, "Administración llega después y encuentra la plantilla mordida");
    const admon = await entrar("admon");
    dice("Coordinación de Administración", `Lleva ${admon.perfil.carreras.join(", ")}.`);

    const EA = "/carreras/LADM/escenarios/caso-base";
    const INV = [
        { carrera: "IADM", escenarioId: "caso-base" },
        { carrera: "IGEM", escenarioId: "caso-base" }
    ];
    const va = (await admon.c(`${EA}/horario/validacion`, {
        metodo: "POST", cuerpo: { paridad: "impares", invitadas: INV }
    })).cuerpo;
    ve(`Programa sus tres carreras juntas: ${va.grupos.length} grupos`);
    ve(`Ya hay ${va.horasAjenas} horas de la plantilla apartadas por otras coordinaciones`);
    const cruz = va.fusionesEntreCarreras ?? [];
    ve(`Entre sus carreras puede compartir ${cruz.length} materias ` +
       `(${cruz.reduce((n, f) => n + f.horasAhorradas, 0)} h ahorradas):`);
    for (const f of cruz) {
        ve(`  ${f.materiaClave} ${f.materiaNombre} · ${f.carreras.join(" + ")}`);
    }

    const ga = (await admon.c(`${EA}/horario`, {
        metodo: "POST",
        cuerpo: {
            paridad: "impares",
            invitadas: INV,
            fusiones: cruz.map((f) => ({ materiaId: f.materiaId, grupos: f.grupos.map((g) => g.id) })),
            parametros: PARAMETROS
        }
    })).cuerpo;
    ve(`Genera ${ga.sesiones.length} bloques · ${ga.factible ? "factible" : "NO factible"}`);
    const enDisputa = ga.diagnostico.horaEnDisputa ?? 0;
    ve(`De ellas, ${plural(enDisputa, "hora la pretende", "horas las pretenden")} también otra ` +
       `carrera. No lo vuelven imposible: se pueden aplicar si la otra cede.`);
    await admon.c(`${EA}/reserva`, {
        metodo: "PUT",
        cuerpo: { paridad: "impares", invitadas: INV, sesiones: ga.sesiones, horario: ga }
    });

    // ------------------------------------------------------------- acto 7
    acto(7, "Dos coordinaciones sobre el mismo docente");
    const mirar = async () =>
        (await admon.c(`${EA}/conflictos`, { metodo: "POST", cuerpo: { paridad: "impares" } }))
            .cuerpo.conflictos;

    let choques = await mirar();
    dice("Coordinación de Administración",
         `Abre Conciliación: ${plural(choques.length, "choque", "choques")}.`);

    if (choques.length === 0) {
        // Que no choque es el motor haciendo su trabajo: prefiere horas libres.
        // Pero el caso que el sistema existe para resolver es el otro, así que
        // se provoca como se provoca en la realidad: insistiendo en un docente.
        ve("Ninguno: el motor prefirió horas libres, que es lo que debe hacer.");
        ve("Pero la coordinadora insiste en un docente concreto y aparta su hora igual.");

        // Por la hoja de saturación, que es lo que sí ve de las demás: no puede
        // leer la reserva ajena, y así debe ser.
        const hoja = (await admon.c("/saturacion", {
            metodo: "POST", cuerpo: { paridad: "impares" }
        })).cuerpo;
        const suyas = new Set(admon.perfil.carreras);
        let robada = null;
        for (const d of hoja.hojas) {
            for (const dia of d.dias) {
                for (const [i, celda] of dia.horas.entries()) {
                    if (celda.estado !== "ocupada" || suyas.has(celda.carrera)) continue;
                    robada = {
                        docenteId: d.docenteId,
                        docenteNombre: d.nombre,
                        dia: dia.dia,
                        horaInicio: d.horaBase + i,
                        horaFin: d.horaBase + i + 1,
                        grupoId: "g-1a",
                        grupoClave: "1A",
                        materiaClave: "ACC-0906",
                        duenoActual: celda.carrera
                    };
                    break;
                }
                if (robada) break;
            }
            if (robada) break;
        }

        if (robada) {
            await admon.c(`${EA}/reserva`, {
                metodo: "PUT",
                cuerpo: {
                    paridad: "impares",
                    invitadas: INV,
                    sesiones: [...ga.sesiones, robada],
                    horario: { ...ga, sesiones: [...ga.sesiones, robada] }
                }
            });
            ve(`  Aparta ${robada.docenteNombre} · ${robada.dia} ` +
               `${hhmm(robada.horaInicio)}–${hhmm(robada.horaFin)}, que ya tenía ${robada.duenoActual}.`);
            choques = await mirar();
            ve(`  Ahora Conciliación muestra ${plural(choques.length, "choque", "choques")}.`);
        }
    }

    if (choques.length === 0) {
        ve("No se pudo provocar ninguno: el relato de la negociación se salta.");
    } else {
        const x = choques.find((c) => !c.propio) ?? choques[0];
        const otra = x.contra[0];
        ve(`${x.docenteNombre} · ${x.dia} de ${hhmm(x.inicio)} a ${hhmm(x.fin)}`);
        ve(`  ella quiere: ${x.mio.grupo} / ${x.mio.materia}`);
        ve(`  ${otra.carrera} ya la tiene para: ${otra.grupo} / ${otra.materia}`);

        if (x.propio) {
            ve("Las dos carreras son suyas: no hay a quién pedirle nada, suelta y sigue.");
            const r = await admon.c("/conflictos/propio", {
                metodo: "POST",
                cuerpo: {
                    cede: { carrera: otra.carrera, escenarioId: otra.escenarioId },
                    bloque: { docenteId: x.docenteId, dia: x.dia, inicio: x.inicio, fin: x.fin }
                }
            });
            ve(`  Liberadas ${r.cuerpo.liberadas}.`);
        } else {
            const sol = (await admon.c("/solicitudes", {
                metodo: "POST",
                cuerpo: {
                    de: { carrera: "LADM", escenarioId: "caso-base" },
                    a: { carrera: otra.carrera, escenarioId: otra.escenarioId },
                    docenteId: x.docenteId, dia: x.dia, inicio: x.inicio, fin: x.fin,
                    motivo: "Es el único autorizado para esa materia en nuestro turno."
                }
            })).cuerpo;
            ve(`Le pide las horas a ${otra.carrera}, con motivo. Queda "${sol.estado}".`);

            const dueno = otra.carrera === "ISIC" || otra.carrera === "ITIC" || otra.carrera === "IDAP"
                ? sis : null;
            if (dueno) {
                const bandeja = (await dueno.c("/solicitudes")).cuerpo.recibidas
                    .filter((s) => s.estado === "pendiente");
                dice("Coordinación de Sistemas y TI",
                     `Le aparece un aviso: ${bandeja.length} solicitud pendiente.`);
                ve(`"${bandeja[0].deCarrera} pide ${bandeja[0].docenteNombre} · ` +
                   `${bandeja[0].dia} ${hhmm(bandeja[0].inicio)}–${hhmm(bandeja[0].fin)}"`);
                ve(`  motivo: ${bandeja[0].motivo}`);

                const r = (await dueno.c(`/solicitudes/${sol.id}/responder`, {
                    metodo: "POST",
                    cuerpo: { acepta: true, respuesta: "Va, la movemos al otro turno." }
                })).cuerpo;
                const n = r.bloquesLiberados;
                ve(`Cede. Se ${n === 1 ? "libera 1 bloque" : `liberan ${n} bloques`} ` +
                   `de su reserva, de verdad.`);

                const suyo = (await dueno.c(`${E}/reserva`)).cuerpo;
                ve(`Su propio horario queda marcado como desfasado` +
                   (suyo.desfase.alDia
                       ? " — no, sigue al día"
                       : `: ${plural(suyo.desfase.sesionesPerdidas.length, "clase", "clases")} sin sus horas`));
                for (const s of suyo.desfase.sesionesPerdidas.slice(0, 2)) {
                    ve(`  ${s.grupoClave} ${s.materiaClave} · ${s.dia} ${hhmm(s.horaInicio)}–${hhmm(s.horaFin)}`);
                }
            }
        }
    }

    // ------------------------------------------------------------- acto 8
    // Las aulas son el otro recurso compartido. Antes esto solo se veía como
    // violación después de generar, cuando ya hay que rehacer el horario.
    acto(8, "Qué aulas quedan, antes de colocar nada");
    const aulas = (await sis.c("/saturacion/aulas", {
        metodo: "POST", cuerpo: { paridad: "impares" }
    })).cuerpo;
    const tomadas = aulas.hojas.reduce((n, h) => n + h.resumen.ocupadas, 0);
    const vacias = aulas.hojas.filter((h) => h.resumen.ocupadas === 0);
    dice("Coordinación de Sistemas y TI", "Mira la ocupación antes de mover nada más.");
    ve(`${aulas.hojas.length} espacios · ${tomadas} horas tomadas · ` +
       `${plural(vacias.length, "espacio que nadie usa", "espacios que nadie usa")}`);

    const compartidas = aulas.hojas.filter((h) => h.resumen.carreras.length > 1);
    const ajenas = aulas.hojas.filter((h) => h.resumen.ocupadas > 0 && h.resumen.propias === 0);
    for (const h of aulas.hojas.filter((x) => x.resumen.ocupadas > 0).slice(0, 4)) {
        ve(`  ${h.clave}: ${h.resumen.ocupadas} de ${h.resumen["hábiles"]} tomadas · ` +
           `la usan ${h.resumen.carreras.join(", ")}` +
           (h.resumen.propias === 0 ? " — ninguna es suya" : ""));
    }
    if (ajenas.length > 0) {
        ve(`${plural(ajenas.length, "espacio está ocupado", "espacios están ocupados")} solo por ` +
           "otras coordinaciones: esas horas hay que negociarlas, no moverlas.");
    }
    if (compartidas.length > 0) {
        ve(`${plural(compartidas.length, "espacio se reparte", "espacios se reparten")} entre ` +
           "varias carreras a distintas horas, que es lo normal.");
    }

    // ------------------------------------------------------------- acto 9
    acto(9, "El coordinador mueve una clase a mano");
    const clase = gen.sesiones[0];
    // A otro día del que ya tiene: moverla al mismo no probaría nada y el
    // relato se contradiría solo.
    const destino = gen.rejilla.dias.find((d) => d !== clase.dia);

    dice("Coordinación de Sistemas y TI",
         `Un docente avisa que el ${clase.dia} ya no puede. Eso el sistema no lo sabe.`);
    ve(`Pulsa ${clase.materiaNombre} de ${clase.grupoClave}, ` +
       `${clase.dia} ${hhmm(clase.horaInicio)}–${hhmm(clase.horaFin)}`);

    const movido = gen.sesiones.map((s) =>
        s.indice === clase.indice ? { ...s, dia: destino } : s
    );
    const ajuste = (await sis.c(`${E}/horario/ajuste`, {
        metodo: "POST", cuerpo: { paridad: "impares", sesiones: movido }
    })).cuerpo;
    ve(`La mueve al ${destino}. El motor reevalúa con sus mismas reglas:`);
    const rotas = durasDe(ajuste.diagnostico);
    if (rotas.length === 0) ve("  Cabe sin romper nada.");
    else for (const [k, n] of rotas) ve(`  ${k}: ${n}`);
    ve(`Queda como propuesta: hay que volver a apartarla para que cuente.`);

    ve("");
    ve("Un movimiento imposible se rechaza antes de evaluarlo:");
    const malo = (await sis.c(`${E}/horario/ajuste`, {
        metodo: "POST",
        cuerpo: {
            paridad: "impares",
            sesiones: gen.sesiones.map((s) => (s.indice === clase.indice ? { ...s, horaInicio: 23 } : s))
        }
    })).cuerpo;
    ve(`  "${malo.error}"`);

    // ------------------------------------------------------------- acto 10
    acto(10, "La hoja compartida, que es de lo que iba todo");
    const hoja = (await depto.c("/saturacion", {
        metodo: "POST", cuerpo: { paridad: "impares" }
    })).cuerpo;
    const ocupadas = hoja.hojas.reduce((n, d) => n + d.resumen.ocupadas, 0);
    const libres = hoja.hojas.reduce((n, d) => n + d.resumen.libres, 0);
    dice("Jefatura del departamento académico", "Mira la hoja de horas catedrático.");
    ve(`${ocupadas} horas apartadas, ${libres} libres — ` +
       `${Math.round((ocupadas * 100) / (ocupadas + libres))}% de saturación`);

    const apretados = [...hoja.hojas]
        .sort((a, b) => b.resumen.ocupadas - a.resumen.ocupadas)
        .slice(0, 3);
    for (const d of apretados) {
        ve(`  ${d.nombre.padEnd(28)} ${d.resumen.ocupadas} de ${d.resumen.declaradas} declaradas`);
    }

    const historial = (await depto.c("/saturacion/historial", {
        metodo: "POST", cuerpo: { limite: 5 }
    })).cuerpo;
    ve("");
    ve("Y quién hizo qué con esas horas:");
    for (const h of historial) {
        ve(`  ${h.momento.slice(11, 16)} ${h.carrera.padEnd(5)} ${h.accion.padEnd(9)} ` +
           `${(h.docenteNombre ?? "").slice(0, 22).padEnd(24)} ${h.dia} ${h.inicio}-${h.fin}` +
           (h.nota ? `  (${h.nota})` : ""));
    }

    // ------------------------------------------------------------- acto 11
    // La primera pregunta de cualquier docente, y hasta hace poco no la
    // contestaba nadie: su enlace solo abría el formulario.
    acto(11, "El docente abre su enlace y ve qué le tocó");
    const conHoras = (hoja.hojas ?? []).filter((h) =>
        h.dias.some((d) => d.horas.some((c) => c.estado === "ocupada"))
    );
    const mirado = enlaces.find((e) => conHoras.some((h) => h.docenteId === e.docenteId));
    if (mirado) {
        const anon2 = cliente();
        const mio = (await anon2(`/mi-horario/${mirado.token}`)).cuerpo;
        const periodo = mio.periodos[0];
        dice(mirado.nombre, "Abre el mismo enlace con el que declaró su horario.");
        if (!periodo) {
            ve("Todavía no hay nada apartado para él.");
        } else {
            const horas = periodo.bloques.reduce((n, b) => n + (b.fin - b.inicio), 0);
            const carreras = [...new Set(periodo.bloques.map((b) => b.carrera))];
            ve(`Su semana: ${horas} h en ${plural(carreras.length, "carrera", "carreras")} ` +
               `(${carreras.join(", ")}) · ${periodo.cerrado ? "definitivo" : "borrador, puede cambiar"}`);
            for (const b of periodo.bloques.slice(0, 4)) {
                ve(`  ${b.dia} ${hhmm(b.inicio)}–${hhmm(b.fin)} · ${b.materia} · ` +
                   `${b.grupo} de ${b.carrera} · aula ${b.aula ?? "por definir"}`);
            }
            ve("Nadie más se la había armado entera: cada coordinación solo tenía su parte.");
        }
        ve(`Y sigue sin ver nada ajeno: la plantilla le responde ` +
           `HTTP ${(await anon2("/docentes")).estado}`);
    }

    // ------------------------------------------------------------- acto 12
    acto(12, "Se cierra la negociación");
    dice("Jefatura del departamento académico", "Cierra el semestre de impares.");
    await depto.c("/periodos/impares/cerrar", { metodo: "POST" });
    const intento = await sis.c(`${E}/reserva`, {
        metodo: "PUT", cuerpo: { paridad: "impares", sesiones: [] }
    });
    ve(`Sistemas intenta mover sus horas: HTTP ${intento.estado}`);
    ve(`  "${intento.cuerpo.error}"`);
    await depto.c("/periodos/impares/cerrar", { metodo: "DELETE" });
    ve("Se reabre para dejar el sistema como estaba.");

    console.log(`
${"━".repeat(70)}
 Fin. Lo apartado se queda: es el estado normal de un periodo
` +
                ` en marcha. Para vaciarlo, cada coordinación suelta su reserva.
${"━".repeat(70)}
`);
}

await main();
