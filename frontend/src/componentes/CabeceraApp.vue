<script setup>
import { estado, guardarAbierto } from "../estado.js";

defineProps({
    titulo: { type: String, required: true },
    subtitulo: { type: String, default: null },
    /** Etiqueta del botón de alta, o `null` si la sección no da de alta nada. */
    agregar: { type: String, default: null }
});
defineEmits(["agregar"]);
</script>

<template>
    <header class="cabecera">
        <div class="cabecera-titulo">
            <h1>{{ titulo }}</h1>
            <p v-if="subtitulo" class="cabecera-subtitulo">{{ subtitulo }}</p>
        </div>

        <div class="cabecera-acciones">
            <slot name="acciones" />

            <button v-if="agregar" type="button" class="btn" @click="$emit('agregar')">
                {{ agregar }}
            </button>

            <template v-if="estado.abierto">
                <span v-if="estado.sucio" class="marca-sucio">Sin guardar</span>
                <button
                    type="button"
                    class="btn btn-primary"
                    :disabled="!estado.sucio || estado.cargando"
                    @click="guardarAbierto"
                >Guardar cambios</button>
            </template>
        </div>
    </header>
</template>
