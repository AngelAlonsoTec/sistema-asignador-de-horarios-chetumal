<script setup>
import { ref, watch, computed } from "vue";
import DialogoModal from "../DialogoModal.vue";

const props = defineProps({
    abierto: { type: Boolean, default: false },
    /** `null` para una materia nueva. */
    materia: { type: Object, default: null },
    especialidades: { type: Array, required: true }
});
const emitir = defineEmits(["cerrar", "guardar"]);

const vacio = () => ({
    clave: "",
    nombre: "",
    semestre: 1,
    horasSemana: 4,
    creditos: 4,
    especialidadId: "",
    requiereLaboratorio: false
});

const forma = ref(vacio());
const error = ref(null);

watch(
    () => [props.abierto, props.materia],
    ([abierto]) => {
        if (!abierto) return;
        error.value = null;
        forma.value = props.materia
            ? { ...props.materia, especialidadId: props.materia.especialidadId ?? "" }
            : vacio();
    },
    { immediate: true }
);

const titulo = computed(() => (props.materia ? "Editar materia" : "Nueva materia"));

function enviar() {
    const clave = forma.value.clave.trim().toUpperCase();
    if (!clave || !forma.value.nombre.trim()) {
        error.value = "La clave y el nombre son obligatorios.";
        return;
    }
    if (forma.value.horasSemana < 1 || forma.value.creditos < 1) {
        error.value = "Las horas y los créditos deben ser al menos 1.";
        return;
    }

    emitir("guardar", {
        clave,
        nombre: forma.value.nombre.trim(),
        semestre: Number(forma.value.semestre),
        horasSemana: Number(forma.value.horasSemana),
        creditos: Number(forma.value.creditos),
        // Cadena vacía es "tronco común"; en los datos eso es `null`.
        especialidadId: forma.value.especialidadId || null,
        requiereLaboratorio: Boolean(forma.value.requiereLaboratorio)
    });
}
</script>

<template>
    <DialogoModal :abierto="abierto" :titulo="titulo" @cerrar="emitir('cerrar')" @enviar="enviar">
        <label class="campo">
            <span>Clave</span>
            <input v-model="forma.clave" type="text" placeholder="ACF-0901" required>
        </label>
        <label class="campo">
            <span>Nombre</span>
            <input v-model="forma.nombre" type="text" required>
        </label>

        <div class="campo-fila">
            <label class="campo">
                <span>Semestre</span>
                <input v-model="forma.semestre" type="number" min="1" max="12" required>
            </label>
            <label class="campo">
                <span>Horas/semana</span>
                <input v-model="forma.horasSemana" type="number" min="1" required>
            </label>
            <label class="campo">
                <span>Créditos</span>
                <input v-model="forma.creditos" type="number" min="1" required>
            </label>
        </div>

        <label class="campo">
            <span>Especialidad</span>
            <select v-model="forma.especialidadId">
                <option value="">Tronco común</option>
                <option v-for="e in especialidades" :key="e.id" :value="e.id">{{ e.nombre }}</option>
            </select>
        </label>

        <label class="campo campo-check">
            <input v-model="forma.requiereLaboratorio" type="checkbox">
            <span>Requiere laboratorio</span>
        </label>
        <p class="campo-ayuda">
            El motor solo coloca esta materia en espacios de tipo laboratorio.
        </p>

        <p v-if="error" class="formulario-error">{{ error }}</p>
    </DialogoModal>
</template>
