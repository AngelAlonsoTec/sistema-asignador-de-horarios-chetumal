<script setup>
/**
 * Envoltura del `<dialog>` nativo.
 *
 * Se usa el elemento del navegador y no un div flotante porque trae gratis lo
 * que cuesta hacer bien a mano: foco atrapado dentro del diálogo, cierre con
 * Escape y fondo inerte.
 */
import { ref, watch, onBeforeUnmount } from "vue";

const props = defineProps({
    abierto: { type: Boolean, default: false },
    titulo: { type: String, required: true },
    ancho: { type: Boolean, default: false }
});
const emitir = defineEmits(["cerrar", "enviar"]);

const dialogo = ref(null);

watch(
    () => props.abierto,
    (abierto) => {
        if (!dialogo.value) return;
        if (abierto && !dialogo.value.open) dialogo.value.showModal();
        if (!abierto && dialogo.value.open) dialogo.value.close();
    }
);

// Escape cierra el diálogo por su cuenta; hay que enterarse para que el estado
// del padre no siga creyendo que está abierto.
function alCerrar() {
    if (props.abierto) emitir("cerrar");
}

onBeforeUnmount(() => dialogo.value?.close());
</script>

<template>
    <dialog ref="dialogo" class="dialogo" :class="{ 'dialogo-ancho': ancho }" @close="alCerrar">
        <form class="formulario" @submit.prevent="emitir('enviar')">
            <h2 class="formulario-titulo">{{ titulo }}</h2>
            <slot />
            <div class="formulario-acciones">
                <button type="button" class="btn btn-ghost" @click="emitir('cerrar')">Cancelar</button>
                <slot name="acciones">
                    <button type="submit" class="btn btn-primary">Guardar</button>
                </slot>
            </div>
        </form>
    </dialog>
</template>
