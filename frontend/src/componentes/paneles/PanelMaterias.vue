<script setup>
import { ref, computed } from "vue";
import { estado, ensuciar } from "../../estado.js";
import {
    agregarMateria,
    editarMateria,
    eliminarMateria,
    claveAId
} from "../../dominio/edicion.js";
import { contarDocentesPorMateria } from "../../dominio/cobertura.js";
import { contiene } from "../../dominio/texto.js";
import { porSemestre, porEspecialidad } from "../../dominio/agrupar.js";
import TablaDatos from "../TablaDatos.vue";
import FormMateria from "../formularios/FormMateria.vue";
import FormDocentesMateria from "../formularios/FormDocentesMateria.vue";

const props = defineProps({ filtroInicial: { type: String, default: null } });

const datos = computed(() => estado.abierto.datos);
const busqueda = ref("");
const filtro = ref(props.filtroInicial ?? "todas");
const editando = ref(null);
const abierto = ref(false);
const asignando = ref(null);

const conteo = computed(() => contarDocentesPorMateria(datos.value.materias, datos.value.docentes));
const nombrePorEspecialidad = computed(
    () => new Map(datos.value.especialidades.map((e) => [e.id, e.nombre]))
);

const visibles = computed(() => {
    const aguja = busqueda.value.trim();
    return datos.value.materias.filter((materia) => {
        if (filtro.value === "sin-docente" && conteo.value.get(materia.id) !== 0) return false;
        if (filtro.value === "laboratorio" && !materia.requiereLaboratorio) return false;
        if (!aguja) return true;
        return contiene(`${materia.clave} ${materia.nombre}`, aguja);
    });
});

/**
 * Semestre como grupo de primer nivel y especialidad como subgrupo. Las materias
 * de especialidad mezcladas con el tronco común y distinguidas solo por una
 * etiqueta son difíciles de leer: un subencabezado las separa de verdad.
 */
const grupos = computed(() => {
    const salida = [];
    for (const [semestre, delSemestre] of porSemestre(visibles.value)) {
        salida.push({ titulo: `Semestre ${semestre} (${delSemestre.length})`, items: [] });

        for (const [especialidadId, suyas] of porEspecialidad(delSemestre, datos.value.especialidades)) {
            const items = suyas.map((materia) => ({
                ...materia,
                __clase: conteo.value.get(materia.id) === 0 ? "is-alerta" : undefined
            }));

            if (especialidadId === null) {
                // El tronco común no lleva subencabezado: es lo esperado por
                // omisión, y nombrarlo solo añadiría ruido.
                salida[salida.length - 1].items.push(...items);
            } else {
                salida.push({
                    titulo: `${nombrePorEspecialidad.value.get(especialidadId)} (${items.length})`,
                    nivel: 2,
                    items
                });
            }
        }
    }
    return salida;
});

function nuevo() {
    editando.value = null;
    abierto.value = true;
}

function editar(materia) {
    editando.value = materia;
    abierto.value = true;
}

function guardar(valores) {
    const id = claveAId(valores.clave);
    if (editando.value) editarMateria(datos.value, editando.value.id, { ...valores, id });
    else agregarMateria(datos.value, { id, carrera: estado.carrera, ...valores });
    ensuciar();
    abierto.value = false;
}

function borrar(materia) {
    if (!confirm(`¿Eliminar ${materia.clave} · ${materia.nombre}?`)) return;
    eliminarMateria(datos.value, materia.id);
    ensuciar();
}


// La pantalla de detalle dibuja el botón "+ Agregar" en su propia fila de
// acciones, junto a "Guardar cambios", y lo dispara desde aquí.
defineExpose({ agregar: nuevo });
</script>

<template>
    <div class="barra-filtros">
        <input
            v-model="busqueda"
            type="search"
            class="input-busqueda"
            placeholder="Buscar materia o clave…"
            aria-label="Buscar materia"
        >
        <div class="filtros">
            <button
                v-for="opcion in [
                    { id: 'todas', etiqueta: 'Todas' },
                    { id: 'sin-docente', etiqueta: 'Sin docente' },
                    { id: 'laboratorio', etiqueta: 'Laboratorio' }
                ]"
                :key="opcion.id"
                class="chip-filtro"
                :class="{ 'is-active': filtro === opcion.id }"
                @click="filtro = opcion.id"
            >{{ opcion.etiqueta }}</button>
        </div>
        <span class="conteo-resultados">{{ visibles.length }} de {{ datos.materias.length }}</span>
    </div>

    <TablaDatos
        :columnas="['Clave', 'Nombre', 'Horas', 'Créditos', 'Espacio', 'Docentes', '']"
        :grupos="grupos"
        vacio="No hay materias que coincidan."
    >
        <template #fila="{ item }">
            <td class="celda-clave">{{ item.clave }}</td>
            <td><span class="celda-principal">{{ item.nombre }}</span></td>
            <td>{{ item.horasSemana }} h</td>
            <td>{{ item.creditos }}</td>
            <td class="celda-tenue">{{ item.requiereLaboratorio ? "Laboratorio" : "Aula" }}</td>
            <td>
                <!-- Quién puede impartirla lo decide el departamento, no esta
                     pantalla: el coordinador reparte las horas. Se muestra
                     porque sin docente no se puede generar, y hay que saberlo. -->
                <button
                    type="button"
                    class="celda-docentes"
                    :title="`Quiénes están autorizados en ${item.clave}`"
                    @click="asignando = item"
                >
                    <span v-if="conteo.get(item.id) === 0" class="chip-alerta">Sin docente</span>
                    <template v-else>{{ conteo.get(item.id) }}</template>
                </button>
            </td>
            <td class="celda-acciones">
                <button type="button" class="btn btn-chico" @click="editar(item)">Editar</button>
                <button type="button" class="btn btn-chico btn-peligro" @click="borrar(item)">Eliminar</button>
            </td>
        </template>
    </TablaDatos>

    <FormMateria
        :abierto="abierto"
        :materia="editando"
        :especialidades="datos.especialidades"
        @cerrar="abierto = false"
        @guardar="guardar"
    />
    <FormDocentesMateria
        :abierto="asignando !== null"
        :materia="asignando"
        :docentes="datos.docentes"
        solo-lectura
        @cerrar="asignando = null"
    />
</template>
