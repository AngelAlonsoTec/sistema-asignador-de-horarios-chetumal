/**
 * Pruebas de la lógica de dominio del frontend.
 *
 * Con el corredor de Node y sin dependencias nuevas, igual que el backend.
 * Cubre `src/dominio/`, que es donde vive la lógica de verdad: funciones puras
 * sobre los datos en memoria, sin DOM. Los componentes siguen sin prueba —
 * montarlos exigiría vitest y un DOM simulado, y esto cubre lo que puede
 * corromper datos en silencio.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { porSemestre, porEspecialidad, materiasDeEspecialidad, porDiaYHora } from "../src/dominio/agrupar.js";
import { contarDocentesPorMateria, calcularCobertura } from "../src/dominio/cobertura.js";
import { contiene, plano } from "../src/dominio/texto.js";
import {
    claveAId,
    nombreAIdEspecialidad,
    siguienteIdDocente,
    agregarMateria,
    editarMateria,
    eliminarMateria,
    agregarEspecialidad,
    editarEspecialidad,
    eliminarEspecialidad,
    asignarDocentesAMateria,
    agregarAula,
    eliminarAula
} from "../src/dominio/edicion.js";

function datosDePrueba() {
    return {
        materias: [
            { id: "m1", clave: "ACF-0901", nombre: "Cálculo", semestre: 1, especialidadId: null },
            { id: "m2", clave: "SCD-1015", nombre: "Autómatas", semestre: 7, especialidadId: "web" },
            { id: "m3", clave: "SCD-1004", nombre: "Redes", semestre: 7, especialidadId: null }
        ],
        docentes: [
            { id: "doc001", nombre: "Ana", materiasCapacitadas: ["m1", "m2"] },
            { id: "doc007", nombre: "Beto", materiasCapacitadas: ["m2"] }
        ],
        especialidades: [{ id: "web", nombre: "Desarrollo Web" }],
        aulas: [{ id: "a1", clave: "V-1", tipo: "aula" }]
    };
}

// ---------------------------------------------------------------- ids

test("la clave se normaliza igual que en los datos existentes", () => {
    assert.equal(claveAId("ACF-0901"), "acf_0901");
    assert.equal(claveAId("  acf-0901  "), "acf_0901");
});

test("el id de especialidad pierde acentos y evita colisiones", () => {
    assert.equal(nombreAIdEspecialidad("Inteligencia Artificial", new Set()), "inteligencia-artificial");
    assert.equal(nombreAIdEspecialidad("Gestión de Redes", new Set()), "gestion-de-redes");
    assert.equal(
        nombreAIdEspecialidad("Redes", new Set(["redes", "redes-2"])),
        "redes-3",
        "sigue buscando hasta encontrar libre"
    );
});

test("un nombre sin letras utilizables no produce un id vacío", () => {
    assert.equal(nombreAIdEspecialidad("¿?¡!", new Set()), "especialidad");
});

test("el siguiente id de docente continúa la numeración, no la longitud", () => {
    // doc007 es el mayor aunque solo haya dos: contar elementos daría doc003 y
    // chocaría en cuanto alguien borre uno de en medio.
    assert.equal(siguienteIdDocente(datosDePrueba().docentes), "doc008");
    assert.equal(siguienteIdDocente([]), "doc001");
});

// ---------------------------------------------------------------- edición

test("no se puede agregar dos materias con la misma clave", () => {
    const datos = datosDePrueba();
    assert.throws(() => agregarMateria(datos, { id: "m1", clave: "ACF-0901" }), /Ya existe/);
    assert.equal(datos.materias.length, 3);
});

test("renombrar una materia a una clave ocupada se rechaza", () => {
    const datos = datosDePrueba();
    assert.throws(() => editarMateria(datos, "m1", { id: "m2", clave: "SCD-1015" }), /Ya existe/);
});

test("borrar una materia limpia las referencias de los docentes", () => {
    // Sin esto, un docente quedaría "capacitado" para una materia que no existe
    // y la cobertura mentiría.
    const datos = datosDePrueba();
    eliminarMateria(datos, "m2");

    assert.deepEqual(datos.materias.map((m) => m.id), ["m1", "m3"]);
    assert.deepEqual(datos.docentes[0].materiasCapacitadas, ["m1"]);
    assert.deepEqual(datos.docentes[1].materiasCapacitadas, []);
});

test("borrar una especialidad devuelve sus materias a tronco común, no las borra", () => {
    const datos = datosDePrueba();
    eliminarEspecialidad(datos, "web");

    assert.deepEqual(datos.especialidades, []);
    assert.equal(datos.materias.length, 3, "las materias son reales, no cuelgan de la especialidad");
    assert.equal(datos.materias.find((m) => m.id === "m2").especialidadId, null);
});

test("editar una especialidad liga y desliga materias en un solo paso", () => {
    const datos = datosDePrueba();
    editarEspecialidad(datos, "web", { nombre: "Web" }, ["m3"]);

    assert.equal(datos.materias.find((m) => m.id === "m2").especialidadId, null, "salió");
    assert.equal(datos.materias.find((m) => m.id === "m3").especialidadId, "web", "entró");
});

test("dos especialidades no pueden llamarse igual", () => {
    const datos = datosDePrueba();
    agregarEspecialidad(datos, { id: "otra", nombre: "Otra" }, []);
    assert.throws(() => editarEspecialidad(datos, "otra", { nombre: "Desarrollo Web" }, []), /Ya existe/);
});

test("asignar docentes a una materia es el mismo dato escrito al revés", () => {
    const datos = datosDePrueba();
    asignarDocentesAMateria(datos, "m2", ["doc007"]);

    assert.deepEqual(datos.docentes[0].materiasCapacitadas, ["m1"], "a Ana se le quitó");
    assert.deepEqual(datos.docentes[1].materiasCapacitadas, ["m2"], "Beto se queda, sin duplicar");
});

test("asignar dos veces no duplica la materia en el docente", () => {
    const datos = datosDePrueba();
    asignarDocentesAMateria(datos, "m2", ["doc001", "doc007"]);
    asignarDocentesAMateria(datos, "m2", ["doc001", "doc007"]);
    assert.deepEqual(datos.docentes[0].materiasCapacitadas, ["m1", "m2"]);
});

test("borrar un aula que no existe avisa en vez de callar", () => {
    const datos = datosDePrueba();
    assert.throws(() => eliminarAula(datos, "a999"), /No existe/);
    assert.throws(() => agregarAula(datos, { id: "a1", clave: "V-1" }), /Ya existe/);
});

// ---------------------------------------------------------------- agrupar

test("las materias salen por semestre ascendente", () => {
    const grupos = porSemestre(datosDePrueba().materias);
    assert.deepEqual(grupos.map(([semestre]) => semestre), [1, 7]);
    assert.equal(grupos[1][1].length, 2);
});

test("el tronco común va primero y los grupos vacíos no aparecen", () => {
    const datos = datosDePrueba();
    const grupos = porEspecialidad(datos.materias, [...datos.especialidades, { id: "vacia", nombre: "Vacía" }]);

    assert.deepEqual(grupos.map(([clave]) => clave), [null, "web"]);
    assert.equal(grupos[0][1].length, 2);
});

test("una materia de una especialidad desconocida cae en tronco común", () => {
    // Pasa al borrar una especialidad sin recargar: la referencia queda colgando
    // y la tabla no debe perder la materia.
    const datos = datosDePrueba();
    datos.materias[1].especialidadId = "fantasma";
    const grupos = porEspecialidad(datos.materias, datos.especialidades);

    assert.equal(grupos.find(([c]) => c === null)[1].length, 3);
});

test("las materias de una especialidad salen del semestre más bajo al más alto", () => {
    const materias = [
        { id: "b", clave: "B", semestre: 9, especialidadId: "web" },
        { id: "a", clave: "A", semestre: 7, especialidadId: "web" },
        { id: "c", clave: "C", semestre: 7, especialidadId: "otra" }
    ];
    assert.deepEqual(materiasDeEspecialidad(materias, "web").map((m) => m.id), ["a", "b"]);
});

test("porDiaYHora agrupa las sesiones que empiezan a la misma hora", () => {
    // Dos a la misma hora es lo normal: son grupos distintos.
    const mapa = porDiaYHora([
        { diaIndice: 0, horaInicio: 7 },
        { diaIndice: 0, horaInicio: 7 },
        { diaIndice: 0, horaInicio: 9 },
        { diaIndice: 3, horaInicio: 7 }
    ]);

    assert.equal(mapa.get(0).get(7).length, 2);
    assert.equal(mapa.get(0).get(9).length, 1);
    assert.equal(mapa.get(3).get(7).length, 1);
    assert.equal(mapa.has(1), false);
});

// ---------------------------------------------------------------- cobertura

test("la cobertura cuenta las materias sin ningún docente", () => {
    const datos = datosDePrueba();
    const c = calcularCobertura(datos.materias, datos.docentes);

    assert.equal(c.total, 3);
    assert.equal(c.cubiertas, 2);
    // `sinDocente` lleva los ids y no un conteo: la interfaz las nombra para
    // llevar al coordinador a la que falta.
    assert.deepEqual(c.sinDocente, ["m3"]);
    assert.equal(c.completa, false);
});

test("una materia que un docente lista pero que no existe no infla el conteo", () => {
    const datos = datosDePrueba();
    datos.docentes[0].materiasCapacitadas.push("fantasma");
    const cuenta = contarDocentesPorMateria(datos.materias, datos.docentes);

    assert.equal(cuenta.has("fantasma"), false);
    assert.equal(cuenta.get("m1"), 1);
    assert.equal(cuenta.get("m2"), 2);
});

// ---------------------------------------------------------------- búsqueda

test("buscar ignora acentos: en español se teclea sin ellos", () => {
    // "etica" no encontraba "Taller de Ética", y quien buscaba concluía que la
    // materia no estaba en el catálogo.
    assert.equal(contiene("ACA-0907 Taller de Ética", "etica"), true);
    assert.equal(contiene("ACA-0907 Taller de Ética", "ética"), true);
    assert.equal(contiene("Matemáticas Discretas", "matematicas"), true);
    assert.equal(contiene("Álgebra Lineal", "algebra"), true);
});

test("y también mayúsculas y espacios de sobra", () => {
    assert.equal(contiene("Cálculo Diferencial", "  CÁLCULO  "), true);
    assert.equal(contiene("Cálculo Diferencial", "integral"), false);
});

test("una búsqueda vacía no filtra nada", () => {
    assert.equal(contiene("lo que sea", ""), true);
    assert.equal(contiene("lo que sea", "   "), true);
});

test("la ñ también se pliega, que es lo que sirve para buscar", () => {
    // Es una letra propia, no una vocal acentuada, pero quien teclea "diseno"
    // espera encontrar "Diseño". Para comparar texto escrito a la carrera, que
    // "año" y "ano" colisionen no molesta a nadie buscando materias.
    assert.equal(plano("Año"), "ano");
    assert.equal(contiene("Diseño de Software", "diseno"), true);
    assert.equal(plano("ÉÍÓÚ"), "eiou");
});
