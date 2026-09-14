<script setup>
import { ref, watch, computed } from "vue";
import DialogoModal from "../DialogoModal.vue";
import ListaChecks from "../ListaChecks.vue";

const props = defineProps({
    abierto: { type: Boolean, default: false },
    materia: { type: Object, default: null },
    docentes: { type: Array, required: true },
    /**
     * Para el coordinador. Quién puede impartir una materia lo decide el
     * departamento académico; desde aquí solo se consulta, porque sin docente
     * autorizado no se puede generar y hay que poder verlo.
     */
    soloLectura: { type: Boolean, default: false }
});
const emitir = defineEmits(["cerrar", "guardar"]);

const elegidos = ref([]);

watch(
    () => [props.abierto, props.materia],
    ([abierto]) => {
        if (!abierto || !props.materia) return;
        elegidos.value = props.docentes
            .filter((docente) => (docente.materiasCapacitadas ?? []).includes(props.materia.id))
            .map((docente) => docente.id);
    },
    { immediate: true }
);

/**
 * Los docentes de otras áreas van primero: es el orden en que el departamento
 * los considera, porque eligen horario antes que los de la carrera.
 */
const grupos = computed(() => {
    const ordenados = [...props.docentes].sort(
        (a, b) => Number(b.esDeOtraArea) - Number(a.esDeOtraArea) || a.nombre.localeCompare(b.nombre)
    );
    const deOtraArea = ordenados.filter((d) => d.esDeOtraArea);
    const deLaCarrera = ordenados.filter((d) => !d.esDeOtraArea);

    return [
        { titulo: "De otras áreas", docentes: deOtraArea },
        { titulo: "De la carrera", docentes: deLaCarrera }
    ]
        .filter((grupo) => grupo.docentes.length > 0)
        .map((grupo) => ({
            titulo: grupo.titulo,
            opciones: grupo.docentes.map((docente) => ({
                id: docente.id,
                etiqueta: docente.nombre,
                nota: `${docente.categoria} · ${(docente.materiasCapacitadas ?? []).length} materias`
            }))
        }));
});
</script>

<template>
    <DialogoModal
        :abierto="abierto"
        titulo="Docentes que pueden impartirla"
        @cerrar="emitir('cerrar')"
        @enviar="soloLectura ? emitir('cerrar') : emitir('guardar', [...elegidos])"
    >
        <p v-if="materia" class="formulario-nota">
            {{ materia.clave }} · {{ materia.nombre }} — semestre {{ materia.semestre }}
        </p>
        <p v-if="soloLectura" class="campo-ayuda">
            Lo autoriza el departamento académico. Si falta alguien, hay que pedírselo: el
            coordinador reparte las horas, no decide quién puede impartir.
        </p>

        <fieldset class="campo-grupo">
            <legend>
                {{ soloLectura ? `Autorizados (${elegidos.length})` : `Docentes (${elegidos.length} marcados)` }}
            </legend>
            <template v-if="soloLectura">
                <ul v-if="elegidos.length" class="lista-simple">
                    <li v-for="id in elegidos" :key="id">
                        {{ docentes.find((d) => d.id === id)?.nombre ?? id }}
                    </li>
                </ul>
                <p v-else class="estado-vacio">
                    Nadie está autorizado todavía. Sin al menos uno no se puede generar el horario.
                </p>
            </template>
            <ListaChecks v-else v-model="elegidos" :grupos="grupos" />
        </fieldset>

        <template v-if="soloLectura" #acciones>
            <button type="submit" class="btn btn-primary">Entendido</button>
        </template>
    </DialogoModal>
</template>
