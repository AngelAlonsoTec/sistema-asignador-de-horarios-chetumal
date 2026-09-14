<script setup>
import { ref, computed, watch, onMounted } from "vue";
import {
    estado, generarHorario, validarHorario, irASeccion,
    reservarHoras, liberarHoras, horarioApartado,
    configEscenario, guardarConfigEscenario, ajustarHorario
} from "../../estado.js";
import { api } from "../../api.js";
import RejillaHorario from "../RejillaHorario.vue";
import HorarioImprimible from "../HorarioImprimible.vue";
import DialogoModal from "../DialogoModal.vue";

const ETIQUETAS = {
    docenteNoCapacitado: "Docente no capacitado",
    choqueDocente: "Empalmes de docente",
    choqueGrupo: "Empalmes de grupo",
    choqueAula: "Empalmes de aula",
    aulaInadecuada: "Espacio inadecuado",
    fueraDeAulaBase: "Grupo fuera de su aula",
    aulaInsuficiente: "No caben en el aula",
    aulaOcupadaPorOtros: "Aula que usa otra carrera",
    materiaRepetidaDia: "Materia repetida en el día",
    horaNoDisponible: "Hora que el docente no tiene",
    // Ni dura ni del todo blanda: el horario se puede aplicar si el otro
    // coordinador cede, así que queda fuera de DURAS pero se nombra igual.
    horaEnDisputa: "Horas que otra carrera pretende",
    excesoMaterias: "Exceso de materias",
    excesoGrupos: "Exceso de grupos",
    horasBajoMinimo: "Horas bajo el mínimo",
    horasSobreMaximo: "Horas sobre el máximo",
    horaEvitada: "Horas que pidió evitar",
    huecos: "Horas muertas de grupo",
    huecosDocente: "Horas muertas de docente"
};

/** Las duras hacen inaplicable el horario; las blandas solo lo empeoran. */
const DURAS = new Set([
    "docenteNoCapacitado",
    "choqueDocente",
    "choqueGrupo",
    "choqueAula",
    "aulaInadecuada",
    "fueraDeAulaBase",
    "aulaInsuficiente",
    "aulaOcupadaPorOtros",
    "materiaRepetidaDia",
    "horaNoDisponible",
    "excesoMaterias",
    "excesoGrupos",
    "horasSobreMaximo"
]);

const SECCIONES = { materias: "Materias", docentes: "Docentes", aulas: "Aulas y laboratorios" };

const datos = computed(() => estado.abierto.datos);

const paridad = ref(null);
/** Líneas de configuración de grupo: semestre × especialidad. */
const lineas = ref([]);
const validacion = ref(null);
const validando = ref(false);
const resultado = ref(null);
/**
 * Si lo que se ve es el horario apartado o uno recién generado sin apartar.
 * La diferencia importa: lo apartado es lo que las demás carreras ya no pueden
 * tomar; lo generado es una propuesta que todavía no compromete nada.
 */
const esApartado = ref(false);
const guardado = ref(null);
const desfase = ref(null);
const grupoVisible = ref(null);

/**
 * Ajuste a mano.
 *
 * El motor entrega un horario correcto según lo que sabe, pero siempre hay algo
 * que no sabe: un docente que avisó tarde, un evento. Sin poder mover una clase
 * el coordinador abandona la herramienta la primera vez que le pasa.
 *
 * Lo que **no** se hace es dejarlo mover a ciegas: el cambio va al motor, que
 * reevalúa con sus propias reglas y dice qué se rompió. Comprobarlo aquí sería
 * escribir las reglas dos veces, y la segunda copia envejece.
 */
const moviendo = ref(null);
const mostrarAvanzados = ref(false);
/** Qué entra en el papel: "grupos", "docentes" o "ambos". */
const alcanceImpresion = ref("grupos");
/** Claves `materiaId|grupoId,grupoId` de las fusiones que el coordinador eligió. */
const fusionesElegidas = ref(new Set());

/**
 * Otras carreras que entran en el mismo horario.
 *
 * Es lo que hace posible la fusión entre carreras: si el motor no conoce el
 * resto de las clases del grupo invitado, le pone la fusionada encima. Hay que
 * programar las dos juntas o ninguna.
 *
 * Solo aparecen las que este coordinador lleva: generar un horario conjunto es
 * decidir el de todas, y nadie debería decidir el de una carrera ajena.
 */
const invitadas = ref([]);
const otrasCarreras = computed(() =>
    (estado.usuario?.carreras ?? []).filter((c) => c !== estado.carrera)
);
const escenariosPorCarrera = ref(new Map());

async function cargarEscenariosAjenos() {
    const mapa = new Map();
    for (const c of otrasCarreras.value) {
        mapa.set(c, await api.escenarios(c).catch(() => []));
    }
    escenariosPorCarrera.value = mapa;
}

function alternarInvitada(carrera) {
    const puesta = invitadas.value.find((x) => x.carrera === carrera);
    if (puesta) {
        invitadas.value = invitadas.value.filter((x) => x.carrera !== carrera);
    } else {
        const suyos = escenariosPorCarrera.value.get(carrera) ?? [];
        const base = suyos.find((e) => e.esBase) ?? suyos[0];
        if (!base) {
            estado.error = `${carrera} no tiene escenarios que programar.`;
            return;
        }
        invitadas.value = [...invitadas.value, { carrera, escenarioId: base.id }];
    }
    // Cambia el conjunto de grupos, así que las fusiones elegidas nombran
    // grupos que pueden dejar de existir.
    fusionesElegidas.value = new Set();
    olvidarResultado();
    revalidar({ conLineas: false });
}

function cambiarEscenarioInvitado(carrera, escenarioId) {
    invitadas.value = invitadas.value.map((x) => (x.carrera === carrera ? { ...x, escenarioId } : x));
    fusionesElegidas.value = new Set();
    olvidarResultado();
    revalidar({ conLineas: false });
}

const fusionesEntreCarreras = computed(() => validacion.value?.fusionesEntreCarreras ?? []);
const esConjunta = computed(() => validacion.value?.conjunta === true);
const bloqueoAbierto = ref(null);

const parametros = ref({
    generaciones: 600,
    islas: 4,
    poblacionPorIsla: 60,
    busquedaLocal: 30,
    semilla: 2026
});

const paridades = computed(() => validacion.value?.paridades ?? []);

const fusionesPosibles = computed(() => [
    ...(validacion.value?.fusionesPosibles ?? []),
    ...(validacion.value?.fusionesEntreCarreras ?? [])
]);

/** Identifica una candidata sin depender de su posición en la lista. */
function claveFusion(f) {
    return `${f.materiaId}|${f.grupos.map((g) => g.id).join(",")}`;
}

function abrirMovimiento(sesion) {
    moviendo.value = {
        indice: sesion.indice,
        titulo: `${sesion.materiaNombre} · ${sesion.grupoClave}`,
        duracion: sesion.horaFin - sesion.horaInicio,
        dia: sesion.dia,
        horaInicio: sesion.horaInicio,
        docenteId: sesion.docenteId,
        aulaId: sesion.aulaId
    };
}

/** Horas donde cabe el bloque entero dentro del turno del grupo. */
const horasPosibles = computed(() => {
    if (!moviendo.value || !resultado.value) return [];
    const turno = resultado.value.rejilla.turnos.find((t) => t.id === turnoDelGrupo.value)
        ?? resultado.value.rejilla.turnos[0];
    const horas = [];
    for (let h = turno.horaInicio; h + moviendo.value.duracion <= turno.horaFin; h++) horas.push(h);
    return horas;
});

const docentesDelEscenario = computed(() => datos.value.docentes ?? []);
const aulasDelEscenario = computed(() => datos.value.aulas ?? []);

async function moverClase() {
    const cambio = moviendo.value;
    const sesiones = resultado.value.sesiones.map((s) =>
        s.indice === cambio.indice
            ? { ...s, dia: cambio.dia, horaInicio: cambio.horaInicio,
                docenteId: cambio.docenteId, aulaId: cambio.aulaId }
            : s
    );

    const r = await ajustarHorario({
        paridad: paridad.value,
        grupos: lineas.value,
        invitadas: invitadas.value,
        fusiones: fusionesAEnviar.value,
        sesiones
    });
    if (!r) return;

    moviendo.value = null;
    resultado.value = r;
    // Lo apartado sigue siendo lo de antes hasta que se vuelva a apartar: decir
    // lo contrario haría creer que el cambio ya está frente a las demás
    // carreras.
    esApartado.value = false;
}

function alternarFusion(f) {
    const clave = claveFusion(f);
    const elegidas = new Set(fusionesElegidas.value);
    elegidas.has(clave) ? elegidas.delete(clave) : elegidas.add(clave);
    fusionesElegidas.value = elegidas;
    // Cambia el problema, así que lo que se vea deja de corresponder.
    olvidarResultado();
    recordar();
}

/**
 * Guarda lo elegido. Sin esto, al volver al escenario las fusiones salían sin
 * marcar y los grupos vueltos a la sugerencia, así que "Generar" daba algo
 * distinto de lo que estaba apartado sin decir por qué.
 */
function recordar() {
    if (!paridad.value) return;
    guardarConfigEscenario({
        paridad: paridad.value,
        lineas: lineas.value,
        invitadas: invitadas.value,
        fusiones: [...fusionesElegidas.value]
    });
}

const elegidas = computed(() =>
    fusionesPosibles.value.filter((f) => fusionesElegidas.value.has(claveFusion(f)))
);

const fusionesAEnviar = computed(() =>
    elegidas.value.map((f) => ({ materiaId: f.materiaId, grupos: f.grupos.map((g) => g.id) }))
);

const horasAhorradas = computed(() =>
    elegidas.value.reduce((n, f) => n + f.horasAhorradas, 0)
);

/** Hasta que llega la primera validación, los turnos conocidos por omisión. */
const TURNOS_POR_OMISION = [{ id: "matutino" }, { id: "vespertino" }];
const turnos = computed(() => validacion.value?.rejilla?.turnos ?? TURNOS_POR_OMISION);
const listo = computed(() => validacion.value?.listo === true);

/**
 * Pide al servidor el estado de preparación. La regla de qué falta vive solo en
 * el backend: recalcularla aquí daría dos versiones que se separan con el
 * tiempo, y es el backend el que de verdad bloquea.
 */
let pendiente = null;
async function revalidar({ conLineas = true } = {}) {
    validando.value = true;
    const peticion = {
        paridad: paridad.value ?? undefined,
        grupos: conLineas && lineas.value.length > 0 ? lineas.value : undefined,
        invitadas: invitadas.value.length > 0 ? invitadas.value : undefined
    };

    // Solo interesa la última respuesta: escribir cantidades rápido dispara
    // varias peticiones y la lenta no debe pisar a la reciente.
    const mia = {};
    pendiente = mia;
    const respuesta = await validarHorario(peticion);
    if (pendiente !== mia) return;

    validando.value = false;
    if (!respuesta) return;

    validacion.value = respuesta;
    paridad.value ??= respuesta.paridadSugerida;
    if (!conLineas || lineas.value.length === 0) lineas.value = respuesta.lineas;
}

/**
 * Recupera el horario apartado. Se hace antes de validar y no en paralelo
 * porque fija la paridad, y validar la daría por omisión: las dos escribiendo
 * a la vez dejarían la pantalla en un periodo que no es el del horario.
 */
/**
 * Recupera lo elegido la última vez. Va antes de validar porque fija la
 * paridad, y validar la daría por omisión: las dos escribiendo a la vez
 * dejarían la pantalla en un periodo que no es el del horario guardado.
 */
async function cargarConfig() {
    const c = await configEscenario().catch(() => null);
    if (!c) return;
    if (c.paridad) paridad.value = c.paridad;
    if (c.lineas?.length) lineas.value = c.lineas;
    if (c.invitadas?.length) invitadas.value = c.invitadas;
    fusionesElegidas.value = new Set(c.fusiones ?? []);
}

async function cargarApartado() {
    const r = await horarioApartado();
    if (!r?.horario) return;

    paridad.value = r.paridad;
    resultado.value = r.horario;
    grupoVisible.value = r.horario.grupos?.[0]?.id ?? null;
    esApartado.value = true;
    guardado.value = r.guardado;
    desfase.value = r.desfase;
}

onMounted(async () => {
    await cargarEscenariosAjenos();
    await cargarConfig();
    await cargarApartado();
    revalidar({ conLineas: lineas.value.length > 0 });
});

// Cambiar de periodo cambia qué semestres existen, así que las líneas del
// anterior dejan de tener sentido y se piden de nuevo.
watch(paridad, async (nueva, previa) => {
    if (previa === null || nueva === previa) return;
    lineas.value = [];
    // Las fusiones nombran grupos del periodo anterior: en el nuevo no existen.
    fusionesElegidas.value = new Set();
    olvidarResultado();
    // Recordar después de revalidar, no antes: es ella quien rellena las
    // líneas del periodo nuevo, y guardarlas vacías las perdería.
    await revalidar({ conLineas: false });
    recordar();
});

function olvidarResultado() {
    resultado.value = null;
    esApartado.value = false;
    guardado.value = null;
    desfase.value = null;
}

const fechaGuardado = computed(() =>
    guardado.value
        ? new Date(guardado.value).toLocaleString("es-MX", {
              day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
          })
        : null
);

const totalGrupos = computed(() =>
    lineas.value.reduce(
        (suma, linea) =>
            suma + Object.values(linea.porTurno ?? {}).reduce((s, n) => s + Number(n || 0), 0),
        0
    )
);

function etiquetaTurno(id) {
    return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Horas semanales que cursa un grupo de esta línea: el tronco común de su
 * semestre más las materias de su módulo. Es la carga de un grupo, no la suma
 * de todos los que se abran.
 */
function horasDeLinea(linea) {
    return datos.value.materias
        .filter((materia) => materia.semestre === linea.semestre)
        .filter(
            (materia) =>
                materia.especialidadId == null || materia.especialidadId === linea.especialidadId
        )
        .reduce((suma, materia) => suma + materia.horasSemana, 0);
}

const sesionesDelGrupo = computed(() => {
    if (!resultado.value || !grupoVisible.value) return [];
    // Se filtra por `grupoIds` y no por `grupoId`: una materia fusionada la
    // cursan varios grupos a la vez y tiene que salir en el horario de todos.
    return resultado.value.sesiones.filter((sesion) =>
        (sesion.grupoIds ?? [sesion.grupoId]).includes(grupoVisible.value)
    );
});

const grupoActual = computed(() =>
    resultado.value?.grupos.find((g) => g.id === grupoVisible.value)
);

const turnoDelGrupo = computed(() => grupoActual.value?.turno ?? "matutino");

/** Cuántas clases del grupo salen de su aula: son las de laboratorio. */
const salidasDelAula = computed(
    () => sesionesDelGrupo.value.filter((s) => s.esAulaBase === false).length
);

/**
 * Un tono por especialidad. El tronco común no lleva: es la mayoría de las
 * materias y colorearlas todas anularía el propósito de distinguir el módulo.
 */
const tonoPorEspecialidad = computed(
    () => new Map(datos.value.especialidades.map((e, i) => [e.id, i]))
);

const tonosPorMateria = computed(
    () =>
        new Map(
            datos.value.materias.map((materia) => [
                materia.id,
                materia.especialidadId ? tonoPorEspecialidad.value.get(materia.especialidadId) ?? null : null
            ])
        )
);

const leyenda = computed(() => {
    if (!resultado.value) return [];
    const presentes = new Set(sesionesDelGrupo.value.map((s) => tonosPorMateria.value.get(s.materiaId)));
    const items = datos.value.especialidades
        .filter((e) => presentes.has(tonoPorEspecialidad.value.get(e.id)))
        .map((e) => ({ nombre: e.nombre, clase: `clase-tono-${tonoPorEspecialidad.value.get(e.id) % 6}` }));
    if (presentes.has(null)) items.unshift({ nombre: "Tronco común", clase: "clase-tono-base" });
    return items;
});

const violaciones = computed(() => {
    if (!resultado.value) return [];
    return Object.entries(resultado.value.diagnostico)
        .filter(([, cantidad]) => cantidad > 0)
        .map(([clave, cantidad]) => ({
            clave,
            cantidad,
            etiqueta: ETIQUETAS[clave] ?? clave,
            dura: DURAS.has(clave)
        }))
        .sort((a, b) => Number(b.dura) - Number(a.dura) || b.cantidad - a.cantidad);
});

function alCambiarLinea() {
    olvidarResultado();
    recordar();
    revalidar();
}

/**
 * Aparta en la hoja compartida las horas de este horario. A partir de aquí,
 * otro escenario que se genere las verá tomadas y no podrá usarlas.
 */
async function apartar() {
    if (!resultado.value) return;
    // El horario viaja junto con las horas: apartar es lo que lo vuelve
    // recuperable, y generarlo de nuevo con otra semilla daría otro distinto.
    await reservarHoras({
        paridad: paridad.value,
        // Cada carrera aparta las suyas: el backend las separa por el prefijo
        // del grupo, pero necesita saber en qué escenario de cada una van.
        invitadas: invitadas.value,
        sesiones: resultado.value.sesiones,
        horario: resultado.value
    });
    await cargarApartado();
    revalidar();
}

async function soltar() {
    await liberarHoras();
    olvidarResultado();
    revalidar();
}

/**
 * Imprimir es del navegador, no de la app: `window.print()` abre su diálogo, que
 * ya sabe exportar a PDF en los tres sistemas. Generar el PDF aquí significaría
 * embarcar una librería de cientos de kilobytes para hacer peor lo que el
 * navegador hace bien.
 */
function imprimir() {
    window.print();
}

async function generar() {
    olvidarResultado();
    const respuesta = await generarHorario({
        paridad: paridad.value,
        grupos: lineas.value,
        invitadas: invitadas.value,
        fusiones: fusionesAEnviar.value,
        parametros: { ...parametros.value }
    });
    if (!respuesta) return;
    resultado.value = respuesta;
    grupoVisible.value = respuesta.grupos[0]?.id ?? null;
}
</script>

<template>
    <div class="seccion-horario">
        <!-- 1. Periodo -->
        <section class="tarjeta-panel">
            <header class="tarjeta-panel-cabeza">
                <div>
                    <h2 class="tarjeta-panel-titulo">Periodo por programar</h2>
                    <p class="campo-ayuda">
                        Un periodo no imparte los nueve semestres a la vez: agosto-diciembre da los
                        impares y enero-junio los pares. Solo se programan los del periodo elegido.
                    </p>
                </div>
            </header>

            <div class="tarjeta-panel-cuerpo">
                <div class="filtros filtros-grandes">
                    <button
                        v-for="opcion in paridades"
                        :key="opcion.id"
                        class="chip-filtro"
                        :class="{ 'is-active': opcion.id === paridad }"
                        @click="paridad = opcion.id"
                    >
                        {{ opcion.etiqueta }}
                        <span class="chip-filtro-nota">{{ opcion.semestres.join(", ") }}</span>
                    </button>
                </div>
            </div>
        </section>

        <!-- 1b. Carreras que entran -->
        <section v-if="otrasCarreras.length" class="tarjeta-panel">
            <header class="tarjeta-panel-cabeza">
                <div>
                    <h2 class="tarjeta-panel-titulo">Programar junto con otra carrera</h2>
                    <p class="campo-ayuda">
                        Para que dos carreras compartan una clase hay que programarlas juntas: si el
                        algoritmo no conoce el resto del horario del otro grupo, le pone la clase
                        compartida encima. Solo salen las carreras que coordinas.
                    </p>
                </div>
                <span v-if="esConjunta" class="detalle-meta">
                    {{ invitadas.length + 1 }} carreras en un solo horario
                </span>
            </header>

            <div class="tarjeta-panel-cuerpo">
                <div class="lista-invitadas">
                    <label v-for="c in otrasCarreras" :key="c" class="invitada">
                        <input
                            type="checkbox"
                            :checked="invitadas.some((x) => x.carrera === c)"
                            @change="alternarInvitada(c)"
                        >
                        <span class="invitada-nombre">{{ c }}</span>
                        <!-- Cuál de sus escenarios: una carrera puede tener
                             varios y no da igual con cuál se programa. -->
                        <select
                            v-if="invitadas.some((x) => x.carrera === c)"
                            class="select-chico"
                            :value="invitadas.find((x) => x.carrera === c).escenarioId"
                            :aria-label="`Escenario de ${c}`"
                            @change="cambiarEscenarioInvitado(c, $event.target.value)"
                        >
                            <option
                                v-for="e in escenariosPorCarrera.get(c) ?? []"
                                :key="e.id"
                                :value="e.id"
                            >{{ e.nombre }}</option>
                        </select>
                    </label>
                </div>

                <p v-if="esConjunta && fusionesEntreCarreras.length" class="campo-ayuda" style="margin-top: 16px">
                    Hay <strong>{{ fusionesEntreCarreras.length }}</strong> materias que las dos
                    cursan en el mismo turno. Marcarlas abajo ahorra
                    {{ fusionesEntreCarreras.reduce((n, f) => n + f.horasAhorradas, 0) }} horas de
                    clase a la semana.
                </p>
            </div>
        </section>

        <!-- 2. Grupos -->
        <section class="tarjeta-panel">
            <header class="tarjeta-panel-cabeza">
                <div>
                    <h2 class="tarjeta-panel-titulo">Grupos del periodo</h2>
                    <p class="campo-ayuda">
                        Cada grupo cursa el tronco común de su semestre y, si es de especialidad,
                        únicamente las materias de su módulo.
                    </p>
                </div>
                <span class="detalle-meta">{{ totalGrupos }} grupos</span>
            </header>

            <div class="tarjeta-panel-cuerpo sin-relleno">
                <p v-if="lineas.length === 0" class="estado-vacio">
                    Este escenario no tiene materias en el periodo elegido.
                </p>

                <table v-else class="tabla tabla-compacta">
                    <thead>
                        <tr>
                            <th>Semestre</th>
                            <th>Módulo</th>
                            <th>Carga por grupo</th>
                            <th>Alumnos</th>
                            <!-- Una columna por turno: un mismo semestre puede
                                 abrir grupos en la mañana y en la tarde. -->
                            <th v-for="turno in turnos" :key="turno.id">
                                {{ etiquetaTurno(turno.id) }}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="(linea, i) in lineas"
                            :key="`${linea.semestre}-${linea.especialidadId}`"
                        >
                            <td class="celda-principal">{{ linea.semestre }}</td>
                            <td>
                                <span v-if="linea.especialidad" class="etiqueta-modulo">
                                    {{ linea.especialidad }}
                                </span>
                                <span v-else class="celda-tenue">Tronco común</span>
                            </td>
                            <td class="celda-tenue">{{ horasDeLinea(linea) }} h/semana</td>
                            <td>
                                <input
                                    v-model.number="lineas[i].alumnos"
                                    type="number"
                                    min="0"
                                    max="120"
                                    class="input-chico input-conteo"
                                    :class="{ 'is-faltante': !(linea.alumnos > 0) }"
                                    :title="linea.alumnos > 0
                                        ? ''
                                        : 'Sin alumnos no se comprueba que el grupo quepa en el aula'"
                                    :aria-label="`Alumnos por grupo en semestre ${linea.semestre}`"
                                    @change="alCambiarLinea"
                                >
                            </td>
                            <td v-for="turno in turnos" :key="turno.id">
                                <input
                                    v-model.number="lineas[i].porTurno[turno.id]"
                                    type="number"
                                    min="0"
                                    max="9"
                                    class="input-chico input-conteo"
                                    :aria-label="`Grupos de ${etiquetaTurno(turno.id)} en semestre ${linea.semestre}`"
                                    @change="alCambiarLinea"
                                >
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>

        <!-- 3. Preparación: el portero -->
        <section class="tarjeta-panel">
            <header class="tarjeta-panel-cabeza">
                <h2 class="tarjeta-panel-titulo">Antes de generar</h2>
                <span v-if="validando" class="detalle-meta">Revisando…</span>
            </header>

            <div class="tarjeta-panel-cuerpo">
                <p v-if="!validacion" class="estado-vacio">Revisando los datos…</p>

                <template v-else>
                    <div v-if="listo" class="aviso-listo">
                        <span class="aviso-listo-marca">Datos completos</span>
                        <span>
                            {{ validacion.resumen.materias }} materias en
                            {{ validacion.resumen.grupos }} grupos ·
                            {{ validacion.resumen.horasTotales }} h/semana contra
                            {{ validacion.resumen.capacidadDocente }} h de capacidad docente.
                        </span>
                        <!-- Cuánto de lo que va a salir lo decidió el
                             departamento y cuánto lo va a elegir el motor. -->
                        <span v-if="validacion.resumen.clases">
                            {{ validacion.resumen.clases - validacion.resumen.sinAsignar }}
                            de {{ validacion.resumen.clases }} clases con docente asignado.
                        </span>
                    </div>

                    <ul v-else class="lista-bloqueos">
                        <li v-for="bloqueo in validacion.bloqueos" :key="bloqueo.codigo">
                            <div class="bloqueo-fila">
                                <span class="bloqueo-mensaje">{{ bloqueo.mensaje }}</span>
                                <div class="bloqueo-acciones">
                                    <button
                                        v-if="bloqueo.detalle.length"
                                        type="button"
                                        class="btn btn-chico"
                                        @click="bloqueoAbierto = bloqueoAbierto === bloqueo.codigo ? null : bloqueo.codigo"
                                    >
                                        {{ bloqueoAbierto === bloqueo.codigo ? "Ocultar" : `Ver ${bloqueo.detalle.length}` }}
                                    </button>
                                    <button
                                        v-if="SECCIONES[bloqueo.seccion]"
                                        type="button"
                                        class="btn btn-chico"
                                        @click="irASeccion(bloqueo.seccion, bloqueo.codigo === 'materias-sin-docente' ? 'sin-docente' : null)"
                                    >Ir a {{ SECCIONES[bloqueo.seccion] }}</button>
                                </div>
                            </div>
                            <ul v-if="bloqueoAbierto === bloqueo.codigo" class="bloqueo-detalle">
                                <li v-for="linea in bloqueo.detalle" :key="linea">{{ linea }}</li>
                            </ul>
                        </li>
                    </ul>

                    <p v-if="validacion.horasAjenas > 0" class="campo-ayuda">
                        Otras carreras ya apartaron horas de estos docentes; el horario se genera
                        con lo que queda libre.
                    </p>

                    <ul v-if="validacion.advertencias.length" class="lista-avisos" style="margin-top: 16px">
                        <li v-for="aviso in validacion.advertencias" :key="aviso.codigo">
                            {{ aviso.mensaje }}
                        </li>
                    </ul>
                </template>
            </div>
        </section>

        <!-- 4. Fusiones -->
        <section v-if="fusionesPosibles.length" class="tarjeta-panel">
            <header class="tarjeta-panel-cabeza">
                <div>
                    <h2 class="tarjeta-panel-titulo">Materias que pueden compartirse</h2>
                    <p class="campo-ayuda">
                        Estos grupos cursan la misma materia en el mismo turno. Fusionarla es
                        impartirla una sola vez, con un docente y un aula, en lugar de repetirla
                        para cada grupo.
                    </p>
                </div>
                <span v-if="horasAhorradas" class="detalle-meta">
                    {{ horasAhorradas }} h ahorradas
                </span>
            </header>

            <div class="tarjeta-panel-cuerpo sin-relleno">
                <table class="tabla">
                    <thead>
                        <tr>
                            <th></th>
                            <th>Materia</th>
                            <th>Grupos</th>
                            <th>Turno</th>
                            <th>Alumnos</th>
                            <th>Ahorra</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="f in fusionesPosibles" :key="claveFusion(f)">
                            <td>
                                <input
                                    type="checkbox"
                                    :checked="fusionesElegidas.has(claveFusion(f))"
                                    :aria-label="`Fusionar ${f.materiaNombre}`"
                                    @change="alternarFusion(f)"
                                />
                            </td>
                            <td class="celda-principal">
                                {{ f.materiaNombre }}
                                <span class="celda-tenue">{{ f.materiaClave }}</span>
                            </td>
                            <td>
                                {{ f.grupos.map((g) => g.clave).join(" + ") }}
                                <span v-if="f.carreras" class="etiqueta-suave">entre carreras</span>
                                <!-- Una fusión es una clase y la da una sola
                                     persona: fusionar deja fuera una de las dos
                                     decisiones del departamento. -->
                                <span v-if="f.docentesDistintos" class="violacion is-blanda">
                                    docentes distintos
                                </span>
                            </td>
                            <td class="celda-tenue">{{ f.turno }}</td>
                            <!-- El aula tiene que aguantar a los dos grupos
                                 juntos, y es el dato que decide si caben. -->
                            <td :class="{ 'celda-tenue': !f.alumnos }">
                                {{ f.alumnos || "sin capturar" }}
                            </td>
                            <td>{{ f.horasAhorradas }} h</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>

        <!-- 5. Parámetros -->
        <section class="tarjeta-panel">
            <header class="tarjeta-panel-cabeza">
                <h2 class="tarjeta-panel-titulo">Parámetros del algoritmo</h2>
                <button type="button" class="btn btn-chico" @click="mostrarAvanzados = !mostrarAvanzados">
                    {{ mostrarAvanzados ? "Ocultar" : "Mostrar" }}
                </button>
            </header>

            <div class="tarjeta-panel-cuerpo">
                <div v-if="mostrarAvanzados">
                    <div class="campo-fila">
                        <label class="campo">
                            <span>Generaciones</span>
                            <input v-model.number="parametros.generaciones" type="number" min="0" max="20000">
                        </label>
                        <label class="campo">
                            <span>Islas (hilos)</span>
                            <input v-model.number="parametros.islas" type="number" min="1" max="64">
                        </label>
                        <label class="campo">
                            <span>Población por isla</span>
                            <input v-model.number="parametros.poblacionPorIsla" type="number" min="4" max="500">
                        </label>
                        <label class="campo">
                            <span>Búsqueda local</span>
                            <input v-model.number="parametros.busquedaLocal" type="number" min="0" max="500">
                        </label>
                        <label class="campo">
                            <span>Semilla</span>
                            <input v-model.number="parametros.semilla" type="number" min="0">
                        </label>
                    </div>
                    <p class="campo-ayuda">
                        La misma semilla produce exactamente el mismo horario, lo que permite
                        comparar dos configuraciones y atribuir la diferencia a los parámetros.
                        Búsqueda local en 0 deja un algoritmo genético puro, útil como línea base.
                    </p>
                </div>

                <div class="config-acciones">
                    <p class="campo-ayuda">
                        <template v-if="listo">
                            {{ parametros.generaciones }} generaciones en {{ parametros.islas }} islas,
                            semilla {{ parametros.semilla }}.
                        </template>
                        <template v-else>
                            No se puede generar hasta que los datos estén completos.
                        </template>
                    </p>
                    <button
                        type="button"
                        class="btn btn-primary"
                        :disabled="!listo || estado.cargando"
                        @click="generar"
                    >{{ estado.cargando ? "Generando…" : "Generar horario" }}</button>
                </div>
            </div>
        </section>

        <!-- 6. Resultado -->
        <template v-if="resultado">
            <section class="tarjeta-panel">
                <header class="tarjeta-panel-cabeza">
                    <div>
                        <h2 class="tarjeta-panel-titulo">
                            {{ esApartado ? "Horario apartado" : "Propuesta sin apartar" }}
                        </h2>
                        <p class="campo-ayuda">
                            <template v-if="esApartado">
                                Guardado el {{ fechaGuardado }} · Es el que las demás
                                carreras ven como tuyo.
                            </template>
                            <template v-else>
                                Todavía no compromete horas. Apartarlo lo hace visible para las
                                demás carreras y permite recuperarlo después.
                            </template>
                        </p>
                    </div>
                    <div class="cabecera-acciones">
                        <span class="detalle-meta">{{ resultado.sesiones.length }} bloques</span>
                        <button
                            type="button"
                            class="btn btn-chico"
                            :class="{ 'btn-primary': !esApartado }"
                            @click="apartar"
                        >
                            {{ esApartado ? "Volver a apartar" : "Apartar estas horas" }}
                        </button>
                        <button
                            v-if="esApartado"
                            type="button"
                            class="btn btn-chico"
                            @click="soltar"
                        >Liberar</button>
                        <select v-model="alcanceImpresion" class="select-chico" aria-label="Qué imprimir">
                            <option value="grupos">Por grupo</option>
                            <option value="docentes">Por docente</option>
                            <option value="ambos">Grupos y docentes</option>
                        </select>
                        <button type="button" class="btn btn-chico" @click="imprimir">
                            Imprimir
                        </button>
                    </div>
                </header>

                <!--
                    El horario guardado y las horas apartadas se separan cuando
                    el coordinador cede en una conciliación: las horas se van y
                    el horario sigue mostrando esa clase. Reacomodarlo es trabajo
                    del motor, así que aquí solo se dice.
                -->
                <div v-if="desfase && !desfase.alDia" class="aviso-desfase">
                    <p class="aviso-desfase-titulo">
                        Este horario ya no corresponde con tus horas
                    </p>
                    <p class="campo-ayuda">
                        Cediste
                        {{ desfase.sesionesPerdidas.length }}
                        {{ desfase.sesionesPerdidas.length === 1 ? "clase" : "clases" }}
                        desde que lo generaste. Hay que generar de nuevo y volver a apartar.
                    </p>
                    <ul class="lista-perdidas">
                        <li v-for="(s, i) in desfase.sesionesPerdidas" :key="i">
                            <strong>{{ s.grupoClave }}</strong>
                            {{ s.materiaClave }}
                            <span class="celda-tenue">
                                {{ s.dia }} {{ s.horaInicio }}:00-{{ s.horaFin }}:00 ·
                                {{ s.docenteNombre }}
                            </span>
                        </li>
                    </ul>
                </div>

                <div v-if="resultado.fusionesDescartadas?.length" class="aviso-desfase">
                    <p class="aviso-desfase-titulo">Se ignoraron algunas fusiones</p>
                    <ul class="lista-perdidas">
                        <li v-for="(f, i) in resultado.fusionesDescartadas" :key="i">
                            <strong>{{ f.materiaId }}</strong>
                            <span class="celda-tenue">{{ f.motivo }}</span>
                        </li>
                    </ul>
                </div>

                <div class="tarjeta-panel-cuerpo">
                    <div class="cifras">
                        <div class="cifra" :class="resultado.factible ? 'is-ok' : 'is-alerta'">
                            <p class="cifra-rotulo">Estado</p>
                            <p class="cifra-valor">{{ resultado.factible ? "Factible" : "No factible" }}</p>
                            <p class="cifra-nota">
                                {{ resultado.factible
                                    ? "Cumple todas las restricciones duras"
                                    : "Hay restricciones duras sin resolver" }}
                            </p>
                        </div>
                        <div class="cifra">
                            <p class="cifra-rotulo">Aptitud</p>
                            <p class="cifra-valor">{{ Math.round(resultado.aptitud) }}</p>
                            <p class="cifra-nota">Menor es mejor; 0 es perfecto</p>
                        </div>
                        <div class="cifra">
                            <p class="cifra-rotulo">Cómputo</p>
                            <p class="cifra-valor">{{ resultado.milisegundos }} ms</p>
                            <p class="cifra-nota">
                                {{ resultado.generaciones }} generaciones · {{ resultado.islas }} islas
                            </p>
                        </div>
                        <div class="cifra">
                            <p class="cifra-rotulo">Grupos</p>
                            <p class="cifra-valor">{{ resultado.grupos.length }}</p>
                            <p class="cifra-nota">
                                Semestres {{ resultado.resumen.semestres.join(", ") }}
                            </p>
                        </div>
                    </div>

                    <div v-if="violaciones.length" class="violaciones" style="margin-top: 24px">
                        <span
                            v-for="v in violaciones"
                            :key="v.clave"
                            class="violacion"
                            :class="v.dura ? 'is-dura' : 'is-blanda'"
                        >{{ v.etiqueta }}: {{ v.cantidad }}</span>
                    </div>
                </div>
            </section>

            <section class="tarjeta-panel">
                <header class="tarjeta-panel-cabeza">
                    <div>
                        <h2 class="tarjeta-panel-titulo">Horario semanal</h2>
                        <!-- El aula va aquí y no en cada bloque: es la misma
                             para todo el grupo, y repetirla sería ruido. -->
                        <p class="campo-ayuda">
                            Pulsa una clase para moverla de día, hora, docente o aula.
                        </p>
                        <p v-if="grupoActual" class="campo-ayuda">
                            Grupo {{ grupoActual.clave }} · {{ grupoActual.turno }}
                            <template v-if="grupoActual.aulaClave">
                                · aula {{ grupoActual.aulaClave }}
                            </template>
                            <template v-if="salidasDelAula > 0">
                                · {{ salidasDelAula }} clases en laboratorio
                            </template>
                        </p>
                    </div>
                    <div class="leyenda">
                        <span v-for="item in leyenda" :key="item.nombre" class="leyenda-item">
                            <span class="leyenda-muestra" :class="item.clase"></span>
                            {{ item.nombre }}
                        </span>
                    </div>
                </header>

                <div class="tarjeta-panel-cuerpo">
                    <div class="selector-grupos">
                        <button
                            v-for="grupo in resultado.grupos"
                            :key="grupo.id"
                            type="button"
                            class="grupo-pastilla"
                            :class="{ 'is-activo': grupo.id === grupoVisible }"
                            @click="grupoVisible = grupo.id"
                        >
                            <span class="grupo-pastilla-clave">
                                {{ grupo.clave
                                }}<template v-if="grupo.carrera"> · {{ grupo.carrera }}</template>
                            </span>
                            <span class="grupo-pastilla-turno">
                                {{ grupo.especialidad ?? grupo.turno }}
                            </span>
                            <span v-if="grupo.aulaClave" class="grupo-pastilla-aula">
                                {{ grupo.aulaClave }}
                            </span>
                        </button>
                    </div>
                </div>

                <RejillaHorario
                    v-if="grupoVisible"
                    :sesiones="sesionesDelGrupo"
                    :rejilla="resultado.rejilla"
                    :turno="turnoDelGrupo"
                    :tonos="tonosPorMateria"
                    editable
                    @elegir="abrirMovimiento"
                />
            </section>

            <!-- Invisible en pantalla; es lo único que el navegador imprime. -->
            <HorarioImprimible
                :resultado="resultado"
                :tonos="tonosPorMateria"
                :carrera="estado.carrera"
                :escenario="estado.abierto.nombre"
                :paridad="paridad ?? ''"
                :alcance="alcanceImpresion"
            />

            <section class="tarjeta-panel">
                <header class="tarjeta-panel-cabeza">
                    <h2 class="tarjeta-panel-titulo">Carga docente resultante</h2>
                </header>
                <div class="tarjeta-panel-cuerpo sin-relleno">
                    <table class="tabla">
                        <thead>
                            <tr>
                                <th>Docente</th>
                                <th>Asignadas</th>
                                <th>Rango permitido</th>
                                <th>Situación</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="carga in resultado.cargaDocente" :key="carga.docenteId">
                                <td class="celda-principal">{{ carga.docenteNombre }}</td>
                                <td>{{ carga.horasAsignadas }} h</td>
                                <td class="celda-tenue">{{ carga.horasMin }}–{{ carga.horasMax }} h</td>
                                <td>
                                    <span v-if="carga.horasAsignadas > carga.horasMax" class="chip-alerta">
                                        Sobrecargado
                                    </span>
                                    <span v-else-if="carga.horasAsignadas === 0" class="celda-tenue">
                                        Sin carga
                                    </span>
                                    <span v-else-if="carga.horasAsignadas < carga.horasMin" class="celda-tenue">
                                        Bajo el mínimo
                                    </span>
                                    <span v-else class="texto-ok">Dentro del rango</span>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>
        </template>
        <DialogoModal
            :abierto="moviendo !== null"
            :titulo="moviendo ? `Mover ${moviendo.titulo}` : ''"
            @cerrar="moviendo = null"
            @enviar="moverClase"
        >
            <div v-if="moviendo" class="campos">
                <p class="campo-ayuda">
                    El cambio se comprueba con las mismas reglas que armaron el horario: si choca
                    con algo, se dice al guardar. Bloque de {{ moviendo.duracion }} h.
                </p>
                <div class="campo-fila">
                    <label class="campo">
                        <span class="campo-rotulo">Día</span>
                        <select v-model="moviendo.dia" class="campo-control">
                            <option v-for="d in resultado.rejilla.dias" :key="d" :value="d">{{ d }}</option>
                        </select>
                    </label>
                    <label class="campo">
                        <span class="campo-rotulo">Hora</span>
                        <select v-model.number="moviendo.horaInicio" class="campo-control">
                            <option v-for="h in horasPosibles" :key="h" :value="h">
                                {{ String(h).padStart(2, "0") }}:00
                            </option>
                        </select>
                    </label>
                </div>
                <label class="campo">
                    <span class="campo-rotulo">Docente</span>
                    <select v-model="moviendo.docenteId" class="campo-control">
                        <option v-for="d in docentesDelEscenario" :key="d.id" :value="d.id">
                            {{ d.nombre }}
                        </option>
                    </select>
                    <span class="campo-ayuda">
                        Se avisa si no está autorizado en esa materia o no tiene esa hora.
                    </span>
                </label>
                <label class="campo">
                    <span class="campo-rotulo">Espacio</span>
                    <select v-model="moviendo.aulaId" class="campo-control">
                        <option v-for="a in aulasDelEscenario" :key="a.id" :value="a.id">
                            {{ a.clave }}{{ a.tipo === "laboratorio" ? " (laboratorio)" : "" }}
                        </option>
                    </select>
                </label>
            </div>
            <template #acciones>
                <button type="submit" class="btn btn-primary">Mover y comprobar</button>
            </template>
        </DialogoModal>
    </div>
</template>
