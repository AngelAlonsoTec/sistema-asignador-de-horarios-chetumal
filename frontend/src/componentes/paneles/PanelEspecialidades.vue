<script setup>
import { ref, computed } from "vue";
import { estado, ensuciar } from "../../estado.js";
import {
    agregarEspecialidad,
    editarEspecialidad,
    eliminarEspecialidad,
    nombreAIdEspecialidad
} from "../../dominio/edicion.js";
import { calcularCobertura, contarDocentesPorMateria } from "../../dominio/cobertura.js";
import { materiasDeEspecialidad } from "../../dominio/agrupar.js";
import ChipCobertura from "../ChipCobertura.vue";
import MenuAcciones from "../MenuAcciones.vue";
import FormEspecialidad from "../formularios/FormEspecialidad.vue";

const datos = computed(() => estado.abierto.datos);
const editando = ref(null);
const abierto = ref(false);

const conteo = computed(() => contarDocentesPorMateria(datos.value.materias, datos.value.docentes));

/**
 * Cada especialidad con sus materias y su propia cobertura. La cobertura por
 * módulo importa: una especialidad puede estar completamente descubierta
 * mientras el escenario en conjunto se ve bien.
 */
const bloques = computed(() =>
    datos.value.especialidades.map((especialidad) => {
        const suyas = materiasDeEspecialidad(datos.value.materias, especialidad.id);
        return {
            especialidad,
            materias: suyas,
            horas: suyas.reduce((suma, materia) => suma + materia.horasSemana, 0),
            cobertura: calcularCobertura(suyas, datos.value.docentes)
        };
    })
);

const enTroncoComun = computed(
    () => datos.value.materias.filter((materia) => !materia.especialidadId).length
);

function nuevo() {
    editando.value = null;
    abierto.value = true;
}

function editar(especialidad) {
    editando.value = especialidad;
    abierto.value = true;
}

function guardar({ nombre, materiaIds }) {
    if (editando.value) {
        editarEspecialidad(datos.value, editando.value.id, { nombre }, materiaIds);
    } else {
        const ids = new Set(datos.value.especialidades.map((e) => e.id));
        agregarEspecialidad(datos.value, { id: nombreAIdEspecialidad(nombre, ids), nombre }, materiaIds);
    }
    ensuciar();
    abierto.value = false;
}

function borrar(bloque) {
    const cuantas = bloque.materias.length;
    const aviso =
        `¿Eliminar la especialidad "${bloque.especialidad.nombre}"?\n\n` +
        `Sus ${cuantas} materias no se borran: vuelven a tronco común.`;
    if (!confirm(aviso)) return;
    eliminarEspecialidad(datos.value, bloque.especialidad.id);
    ensuciar();
}

defineExpose({ agregar: nuevo });
</script>

<template>
    <div v-if="bloques.length > 0" class="cifras" style="margin-bottom: 24px">
        <div class="cifra">
            <p class="cifra-rotulo">Especialidades</p>
            <p class="cifra-valor">{{ bloques.length }}</p>
        </div>
        <div class="cifra">
            <p class="cifra-rotulo">De especialidad</p>
            <p class="cifra-valor">{{ datos.materias.length - enTroncoComun }}</p>
            <p class="cifra-nota">materias en algún módulo</p>
        </div>
        <div class="cifra">
            <p class="cifra-rotulo">Tronco común</p>
            <p class="cifra-valor">{{ enTroncoComun }}</p>
            <p class="cifra-nota">materias que cursan todos</p>
        </div>
    </div>

    <p v-if="bloques.length === 0" class="estado-vacio">
        Este escenario no tiene especialidades. Crea una para agrupar las materias de un módulo.
    </p>

    <section v-for="bloque in bloques" :key="bloque.especialidad.id" class="bloque-especialidad">
        <header class="bloque-head">
            <div class="escenario-titulo">
                <h2 class="bloque-nombre">{{ bloque.especialidad.nombre }}</h2>
                <span class="detalle-meta">
                    {{ bloque.materias.length }} materias
                    <span class="separador">·</span>
                    {{ bloque.horas }} h/semana
                </span>
            </div>
            <div class="bloque-acciones">
                <ChipCobertura :cobertura="bloque.cobertura" />
                <button type="button" class="btn btn-chico" @click="editar(bloque.especialidad)">
                    Editar
                </button>
                <MenuAcciones
                    :acciones="[{ id: 'eliminar', etiqueta: 'Eliminar especialidad', peligro: true }]"
                    @elegir="borrar(bloque)"
                />
            </div>
        </header>

        <p v-if="bloque.materias.length === 0" class="estado-vacio">
            Todavía no tiene materias asignadas.
        </p>

        <table v-else class="tabla">
            <thead>
                <tr>
                    <th>Sem.</th>
                    <th>Clave</th>
                    <th>Nombre</th>
                    <th>Horas</th>
                    <th>Docentes</th>
                </tr>
            </thead>
            <tbody>
                <tr
                    v-for="materia in bloque.materias"
                    :key="materia.id"
                    :class="{ 'is-alerta': conteo.get(materia.id) === 0 }"
                >
                    <td>{{ materia.semestre }}</td>
                    <td class="celda-clave">{{ materia.clave }}</td>
                    <td><span class="celda-principal">{{ materia.nombre }}</span></td>
                    <td>{{ materia.horasSemana }} h</td>
                    <td>
                        <span v-if="conteo.get(materia.id) === 0" class="chip-alerta">Sin docente</span>
                        <template v-else>
                            {{ conteo.get(materia.id) }}
                            {{ conteo.get(materia.id) === 1 ? "docente" : "docentes" }}
                        </template>
                    </td>
                </tr>
            </tbody>
        </table>
    </section>

    <FormEspecialidad
        :abierto="abierto"
        :especialidad="editando"
        :materias="datos.materias"
        :especialidades="datos.especialidades"
        @cerrar="abierto = false"
        @guardar="guardar"
    />
</template>
