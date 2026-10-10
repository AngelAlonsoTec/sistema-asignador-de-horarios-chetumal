/**
 * Pruebas de componentes.
 *
 * Cubren lo que la lógica de dominio no puede: que el componente dibuje lo que
 * los datos dicen. Se montan de verdad, con un DOM simulado, porque el defecto
 * típico aquí no es un cálculo mal hecho sino una condición que nunca se cumple
 * o una etiqueta que no llega.
 */

import { describe, test, expect } from "vitest";
import { mount } from "@vue/test-utils";

import RejillaHorario from "../src/componentes/RejillaHorario.vue";
import HorarioImprimible from "../src/componentes/HorarioImprimible.vue";
import ListaPendientes from "../src/componentes/ListaPendientes.vue";
import { alcanza } from "../src/dominio/turnos.js";

const REJILLA = {
    dias: ["lunes", "martes", "miercoles", "jueves", "viernes"],
    turnos: [
        { id: "matutino", horaInicio: 7, horaFin: 14 },
        { id: "vespertino", horaInicio: 14, horaFin: 22 }
    ]
};

const SESION = {
    grupoId: "g1",
    grupoClave: "1A",
    grupoClaves: ["1A"],
    materiaId: "m1",
    materiaNombre: "Cálculo Diferencial",
    docenteId: "d1",
    docenteNombre: "Laura Mendoza",
    aulaClave: "V-1",
    esAulaBase: true,
    fusionada: false,
    diaIndice: 0,
    horaInicio: 7,
    horaFin: 9
};

const montarRejilla = (props) =>
    mount(RejillaHorario, {
        props: { sesiones: [SESION], rejilla: REJILLA, turno: "matutino", tonos: new Map(), ...props }
    });

describe("RejillaHorario", () => {
    test("un bloque de dos horas ocupa una sola celda", () => {
        // Repetirlo en cada hora haría creer que son dos clases distintas.
        const r = montarRejilla();
        const clases = r.findAll("td.rejilla-clase");

        expect(clases).toHaveLength(1);
        expect(clases[0].attributes("rowspan")).toBe("2");
        expect(clases[0].text()).toContain("Cálculo Diferencial");
    });

    test("la franja abarca el turno pedido, no el día entero", () => {
        expect(montarRejilla().findAll("tbody tr")).toHaveLength(7);
        expect(montarRejilla({ turno: "vespertino", sesiones: [] }).findAll("tbody tr")).toHaveLength(8);
    });

    test("un turno desconocido no deja la tabla vacía", () => {
        // Cae al primero en vez de romperse: una rejilla en blanco no diría qué
        // pasó, y el turno lo puede traer un dato viejo.
        expect(montarRejilla({ turno: "nocturno" }).findAll("tbody tr")).toHaveLength(7);
    });

    test("para un grupo, el aula solo se nombra al salir de la suya", () => {
        expect(montarRejilla().find(".rejilla-aula").exists()).toBe(false);

        const fuera = montarRejilla({ sesiones: [{ ...SESION, esAulaBase: false, aulaClave: "LAB-2" }] });
        expect(fuera.find(".rejilla-aula").text()).toBe("LAB-2");
    });

    test("para un docente cambia lo que se nombra: el grupo y el aula, no él", () => {
        const r = montarRejilla({ conGrupo: true });
        const celda = r.find("td.rejilla-clase");

        expect(celda.text()).not.toContain("Laura Mendoza");
        expect(celda.text()).toContain("1A");
        expect(celda.find(".rejilla-aula").text()).toBe("V-1");
    });

    test("una fusión nombra a todos sus grupos y se marca", () => {
        const r = montarRejilla({
            conGrupo: true,
            sesiones: [{ ...SESION, fusionada: true, grupoClaves: ["1A", "1B"] }]
        });
        expect(r.find("td.rejilla-clase").text()).toContain("1A + 1B");
        expect(r.find(".rejilla-fusion").exists()).toBe(true);
    });

    test("sin sesiones la rejilla sigue dibujada y vacía", () => {
        const r = montarRejilla({ sesiones: [] });
        expect(r.findAll("td.rejilla-clase")).toHaveLength(0);
        expect(r.findAll("td.rejilla-libre").length).toBe(7 * 5);
    });
});

describe("HorarioImprimible", () => {
    const resultado = {
        rejilla: REJILLA,
        grupos: [
            { id: "g1", clave: "1A", semestre: 1, turno: "matutino", aulaClave: "V-1", carrera: "ISIC" },
            { id: "g2", clave: "1A", semestre: 1, turno: "matutino", aulaClave: "V-2", carrera: "ITIC" }
        ],
        sesiones: [
            { ...SESION, grupoIds: ["g1", "g2"], fusionada: true, grupoClaves: ["1A", "1A"] },
            { ...SESION, grupoId: "g2", grupoIds: ["g2"], docenteId: "d2", docenteNombre: "Otro",
              diaIndice: 1, horaInicio: 16, horaFin: 18 }
        ]
    };
    const montar = (alcance) =>
        mount(HorarioImprimible, { props: { resultado, tonos: new Map(), alcance } });

    test("una hoja por grupo, y la fusionada sale en las dos", () => {
        const hojas = montar("grupos").findAll(".hoja");
        expect(hojas).toHaveLength(2);
        expect(hojas[0].text()).toContain("Cálculo Diferencial");
        expect(hojas[1].text()).toContain("Cálculo Diferencial");
    });

    test("con dos carreras, el título distingue los grupos homónimos", () => {
        // Los dos se llaman 1A: sin la carrera, las dos hojas serían iguales.
        const titulos = montar("grupos").findAll(".hoja-titulo").map((t) => t.text());
        expect(titulos[0]).toContain("ISIC");
        expect(titulos[1]).toContain("ITIC");
    });

    test("una hoja por docente, ordenadas por nombre", () => {
        const hojas = montar("docentes").findAll(".hoja-titulo").map((t) => t.text());
        expect(hojas).toEqual(["Laura Mendoza", "Otro"]);
    });

    test("la rejilla del docente se acota a las horas que ocupa", () => {
        // Un docente de tarde con una rejilla de 07:00 a 22:00 recibiría nueve
        // filas vacías, y además no cabría en una página.
        const hojas = montar("docentes").findAll(".hoja");
        const deOtro = hojas.find((h) => h.text().includes("Otro"));
        expect(deOtro.findAll("tbody tr")).toHaveLength(4); // 15:00 a 19:00
    });

    test("la hoja avisa de lo que el grupo cursa y el horario no trae", () => {
        // Nadie autorizado para "m9": la clase se apartó y la rejilla sale con
        // un hueco que en papel no se distingue de una hora libre.
        const conFaltante = {
            ...resultado,
            grupos: resultado.grupos.map((g) =>
                g.id === "g1" ? { ...g, materias: ["m1", "m9"] } : g
            )
        };
        const r = mount(HorarioImprimible, {
            props: {
                resultado: conFaltante,
                tonos: new Map(),
                alcance: "grupos",
                materias: [
                    { id: "m1", clave: "ACF-0901", nombre: "Cálculo", horasSemana: 5 },
                    { id: "m9", clave: "SCH-1024", nombre: "Taller", horasSemana: 4 }
                ]
            }
        });
        const aviso = r.find(".hoja-faltan");
        expect(aviso.exists()).toBe(true);
        expect(aviso.text()).toContain("SCH-1024 Taller (4 h)");
        expect(aviso.text()).not.toContain("ACF-0901");
    });

    test("un horario apartado sin las materias del grupo no inventa faltantes", () => {
        // Los guardados antes de que el grupo viajara con su retícula no traen
        // con qué comparar: callar es mejor que avisar de un faltante inventado.
        expect(montar("grupos").find(".hoja-faltan").exists()).toBe(false);
    });

    test("«ambos» imprime grupos y docentes; en pantalla no se ve nada", () => {
        expect(montar("ambos").findAll(".hoja")).toHaveLength(4);
        expect(montar("grupos").find(".impresion").exists()).toBe(true);
    });
});

describe("ListaPendientes", () => {
    const NECESIDAD = {
        codigo: "materias-sin-docente",
        mensaje: "3 materias no tienen a nadie autorizado para darlas (11 h/semana).",
        seccion: "materias",
        horas: 11,
        detalle: ["A · Uno: 4 h", "B · Dos: 4 h", "C · Tres: 3 h"]
    };
    const montar = (props) =>
        mount(ListaPendientes, {
            props: { secciones: { materias: "Materias" }, ...props }
        });

    test("el tono distingue un bloqueo de una necesidad", () => {
        expect(montar({ items: [NECESIDAD], tono: "necesidad" }).find("ul").classes())
            .toContain("lista-necesidad");
        expect(montar({ items: [NECESIDAD], tono: "bloqueo" }).find("ul").classes())
            .toContain("lista-bloqueo");
    });

    test("el detalle se abre y se cierra, y dice cuántos hay", () => {
        const r = montar({ items: [NECESIDAD], tono: "necesidad" });
        const ver = r.findAll("button").find((b) => b.text().startsWith("Ver"));
        expect(ver.text()).toBe("Ver 3");
        expect(r.find(".bloqueo-detalle").exists()).toBe(false);

        return ver.trigger("click").then(async () => {
            expect(r.findAll(".bloqueo-detalle li")).toHaveLength(3);
            await r.findAll("button").find((b) => b.text() === "Ocultar").trigger("click");
            expect(r.find(".bloqueo-detalle").exists()).toBe(false);
        });
    });

    test("sin detalle y sin sección conocida no se ofrecen botones", () => {
        // La necesidad de capacidad no tiene detalle: es una cifra, no una lista.
        const r = montar({
            items: [{ codigo: "capacidad-docente", mensaje: "Faltan 25 h.", seccion: "docentes", detalle: [] }],
            tono: "necesidad"
        });
        expect(r.findAll("button")).toHaveLength(0);
        expect(r.text()).toContain("Faltan 25 h.");
    });
});

describe("alcance del docente en un turno", () => {
    const conBloques = (bloques) => ({ disponibilidad: { declarada: bloques } });
    const soloLunes = conBloques([{ dia: "lunes", inicio: 7, fin: 14 }]);
    const todaLaManana = conBloques(
        ["lunes", "martes", "miércoles", "jueves", "viernes"].map((dia) => ({ dia, inicio: 7, fin: 14 }))
    );

    test("quien no declaró ese turno no puede", () => {
        expect(alcanza(todaLaManana, "vespertino", 4).puede).toBe(false);
    });

    test("tener horas no basta: una materia no se repite el mismo día", () => {
        // Siete horas el lunes sobran para una materia de cinco, pero son tres
        // bloques y solo hay un día: es lo que producía horas imposibles.
        const r = alcanza(soloLunes, "matutino", 5);
        expect(r.puede).toBe(false);
        expect(r.motivo).toMatch(/día/);
    });

    test("con la semana entera declarada sí", () => {
        expect(alcanza(todaLaManana, "matutino", 5).puede).toBe(true);
    });

    test("sin turno conocido no se opina", () => {
        expect(alcanza(soloLunes, "inventado", 5).puede).toBe(true);
    });
});
