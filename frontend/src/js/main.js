/**
 * Punto de entrada de "Datos base". Coordina las dos vistas (lista de
 * escenarios y detalle de un escenario) y conecta los datos con la UI;
 * ningún otro archivo toca ambos lados.
 */

import { CARRERA_POR_DEFECTO, nombreCarrera } from "./catalogo.js";
import { obtenerEscenariosPorCarrera, obtenerEscenario, crearEscenario, olvidarEscenario } from "./escenarios.js";
import { guardarEscenario, guardarAulas, eliminarEscenario } from "./guardar.js";
import { iniciarTabs } from "./ui/tabs.js";
import { renderEscenarios, renderError, renderCargando } from "./ui/escenarios-view.js";
import { crearDetalle } from "./ui/escenario-detalle.js";
import { crearFormularioMateria } from "./ui/formulario-materia.js";
import { crearFormularioDocente } from "./ui/formulario-docente.js";
import { crearFormularioAula } from "./ui/formulario-aula.js";
import { crearFormularioEscenario } from "./ui/formulario-escenario.js";
import { crearFormularioEspecialidad } from "./ui/formulario-especialidad.js";
import { crearFormularioDocentesMateria } from "./ui/formulario-docentes-materia.js";

const formularioEscenario = crearFormularioEscenario({
    dialogo: document.getElementById("dialog-escenario"),
    form: document.getElementById("form-escenario"),
    nombre: document.getElementById("escenario-nombre"),
    basadoEn: document.getElementById("escenario-basado-en"),
    error: document.getElementById("escenario-form-error"),
    cancelar: document.getElementById("escenario-cancelar")
});

const formularioMateria = crearFormularioMateria({
    dialogo: document.getElementById("dialog-materia"),
    form: document.getElementById("form-materia"),
    titulo: document.getElementById("materia-form-titulo"),
    clave: document.getElementById("materia-clave"),
    nombre: document.getElementById("materia-nombre"),
    semestre: document.getElementById("materia-semestre"),
    horas: document.getElementById("materia-horas"),
    creditos: document.getElementById("materia-creditos"),
    especialidad: document.getElementById("materia-especialidad"),
    error: document.getElementById("materia-form-error"),
    cancelar: document.getElementById("materia-cancelar")
});

const formularioDocente = crearFormularioDocente({
    dialogo: document.getElementById("dialog-docente"),
    form: document.getElementById("form-docente"),
    titulo: document.getElementById("docente-form-titulo"),
    nombre: document.getElementById("docente-nombre"),
    categoria: document.getElementById("docente-categoria"),
    nivel: document.getElementById("docente-nivel"),
    horasMin: document.getElementById("docente-horas-min"),
    horasMax: document.getElementById("docente-horas-max"),
    maxMaterias: document.getElementById("docente-max-materias"),
    maxGrupos: document.getElementById("docente-max-grupos"),
    antiguedad: document.getElementById("docente-antiguedad"),
    carreraBase: document.getElementById("docente-carrera-base"),
    otraArea: document.getElementById("docente-otra-area"),
    turno: document.getElementById("docente-turno"),
    horasEvitar: document.getElementById("docente-horas-evitar"),
    diasPreferidos: document.getElementById("docente-dias-preferidos"),
    diasEvitar: document.getElementById("docente-dias-evitar"),
    materiasChecklist: document.getElementById("docente-materias-checklist"),
    error: document.getElementById("docente-form-error"),
    cancelar: document.getElementById("docente-cancelar")
});

const formularioEspecialidad = crearFormularioEspecialidad({
    dialogo: document.getElementById("dialog-especialidad"),
    form: document.getElementById("form-especialidad"),
    titulo: document.getElementById("especialidad-form-titulo"),
    nombre: document.getElementById("especialidad-nombre"),
    materiasChecklist: document.getElementById("especialidad-materias-checklist"),
    error: document.getElementById("especialidad-form-error"),
    cancelar: document.getElementById("especialidad-cancelar")
});

const formularioDocentesMateria = crearFormularioDocentesMateria({
    dialogo: document.getElementById("dialog-docentes-materia"),
    form: document.getElementById("form-docentes-materia"),
    titulo: document.getElementById("docentes-materia-form-titulo"),
    nota: document.getElementById("docentes-materia-nota"),
    checklist: document.getElementById("docentes-materia-checklist"),
    cancelar: document.getElementById("docentes-materia-cancelar")
});

const formularioAula = crearFormularioAula({
    dialogo: document.getElementById("dialog-aula"),
    form: document.getElementById("form-aula"),
    titulo: document.getElementById("aula-form-titulo"),
    clave: document.getElementById("aula-clave"),
    tipo: document.getElementById("aula-tipo"),
    error: document.getElementById("aula-form-error"),
    cancelar: document.getElementById("aula-cancelar")
});

const vistas = {
    lista: document.getElementById("vista-lista"),
    detalle: document.getElementById("vista-detalle")
};

const lista = {
    tabs: document.getElementById("tabs-carrera"),
    titulo: document.getElementById("carrera-nombre"),
    escenarios: document.getElementById("escenario-list"),
    plantilla: document.getElementById("tpl-escenario")
};

const detalle = crearDetalle({
    tabs: document.getElementById("tabs-entidad"),
    contenido: document.getElementById("detalle-contenido"),
    barra: document.getElementById("barra-filtros"),
    busqueda: document.getElementById("busqueda"),
    filtros: document.getElementById("filtros-materia"),
    refs: {
        nombre: document.getElementById("detalle-nombre"),
        fecha: document.getElementById("detalle-fecha"),
        badge: document.getElementById("detalle-badge"),
        semestre: document.getElementById("detalle-semestre"),
        cobertura: document.getElementById("detalle-cobertura"),
        agregar: document.getElementById("detalle-agregar"),
        guardar: document.getElementById("detalle-guardar")
    },
    formularios: {
        materia: formularioMateria,
        docente: formularioDocente,
        especialidad: formularioEspecialidad,
        docentesMateria: formularioDocentesMateria,
        aula: formularioAula
    }
});

/** Estado mínimo del nivel superior: qué carrera se está listando. */
let carreraActiva = CARRERA_POR_DEFECTO;

// ---------- vista: lista de escenarios ----------

async function mostrarLista(carrera) {
    carreraActiva = carrera;
    lista.titulo.textContent = nombreCarrera(carrera);
    mostrarVista("lista");
    renderCargando(lista.escenarios);

    try {
        const escenarios = await obtenerEscenariosPorCarrera(carrera);
        renderEscenarios(lista.escenarios, lista.plantilla, escenarios);
    } catch (error) {
        console.error(error);
        renderError(lista.escenarios, `No se pudieron cargar los datos de ${carrera}.`);
    }
}

// ---------- vista: detalle de un escenario ----------

async function abrirEscenario(id) {
    renderCargando(lista.escenarios);

    try {
        detalle.mostrar(await obtenerEscenario(carreraActiva, id));
        mostrarVista("detalle");
    } catch (error) {
        console.error(error);
        renderError(lista.escenarios, "No se pudo abrir el escenario.");
    }
}

function mostrarVista(nombre) {
    for (const [clave, elemento] of Object.entries(vistas)) {
        elemento.hidden = clave !== nombre;
    }
}

// ---------- acciones de las tarjetas ----------

lista.escenarios.addEventListener("click", (evento) => {
    const boton = evento.target.closest("[data-accion]");
    if (!boton) return cerrarMenus();

    const tarjeta = boton.closest(".escenario-card");
    if (boton.dataset.accion === "abrir") return abrirEscenario(tarjeta.dataset.escenarioId);
    if (boton.dataset.accion === "menu-toggle") return alternarMenu(boton);
    if (boton.dataset.accion === "eliminar") return eliminarEscenarioFlujo(tarjeta);
});

// El menú se cierra solo con clic afuera: no hay que recordar volver a
// presionar el botón, y evita que quede abierto sobre otra tarjeta.
document.addEventListener("click", (evento) => {
    if (!evento.target.closest(".escenario-menu")) cerrarMenus();
});

document.addEventListener("keydown", (evento) => {
    if (evento.key === "Escape") cerrarMenus();
});

function alternarMenu(boton) {
    const menu = boton.closest(".escenario-menu");
    const desplegable = menu.querySelector(".menu-desplegable");
    const yaAbierto = !desplegable.hidden;
    cerrarMenus();
    if (!yaAbierto) abrirMenu(boton, desplegable);
}

function abrirMenu(boton, desplegable) {
    desplegable.hidden = false;
    boton.setAttribute("aria-expanded", "true");
}

function cerrarMenus() {
    for (const menu of lista.escenarios.querySelectorAll(".escenario-menu")) {
        menu.querySelector(".menu-desplegable").hidden = true;
        menu.querySelector(".btn-menu").setAttribute("aria-expanded", "false");
    }
}

async function eliminarEscenarioFlujo(tarjeta) {
    cerrarMenus();
    const id = tarjeta.dataset.escenarioId;
    const nombre = tarjeta.querySelector(".escenario-nombre").textContent;
    if (!confirm(`¿Eliminar el escenario "${nombre}"? Esta acción no se puede deshacer.`)) return;

    try {
        await eliminarEscenario(carreraActiva, id);
        olvidarEscenario(carreraActiva, id);
        mostrarLista(carreraActiva);
    } catch (error) {
        alert(`No se pudo eliminar: ${error.message}`);
    }
}

// ---------- crear un escenario nuevo ----------

document.getElementById("btn-nuevo").addEventListener("click", async () => {
    const escenariosActuales = await obtenerEscenariosPorCarrera(carreraActiva);
    const resultado = await formularioEscenario.abrir({ escenarios: escenariosActuales });
    if (!resultado) return;

    try {
        const nuevo = await crearEscenario(carreraActiva, resultado);
        // Se guarda de inmediato: un escenario que solo vive en memoria
        // desaparece al recargar, y "crear" debería ser un hecho permanente.
        const completo = await obtenerEscenario(carreraActiva, nuevo.id);
        await guardarEscenario(completo);
        await guardarAulas(completo);
        mostrarLista(carreraActiva);
    } catch (error) {
        alert(`No se pudo crear el escenario: ${error.message}\n\n¿Está corriendo backend/server.js?`);
    }
});

// ---------- arranque ----------

iniciarTabs(lista.tabs, "carrera", mostrarLista);
iniciarTabs(document.getElementById("tabs-entidad"), "entidad", (entidad) => detalle.irA(entidad));

// El chip de alerta es un atajo: lleva a las materias que lo provocaron.
document.getElementById("detalle-cobertura")
    .addEventListener("click", () => detalle.irA("materias", "sin-docente"));

document.getElementById("filtros-materia").addEventListener("click", (evento) => {
    const chip = evento.target.closest(".chip-filtro");
    if (chip) detalle.cambiarFiltro(chip.dataset.filtro);
});

document.getElementById("busqueda").addEventListener("input", () => detalle.buscar());

document.getElementById("btn-volver-lista")
    .addEventListener("click", () => mostrarLista(carreraActiva));

mostrarLista(carreraActiva);
