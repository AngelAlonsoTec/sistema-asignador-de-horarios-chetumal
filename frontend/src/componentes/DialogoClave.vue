<script setup>
/**
 * Cambio de la contraseña propia.
 *
 * Pide la actual aunque haya sesión iniciada: una sesión abierta en una máquina
 * prestada no debe bastar para quedarse con la cuenta.
 *
 * Al cambiarla el servidor cierra **todas** las sesiones, incluida esta — si la
 * contraseña se cambia porque alguien más la sabía, dejar viva su sesión vacía
 * el cambio de sentido. Por eso al terminar se vuelve al inicio de sesión, y se
 * avisa antes para que no parezca que la app se cayó.
 */
import { ref, watch } from "vue";
import { api } from "../api.js";
import { estado } from "../estado.js";
import DialogoModal from "./DialogoModal.vue";

const props = defineProps({ abierto: { type: Boolean, default: false } });
const emitir = defineEmits(["cerrar"]);

const actual = ref("");
const nueva = ref("");
const repetida = ref("");
const error = ref(null);
const guardando = ref(false);

watch(
    () => props.abierto,
    () => {
        actual.value = nueva.value = repetida.value = "";
        error.value = null;
    }
);

async function enviar() {
    error.value = null;
    // Se comprueba aquí y no en el servidor: la repetición existe para atrapar
    // un error de tecleo, y el servidor solo recibe una contraseña.
    if (nueva.value !== repetida.value) {
        error.value = "Las dos contraseñas nuevas no coinciden.";
        return;
    }

    guardando.value = true;
    try {
        await api.cambiarClave({ actual: actual.value, nueva: nueva.value });
        estado.usuario = null;
    } catch (e) {
        error.value = e.message;
    } finally {
        guardando.value = false;
    }
}
</script>

<template>
    <DialogoModal :abierto="abierto" titulo="Cambiar contraseña" @cerrar="emitir('cerrar')" @enviar="enviar">
        <div class="campos">
            <p class="campo-ayuda">
                Al cambiarla se cierran todas tus sesiones, incluida esta: habrá que entrar de
                nuevo.
            </p>
            <label class="campo">
                <span class="campo-rotulo">Contraseña actual</span>
                <input v-model="actual" type="password" class="campo-control" autocomplete="current-password" />
            </label>
            <label class="campo">
                <span class="campo-rotulo">Nueva</span>
                <input v-model="nueva" type="password" class="campo-control" autocomplete="new-password" />
                <span class="campo-ayuda">Mínimo 8 caracteres.</span>
            </label>
            <label class="campo">
                <span class="campo-rotulo">Repetir la nueva</span>
                <input v-model="repetida" type="password" class="campo-control" autocomplete="new-password" />
            </label>
            <p v-if="error" class="banda banda-error">{{ error }}</p>
        </div>
        <template #acciones>
            <button type="submit" class="btn btn-primary" :disabled="guardando">
                {{ guardando ? "Cambiando…" : "Cambiar" }}
            </button>
        </template>
    </DialogoModal>
</template>
