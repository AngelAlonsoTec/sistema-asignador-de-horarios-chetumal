<script setup>
/**
 * Lista de casillas agrupada, con una nota opcional por opción.
 *
 * La usan tres formularios distintos (materias de un docente, materias de una
 * especialidad, docentes de una materia). Todos necesitan lo mismo: marcar un
 * subconjunto de una lista larga sin perder de vista a qué grupo pertenece cada
 * elemento.
 */
const props = defineProps({
    /** `[{ titulo, opciones: [{ id, etiqueta, nota? }] }]`. */
    grupos: { type: Array, required: true },
    modelValue: { type: Array, required: true }
});
const emitir = defineEmits(["update:modelValue"]);

function alternar(id) {
    const marcados = new Set(props.modelValue);
    if (marcados.has(id)) marcados.delete(id);
    else marcados.add(id);
    emitir("update:modelValue", [...marcados]);
}
</script>

<template>
    <div class="materias-checklist">
        <p v-if="grupos.length === 0" class="estado-vacio">No hay opciones disponibles.</p>

        <div v-for="grupo in grupos" :key="grupo.titulo" class="checklist-grupo">
            <p class="checklist-titulo">{{ grupo.titulo }}</p>
            <label v-for="opcion in grupo.opciones" :key="opcion.id" class="materia-check">
                <input
                    type="checkbox"
                    :checked="modelValue.includes(opcion.id)"
                    @change="alternar(opcion.id)"
                >
                <span>{{ opcion.etiqueta }}</span>
                <span v-if="opcion.nota" class="materia-check-nota">{{ opcion.nota }}</span>
            </label>
        </div>
    </div>
</template>
