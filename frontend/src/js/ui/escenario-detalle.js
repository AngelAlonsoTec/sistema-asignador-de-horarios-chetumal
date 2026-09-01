/**
 * Pantalla de detalle de un escenario: los datos base completos, una entidad
 * por tab. El semestre no es un tab porque es un solo registro de cinco
 * campos: va en el encabezado, como contexto de todo lo demás.
 *
 * Aquí no hay grupos: son la salida del motor, no un insumo que se capture.
 *
 * `crearDetalle` devuelve un controlador con el estado de la pantalla
 * encerrado adentro (escenario abierto, entidad, búsqueda, filtro), en vez de
 * repartirlo en variables sueltas del módulo.
 */

import { calcularCobertura, contarDocentesPorMateria } from "../cobertura.js";
import {
    agregarMateria, editarMateria, eliminarMateria,
    agregarDocente, editarDocente, eliminarDocente, siguienteIdDocente,
    agregarEspecialidad, editarEspecialidad, eliminarEspecialidad,
    nombreAIdEspecialidad, asignarDocentesAMateria,
    agregarAula, editarAula, eliminarAula
} from "../edicion.js";
import { guardarEscenario, guardarAulas } from "../guardar.js";
import { crearTabla } from "./tabla.js";
import { pintarCobertura, formatearFecha } from "./formato.js";
import { FILTROS_MATERIA, buscar } from "./filtros.js";
import { activarTab } from "./tabs.js";

const GRUPOS_DE_AULA = [
    { titulo: "Aulas", tipo: "aula" },
    { titulo: "Laboratorios", tipo: "laboratorio" }
];

/** Cada entidad declara cómo se dibuja y qué controles necesita. */
const ENTIDADES = {
    docentes: {
        render: renderDocentes, busqueda: "Buscar docente o materia que imparte…", filtros: false,
        agregar: { accion: "agregar-docente", texto: "+ Agregar docente" }
    },
    materias: {
        render: renderMaterias, busqueda: "Buscar materia o clave…", filtros: true,
        agregar: { accion: "agregar-materia", texto: "+ Agregar materia" }
    },
    especialidades: {
        render: renderEspecialidades, busqueda: null, filtros: false,
        agregar: { accion: "agregar-especialidad", texto: "+ Agregar especialidad" }
    },
    aulas: {
        render: renderAulas, busqueda: null, filtros: false,
        agregar: { accion: "agregar-aula", texto: "+ Agregar aula" }
    }
};

export function crearDetalle(elementos) {
    let escenario = null;
    let entidad = "docentes";
    let filtro = "todas";

    function mostrar(nuevoEscenario) {
        escenario = nuevoEscenario;
        renderEncabezado(elementos.refs, escenario);
        irA("docentes", "todas");
    }

    /** Cambia de tab. `filtroInicial` deja preseleccionado un criterio. */
    function irA(nuevaEntidad, filtroInicial = "todas") {
        if (!escenario) return;

        entidad = nuevaEntidad;
        filtro = filtroInicial;

        activarTab(elementos.tabs, "entidad", entidad);
        activarChipFiltro(elementos.filtros, filtro);
        elementos.busqueda.value = "";
        ajustarControles();
        pintar();
    }

    function cambiarFiltro(nuevoFiltro) {
        filtro = nuevoFiltro;
        activarChipFiltro(elementos.filtros, filtro);
        pintar();
    }

    function pintar() {
        if (!escenario) return;
        const contexto = { escenario, texto: elementos.busqueda.value, filtro };
        elementos.contenido.replaceChildren(ENTIDADES[entidad].render(contexto));
    }

    /** La búsqueda y los filtros solo aparecen donde tienen sentido. */
    function ajustarControles() {
        const config = ENTIDADES[entidad];
        elementos.barra.hidden = !config.busqueda && !config.filtros;
        elementos.busqueda.hidden = !config.busqueda;
        elementos.busqueda.placeholder = config.busqueda ?? "";
        elementos.filtros.hidden = !config.filtros;

        // El alta vive en la barra superior, así que cambia de etiqueta y de
        // acción con la pestaña en vez de repetirse dentro de cada tabla.
        elementos.refs.agregar.textContent = config.agregar.texto;
        elementos.refs.agregar.dataset.accion = config.agregar.accion;
    }

    // ---------- edición ----------

    /** Después de cualquier alta/baja/cambio: la cobertura pudo moverse. */
    function actualizarTrasCambio() {
        escenario.cobertura = calcularCobertura(escenario.datos.materias, escenario.datos.docentes);
        renderEncabezado(elementos.refs, escenario);
        pintar();
    }

    async function agregarMateriaFlujo() {
        const materia = await elementos.formularios.materia.abrir({
            titulo: "Nueva materia", valores: null, especialidades: escenario.datos.especialidades
        });
        if (!materia) return;
        try {
            agregarMateria(escenario.datos, { ...materia, carrera: escenario.carrera });
            actualizarTrasCambio();
        } catch (error) {
            alert(error.message);
        }
    }

    async function editarMateriaFlujo(id) {
        const original = escenario.datos.materias.find((materia) => materia.id === id);
        if (!original) return;

        const editada = await elementos.formularios.materia.abrir({
            titulo: "Editar materia", valores: original, especialidades: escenario.datos.especialidades
        });
        if (!editada) return;
        try {
            editarMateria(escenario.datos, id, { ...editada, carrera: escenario.carrera });
            actualizarTrasCambio();
        } catch (error) {
            alert(error.message);
        }
    }

    function eliminarMateriaFlujo(id) {
        const materia = escenario.datos.materias.find((candidata) => candidata.id === id);
        if (!materia) return;
        if (!confirm(`¿Eliminar la materia "${materia.nombre}"? También se quita de los docentes que la tenían asignada.`)) return;

        eliminarMateria(escenario.datos, id);
        actualizarTrasCambio();
    }

    async function agregarDocenteFlujo() {
        const docente = await elementos.formularios.docente.abrir({
            titulo: "Nuevo docente",
            valores: null,
            materias: escenario.datos.materias
        });
        if (!docente) return;

        agregarDocente(escenario.datos, { id: siguienteIdDocente(escenario.datos.docentes), ...docente });
        actualizarTrasCambio();
    }

    async function editarDocenteFlujo(id) {
        const original = escenario.datos.docentes.find((docente) => docente.id === id);
        if (!original) return;

        const editado = await elementos.formularios.docente.abrir({
            titulo: "Editar docente",
            valores: original,
            materias: escenario.datos.materias
        });
        if (!editado) return;

        editarDocente(escenario.datos, id, editado);
        actualizarTrasCambio();
    }

    function eliminarDocenteFlujo(id) {
        const docente = escenario.datos.docentes.find((candidato) => candidato.id === id);
        if (!docente) return;
        if (!confirm(`¿Eliminar a ${docente.nombre}?`)) return;

        eliminarDocente(escenario.datos, id);
        actualizarTrasCambio();
    }

    async function agregarEspecialidadFlujo() {
        const capturada = await elementos.formularios.especialidad.abrir({
            titulo: "Nueva especialidad",
            valores: null,
            materias: escenario.datos.materias,
            especialidades: escenario.datos.especialidades
        });
        if (!capturada) return;

        const idsUsados = new Set(escenario.datos.especialidades.map((e) => e.id));
        try {
            agregarEspecialidad(
                escenario.datos,
                { id: nombreAIdEspecialidad(capturada.nombre, idsUsados), nombre: capturada.nombre },
                capturada.materiaIds
            );
            actualizarTrasCambio();
        } catch (error) {
            alert(error.message);
        }
    }

    async function editarEspecialidadFlujo(id) {
        const original = escenario.datos.especialidades.find((especialidad) => especialidad.id === id);
        if (!original) return;

        const editada = await elementos.formularios.especialidad.abrir({
            titulo: "Editar especialidad",
            valores: original,
            materias: escenario.datos.materias,
            especialidades: escenario.datos.especialidades
        });
        if (!editada) return;

        try {
            editarEspecialidad(escenario.datos, id, { nombre: editada.nombre }, editada.materiaIds);
            actualizarTrasCambio();
        } catch (error) {
            alert(error.message);
        }
    }

    function eliminarEspecialidadFlujo(id) {
        const especialidad = escenario.datos.especialidades.find((candidata) => candidata.id === id);
        if (!especialidad) return;

        const cuantas = escenario.datos.materias.filter((materia) => materia.especialidadId === id).length;
        const detalle = cuantas === 0
            ? ""
            : ` Sus ${cuantas} materias no se borran: vuelven a tronco común.`;
        if (!confirm(`¿Eliminar la especialidad "${especialidad.nombre}"?${detalle}`)) return;

        eliminarEspecialidad(escenario.datos, id);
        actualizarTrasCambio();
    }

    /** Tapa un hueco de cobertura desde la materia, sin entrar docente por docente. */
    async function asignarDocentesFlujo(materiaId) {
        const materia = escenario.datos.materias.find((candidata) => candidata.id === materiaId);
        if (!materia) return;

        const elegidos = await elementos.formularios.docentesMateria.abrir({
            materia,
            docentes: escenario.datos.docentes
        });
        if (!elegidos) return;

        asignarDocentesAMateria(escenario.datos, materiaId, elegidos);
        actualizarTrasCambio();
    }

    async function agregarAulaFlujo() {
        const aula = await elementos.formularios.aula.abrir({ titulo: "Nueva aula", valores: null });
        if (!aula) return;
        try {
            agregarAula(escenario.datos, aula);
            actualizarTrasCambio();
        } catch (error) {
            alert(error.message);
        }
    }

    async function editarAulaFlujo(id) {
        const original = escenario.datos.aulas.find((aula) => aula.id === id);
        if (!original) return;

        const editada = await elementos.formularios.aula.abrir({ titulo: "Editar aula", valores: original });
        if (!editada) return;
        try {
            editarAula(escenario.datos, id, editada);
            actualizarTrasCambio();
        } catch (error) {
            alert(error.message);
        }
    }

    function eliminarAulaFlujo(id) {
        const aula = escenario.datos.aulas.find((candidata) => candidata.id === id);
        if (!aula) return;
        if (!confirm(`¿Eliminar el aula "${aula.clave}"?`)) return;

        eliminarAula(escenario.datos, id);
        actualizarTrasCambio();
    }

    const ACCIONES = {
        "agregar-materia": () => agregarMateriaFlujo(),
        "editar-materia": (id) => editarMateriaFlujo(id),
        "eliminar-materia": (id) => eliminarMateriaFlujo(id),
        "agregar-docente": () => agregarDocenteFlujo(),
        "editar-docente": (id) => editarDocenteFlujo(id),
        "eliminar-docente": (id) => eliminarDocenteFlujo(id),
        "agregar-especialidad": () => agregarEspecialidadFlujo(),
        "editar-especialidad": (id) => editarEspecialidadFlujo(id),
        "eliminar-especialidad": (id) => eliminarEspecialidadFlujo(id),
        "asignar-docentes": (id) => asignarDocentesFlujo(id),
        "agregar-aula": () => agregarAulaFlujo(),
        "editar-aula": (id) => editarAulaFlujo(id),
        "eliminar-aula": (id) => eliminarAulaFlujo(id)
    };

    elementos.contenido.addEventListener("click", (evento) => {
        const boton = evento.target.closest("[data-accion]");
        if (!boton) return;
        ACCIONES[boton.dataset.accion]?.(boton.dataset.id);
    });

    elementos.refs.agregar.addEventListener("click", (evento) => {
        ACCIONES[evento.currentTarget.dataset.accion]?.();
    });

    elementos.refs.guardar.addEventListener("click", async () => {
        if (!escenario) return;

        const boton = elementos.refs.guardar;
        boton.disabled = true;
        boton.textContent = "Guardando…";
        try {
            await guardarEscenario(escenario);
            await guardarAulas(escenario);
            boton.textContent = "Guardado";
        } catch (error) {
            boton.textContent = "Error al guardar";
            alert(`No se pudo guardar: ${error.message}\n\n¿Está corriendo backend/server.js?`);
        }
        setTimeout(() => {
            boton.textContent = "Guardar cambios";
            boton.disabled = false;
        }, 1500);
    });

    return { mostrar, irA, cambiarFiltro, buscar: pintar };
}

// ---------- encabezado ----------

function renderEncabezado(refs, escenario) {
    refs.nombre.textContent = escenario.nombre;
    refs.fecha.textContent = formatearFecha(escenario.fecha);
    refs.badge.hidden = !escenario.esBase;
    refs.semestre.textContent = describirSemestre(escenario.datos.semestres);

    pintarCobertura(refs.cobertura, escenario.cobertura);
    // Con materias sin cubrir el chip es un atajo hacia ellas; si todo está
    // bien no hay a dónde ir, así que deja de comportarse como botón.
    refs.cobertura.disabled = escenario.cobertura.esCompleta;
    refs.cobertura.classList.toggle("es-accion", !escenario.cobertura.esCompleta);
}

function activarChipFiltro(contenedor, filtro) {
    for (const chip of contenedor.querySelectorAll(".chip-filtro")) {
        chip.classList.toggle("is-active", chip.dataset.filtro === filtro);
    }
}

// ---------- tablas ----------

function renderDocentes({ escenario, texto }) {
    // Buscar "redes" debe encontrar a quien la imparte, no solo a quien se
    // apellide así: se busca también en las materias que puede dar.
    const nombrePorMateria = new Map(
        escenario.datos.materias.map((materia) => [materia.id, materia.nombre])
    );
    const materiasDe = (docente) =>
        docente.materiasCapacitadas.map((id) => nombrePorMateria.get(id) ?? "").join(" ");

    const todos = escenario.datos.docentes;
    const docentes = buscar(todos, texto, ["nombre", "categoria", materiasDe]);
    const titulo = etiquetaConteo("Docentes", docentes.length, todos.length);

    if (docentes.length === 0) {
        return crearSeccion(titulo, crearAviso("Ningún docente coincide con la búsqueda."));
    }

    const filas = docentes.map((docente) => ({
        celdas: [
            docente.nombre,
            docente.categoria,
            `${docente.horasMin}-${docente.horasMax} h`,
            docente.esDeOtraArea ? `${docente.carreraBase} (otra área)` : docente.carreraBase,
            `${docente.materiasCapacitadas.length} materias`,
            crearAcciones("docente", docente.id)
        ]
    }));

    return crearSeccion(
        titulo,
        crearTabla(["Docente", "Categoría", "Horas", "Área", "Puede impartir", "Acciones"], filas)
    );
}

/** Materias agrupadas por semestre, que es como está organizada la retícula. */
function renderMaterias({ escenario, texto, filtro }) {
    const { materias, docentes, especialidades } = escenario.datos;
    const conteo = contarDocentesPorMateria(materias, docentes);
    const nombrePorEspecialidad = new Map(especialidades.map((e) => [e.id, e.nombre]));

    const visibles = buscar(materias, texto, ["nombre", "clave"])
        .filter((materia) => FILTROS_MATERIA[filtro](materia, conteo));
    const titulo = etiquetaConteo("Materias", visibles.length, materias.length);

    if (visibles.length === 0) {
        return crearSeccion(titulo, crearAviso("Ninguna materia coincide con los criterios."));
    }

    const filas = [];
    for (const [semestre, delSemestre] of agruparPorSemestre(visibles)) {
        filas.push({ separador: `Semestre ${semestre} (${delSemestre.length})` });

        // Dentro del semestre, cada especialidad va en su propio subgrupo: en
        // un semestre con varias, mezclarlas obliga a leer materia por materia
        // para saber cuál pertenece a cuál.
        for (const [especialidadId, grupo] of agruparPorEspecialidad(delSemestre, especialidades)) {
            if (especialidadId !== null) {
                filas.push({
                    separador: `${nombrePorEspecialidad.get(especialidadId)} (${grupo.length})`,
                    nivel: 2
                });
            }

            for (const materia of grupo) {
                const total = conteo.get(materia.id);
                filas.push({
                    clase: total === 0 ? "is-alerta" : undefined,
                    celdas: [
                        materia.clave,
                        materia.nombre,
                        `${materia.horasSemana} h`,
                        String(materia.creditos),
                        celdaDocentes(materia.id, total),
                        crearAcciones("materia", materia.id)
                    ]
                });
            }
        }
    }

    return crearSeccion(
        titulo,
        crearTabla(["Clave", "Materia", "Hrs/sem", "Créditos", "Docentes", "Acciones"], filas)
    );
}

/**
 * Especialidades: el módulo que la retícula cambia cada pocos años. Cada una
 * se muestra con la cobertura de SUS materias, que es la pregunta que importa
 * antes de comprometerse con una especialidad — de nada sirve ofrecerla si
 * nadie puede impartir la mitad de sus materias.
 */
function renderEspecialidades({ escenario }) {
    const { especialidades, materias, docentes } = escenario.datos;
    const conteo = contarDocentesPorMateria(materias, docentes);

    const contenedor = document.createElement("div");
    contenedor.className = "aulas-grupos";
    contenedor.appendChild(crearSeccion(
        etiquetaConteo("Especialidades", especialidades.length, especialidades.length),
        document.createDocumentFragment()
    ));

    if (especialidades.length === 0) {
        contenedor.appendChild(crearAviso(
            "Este escenario no tiene especialidades. Agrega una para agrupar las materias del módulo y validar que haya quién las imparta."
        ));
        return contenedor;
    }

    for (const especialidad of especialidades) {
        // Del semestre más bajo al más alto: es el orden en que se cursa el módulo.
        const suyas = materias
            .filter((materia) => materia.especialidadId === especialidad.id)
            .sort((a, b) => a.semestre - b.semestre || a.clave.localeCompare(b.clave));
        contenedor.appendChild(crearBloqueEspecialidad(especialidad, suyas, docentes, conteo));
    }

    return contenedor;
}

function crearBloqueEspecialidad(especialidad, suyas, docentes, conteo) {
    const seccion = document.createElement("section");

    const encabezado = document.createElement("div");
    encabezado.className = "seccion-encabezado";

    const titulo = document.createElement("div");
    titulo.className = "especialidad-titulo";

    const nombre = document.createElement("h2");
    nombre.className = "seccion-titulo";
    nombre.textContent = `${especialidad.nombre} (${suyas.length})`;
    titulo.appendChild(nombre);

    const chip = document.createElement("span");
    pintarCobertura(chip, calcularCobertura(suyas, docentes));
    titulo.appendChild(chip);

    const acciones = document.createElement("div");
    acciones.className = "fila-acciones";
    acciones.append(
        crearBoton("editar-especialidad", especialidad.id, "Editar"),
        crearBoton("eliminar-especialidad", especialidad.id, "Eliminar", "btn-peligro")
    );

    encabezado.append(titulo, acciones);
    seccion.appendChild(encabezado);

    seccion.appendChild(suyas.length === 0
        ? crearAviso("Todavía no tiene materias. Edítala para elegir cuáles la componen.")
        : crearTablaMateriasEspecialidad(suyas, conteo));

    return seccion;
}

function crearTablaMateriasEspecialidad(materias, conteo) {
    const filas = materias.map((materia) => {
        const total = conteo.get(materia.id);
        return {
            clase: total === 0 ? "is-alerta" : undefined,
            celdas: [
                materia.clave,
                materia.nombre,
                `Semestre ${materia.semestre}`,
                total === 0 ? chipSinDocente() : `${total} ${total === 1 ? "docente" : "docentes"}`,
                crearBoton("asignar-docentes", materia.id, "Asignar docentes")
            ]
        };
    });

    return crearTabla(["Clave", "Materia", "Semestre", "Docentes", "Acciones"], filas);
}

/** Catálogo de espacios disponibles: el motor no puede ubicar un grupo sin esto. */
function renderAulas({ escenario }) {
    const contenedor = document.createElement("div");
    contenedor.className = "aulas-grupos";

    const encabezado = document.createElement("div");
    encabezado.className = "seccion-encabezado";
    const tituloTab = document.createElement("h2");
    tituloTab.className = "seccion-titulo";
    tituloTab.textContent = `Catálogo de aulas (${escenario.datos.aulas.length})`;
    encabezado.appendChild(tituloTab);
    contenedor.appendChild(encabezado);

    for (const { titulo, tipo } of GRUPOS_DE_AULA) {
        const aulas = escenario.datos.aulas.filter((aula) => aula.tipo === tipo);
        if (aulas.length === 0) continue;

        contenedor.appendChild(crearSeccion(`${titulo} (${aulas.length})`, crearTablaAulas(aulas)));
    }

    if (escenario.datos.aulas.length === 0) {
        contenedor.appendChild(crearAviso("Este escenario todavía no tiene aulas."));
    }

    return contenedor;
}

function crearTablaAulas(aulas) {
    const filas = aulas.map((aula) => ({
        celdas: [aula.clave, crearAcciones("aula", aula.id)]
    }));
    return crearTabla(["Clave", "Acciones"], filas);
}

// ---------- auxiliares ----------

/** @returns {Map<number, Array>} semestre → materias, en orden ascendente */
function agruparPorSemestre(materias) {
    const grupos = new Map();

    for (const materia of materias) {
        if (!grupos.has(materia.semestre)) grupos.set(materia.semestre, []);
        grupos.get(materia.semestre).push(materia);
    }

    return new Map([...grupos].sort(([a], [b]) => a - b));
}

/**
 * Materias de un semestre repartidas por especialidad. Tronco común va
 * primero (clave `null`) por ser el grueso de la retícula; después cada
 * especialidad en el orden en que están declaradas, no alfabético, para que
 * el orden no baile cada vez que se renombra una.
 *
 * @returns {Map<string|null, Array>} especialidadId → materias
 */
function agruparPorEspecialidad(materias, especialidades) {
    const grupos = new Map([[null, []]]);
    for (const especialidad of especialidades) grupos.set(especialidad.id, []);

    for (const materia of materias) {
        // Una materia con una especialidad ya borrada cae en tronco común,
        // que es justo lo que pasó con sus datos al desligarla.
        const clave = grupos.has(materia.especialidadId) ? materia.especialidadId : null;
        grupos.get(clave).push(materia);
    }

    return new Map([...grupos].filter(([, materias]) => materias.length > 0));
}

function describirSemestre(semestres) {
    const semestre = semestres[0];
    if (!semestre) return "Sin semestre definido";

    return `${semestre.periodo} · ${semestre.semanas} semanas · ${semestre.turnos.join(", ")}`;
}

/** Título de sección con su conteo, el mismo patrón en los tres tabs. */
function crearSeccion(titulo, contenido, accion) {
    const seccion = document.createElement("section");

    const encabezado = document.createElement("div");
    encabezado.className = "seccion-encabezado";

    const tituloEl = document.createElement("h2");
    tituloEl.className = "seccion-titulo";
    tituloEl.textContent = titulo;
    encabezado.appendChild(tituloEl);
    if (accion) encabezado.appendChild(accion);

    seccion.append(encabezado, contenido);
    return seccion;
}

/** Botones de una fila: se resuelven por delegación en el contenedor del tab. */
function crearAcciones(tipo, id) {
    const contenedor = document.createElement("div");
    contenedor.className = "fila-acciones";
    contenedor.append(
        crearBoton(`editar-${tipo}`, id, "Editar"),
        crearBoton(`eliminar-${tipo}`, id, "Eliminar", "btn-peligro")
    );
    return contenedor;
}

function crearBoton(accion, id, texto, claseExtra) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = claseExtra ? `btn btn-mini ${claseExtra}` : "btn btn-mini";
    boton.dataset.accion = accion;
    if (id !== undefined) boton.dataset.id = id;
    boton.textContent = texto;
    return boton;
}

/** "Materias (46)" o "Materias (3 de 46)" cuando hay búsqueda o filtro. */
function etiquetaConteo(nombre, visibles, total) {
    return visibles === total
        ? `${nombre} (${total})`
        : `${nombre} (${visibles} de ${total})`;
}

/**
 * El conteo es también el acceso a editarlo: hacer clic en "0 docentes" lleva
 * directo a elegir quién puede impartirla, que es la reacción natural al verlo.
 */
function celdaDocentes(materiaId, total) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "celda-docentes";
    boton.dataset.accion = "asignar-docentes";
    boton.dataset.id = materiaId;
    boton.append(total === 0 ? chipSinDocente() : document.createTextNode(String(total)));
    return boton;
}

function chipSinDocente() {
    const chip = document.createElement("span");
    chip.className = "chip-alerta";
    chip.textContent = "ninguno";
    return chip;
}

function crearAviso(mensaje) {
    const aviso = document.createElement("p");
    aviso.className = "empty-state";
    aviso.textContent = mensaje;
    return aviso;
}
