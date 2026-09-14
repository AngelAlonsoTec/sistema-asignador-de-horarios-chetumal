<script setup>
import { ref, watch, computed } from "vue";
import DialogoModal from "../DialogoModal.vue";
import ListaChecks from "../ListaChecks.vue";
import { porSemestre } from "../../dominio/agrupar.js";

const props = defineProps({
    abierto: { type: Boolean, default: false },
    especialidad: { type: Object, default: null },
    materias: { type: Array, required: true },
    especialidades: { type: Array, required: true }
});
const emitir = defineEmits(["cerrar", "guardar"]);

const nombre = ref("");
const elegidas = ref([]);
const error = ref(null);

watch(
    () => [props.abierto, props.especialidad],
    ([abierto]) => {
        if (!abierto) return;
        error.value = null;
        nombre.value = props.especialidad?.nombre ?? "";
        elegidas.value = props.materias
            .filter((materia) => materia.especialidadId === props.especialidad?.id)
            .map((materia) => materia.id);
    },
    { immediate: true }
);

const titulo = computed(() => (props.especialidad ? "Editar especialidad" : "Nueva especialidad"));

const nombrePorId = computed(
    () => new Map(props.especialidades.map((e) => [e.id, e.nombre]))
);

/**
 * Todas las materias, agrupadas por semestre. Las que ya pertenecen a otra
 * especialidad se muestran con su nombre como nota: marcarlas las mueve, porque
 * una materia pertenece a un solo módulo, y conviene saberlo antes de marcar.
 */
const grupos = computed(() =>
    porSemestre(props.materias).map(([semestre, suyas]) => ({
        titulo: `Semestre ${semestre}`,
        opciones: suyas.map((materia) => ({
            id: materia.id,
            etiqueta: `${materia.clave} · ${materia.nombre}`,
            nota:
                materia.especialidadId && materia.especialidadId !== props.especialidad?.id
                    ? nombrePorId.value.get(materia.especialidadId)
                    : null
        }))
    }))
);

function enviar() {
    if (!nombre.value.trim()) {
        error.value = "El nombre es obligatorio.";
        return;
    }
    emitir("guardar", { nombre: nombre.value.trim(), materiaIds: elegidas.value });
}
</script>

<template>
    <DialogoModal :abierto="abierto" :titulo="titulo" ancho @cerrar="emitir('cerrar')" @enviar="enviar">
        <label class="campo">
            <span>Nombre</span>
            <input v-model="nombre" type="text" placeholder="Ej. Inteligencia Artificial" required>
        </label>

        <fieldset class="campo-grupo">
            <legend>Materias que la componen ({{ elegidas.length }})</legend>
            <ListaChecks v-model="elegidas" :grupos="grupos" />
        </fieldset>

        <p v-if="error" class="formulario-error">{{ error }}</p>
    </DialogoModal>
</template>
