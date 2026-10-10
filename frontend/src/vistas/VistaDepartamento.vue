<script setup>
/**
 * Pantalla del departamento académico.
 *
 * Es otro trabajo, no una variante del de coordinación: aquí no se arman
 * horarios. Se decide **quién puede impartir qué**, se cargan las descargas
 * administrativas y se cierra el periodo cuando la negociación entre carreras
 * terminó. Por eso tiene su propia vista y no una sección más en la barra
 * lateral del coordinador.
 */
import { ref, computed, onMounted, nextTick } from "vue";
import { estado, salir } from "../estado.js";
import { api } from "../api.js";
import LogoMarca from "../componentes/LogoMarca.vue";
import ListaChecks from "../componentes/ListaChecks.vue";
import DialogoModal from "../componentes/DialogoModal.vue";
import ListaPendientes from "../componentes/ListaPendientes.vue";
import DialogoClave from "../componentes/DialogoClave.vue";
import { contiene } from "../dominio/texto.js";
import { siguienteIdDocente } from "../dominio/edicion.js";
import { alcanza, horasEn } from "../dominio/turnos.js";
import CatalogoImprimible from "../componentes/CatalogoImprimible.vue";

const docentes = ref([]);
const periodos = ref([]);
const usuarios = ref([]);
const carreras = ref([]);
const nuevoUsuario = ref(null);
const nuevaCarrera = ref(null);
const editandoCarreras = ref(null);
const reiniciando = ref(null);
const buscaCuenta = ref("");

/**
 * Los espacios son del plantel: una sola lista para las trece carreras.
 *
 * Los editaba cada coordinación desde su pantalla, reemplazando la lista
 * entera: guardar una sola aula dejaba al resto sin ninguna. Un recurso
 * compartido no lo administra quien compite por él.
 */
/**
 * El catálogo visto por carrera.
 *
 * La ficha del docente responde "qué puede dar esta persona". Esto responde la
 * pregunta que el jefe de departamento se hace al sentarse a repartir: **quién
 * le da cada clase a esta coordinación**. Sin esta vista había que abrir treinta
 * fichas para saberlo.
 *
 * La unidad es la clase —una materia frente a un grupo—, no la materia. Si un
 * semestre abre tres grupos, son tres decisiones: pueden ser de la misma
 * persona o de tres distintas. Y son independientes entre carreras: que alguien
 * dé Cálculo en ISIC no dice nada de quién lo da en ITIC.
 *
 * No hay horas por ninguna parte, a propósito: el departamento dice quién
 * imparte qué, y en qué momento de la semana lo resuelve el coordinador con el
 * generador.
 */
const resumenCatalogo = ref([]);
const carreraCatalogo = ref(null);
const detalleCatalogo = ref(null);
const buscaCatalogo = ref("");
const asignando = ref(null);
const buscaDocente = ref("");
const carga = ref([]);
/** Lo que el plantel no cubre con su plantilla. Solo el departamento contrata. */
const necesidadesPlantel = ref(null);

/**
 * Lo que las coordinaciones piden sobre el reparto.
 *
 * El departamento decide quién imparte cada clase, pero quien arma el horario es
 * el coordinador y es quien descubre que esa persona no tiene huecos donde hace
 * falta. Sin esta bandeja, el sistema le decía que lo pidiera y no había dónde:
 * la conversación se iba por fuera y la decisión se cambiaba sin registro.
 */
const peticiones = ref([]);
const respondiendo = ref(null);

const peticionesPendientes = computed(
    () => peticiones.value.filter((p) => p.estado === "pendiente").length
);

function abrirRespuesta(peticion) {
    respondiendo.value = {
        ...peticion,
        // Se propone lo que pidió la coordinación; si no propuso a nadie, hay
        // que elegir: aceptar sin decir quién dejaría la clase igual.
        docenteId: peticion.propuesto ?? "",
        respuesta: ""
    };
}

/** Quién puede darla, para responder sin salir a buscarlo. */
const candidatosPeticion = computed(() => {
    const p = respondiendo.value;
    if (!p) return [];
    return docentes.value
        .filter((d) => (d.materiasCapacitadas ?? []).includes(p.materiaId))
        .map((d) => ({ ...d, carga: cargaPorId.value.get(d.id) ?? null }));
});

async function responderPeticion(acepta) {
    error.value = null;
    try {
        await api.responderCambio(respondiendo.value.id, {
            acepta,
            docenteId: acepta ? respondiendo.value.docenteId || null : null,
            respuesta: respondiendo.value.respuesta
        });
        respondiendo.value = null;
        await Promise.all([cargarCatalogo(), verCatalogoDe(carreraCatalogo.value)]);
    } catch (e) {
        error.value = e.message;
    }
}

async function cargarCatalogo() {
    [resumenCatalogo.value, carga.value, peticiones.value, necesidadesPlantel.value] = await Promise.all([
        api.catalogo().catch(() => []),
        api.cargaDocentes().catch(() => []),
        api.cambios().catch(() => []),
        api.necesidadesPlantel().catch(() => null)
    ]);
    if (!carreraCatalogo.value && resumenCatalogo.value.length > 0) {
        // Se abre por la que más trabajo tiene: donde falta repartir.
        const peor = [...resumenCatalogo.value].sort(
            (a, b) => b.sinAsignar - a.sinAsignar || b.clases - a.clases
        )[0];
        carreraCatalogo.value = peor.carrera;
    }
    await verCatalogoDe(carreraCatalogo.value);
}

async function verCatalogoDe(carrera) {
    if (!carrera) return;
    carreraCatalogo.value = carrera;
    buscaCatalogo.value = "";
    detalleCatalogo.value = await api.catalogoDe(carrera).catch(() => null);
}

/**
 * Las clases agrupadas por grupo. Es como se reparte de verdad: se toma la hoja
 * de 1A y se decide quién le da cada materia, no se recorre materia por materia
 * cruzando grupos.
 */
const gruposCatalogo = computed(() => {
    const visibles = (detalleCatalogo.value?.filas ?? []).filter((f) =>
        contiene(`${f.clave} ${f.nombre} ${f.docenteNombre ?? ""}`, buscaCatalogo.value)
    );
    const porGrupo = new Map();
    for (const f of visibles) {
        if (!porGrupo.has(f.grupoClave)) {
            porGrupo.set(f.grupoClave, { clave: f.grupoClave, turno: f.turno, filas: [] });
        }
        porGrupo.get(f.grupoClave).filas.push(f);
    }
    // Por clave y no por orden de aparición: un semestre con dos especialidades
    // puede meter una materia de 9B antes que la primera de 9A.
    return [...porGrupo.values()].sort((a, b) => a.clave.localeCompare(b.clave));
});

const sinAsignarAqui = computed(
    () => (detalleCatalogo.value?.filas ?? []).filter((f) => !f.docenteId).length
);

/**
 * Decisiones que quedaron sin clase: el coordinador cerró el grupo o quitó la
 * materia de la retícula después de repartir. No se borran —si el grupo vuelve
 * a abrirse, la decisión sigue valiendo— pero invisibles y contadas era lo peor
 * de los dos mundos.
 */
const huerfanas = computed(() => detalleCatalogo.value?.huerfanas ?? []);

/** Si quien tiene la clase puede darla con lo que declaró. */
function alcanceDe(fila) {
    const d = docentes.value.find((x) => x.id === fila.docenteId);
    return d ? alcanza(d, fila.turno, fila.horasSemana) : { puede: true };
}

/** La carga de cada docente, para decidir viendo lo que ya lleva encima. */
const cargaPorId = computed(() => new Map(carga.value.map((c) => [c.docenteId, c])));

/** Lo que le ha pasado a la clase que se está asignando. */
const historialClase = ref([]);

/**
 * Qué se manda al papel. La hoja imprimible está siempre montada pero escondida;
 * esto decide cuál de las dos se dibuja antes de llamar a imprimir.
 */
const aImprimir = ref("catalogo");

function imprimirCatalogo() {
    aImprimir.value = "catalogo";
    // Un tick para que la hoja se redibuje con el alcance nuevo antes de que el
    // navegador tome la instantánea.
    nextTick(() => window.print());
}

function imprimirCarga() {
    aImprimir.value = "carga";
    nextTick(() => window.print());
}

const cuando = (iso) =>
    new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });

async function abrirAsignacion(fila) {
    buscaDocente.value = "";
    historialClase.value = [];
    asignando.value = {
        materiaId: fila.materiaId,
        grupoClave: fila.grupoClave,
        titulo: `${fila.clave} · ${fila.nombre}`,
        grupo: fila.grupoClave,
        turno: fila.turno,
        horasSemana: fila.horasSemana,
        // Cuántos grupos más cursan esta materia: es la diferencia entre una
        // decisión y tres idénticas.
        hermanos: (detalleCatalogo.value?.filas ?? []).filter(
            (f) => f.materiaId === fila.materiaId && f.grupoClave !== fila.grupoClave
        ).length,
        aTodos: false,
        elegido: fila.docenteId
    };
    // Quién la tuvo antes. Se pide al abrir y no con el catálogo: son setenta
    // clases y casi siempre interesa la historia de una.
    historialClase.value = await api
        .historialReparto({
            carrera: carreraCatalogo.value,
            materiaId: fila.materiaId,
            grupoClave: fila.grupoClave,
            limite: 8
        })
        .catch(() => []);
}

/**
 * Los candidatos, con los autorizados primero.
 *
 * No se esconde a los demás: la autorización es un registro del propio
 * departamento y puede ir atrasada. Se marca, para que asignar a alguien sin
 * autorizar sea una decisión visible y no un descuido.
 */
const candidatos = computed(() => {
    const a = asignando.value;
    if (!a) return [];
    return docentes.value
        .filter((d) => contiene(d.nombre, buscaDocente.value))
        .map((d) => ({
            ...d,
            autorizado: (d.materiasCapacitadas ?? []).includes(a.materiaId),
            // Declarar horas en el turno del grupo no es un permiso, es una
            // posibilidad: sin ellas el horario no puede colocar la clase.
            alcance: alcanza(d, a.turno, a.horasSemana),
            horasTurno: horasEn(d, a.turno),
            carga: cargaPorId.value.get(d.id) ?? null
        }))
        .sort(
            (x, y) =>
                Number(y.autorizado) - Number(x.autorizado) ||
                Number(y.alcance.puede) - Number(x.alcance.puede) ||
                x.nombre.localeCompare(y.nombre)
        );
});

async function guardarAsignacion(docenteId) {
    error.value = null;
    const a = asignando.value;
    try {
        if (a.aTodos) {
            await api.asignarMateria({
                carrera: carreraCatalogo.value,
                materiaId: a.materiaId,
                docenteId
            });
        } else {
            await api.asignar({
                carrera: carreraCatalogo.value,
                materiaId: a.materiaId,
                grupoClave: a.grupoClave,
                docenteId
            });
        }
        asignando.value = null;
        await cargarCatalogo();
    } catch (e) {
        error.value = e.message;
    }
}

/**
 * Quita el reparto entero de una carrera. Se pregunta porque son setenta
 * decisiones a la vez, y se dice cuántas: "vaciar" sin número no deja medir lo
 * que se está deshaciendo.
 */
async function vaciarReparto() {
    const cuantas = (detalleCatalogo.value?.filas ?? []).filter((f) => f.docenteId).length;
    if (cuantas === 0) return;
    const texto =
        `Se van a quitar ${cuantas} asignaciones de ${carreraCatalogo.value}. ` +
        "Queda el registro de quién tenía cada clase. ¿Seguir?";
    if (!window.confirm(texto)) return;
    error.value = null;
    try {
        await api.vaciarReparto(carreraCatalogo.value);
        await cargarCatalogo();
    } catch (e) {
        error.value = e.message;
    }
}

const aulas = ref([]);
const editandoAula = ref(null);

async function cargarAulas() {
    aulas.value = await api.aulasDelPlantel().catch(() => []);
}

function nuevaAula() {
    editandoAula.value = { id: "", clave: "", tipo: "aula", capacidad: null, nueva: true };
}

function editarAula(a) {
    editandoAula.value = { ...a, nueva: false };
}

async function guardarAula() {
    const a = editandoAula.value;
    if (!a.clave.trim()) {
        error.value = "El espacio necesita una clave.";
        return;
    }
    const id = a.nueva ? a.clave.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_") : a.id;
    if (a.nueva && aulas.value.some((x) => x.id === id)) {
        error.value = `Ya existe un espacio con la clave ${a.clave}.`;
        return;
    }

    const lista = a.nueva
        ? [...aulas.value, { id, clave: a.clave.trim(), tipo: a.tipo, capacidad: a.capacidad }]
        : aulas.value.map((x) =>
              x.id === a.id ? { ...x, clave: a.clave.trim(), tipo: a.tipo, capacidad: a.capacidad } : x
          );
    await escribirAulas(lista);
}

async function borrarAula(a) {
    if (!confirm(`¿Eliminar ${a.clave}? Los horarios que lo usen dejarán de cuadrar.`)) return;
    await escribirAulas(aulas.value.filter((x) => x.id !== a.id));
}

async function escribirAulas(lista) {
    error.value = null;
    try {
        await api.guardarAulasDelPlantel(lista);
        editandoAula.value = null;
        await cargarAulas();
    } catch (e) {
        error.value = e.message;
    }
}

/**
 * Este trabajo son cuatro cosas distintas, no una página larga.
 *
 * Antes iban apiladas en un solo desplazamiento y la barra lateral estaba
 * vacía: con trece carreras y treinta docentes eso son varios metros de
 * página para llegar a lo de abajo.
 */
const SECCIONES = [
    { id: "periodos", etiqueta: "Periodos" },
    { id: "carreras", etiqueta: "Carreras" },
    { id: "catalogo", etiqueta: "Quién imparte qué" },
    { id: "carga", etiqueta: "Carga acumulada" },
    { id: "peticiones", etiqueta: "Peticiones de cambio" },
    { id: "cuentas", etiqueta: "Cuentas" },
    { id: "espacios", etiqueta: "Espacios" },
    { id: "plantilla", etiqueta: "Plantilla docente" }
];
const seccion = ref("periodos");
const cambiandoClave = ref(false);
const busqueda = ref("");
const editando = ref(null);
const nombramiento = ref(null);
const autorizadas = ref([]);

/**
 * Las reglas del Reglamento Interior de Trabajo, traídas del backend.
 *
 * No se copian a la interfaz: una segunda versión de la tabla envejecería
 * aparte de la que el sistema aplica, y acabaría proponiendo horas que luego se
 * marcan como incorrectas.
 */
const normativa = ref(null);
const reglas = computed(() => normativa.value?.reglas ?? null);
const observados = computed(() => normativa.value?.observados ?? []);

const CATEGORIAS = [
    { valor: "Titular", clave: "titular", etiqueta: "Titular" },
    { valor: "Asociado", clave: "asociado", etiqueta: "Asociado" },
    { valor: "Asistente", clave: "asistente", etiqueta: "Asistente" },
    { valor: "Investigador", clave: "investigador", etiqueta: "Profesor investigador" },
    { valor: "Tecnico-docente", clave: "tecnico-docente", etiqueta: "Técnico docente" },
    { valor: "Asignatura", clave: null, etiqueta: "Por asignatura" }
];

const DEDICACIONES = [
    { valor: "tiempo completo", etiqueta: "Tiempo completo (40 h)" },
    { valor: "tres cuartos", etiqueta: "Tres cuartos (30 h)" },
    { valor: "medio tiempo", etiqueta: "Medio tiempo (20 h)" },
    { valor: "asignatura", etiqueta: "Asignatura (1 a 19 h)" }
];

const horasDeReglamento = (categoria, dedicacion) => {
    const clave = CATEGORIAS.find((c) => c.valor === categoria)?.clave;
    if (!clave) return null;
    return reglas.value?.horasFrenteAGrupo?.[clave]?.[dedicacion] ?? null;
};

/**
 * Al cambiar el nombramiento se propone lo que dice el reglamento. Se propone y
 * no se impone: hay comisiones, plazas mixtas y nombramientos en trámite, y el
 * formulario no debería impedir capturarlos.
 */
function alCambiarNombramiento() {
    const n = nombramiento.value;
    if (n.categoria === "Asignatura") {
        n.dedicacion = "asignatura";
        return;
    }
    if (n.dedicacion === "asignatura") n.dedicacion = "tiempo completo";
    const horas = horasDeReglamento(n.categoria, n.dedicacion);
    if (horas !== null) n.horasMax = horas;
}

/** Qué dice la norma de lo que hay capturado ahora mismo en el diálogo. */
const segunReglamento = computed(() => {
    const n = nombramiento.value;
    if (!n || !reglas.value) return [];
    const avisos = [];
    if (Number(n.maxMaterias) > reglas.value.maxMaterias) {
        avisos.push(
            `El reglamento no permite más de ${reglas.value.maxMaterias} materias diferentes ` +
                "(art. 155 y 156)."
        );
    }
    if (n.categoria === "Asignatura") {
        const { min, max } = reglas.value.asignatura;
        if (Number(n.horasMax) < min || Number(n.horasMax) > max) {
            avisos.push(`Un nombramiento de asignatura va de ${min} a ${max} horas (art. 155).`);
        }
        return avisos;
    }
    const esperadas = horasDeReglamento(n.categoria, n.dedicacion);
    if (esperadas !== null && Math.abs(Number(n.horasMax) - esperadas) > reglas.value.ajusteMaximo) {
        avisos.push(
            `A esta categoría y dedicación le corresponden ${esperadas} horas frente a grupo, ` +
                `con un ajuste de ${reglas.value.ajusteMaximo} (art. 143 y 147).`
        );
    }
    return avisos;
});
const descargas = ref([]);
const nuevaDescarga = ref({ dia: "lunes", inicio: 7, fin: 9, motivo: "" });
const error = ref(null);
const aviso = ref(null);

const DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes"];

// ---------------------------------------------------------------- cuentas

const EN_BLANCO = { nombre: "", usuario: "", clave: "", rol: "coordinador", carreras: [] };

async function cargarCuentas() {
    usuarios.value = await api.usuarios().catch(() => []);
    // Del plantel y no de `api.carreras()`: esa devuelve solo las que uno
    // lleva, y el departamento las administra todas.
    carreras.value = await api.plantel().catch(() => []);
}

/** Cada carrera con quién la coordina. Es lo que el departamento revisa. */
const carrerasConDueno = computed(() =>
    carreras.value.map((c) => ({
        ...c,
        coordinan: usuarios.value.filter((u) => u.carreras.includes(c.codigo))
    }))
);

const cuentasVisibles = computed(() => {
    const suyas = usuarios.value.filter((u) =>
        contiene(`${u.nombre} ${u.usuario} ${u.carreras.join(" ")}`, buscaCuenta.value)
    );
    // El departamento arriba, luego quien coordina algo, y al final las
    // retiradas: son cuentas que existen solo para que su historial tenga autor.
    return [...suyas].sort(
        (a, b) =>
            Number(b.activo) - Number(a.activo) ||
            Number(b.rol === "departamento") - Number(a.rol === "departamento") ||
            Number(b.carreras.length > 0) - Number(a.carreras.length > 0) ||
            a.nombre.localeCompare(b.nombre, "es")
    );
});

function abrirCarrera() {
    nuevaCarrera.value = { codigo: "", nombre: "" };
}

async function guardarCarrera() {
    error.value = null;
    try {
        await api.abrirCarrera(nuevaCarrera.value);
        nuevaCarrera.value = null;
        await cargarCuentas();
    } catch (e) {
        error.value = e.message;
    }
}

async function cerrarCarrera(c) {
    if (c.coordinan.length > 0) {
        error.value = `${c.codigo} la coordina ${c.coordinan[0].nombre}. Quítasela antes de cerrarla.`;
        return;
    }
    if (!confirm(`¿Cerrar ${c.codigo}? Se van sus escenarios y su horario.`)) return;
    try {
        await api.cerrarCarreraDelPlantel(c.codigo);
        await cargarCuentas();
    } catch (e) {
        error.value = e.message;
    }
}

/**
 * Las carreras de una cuenta se editan en un diálogo y no con trece botones en
 * cada fila: con todas las del plantel pintadas siempre, las dos o tres activas
 * se perdían entre las apagadas.
 */
/**
 * Reiniciar la contraseña de quien la olvidó. La provisional se dicta a esa
 * persona y la cuenta queda obligada a cambiarla en su siguiente entrada, así
 * que el paso por manos ajenas dura lo que tarde en entrar.
 */
function reiniciarClave(u) {
    reiniciando.value = { id: u.id, nombre: u.nombre, nueva: "", retirada: !u.activo };
}

async function guardarClaveNueva() {
    error.value = null;
    try {
        await api.reiniciarClave(reiniciando.value.id, reiniciando.value.nueva);
        const { nombre, retirada } = reiniciando.value;
        reiniciando.value = null;
        await cargarCuentas();
        aviso.value = retirada
            ? `${nombre} vuelve a tener acceso. Dile la contraseña: al entrar tendrá que cambiarla.`
            : `Contraseña reiniciada. Dísela a ${nombre}: al entrar tendrá que cambiarla.`;
    } catch (e) {
        error.value = e.message;
    }
}

function editarCarreras(u) {
    editandoCarreras.value = { id: u.id, nombre: u.nombre, elegidas: [...u.carreras] };
}

async function guardarCarrerasDe() {
    error.value = null;
    try {
        await api.asignarCarreras(editandoCarreras.value.id, editandoCarreras.value.elegidas);
        editandoCarreras.value = null;
        await cargarCuentas();
    } catch (e) {
        error.value = e.message;
    }
}

function nuevaCuenta() {
    nuevoUsuario.value = { ...EN_BLANCO, carreras: [] };
}

async function guardarCuenta() {
    error.value = null;
    try {
        await api.crearUsuario(nuevoUsuario.value);
        nuevoUsuario.value = null;
        await cargarCuentas();
    } catch (e) {
        // El diálogo sigue abierto con lo escrito: cerrarlo obligaría a
        // teclearlo todo otra vez por un usuario repetido.
        error.value = e.message;
    }
}

function alternarEnDialogo(codigo) {
    const d = editandoCarreras.value;
    d.elegidas = d.elegidas.includes(codigo)
        ? d.elegidas.filter((c) => c !== codigo)
        : [...d.elegidas, codigo];
}

/**
 * Retirar no borra la cuenta: `saturacion_historial` y `solicitudes` guardan
 * quién hizo cada cosa, y borrar al autor dejaría la historia sin dueño. Se le
 * quitan las carreras, se cierran sus sesiones y deja de poder entrar. Vuelve
 * con una contraseña nueva.
 */
async function retirar(usuario) {
    if (
        !confirm(
            `¿Retirar a ${usuario.nombre}? Perderá sus carreras, sus sesiones y el acceso. ` +
                "Se puede reactivar dándole una contraseña nueva."
        )
    ) return;
    try {
        await api.retirarUsuario(usuario.id);
        await cargarCuentas();
    } catch (e) {
        error.value = e.message;
    }
}

async function cargar() {
    [docentes.value, periodos.value] = await Promise.all([
        api.docentes().catch(() => []),
        api.periodos().catch(() => [])
    ]);
}

onMounted(cargar);
onMounted(cargarCuentas);
onMounted(cargarAulas);
onMounted(async () => {
    await cargarCatalogo();
    normativa.value = await api.normativa().catch(() => null);
});

const visibles = computed(() => {
    const aguja = busqueda.value;
    return docentes.value.filter((d) => contiene(d.nombre, aguja));
});

/**
 * Alta de docente.
 *
 * La plantilla pasó a ser del departamento y el alta se quedó en el panel del
 * coordinador, donde ya no guardaba nada: se podía capturar a una persona
 * entera y perderla al recargar. Aquí sí se guarda, y es el único sitio donde
 * tiene sentido — es quien contrata.
 *
 * No se pide la disponibilidad: la declara el propio docente por su enlace, que
 * es el modelo. Tampoco las descargas ni las autorizaciones, que se añaden en
 * cuanto existe la ficha.
 */
function nuevoDocente() {
    abrir({
        id: siguienteIdDocente(docentes.value),
        nombre: "",
        categoria: "Titular",
        dedicacion: "tiempo completo",
        nivel: "A",
        horasMin: 0,
        horasMax: 22,
        maxMaterias: 3,
        maxGrupos: 5,
        materiasCapacitadas: [],
        descargas: [],
        disponibilidad: { declarada: [], evitar: [] },
        nueva: true
    });
}

function abrir(docente) {
    buscaMateria.value = "";
    soloAutorizadas.value = false;
    editando.value = docente;
    nombramiento.value = {
        categoria: docente.categoria ?? "Titular",
        // Capturado antes de que existiera el campo: se deduce en vez de dejarlo
        // vacío, y la revisión lo marca para confirmarlo.
        dedicacion:
            docente.dedicacion ?? (docente.categoria === "Asignatura" ? "asignatura" : "tiempo completo"),
        nivel: docente.nivel ?? "A",
        horasMin: docente.horasMin ?? 0,
        horasMax: docente.horasMax ?? 0,
        maxMaterias: docente.maxMaterias ?? 3,
        maxGrupos: docente.maxGrupos ?? 5
    };
    autorizadas.value = [...docente.materiasCapacitadas];
    descargas.value = docente.descargas.map((d) => ({ ...d }));
    error.value = null;
}

function agregarDescarga() {
    const d = nuevaDescarga.value;
    if (d.fin <= d.inicio || !d.motivo.trim()) {
        error.value = "La descarga necesita un motivo y un rango válido.";
        return;
    }
    descargas.value.push({ ...d, motivo: d.motivo.trim() });
    nuevaDescarga.value = { dia: "lunes", inicio: 7, fin: 9, motivo: "" };
    error.value = null;
}

async function guardar() {
    if (!editando.value.nombre?.trim()) {
        error.value = "El nombre es obligatorio.";
        return;
    }
    try {
        // El alta no tiene descargas todavía y la ficha aún no existe en la
        // base: primero se crea con la plantilla y después se le cuelga lo suyo.
        if (!editando.value.nueva) {
            await api.guardarDescargas(editando.value.id, descargas.value);
        }
        // Solo este docente. Mandar la plantilla completa llevaba a los otros
        // veintinueve tal como estaban al abrir el diálogo, y el cambio de
        // quien hubiera guardado mientras tanto se perdía sin aviso.
        await api.guardarDocente(editando.value.id, {
            ...nombramiento.value,
            horasMin: Number(nombramiento.value.horasMin),
            horasMax: Number(nombramiento.value.horasMax),
            maxMaterias: Number(nombramiento.value.maxMaterias),
            maxGrupos: Number(nombramiento.value.maxGrupos),
            nombre: editando.value.nombre.trim(),
            materiasCapacitadas: autorizadas.value
        });
        if (editando.value.nueva && descargas.value.length > 0) {
            await api.guardarDescargas(editando.value.id, descargas.value);
        }
        editando.value = null;
        await cargar();
        normativa.value = await api.normativa().catch(() => null);
    } catch (e) {
        error.value = e.message;
    }
}

async function alternarPeriodo(p) {
    try {
        if (p.cerrado) await api.reabrirPeriodo(p.paridad);
        else await api.cerrarPeriodo(p.paridad);
        await cargar();
    } catch (e) {
        error.value = e.message;
    }
}

/** Materias de todas las carreras, agrupadas por su clave. */
const catalogo = ref([]);
onMounted(async () => {
    const carreras = await api.carreras().catch(() => []);
    const vistas = new Map();
    for (const carrera of carreras) {
        const escenarios = await api.escenarios(carrera).catch(() => []);
        for (const e of escenarios) {
            const detalle = await api.escenario(carrera, e.id).catch(() => null);
            for (const m of detalle?.datos.materias ?? []) {
                if (!vistas.has(m.id)) vistas.set(m.id, { ...m, carrera });
            }
        }
    }
    catalogo.value = [...vistas.values()].sort(
        (a, b) => a.semestre - b.semestre || a.clave.localeCompare(b.clave)
    );
});

/**
 * Filtro del catálogo de materias.
 *
 * Autorizar es el trabajo principal del departamento y el catálogo son sesenta
 * y siete materias con trece carreras; encontrar una era desplazarse. El filtro
 * **no oculta las marcadas** cuando se busca: quitar una autorización sin verla
 * en la lista sería fácil de hacer sin querer.
 */
const buscaMateria = ref("");
const soloAutorizadas = ref(false);

const grupos = computed(() => {
    const aguja = buscaMateria.value;
    const marcadas = new Set(autorizadas.value);

    const visibles = catalogo.value.filter((m) => {
        if (soloAutorizadas.value && !marcadas.has(m.id)) return false;
        // Una autorizada siempre se ve: si la búsqueda la escondiera, se podría
        // desmarcar a ciegas al guardar.
        return marcadas.has(m.id) || contiene(`${m.clave} ${m.nombre}`, aguja);
    });

    const porSemestre = new Map();
    for (const m of visibles) {
        if (!porSemestre.has(m.semestre)) porSemestre.set(m.semestre, []);
        porSemestre.get(m.semestre).push(m);
    }
    return [...porSemestre]
        .sort((a, b) => a[0] - b[0])
        .map(([semestre, suyas]) => ({
            titulo: `Semestre ${semestre}`,
            opciones: suyas.map((m) => ({
                id: m.id,
                etiqueta: `${m.clave} · ${m.nombre}`,
                // De qué carrera salió. Las que comparten clave aparecen una
                // vez, que es lo correcto: autorizar en ACF-0901 vale para todas.
                nota: m.carrera
            }))
        }));
});

/** Cuántas quedan fuera del filtro, para que el conteo no engañe. */
/** Clases del plantel sin nadie al frente. Es lo que le falta al departamento. */
const sinAsignarTotal = computed(() =>
    resumenCatalogo.value.reduce((n, c) => n + c.sinAsignar, 0)
);

const ocultas = computed(
    () => catalogo.value.length - grupos.value.reduce((n, g) => n + g.opciones.length, 0)
);
</script>

<template>
    <div class="app">
        <aside class="lateral">
            <div class="lateral-marca">
                <LogoMarca :tamano="28" />
                <span class="marca-texto">Schedul<span class="marca-ia">AI</span></span>
            </div>

            <div class="lateral-escenario">
                <p class="lateral-escenario-nombre">Departamento Académico</p>
                <p class="lateral-escenario-meta">Asignación, descargas y cierre</p>
            </div>

            <nav class="lateral-nav">
                <p class="lateral-rotulo">Administración</p>
                <button
                    v-for="s in SECCIONES"
                    :key="s.id"
                    type="button"
                    class="lateral-item"
                    :class="{ 'is-activo': seccion === s.id }"
                    @click="seccion = s.id"
                >
                    {{ s.etiqueta }}
                    <span v-if="s.id === 'carreras'" class="lateral-item-conteo">{{ carreras.length }}</span>
                    <span v-else-if="s.id === 'cuentas'" class="lateral-item-conteo">{{ usuarios.length }}</span>
                    <span
                        v-else-if="s.id === 'catalogo' && sinAsignarTotal > 0"
                        class="lateral-item-conteo is-aviso"
                    >{{ sinAsignarTotal }}</span>
                    <span
                        v-else-if="s.id === 'peticiones' && peticionesPendientes > 0"
                        class="lateral-item-conteo is-aviso"
                    >{{ peticionesPendientes }}</span>
                    <span v-else-if="s.id === 'espacios'" class="lateral-item-conteo">{{ aulas.length }}</span>
                    <span
                        v-else-if="s.id === 'plantilla' && observados.length > 0"
                        class="lateral-item-conteo is-aviso"
                    >{{ observados.length }}</span>
                    <span v-else-if="s.id === 'plantilla'" class="lateral-item-conteo">{{ docentes.length }}</span>
                </button>
            </nav>

            <div class="lateral-pie">
                <div class="lateral-usuario">
                    <span class="lateral-pie-linea lateral-usuario-nombre">
                        {{ estado.usuario?.nombre }}
                    </span>
                    <div class="lateral-usuario-acciones">
                        <button type="button" class="btn btn-chico" @click="cambiandoClave = true">
                            Contraseña
                        </button>
                        <button type="button" class="btn btn-chico" @click="salir">Salir</button>
                    </div>
                </div>
            </div>
        </aside>

        <div class="principal">
            <header class="cabecera">
                <div class="cabecera-titulo">
                    <h1>Departamento Académico</h1>
                    <p class="cabecera-subtitulo">
                        Quién imparte qué, las horas de comisión y el cierre del periodo.
                    </p>
                </div>
            </header>

            <p v-if="error" class="banda banda-error">{{ error }}</p>
            <p v-if="aviso" class="banda banda-ok" role="status">{{ aviso }}</p>

            <div class="contenido">
                <section v-if="seccion === 'periodos'" class="tarjeta-panel">
                    <header class="tarjeta-panel-cabeza">
                        <div>
                            <h2 class="tarjeta-panel-titulo">Periodos</h2>
                            <p class="campo-ayuda">
                                Cerrar da por terminada la negociación entre carreras: lo apartado
                                pasa a ser el horario del semestre y nadie lo mueve.
                            </p>
                        </div>
                    </header>
                    <div class="tarjeta-panel-cuerpo sin-relleno">
                        <table class="tabla tabla-compacta">
                            <tbody>
                                <tr v-for="p in periodos" :key="p.paridad">
                                    <td class="celda-principal">{{ p.etiqueta }}</td>
                                    <td class="celda-tenue">{{ p.semestres.join(", ") }}</td>
                                    <td>
                                        <span v-if="p.cerrado" class="violacion is-dura">
                                            cerrado el {{ p.cerrado.cerrado.slice(0, 10) }}
                                        </span>
                                        <span v-else class="violacion is-blanda">abierto</span>
                                    </td>
                                    <td class="celda-acciones">
                                        <button type="button" class="btn btn-chico" @click="alternarPeriodo(p)">
                                            {{ p.cerrado ? "Reabrir" : "Cerrar periodo" }}
                                        </button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>

                <!-- Carreras: no existían como entidad visible, aunque son lo
                     que todo lo demás organiza. -->
                <section v-if="seccion === 'carreras'" class="tarjeta-panel">
                    <header class="tarjeta-panel-cabeza">
                        <div>
                            <h2 class="tarjeta-panel-titulo">Carreras del plantel</h2>
                            <p class="campo-ayuda">
                                La oferta que el instituto imparte. Abrir una la deja lista para que
                                su coordinación capture la retícula.
                            </p>
                        </div>
                        <button type="button" class="btn btn-primary btn-chico" @click="abrirCarrera">
                            Abrir carrera
                        </button>
                    </header>
                    <div class="tarjeta-panel-cuerpo sin-relleno">
                        <table class="tabla">
                            <thead>
                                <tr>
                                    <th>Clave</th>
                                    <th>Nombre</th>
                                    <th>Coordinación</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="c in carrerasConDueno" :key="c.codigo">
                                    <td><span class="chip-carrera is-activo">{{ c.codigo }}</span></td>
                                    <td class="celda-principal">{{ c.nombre }}</td>
                                    <td>
                                        <template v-if="c.coordinan.length">
                                            {{ c.coordinan.map((u) => u.nombre).join(", ") }}
                                        </template>
                                        <!-- Una carrera sin coordinador no falla
                                             en ninguna parte: simplemente nadie
                                             puede abrirla. Por eso se marca. -->
                                        <span v-else class="violacion is-dura">sin coordinador</span>
                                    </td>
                                    <td class="celda-acciones">
                                        <button type="button" class="btn btn-chico" @click="cerrarCarrera(c)">
                                            Cerrar
                                        </button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>

                <section v-if="seccion === 'cuentas'" class="tarjeta-panel">
                    <header class="tarjeta-panel-cabeza">
                        <div>
                            <h2 class="tarjeta-panel-titulo">Cuentas ({{ usuarios.length }})</h2>
                            <p class="campo-ayuda">
                                Quién coordina qué carrera. Un coordinador puede llevar varias.
                            </p>
                        </div>
                        <div class="cabecera-acciones">
                            <input
                                v-model="buscaCuenta"
                                type="search"
                                class="input-busqueda"
                                style="flex: 0 1 260px"
                                placeholder="Buscar cuenta…"
                            >
                            <button type="button" class="btn btn-primary btn-chico" @click="nuevaCuenta">
                                Nueva cuenta
                            </button>
                        </div>
                    </header>
                    <div class="tarjeta-panel-cuerpo sin-relleno">
                        <table class="tabla">
                            <thead>
                                <tr>
                                    <th>Nombre</th>
                                    <th>Usuario</th>
                                    <th>Rol</th>
                                    <th>Carreras</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="u in cuentasVisibles"
                                    :key="u.id"
                                    :class="{ 'fila-retirada': !u.activo }"
                                >
                                    <td class="celda-principal">{{ u.nombre }}</td>
                                    <td class="celda-tenue">{{ u.usuario }}</td>
                                    <td>
                                        <span
                                            class="violacion"
                                            :class="u.rol === 'departamento' ? 'is-dura' : 'is-blanda'"
                                        >{{ u.rol }}</span>
                                    </td>
                                    <td>
                                        <!-- El departamento ve todas las carreras
                                             por definición, así que asignarle
                                             alguna no significaría nada. -->
                                        <template v-if="u.rol === 'departamento'">
                                            <span class="celda-tenue">todas</span>
                                        </template>
                                        <!-- Solo las que lleva. Antes se pintaban
                                             las trece del plantel en cada fila y
                                             las activas se perdían entre ellas. -->
                                        <div v-else class="fila-chips">
                                            <span
                                                v-for="c in u.carreras"
                                                :key="c"
                                                class="chip-carrera is-activo"
                                            >{{ c }}</span>
                                            <span v-if="!u.activo" class="celda-tenue">retirada</span>
                                            <span
                                                v-else-if="!u.carreras.length"
                                                class="celda-tenue"
                                            >sin carreras</span>
                                            <button
                                                v-if="u.activo"
                                                type="button"
                                                class="chip-carrera chip-editar"
                                                :aria-label="`Editar las carreras de ${u.nombre}`"
                                                @click="editarCarreras(u)"
                                            >Editar</button>
                                        </div>
                                    </td>
                                    <td class="celda-acciones">
                                        <template v-if="u.id !== estado.usuario?.id">
                                            <!-- Una cuenta retirada vuelve con una
                                                 contraseña nueva: es lo único que
                                                 necesita para entrar otra vez. -->
                                            <button
                                                v-if="!u.activo"
                                                type="button"
                                                class="btn btn-chico"
                                                @click="reiniciarClave(u)"
                                            >Reactivar</button>
                                            <template v-else>
                                                <button type="button" class="btn btn-chico" @click="reiniciarClave(u)">
                                                    Contraseña
                                                </button>
                                                <button type="button" class="btn btn-chico" @click="retirar(u)">
                                                    Retirar
                                                </button>
                                            </template>
                                        </template>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>

                <!-- Quién imparte qué, por carrera: lo que el jefe reparte. -->
                <section v-if="seccion === 'catalogo'" class="tarjeta-panel">
                    <header class="tarjeta-panel-cabeza">
                        <div>
                            <h2 class="tarjeta-panel-titulo">Quién imparte qué</h2>
                            <p class="campo-ayuda">
                                Una decisión por clase: una materia frente a un grupo. Aquí no hay
                                horas, en qué momento de la semana cae lo resuelve el coordinador
                                con el generador.
                            </p>
                        </div>
                        <div class="tarjeta-panel-acciones">
                            <input
                                v-model="buscaCatalogo"
                                type="search"
                                class="input-busqueda"
                                style="flex: 0 1 260px"
                                placeholder="Buscar materia o docente…"
                            >
                            <button type="button" class="btn btn-chico" @click="imprimirCatalogo">
                                Imprimir
                            </button>
                            <button
                                type="button"
                                class="btn btn-chico"
                                :disabled="sinAsignarAqui === (detalleCatalogo?.filas?.length ?? 0)"
                                @click="vaciarReparto"
                            >Vaciar</button>
                        </div>
                    </header>

                    <div class="tarjeta-panel-cuerpo">
                        <div class="fila-carreras">
                            <button
                                v-for="c in resumenCatalogo"
                                :key="c.carrera"
                                type="button"
                                class="pastilla-carrera"
                                :class="{ 'is-activo': carreraCatalogo === c.carrera }"
                                @click="verCatalogoDe(c.carrera)"
                            >
                                <span class="pastilla-clave">{{ c.carrera }}</span>
                                <span class="pastilla-meta">{{ c.clases }} clases</span>
                                <!-- Sin nadie al frente, el coordinador genera con
                                     quien el motor elija, que no es una decisión suya. -->
                                <span v-if="c.sinAsignar" class="violacion is-dura">
                                    {{ c.sinAsignar }} sin asignar
                                </span>
                                <span v-else class="violacion is-blanda">repartida</span>
                                <!-- Decisiones que se quedaron sin clase. Sin
                                     esto solo se veían abriendo la carrera. -->
                                <span v-if="c.huerfanas" class="violacion is-blanda">
                                    {{ c.huerfanas }} sin clase
                                </span>
                            </button>
                        </div>
                    </div>

                    <!-- El déficit es del plantel: cada coordinación compara su
                         carga contra el tope de toda la plantilla, así que
                         ninguna ve por sí sola que las sumas no dan. Y quien
                         contrata es el departamento. -->
                    <div
                        v-if="necesidadesPlantel?.necesidades?.length"
                        class="tarjeta-panel-cuerpo"
                    >
                        <div class="bloque-necesidades" style="margin-top: 0">
                            <div class="necesidades-cabeza">
                                <span class="necesidades-marca">Para contratar</span>
                                <span class="detalle-meta">
                                    {{ necesidadesPlantel.clases }} clases del plantel son
                                    {{ necesidadesPlantel.horas }} h y los nombramientos suman
                                    {{ necesidadesPlantel.capacidad }} h
                                </span>
                            </div>
                            <ListaPendientes
                                :items="necesidadesPlantel.necesidades"
                                tono="necesidad"
                            />
                        </div>
                    </div>

                    <div v-if="huerfanas.length" class="tarjeta-panel-cuerpo">
                        <ul class="lista-avisos" style="margin: 0">
                            <li>
                                <strong>{{ huerfanas.length }}</strong>
                                asignaciones ya no corresponden a ninguna clase de este escenario:
                                la coordinación cerró el grupo o quitó la materia después de
                                repartir. No cuentan para la carga y vuelven solas si la clase
                                vuelve a abrirse.
                                <span class="celda-tenue">
                                    {{ huerfanas.map((h) => `${h.grupoClave} · ${h.docenteNombre}`).join(" — ") }}
                                </span>
                            </li>
                        </ul>
                    </div>

                    <div v-if="detalleCatalogo" class="tarjeta-panel-cuerpo sin-relleno">
                        <table class="tabla">
                            <thead>
                                <tr>
                                    <th>Materia</th>
                                    <th>Horas</th>
                                    <th>La imparte</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody v-for="g in gruposCatalogo" :key="g.clave">
                                <tr class="fila-grupo">
                                    <th colspan="4">
                                        Grupo {{ g.clave }}
                                        <span class="celda-tenue">{{ g.turno }}</span>
                                    </th>
                                </tr>
                                <tr v-for="f in g.filas" :key="f.materiaId + f.grupoClave">
                                    <td class="celda-principal">
                                        {{ f.nombre }}
                                        <span class="celda-tenue">{{ f.clave }}</span>
                                    </td>
                                    <td class="celda-tenue celda-numero">{{ f.horasSemana }}</td>
                                    <td>
                                        <div class="celda-marcas">
                                            <span v-if="f.docenteId" class="chip-carrera is-activo">
                                                {{ f.docenteNombre }}
                                            </span>
                                            <span v-else class="violacion is-dura">sin asignar</span>
                                            <!-- Se asignó, pero no declaró horas
                                                 en ese turno: el horario no va a
                                                 poder colocar la clase. -->
                                            <span v-if="f.docenteId && !alcanceDe(f).puede" class="violacion is-dura">
                                                {{ alcanceDe(f).motivo }}
                                            </span>
                                        </div>
                                    </td>
                                    <td class="celda-acciones">
                                        <button type="button" class="btn btn-chico" @click="abrirAsignacion(f)">
                                            {{ f.docenteId ? "Cambiar" : "Asignar" }}
                                        </button>
                                    </td>
                                </tr>
                            </tbody>
                            <tbody v-if="gruposCatalogo.length === 0">
                                <tr>
                                    <td class="celda-tenue" colspan="4">Ninguna clase coincide.</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>

                <!-- Lo que las coordinaciones piden sobre el reparto. -->
                <section v-if="seccion === 'peticiones'" class="tarjeta-panel">
                    <header class="tarjeta-panel-cabeza">
                        <div>
                            <h2 class="tarjeta-panel-titulo">Peticiones de cambio</h2>
                            <p class="campo-ayuda">
                                Quien arma el horario descubre lo que no se ve al repartir: que esa
                                persona no tiene huecos donde hace falta. Aceptar aquí cambia la
                                asignación; rechazar deja constancia del porqué.
                            </p>
                        </div>
                    </header>
                    <div class="tarjeta-panel-cuerpo sin-relleno">
                        <table class="tabla">
                            <thead>
                                <tr>
                                    <th>Clase</th>
                                    <th>Pide</th>
                                    <th>Motivo</th>
                                    <th>Estado</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="p in peticiones" :key="p.id">
                                    <td class="celda-principal">
                                        {{ p.materia }}
                                        <span class="celda-tenue">{{ p.carrera }} · grupo {{ p.grupoClave }}</span>
                                    </td>
                                    <td>
                                        <span class="celda-tenue">{{ p.pedidaPor ?? p.carrera }}</span>
                                        <div v-if="p.actualNombre" class="celda-tenue">
                                            ahora: {{ p.actualNombre }}
                                        </div>
                                        <div v-if="p.propuesto && p.estado === 'pendiente'" class="fila-chips">
                                            <span v-if="p.propuestoNombre" class="chip-carrera">
                                                propone {{ p.propuestoNombre }}
                                            </span>
                                            <!-- Propuso a alguien que después se
                                                 dio de baja: sin esto la fila
                                                 salía con un hueco. -->
                                            <span v-else class="violacion is-dura">
                                                proponía a alguien que ya no está en la plantilla
                                            </span>
                                        </div>
                                    </td>
                                    <td class="celda-tenue">{{ p.motivo }}</td>
                                    <td>
                                        <span v-if="p.estado === 'pendiente'" class="violacion is-dura">
                                            esperando
                                        </span>
                                        <span v-else-if="p.estado === 'aceptada'" class="chip-carrera is-activo">
                                            aceptada · {{ p.propuestoNombre }}
                                        </span>
                                        <span v-else class="etiqueta-suave">rechazada</span>
                                        <div v-if="p.respuesta" class="celda-tenue">{{ p.respuesta }}</div>
                                    </td>
                                    <td class="celda-acciones">
                                        <button
                                            v-if="p.estado === 'pendiente'"
                                            type="button"
                                            class="btn btn-chico"
                                            @click="abrirRespuesta(p)"
                                        >Responder</button>
                                    </td>
                                </tr>
                                <tr v-if="peticiones.length === 0">
                                    <td class="celda-tenue" colspan="5">
                                        Ninguna coordinación ha pedido cambios.
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>

                <!-- Lo que cada persona junta entre todas las coordinaciones. -->
                <section v-if="seccion === 'carga'" class="tarjeta-panel">
                    <header class="tarjeta-panel-cabeza">
                        <div>
                            <h2 class="tarjeta-panel-titulo">Carga acumulada</h2>
                            <p class="campo-ayuda">
                                Asignar a alguien en dos carreras son dos decisiones
                                independientes; la persona no lo es. Esto es lo que junta entre
                                todas, para no descubrir en marzo que quedó con cuarenta horas.
                            </p>
                        </div>
                        <button type="button" class="btn btn-chico" @click="imprimirCarga">
                            Imprimir
                        </button>
                    </header>
                    <div class="tarjeta-panel-cuerpo sin-relleno">
                        <table class="tabla">
                            <thead>
                                <tr>
                                    <th>Docente</th>
                                    <th>Horas</th>
                                    <th>Clases</th>
                                    <th>Materias</th>
                                    <th>Carreras</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="c in carga" :key="c.docenteId">
                                    <td class="celda-principal">{{ c.nombre }}</td>
                                    <td class="celda-numero">
                                        <span :class="{ violacion: c.sobreHoras, 'is-dura': c.sobreHoras }">
                                            {{ c.horas }}
                                        </span>
                                        <span class="celda-tenue">&nbsp;/ {{ c.horasMax }}</span>
                                    </td>
                                    <td class="celda-numero">
                                        <span :class="{ violacion: c.sobreGrupos, 'is-dura': c.sobreGrupos }">
                                            {{ c.clases }}
                                        </span>
                                    </td>
                                    <td class="celda-numero">
                                        <span :class="{ violacion: c.sobreMaterias, 'is-dura': c.sobreMaterias }">
                                            {{ c.materias }}
                                        </span>
                                    </td>
                                    <td>
                                        <div class="fila-chips">
                                            <span v-for="x in c.carreras" :key="x" class="chip-carrera">{{ x }}</span>
                                        </div>
                                    </td>
                                </tr>
                                <tr v-if="carga.length === 0">
                                    <td class="celda-tenue" colspan="5">
                                        Nadie tiene clases asignadas todavía.
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>

                <section v-if="seccion === 'espacios'" class="tarjeta-panel">
                    <header class="tarjeta-panel-cabeza">
                        <div>
                            <h2 class="tarjeta-panel-titulo">Espacios del plantel ({{ aulas.length }})</h2>
                            <p class="campo-ayuda">
                                Aulas y laboratorios son del instituto, no de una carrera: la misma
                                aula la usa un grupo por la mañana y otro por la tarde. Quién la
                                ocupa cada hora lo decide el generador.
                            </p>
                        </div>
                        <button type="button" class="btn btn-primary btn-chico" @click="nuevaAula">
                            Agregar espacio
                        </button>
                    </header>
                    <div class="tarjeta-panel-cuerpo sin-relleno">
                        <table class="tabla">
                            <thead>
                                <tr>
                                    <th>Clave</th>
                                    <th>Tipo</th>
                                    <th>Capacidad</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="a in aulas" :key="a.id">
                                    <td class="celda-clave">{{ a.clave }}</td>
                                    <td>{{ a.tipo === "laboratorio" ? "Laboratorio" : "Aula" }}</td>
                                    <!-- Sin capacidad no se comprueba que los
                                         grupos quepan, y al fusionar dos suman. -->
                                    <td :class="{ 'celda-tenue': !a.capacidad }">
                                        {{ a.capacidad ? `${a.capacidad} alumnos` : "sin dato" }}
                                    </td>
                                    <td class="celda-acciones">
                                        <button type="button" class="btn btn-chico" @click="editarAula(a)">
                                            Editar
                                        </button>
                                        <button
                                            type="button"
                                            class="btn btn-chico btn-peligro"
                                            @click="borrarAula(a)"
                                        >Eliminar</button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>

                <section v-if="seccion === 'plantilla'" class="tarjeta-panel">
                    <header class="tarjeta-panel-cabeza">
                        <h2 class="tarjeta-panel-titulo">Plantilla docente ({{ docentes.length }})</h2>
                        <div class="tarjeta-panel-acciones">
                            <input
                                v-model="busqueda"
                                type="search"
                                class="input-busqueda"
                                style="flex: 0 1 300px"
                                placeholder="Buscar docente…"
                            >
                            <button type="button" class="btn btn-primary btn-chico" @click="nuevoDocente">
                                Agregar docente
                            </button>
                        </div>
                    </header>
                    <!--
                        Lo que el Reglamento Interior de Trabajo dice de la
                        plantilla capturada. Avisa y no impide: un plantel real
                        tiene comisiones y plazas mixtas, pero los topes del
                        sistema no pueden ser números inventados.
                    -->
                    <div class="tarjeta-panel-cuerpo">
                        <p v-if="!normativa" class="campo-ayuda">Revisando contra el reglamento…</p>
                        <p v-else-if="observados.length === 0" class="campo-ayuda">
                            Los {{ normativa.revisados }} nombramientos cuadran con el Reglamento
                            Interior de Trabajo del TecNM: hasta
                            {{ reglas.maxMaterias }} materias distintas (art. 155 y 156) y las horas
                            frente a grupo de su categoría (art. 143), con el ajuste de
                            {{ reglas.ajusteMaximo }} horas del artículo 147.
                        </p>
                        <div v-else>
                            <p class="campo-ayuda">
                                <strong>{{ observados.length }} de {{ normativa.revisados }}</strong>
                                nombramientos no cuadran con el Reglamento Interior de Trabajo.
                                No impide programar; conviene revisarlos.
                            </p>
                            <ul class="lista-avisos" style="margin-top: 12px">
                                <li v-for="o in observados" :key="o.docenteId">
                                    <strong>{{ o.nombre }}</strong>
                                    <template v-for="a in o.avisos" :key="a.codigo">
                                        — art. {{ a.articulo }}: {{ a.mensaje }}
                                    </template>
                                </li>
                            </ul>
                        </div>
                    </div>

                    <div class="tarjeta-panel-cuerpo sin-relleno">
                        <table class="tabla tabla-compacta">
                            <thead>
                                <tr>
                                    <th>Docente</th>
                                    <th>Nombramiento</th>
                                    <th>Frente a grupo</th>
                                    <th>Autorizado en</th>
                                    <th>Descarga</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="d in visibles" :key="d.id">
                                    <td class="celda-principal">{{ d.nombre }}</td>
                                    <td class="celda-tenue">
                                        {{ d.categoria }}<template v-if="d.nivel">&nbsp;{{ d.nivel }}</template><template
                                            v-if="d.dedicacion"
                                        >&nbsp;· {{ d.dedicacion }}</template>
                                    </td>
                                    <td class="celda-numero">
                                        {{ d.horasMax }} h
                                        <span class="celda-tenue">/ {{ d.maxMaterias }} mat.</span>
                                    </td>
                                    <td>{{ d.materiasCapacitadas.length }} materias</td>
                                    <td class="celda-tenue">
                                        {{ d.descargas.reduce((s, x) => s + (x.fin - x.inicio), 0) }} h
                                    </td>
                                    <td class="celda-acciones">
                                        <button type="button" class="btn btn-chico" @click="abrir(d)">
                                            Editar
                                        </button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>
            </div>
        </div>

        <DialogoModal
            :abierto="editandoAula !== null"
            :titulo="editandoAula?.nueva ? 'Agregar espacio' : 'Editar espacio'"
            @cerrar="editandoAula = null"
            @enviar="guardarAula"
        >
            <div v-if="editandoAula" class="campos">
                <label class="campo">
                    <span class="campo-rotulo">Clave</span>
                    <input v-model="editandoAula.clave" type="text" class="campo-control">
                    <span class="campo-ayuda">Como V-1 o LAB-2.</span>
                </label>
                <label class="campo">
                    <span class="campo-rotulo">Tipo</span>
                    <select v-model="editandoAula.tipo" class="campo-control">
                        <option value="aula">Aula</option>
                        <option value="laboratorio">Laboratorio</option>
                    </select>
                    <span class="campo-ayuda">
                        Las materias que piden laboratorio sacan al grupo de su aula.
                    </span>
                </label>
                <label class="campo">
                    <span class="campo-rotulo">Capacidad</span>
                    <input v-model.number="editandoAula.capacidad" type="number" min="0" class="campo-control">
                    <span class="campo-ayuda">
                        Sin este dato no se comprueba que los grupos quepan, y al fusionar dos suman.
                    </span>
                </label>
            </div>
        </DialogoModal>

        <DialogoModal
            :abierto="reiniciando !== null"
            :titulo="
                reiniciando
                    ? `${reiniciando.retirada ? 'Reactivar a' : 'Contraseña de'} ${reiniciando.nombre}`
                    : ''
            "
            @cerrar="reiniciando = null"
            @enviar="guardarClaveNueva"
        >
            <div v-if="reiniciando" class="campos">
                <p v-if="reiniciando.retirada" class="campo-ayuda">
                    La cuenta está retirada y no abre nada. Ponle una contraseña provisional
                    para devolverle el acceso: quedará obligada a cambiarla en su primera
                    entrada. Sus carreras se asignan aparte.
                </p>
                <p v-else class="campo-ayuda">
                    Para quien la olvidó. Pon una provisional, dísela de viva voz y listo: la
                    cuenta queda obligada a cambiarla en su siguiente entrada, así que solo la
                    sabrán los dos hasta entonces. Sus sesiones abiertas se cierran.
                </p>
                <label class="campo">
                    <span class="campo-rotulo">Contraseña provisional</span>
                    <input v-model="reiniciando.nueva" type="text" class="campo-control" autocomplete="off">
                    <span class="campo-ayuda">Mínimo 8 caracteres.</span>
                </label>
            </div>
        </DialogoModal>

        <!-- La hoja de papel: escondida en pantalla, lo único que se ve al
             imprimir. Es el documento que el departamento entrega. -->
        <CatalogoImprimible
            :alcance="aImprimir"
            :carrera="carreraCatalogo ?? ''"
            :carrera-nombre="resumenCatalogo.find((c) => c.carrera === carreraCatalogo)?.nombre ?? ''"
            :escenario-id="detalleCatalogo?.escenarioId ?? ''"
            :filas="detalleCatalogo?.filas ?? []"
            :carga="carga"
        />

        <!--
            Elegir quién imparte una clase. Se decide viendo lo que la persona ya
            lleva encima: es la única pantalla donde esa suma está a la vista en
            el momento de sumarle una clase más.
        -->
        <DialogoModal
            :abierto="asignando !== null"
            :titulo="asignando ? `${asignando.titulo} · grupo ${asignando.grupo}` : ''"
            @cerrar="asignando = null"
        >
            <div v-if="asignando" class="campos">
                <p class="campo-ayuda">
                    Una persona para esta clase. Si el semestre abre varios grupos, cada uno se
                    decide aparte; y lo que dé en otra carrera es otra decisión.
                </p>

                <!-- El caso más común al repartir: la misma persona lleva todos
                     los grupos de la materia. Siguen siendo decisiones por clase
                     —cada una deja su constancia— solo que se toman juntas. -->
                <label v-if="asignando.hermanos > 0" class="franja-evitar">
                    <input v-model="asignando.aTodos" type="checkbox">
                    <span>
                        Aplicar a los {{ asignando.hermanos + 1 }} grupos que cursan esta materia
                    </span>
                </label>
                <input
                    v-model="buscaDocente"
                    type="search"
                    class="input-busqueda"
                    placeholder="Buscar docente…"
                >

                <!-- Quién la tuvo antes. Las horas ya tenían su historia; las
                     decisiones no, y "¿esto desde cuándo?" no lo contestaba
                     nadie. -->
                <details v-if="historialClase.length" class="historial-clase">
                    <summary>Quién la ha impartido ({{ historialClase.length }})</summary>
                    <ul>
                        <li v-for="(h, i) in historialClase" :key="i">
                            <span class="celda-tenue">{{ cuando(h.momento) }}</span>
                            <span v-if="h.accion === 'cambiada'">
                                {{ h.antesNombre }} → <strong>{{ h.despuesNombre }}</strong>
                            </span>
                            <span v-else-if="h.accion === 'asignada'">
                                se asignó a <strong>{{ h.despuesNombre }}</strong>
                            </span>
                            <span v-else>se quitó a {{ h.antesNombre }}</span>
                            <span v-if="h.quien" class="celda-tenue">· {{ h.quien }}</span>
                            <span v-if="h.nota" class="celda-tenue">· {{ h.nota }}</span>
                        </li>
                    </ul>
                </details>
                <div class="rejilla-carreras">
                    <button
                        v-for="d in candidatos"
                        :key="d.id"
                        type="button"
                        class="tarjeta-carrera"
                        :class="{ 'is-activo': asignando.elegido === d.id }"
                        @click="guardarAsignacion(d.id)"
                    >
                        <span class="tarjeta-carrera-clave">{{ d.nombre }}</span>
                        <span class="tarjeta-carrera-nombre">
                            {{ d.carga ? `${d.carga.horas} h · ${d.carga.clases} clases` : "sin clases" }}
                            <template v-if="d.carga && d.carga.horas > d.horasMax"> · pasado de horas</template>
                        </span>
                        <span v-if="!d.autorizado" class="violacion is-blanda">sin autorizar</span>
                        <span v-if="!d.alcance.puede" class="violacion is-dura">
                            {{ d.alcance.motivo }}
                        </span>
                    </button>
                </div>
            </div>
            <!-- Elegir a alguien ya guarda y cierra, así que no hay "Guardar":
                 lo único que queda por ofrecer es deshacer la decisión. -->
            <template #acciones>
                <!-- Siempre hay algo en la ranura: si quedara vacía, Vue pinta
                     el contenido por omisión, que es un "Guardar" sin sentido
                     aquí —elegir a alguien ya guarda—. -->
                <button
                    v-if="asignando?.elegido || asignando?.aTodos"
                    type="button"
                    class="btn"
                    @click="guardarAsignacion(null)"
                >
                    Dejarla sin asignar
                </button>
                <span v-else class="campo-ayuda">Elige a alguien de la lista.</span>
            </template>
        </DialogoModal>

        <!--
            Responder una petición. Aceptar no es decir que sí: es decir a quién
            se le da la clase, y el cambio queda hecho al cerrar el diálogo.
        -->
        <DialogoModal
            :abierto="respondiendo !== null"
            :titulo="respondiendo ? `${respondiendo.materia} · grupo ${respondiendo.grupoClave}` : ''"
            @cerrar="respondiendo = null"
        >
            <div v-if="respondiendo" class="campos">
                <p class="campo-ayuda">
                    {{ respondiendo.pedidaPor ?? respondiendo.carrera }} pide el cambio:
                    «{{ respondiendo.motivo }}»
                    <template v-if="respondiendo.actualNombre">
                        Ahora la imparte {{ respondiendo.actualNombre }}.
                    </template>
                </p>
                <label class="campo">
                    <span class="campo-rotulo">Quién la imparte a partir de ahora</span>
                    <select v-model="respondiendo.docenteId" class="campo-control">
                        <option value="">— elegir —</option>
                        <option v-for="d in candidatosPeticion" :key="d.id" :value="d.id">
                            {{ d.nombre }}<template v-if="d.carga"> — {{ d.carga.horas }} h, {{ d.carga.clases }} {{ d.carga.clases === 1 ? "clase" : "clases" }}</template>
                        </option>
                    </select>
                    <span class="campo-ayuda">
                        Solo los autorizados para esa materia, con lo que ya llevan encima.
                        Aceptar sin elegir a nadie dejaría la clase igual, así que no se puede.
                    </span>
                </label>
                <label class="campo">
                    <span class="campo-rotulo">Respuesta</span>
                    <input v-model="respondiendo.respuesta" type="text" class="campo-control">
                    <span class="campo-ayuda">La lee la coordinación que lo pidió.</span>
                </label>
            </div>
            <template #acciones>
                <button type="button" class="btn" @click="responderPeticion(false)">Rechazar</button>
                <button
                    type="button"
                    class="btn btn-primary"
                    :disabled="!respondiendo?.docenteId"
                    @click="responderPeticion(true)"
                >Aceptar y reasignar</button>
            </template>
        </DialogoModal>

        <!-- Alta de carrera. -->
        <DialogoModal
            :abierto="nuevaCarrera !== null"
            titulo="Abrir una carrera"
            @cerrar="nuevaCarrera = null"
            @enviar="guardarCarrera"
        >
            <div v-if="nuevaCarrera" class="campos">
                <label class="campo">
                    <span class="campo-rotulo">Clave</span>
                    <input v-model="nuevaCarrera.codigo" type="text" class="campo-control" maxlength="8">
                    <span class="campo-ayuda">
                        Como ISIC o IDAP: de 2 a 8 letras o dígitos, empezando por letra.
                    </span>
                </label>
                <label class="campo">
                    <span class="campo-rotulo">Nombre</span>
                    <input v-model="nuevaCarrera.nombre" type="text" class="campo-control">
                    <span class="campo-ayuda">El oficial, como aparece en la oferta educativa.</span>
                </label>
            </div>
        </DialogoModal>

        <!-- Carreras de una cuenta. -->
        <DialogoModal
            :abierto="editandoCarreras !== null"
            :titulo="editandoCarreras ? `Carreras de ${editandoCarreras.nombre}` : ''"
            @cerrar="editandoCarreras = null"
            @enviar="guardarCarrerasDe"
        >
            <div v-if="editandoCarreras" class="campos">
                <p class="campo-ayuda">
                    Una coordinación lleva las carreras de su área. Dejarla sin ninguna la retira:
                    la cuenta sigue existiendo, pero ya no abre nada.
                </p>
                <div class="rejilla-carreras">
                    <button
                        v-for="c in carreras"
                        :key="c.codigo"
                        type="button"
                        class="tarjeta-carrera"
                        :class="{ 'is-activo': editandoCarreras.elegidas.includes(c.codigo) }"
                        @click="alternarEnDialogo(c.codigo)"
                    >
                        <span class="tarjeta-carrera-clave">{{ c.codigo }}</span>
                        <span class="tarjeta-carrera-nombre">{{ c.nombre }}</span>
                    </button>
                </div>
            </div>
        </DialogoModal>

        <DialogoClave :abierto="cambiandoClave" @cerrar="cambiandoClave = false" />

        <DialogoModal
            :abierto="nuevoUsuario !== null"
            titulo="Nueva cuenta"
            @cerrar="nuevoUsuario = null"
            @enviar="guardarCuenta"
        >
            <div v-if="nuevoUsuario" class="campos">
                <label class="campo">
                    <span class="campo-rotulo">Nombre</span>
                    <input v-model="nuevoUsuario.nombre" type="text" class="campo-control" />
                </label>
                <label class="campo">
                    <span class="campo-rotulo">Usuario</span>
                    <input v-model="nuevoUsuario.usuario" type="text" class="campo-control" />
                    <span class="campo-ayuda">De 3 a 32 letras, números, punto o guion.</span>
                </label>
                <label class="campo">
                    <span class="campo-rotulo">Contraseña</span>
                    <input v-model="nuevoUsuario.clave" type="password" class="campo-control" />
                    <span class="campo-ayuda">
                        Mínimo 8 caracteres. Quien entre puede cambiarla desde su sesión.
                    </span>
                </label>
                <label class="campo">
                    <span class="campo-rotulo">Rol</span>
                    <select v-model="nuevoUsuario.rol" class="campo-control">
                        <option value="coordinador">Coordinador</option>
                        <option value="departamento">Departamento académico</option>
                    </select>
                </label>
                <div v-if="nuevoUsuario.rol === 'coordinador'" class="campo">
                    <span class="campo-rotulo">Carreras</span>
                    <div class="fila-chips">
                        <button
                            v-for="c in carreras"
                            :key="c"
                            type="button"
                            class="chip-carrera"
                            :class="{ 'is-activo': nuevoUsuario.carreras.includes(c) }"
                            @click="nuevoUsuario.carreras = nuevoUsuario.carreras.includes(c)
                                ? nuevoUsuario.carreras.filter((x) => x !== c)
                                : [...nuevoUsuario.carreras, c]"
                        >{{ c }}</button>
                    </div>
                </div>
            </div>
        </DialogoModal>

        <DialogoModal
            :abierto="editando !== null"
            :titulo="editando ? (editando.nueva ? 'Nuevo docente' : editando.nombre) : ''"
            ancho
            @cerrar="editando = null"
            @enviar="guardar"
        >
            <label v-if="editando?.nueva" class="campo">
                <span class="campo-rotulo">Nombre</span>
                <input v-model="editando.nombre" type="text" class="campo-control" autocomplete="off">
                <span class="campo-ayuda">
                    Como aparece en su nombramiento. Su disponibilidad la declara después él mismo,
                    por el enlace personal que el sistema le genera.
                </span>
            </label>

            <!--
                El nombramiento: categoría, dedicación y topes. Es lo que fija
                el Reglamento Interior de Trabajo, y hasta ahora no se podía
                capturar desde ninguna pantalla — venía sembrado y ahí se
                quedaba.
            -->
            <fieldset v-if="nombramiento" class="campo-grupo">
                <legend>Nombramiento</legend>
                <p class="campo-ayuda">
                    De aquí salen las horas frente a grupo que le tocan y cuántas materias puede
                    llevar. Al cambiar categoría o dedicación se propone lo que dice el reglamento;
                    si el caso es una excepción, se puede dejar otra cosa y queda señalada.
                </p>
                <div class="campo-fila">
                    <label class="campo">
                        <span class="campo-rotulo">Categoría</span>
                        <select v-model="nombramiento.categoria" class="campo-control" @change="alCambiarNombramiento">
                            <option v-for="c in CATEGORIAS" :key="c.valor" :value="c.valor">
                                {{ c.etiqueta }}
                            </option>
                        </select>
                    </label>
                    <label class="campo">
                        <span class="campo-rotulo">Dedicación</span>
                        <select v-model="nombramiento.dedicacion" class="campo-control" @change="alCambiarNombramiento">
                            <option v-for="d in DEDICACIONES" :key="d.valor" :value="d.valor">
                                {{ d.etiqueta }}
                            </option>
                        </select>
                    </label>
                    <label class="campo">
                        <span class="campo-rotulo">Nivel</span>
                        <select v-model="nombramiento.nivel" class="campo-control">
                            <option value="A">A</option>
                            <option value="B">B</option>
                            <option value="C">C</option>
                        </select>
                    </label>
                </div>
                <div class="campo-fila">
                    <label class="campo">
                        <span class="campo-rotulo">Horas mín.</span>
                        <input v-model.number="nombramiento.horasMin" type="number" min="0" class="campo-control">
                    </label>
                    <label class="campo">
                        <span class="campo-rotulo">Horas frente a grupo</span>
                        <input v-model.number="nombramiento.horasMax" type="number" min="0" class="campo-control">
                    </label>
                    <label class="campo">
                        <span class="campo-rotulo">Máx. materias</span>
                        <input v-model.number="nombramiento.maxMaterias" type="number" min="1" class="campo-control">
                    </label>
                    <label class="campo">
                        <span class="campo-rotulo">Máx. grupos</span>
                        <input v-model.number="nombramiento.maxGrupos" type="number" min="1" class="campo-control">
                    </label>
                </div>
                <ul v-if="segunReglamento.length" class="lista-avisos" style="margin: 0">
                    <li v-for="a in segunReglamento" :key="a">{{ a }}</li>
                </ul>
            </fieldset>

            <fieldset class="campo-grupo">
                <legend>Descargas administrativas ({{ descargas.length }})</legend>
                <p class="campo-ayuda">
                    Horas de comisión. El coordinador no puede programar clase sobre ellas.
                </p>
                <ul v-if="descargas.length" class="lista-descargas">
                    <li v-for="(d, i) in descargas" :key="i">
                        <span class="etiqueta-modulo">{{ d.dia }} {{ d.inicio }}:00-{{ d.fin }}:00</span>
                        {{ d.motivo }}
                        <button type="button" class="btn btn-chico btn-peligro" @click="descargas.splice(i, 1)">
                            Quitar
                        </button>
                    </li>
                </ul>

                <div class="campo-fila">
                    <label class="campo">
                        <span>Día</span>
                        <select v-model="nuevaDescarga.dia">
                            <option v-for="d in DIAS" :key="d" :value="d">{{ d }}</option>
                        </select>
                    </label>
                    <label class="campo">
                        <span>De</span>
                        <input v-model.number="nuevaDescarga.inicio" type="number" min="0" max="23">
                    </label>
                    <label class="campo">
                        <span>A</span>
                        <input v-model.number="nuevaDescarga.fin" type="number" min="1" max="24">
                    </label>
                    <label class="campo" style="flex: 2 1 200px">
                        <span>Motivo</span>
                        <input v-model="nuevaDescarga.motivo" type="text" placeholder="Jefatura de academia">
                    </label>
                </div>
                <button type="button" class="btn btn-chico" @click="agregarDescarga">
                    Agregar descarga
                </button>
            </fieldset>

            <fieldset class="campo-grupo">
                <legend>Materias autorizadas ({{ autorizadas.length }})</legend>
                <p class="campo-ayuda">
                    Qué puede impartir. El coordinador reparte las horas, pero no decide esto.
                </p>

                <div class="filtro-materias">
                    <input
                        v-model="buscaMateria"
                        type="search"
                        class="input-busqueda"
                        placeholder="Buscar por clave o nombre…"
                    >
                    <label class="filtro-solo">
                        <input v-model="soloAutorizadas" type="checkbox">
                        <span>Solo las suyas</span>
                    </label>
                </div>
                <p v-if="ocultas > 0" class="campo-ayuda">
                    {{ ocultas }} materias fuera del filtro. Las que ya tiene autorizadas
                    siguen a la vista, para no quitarlas sin querer.
                </p>

                <ListaChecks v-model="autorizadas" :grupos="grupos" />
            </fieldset>
        </DialogoModal>
    </div>
</template>
