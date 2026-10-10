<script setup>
import { ref, computed, onMounted } from "vue";
import { estado } from "../../estado.js";
import { api } from "../../api.js";
import { contiene } from "../../dominio/texto.js";
import { contarDocentesPorMateria } from "../../dominio/cobertura.js";
import TablaDatos from "../TablaDatos.vue";

const datos = computed(() => estado.abierto.datos);
const busqueda = ref("");

/**
 * Prioridad docente: a quién se le respeta primero su disponibilidad cuando dos
 * evitan la misma hora y solo uno puede librarse.
 *
 * Es un juicio de este coordinador sobre su propia carrera, no un dato del
 * docente: la plantilla es del instituto y priorizar a alguien aquí no se lo
 * impone a quien coordina otra. Por eso se guarda al momento y no espera al
 * "Guardar cambios" del escenario, que es de los datos del escenario.
 */
const NIVELES = ref([{ valor: 0, nombre: "Normal" }]);
const prioridades = ref(new Map());

onMounted(async () => {
    const r = await api.prioridades(estado.carrera).catch(() => null);
    if (!r) return;
    NIVELES.value = r.niveles;
    prioridades.value = new Map(r.prioridades.map((p) => [p.docenteId, p.prioridad]));
});

/** Años de servicio. El campo guarda el año de ingreso, no los años. */
function aniosDe(docente) {
    const ingreso = Number(docente.antiguedad);
    if (!Number.isFinite(ingreso) || ingreso <= 0) return null;
    return Math.max(0, new Date().getFullYear() - ingreso);
}

async function cambiarPrioridad(docente, valor) {
    const nivel = Number(valor);
    const antes = new Map(prioridades.value);

    const nuevas = new Map(prioridades.value);
    nivel === 0 ? nuevas.delete(docente.id) : nuevas.set(docente.id, nivel);
    prioridades.value = nuevas;

    try {
        await api.guardarPrioridades(estado.carrera, [{ docenteId: docente.id, prioridad: nivel }]);
    } catch (e) {
        // Devolver el selector a lo que el servidor tiene: dejarlo mostrando un
        // nivel que no se guardó sería mentir sobre lo que hará el algoritmo.
        prioridades.value = antes;
        estado.error = e.message;
    }
}

const nombrePorMateria = computed(() => new Map(datos.value.materias.map((m) => [m.id, m])));

/** Franja declarada en el formulario de disponibilidad, resumida. */
function franjaDe(docente) {
    const bloques = docente.disponibilidad?.declarada ?? [];
    if (bloques.length === 0) return "sin declarar";
    const inicio = Math.min(...bloques.map((b) => b.inicio));
    const fin = Math.max(...bloques.map((b) => b.fin));
    return `${inicio}:00-${fin}:00 · ${bloques.length} días`;
}

/**
 * Horas de comisión administrativa. Las carga el departamento académico: aquí
 * solo se muestran, porque el coordinador no puede disponer de ellas.
 */
function horasDeDescarga(docente) {
    return (docente.descargas ?? []).reduce((suma, b) => suma + (b.fin - b.inicio), 0);
}

function motivosDe(docente) {
    return (docente.descargas ?? [])
        .map((b) => `${b.dia} ${b.inicio}:00-${b.fin}:00 — ${b.motivo}`)
        .join("\n");
}

const visibles = computed(() => {
    const aguja = busqueda.value.trim();
    if (!aguja) return datos.value.docentes;

    // La búsqueda también entra por las materias que imparte: encontrar "quién
    // puede dar Cálculo" es una pregunta más frecuente que buscar por nombre.
    return datos.value.docentes.filter((docente) => {
        if (contiene(docente.nombre, aguja)) return true;
        return (docente.materiasCapacitadas ?? []).some((id) => {
            const materia = nombrePorMateria.value.get(id);
            return materia && contiene(`${materia.clave} ${materia.nombre}`, aguja);
        });
    });
});

/**
 * Agrupados por tipo de contratación. Con una plantilla de treinta, una lista
 * plana esconde justo lo que se quiere ver: quién tiene plaza y quién cobra por
 * horas, que es lo que ordena la prioridad al repartir carga.
 */
const grupos = computed(() => {
    const plaza = visibles.value.filter((d) => d.categoria !== "Asignatura");
    const asignatura = visibles.value.filter((d) => d.categoria === "Asignatura");
    return [
        { titulo: `Con plaza (${plaza.length})`, items: plaza },
        { titulo: `Por asignatura (${asignatura.length})`, items: asignatura }
    ].filter((grupo) => grupo.items.length > 0);
});

// ---- disponibilidad declarada por los propios docentes ----

const enlaces = ref([]);
const mostrandoEnlaces = ref(false);
const csv = ref("");
const resultadoImport = ref(null);

async function alternarEnlaces() {
    mostrandoEnlaces.value = !mostrandoEnlaces.value;
    if (mostrandoEnlaces.value && enlaces.value.length === 0) {
        enlaces.value = await api.enlaces().catch(() => []);
    }
}

/**
 * Cuántos han contestado en cada carrera que lleva esta coordinación.
 *
 * El total no sirve para perseguir el formulario: quien coordina tres carreras
 * lo hace de una en una, y un docente autorizado en dos cuenta en las dos. La
 * lista ya llega acotada a quien puede dar alguna de sus materias.
 */
const avanceDeEnlaces = computed(() =>
    estado.carreras
        .map((carrera) => {
            const suyos = enlaces.value.filter((e) => e.carreras?.includes(carrera));
            return {
                carrera,
                total: suyos.length,
                contestaron: suyos.filter((e) => e.contestado).length
            };
        })
        .filter((x) => x.total > 0)
);

function enlaceDe(token) {
    return `${window.location.origin}/?disponibilidad=${token}`;
}

async function copiar(token) {
    await navigator.clipboard?.writeText(enlaceDe(token));
}

async function importar() {
    resultadoImport.value = null;
    try {
        resultadoImport.value = await api.importarDisponibilidad(csv.value);
        enlaces.value = await api.enlaces().catch(() => enlaces.value);
    } catch (e) {
        estado.error = e.message;
    }
}

/** Materias que quedarían sin cobertura si se borrara este docente. */
function dejariaHuerfanas(docente) {
    const conteo = contarDocentesPorMateria(datos.value.materias, datos.value.docentes);
    return (docente.materiasCapacitadas ?? []).filter((id) => conteo.get(id) === 1).length;
}

/**
 * Nada que exponer: la plantilla es del instituto y la administra el
 * departamento. El panel la **lee**. Hasta ahora exponía un alta que abría un
 * formulario completo y no guardaba nada —`guardarEscenario` manda materias,
 * semestres y especialidades, y el docente dejó de vivir en el escenario—, así
 * que se podía capturar a una persona entera, marcar el escenario como sucio y
 * perderla al recargar.
 */
</script>

<template>
    <div class="barra-filtros">
        <button type="button" class="btn btn-chico" @click="alternarEnlaces">
            {{ mostrandoEnlaces ? "Ocultar" : "Disponibilidad declarada" }}
        </button>
        <input
            v-model="busqueda"
            type="search"
            class="input-busqueda"
            placeholder="Buscar docente o materia que imparte…"
            aria-label="Buscar docente"
        >
        <span class="conteo-resultados">{{ visibles.length }} de {{ datos.docentes.length }}</span>
    </div>

    <section v-if="mostrandoEnlaces" class="tarjeta-panel" style="margin-bottom: 24px">
        <header class="tarjeta-panel-cabeza">
            <div>
                <h2 class="tarjeta-panel-titulo">Disponibilidad declarada por el docente</h2>
                <p class="campo-ayuda">
                    Cada quien tiene un enlace personal para contestar su horario sin necesidad de
                    cuenta. También se puede cargar de golpe desde una hoja de cálculo.
                </p>
            </div>
            <span class="detalle-meta">
                {{ enlaces.filter((e) => e.contestado).length }} de {{ enlaces.length }} contestados
            </span>
        </header>

        <!-- El formulario se persigue carrera por carrera, no en bloque. -->
        <div v-if="avanceDeEnlaces.length > 1" class="tarjeta-panel-cuerpo">
            <p class="campo-ayuda" style="margin: 0">
                <span v-for="(x, i) in avanceDeEnlaces" :key="x.carrera">
                    <template v-if="i > 0"> · </template>
                    <strong>{{ x.carrera }}</strong> {{ x.contestaron }}/{{ x.total }}
                </span>
            </p>
        </div>

        <div class="tarjeta-panel-cuerpo">
            <label class="campo">
                <span>Importar CSV</span>
                <textarea
                    v-model="csv"
                    class="area-csv"
                    rows="4"
                    placeholder="docente,lunes,martes,miercoles,jueves,viernes&#10;doc001,7-14,7-14,,7-14,7-12"
                ></textarea>
            </label>
            <p class="campo-ayuda">
                Una fila por docente y una columna por día. La primera columna es el id o el nombre;
                una celda vacía significa que ese día no puede.
            </p>
            <div class="config-acciones">
                <button type="button" class="btn btn-chico" :disabled="!csv.trim()" @click="importar">
                    Importar
                </button>
            </div>

            <div v-if="resultadoImport" class="lista-avisos" style="margin-top: 16px">
                <li>{{ resultadoImport.aplicados.length }} docentes actualizados.</li>
                <li v-for="(x, i) in resultadoImport.ignorados" :key="i">
                    Se omitió "{{ x.fila }}": {{ x.motivo }}.
                </li>
            </div>
        </div>

        <div class="tarjeta-panel-cuerpo sin-relleno">
            <table class="tabla tabla-compacta">
                <thead>
                    <tr>
                        <th>Docente</th>
                        <th>Puede dar clase en</th>
                        <th>Contestó</th>
                        <th>Enlace</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="e in enlaces" :key="e.docenteId">
                        <td class="celda-principal">{{ e.nombre }}</td>
                        <td>
                            <span
                                v-for="c in e.carreras ?? []"
                                :key="c"
                                class="etiqueta-suave"
                            >{{ c }}</span>
                        </td>
                        <td>
                            <span v-if="e.contestado" class="texto-ok">sí</span>
                            <span v-else class="celda-tenue">pendiente</span>
                        </td>
                        <td class="celda-acciones">
                            <button type="button" class="btn btn-chico" @click="copiar(e.token)">
                                Copiar enlace
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </section>

    <TablaDatos
        :columnas="['Nombre', 'Categoría', 'Horas', 'Límites', 'Disponible', 'Descarga', 'Imparte', 'Antigüedad y prioridad', '']"
        :grupos="grupos"
        vacio="No hay docentes que coincidan."
    >
        <template #fila="{ item }">
            <td>
                <span class="celda-principal">{{ item.nombre }}</span>
                <span v-if="item.esDeOtraArea" class="etiqueta-suave">{{ item.carreraBase || "otra área" }}</span>
            </td>
            <td>{{ item.categoria }} {{ item.nivel }}</td>
            <td>{{ item.horasMin }}-{{ item.horasMax }} h</td>
            <td class="celda-tenue">{{ item.maxMaterias }} mat · {{ item.maxGrupos }} gr</td>
            <td class="celda-tenue">{{ franjaDe(item) }}</td>
            <td>
                <span v-if="(item.descargas ?? []).length" class="etiqueta-modulo" :title="motivosDe(item)">
                    {{ horasDeDescarga(item) }} h
                </span>
                <span v-else class="celda-tenue">—</span>
            </td>
            <td>
                <span :class="{ 'chip-alerta': (item.materiasCapacitadas ?? []).length === 0 }">
                    {{ (item.materiasCapacitadas ?? []).length }}
                </span>
                <span v-if="dejariaHuerfanas(item) > 0" class="etiqueta-suave">
                    {{ dejariaHuerfanas(item) }} solo él
                </span>
            </td>
            <td>
                <!-- La antigüedad se captura y no la leía nadie. Va aquí porque
                     es lo que el coordinador quiere saber al decidir a quién
                     cuidar: el sistema no la usa, la persona sí. -->
                <span v-if="aniosDe(item)" class="celda-tenue" :title="`Ingresó en ${item.antiguedad}`">
                    {{ aniosDe(item) }} años
                </span>
                <select
                    class="select-chico"
                    :class="{ 'is-marcado': (prioridades.get(item.id) ?? 0) > 0 }"
                    :value="prioridades.get(item.id) ?? 0"
                    :aria-label="`Prioridad de ${item.nombre} en ${estado.carrera}`"
                    @change="cambiarPrioridad(item, $event.target.value)"
                >
                    <option v-for="n in NIVELES" :key="n.valor" :value="n.valor">{{ n.nombre }}</option>
                </select>
            </td>
            <td class="celda-acciones">
                <!-- La plantilla es del instituto: la administra el
                     departamento. Aquí se consulta y se le pone prioridad, que
                     sí es juicio de esta coordinación. -->
                <span class="celda-tenue">del instituto</span>
            </td>
        </template>
    </TablaDatos>
</template>
