<script setup>
import { computed } from "vue";
import { estado } from "../../estado.js";
import TablaDatos from "../TablaDatos.vue";

const datos = computed(() => estado.abierto.datos);

/** Aulas y laboratorios separados: el motor los trata como recursos distintos. */
const grupos = computed(() => {
    const aulas = datos.value.aulas.filter((aula) => aula.tipo !== "laboratorio");
    const laboratorios = datos.value.aulas.filter((aula) => aula.tipo === "laboratorio");
    return [
        { titulo: `Aulas (${aulas.length})`, items: aulas },
        { titulo: `Laboratorios (${laboratorios.length})`, items: laboratorios }
    ].filter((grupo) => grupo.items.length > 0);
});

</script>

<template>
    <!-- Los espacios son del plantel: una sola lista para las trece carreras.
         Editarlos aquí reemplazaba la lista entera y dejaba a las demás sin
         ninguna, así que los administra el departamento. -->
    <p class="panel-nota">
        Los espacios son del plantel y los administra el departamento académico. Aquí se ven
        para saber con qué se cuenta; el reparto entre grupos lo hace el generador.
    </p>

    <TablaDatos
        :columnas="['Clave', 'Tipo', 'Capacidad', 'Pertenece a']"
        :grupos="grupos"
        vacio="No hay espacios registrados."
    >
        <template #fila="{ item }">
            <td class="celda-clave">{{ item.clave }}</td>
            <td>{{ item.tipo === "laboratorio" ? "Laboratorio" : "Aula" }}</td>
            <td class="celda-tenue">
                {{ item.capacidad ? `${item.capacidad} alumnos` : "sin dato" }}
            </td>
            <td class="celda-tenue">
                <!-- Qué carrera lo usa en cada turno lo decide el horario, no
                     una asignación fija: por eso aquí no hay dueño. -->
                del plantel
            </td>
        </template>
    </TablaDatos>

</template>
