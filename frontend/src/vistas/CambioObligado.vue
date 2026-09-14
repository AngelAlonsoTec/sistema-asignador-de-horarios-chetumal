<script setup>
/**
 * Primera entrada: hay que cambiar la contraseña antes de nada.
 *
 * Las cuentas nacen con una que alguien más eligió y dictó de viva voz. Mientras
 * no se cambie, la cuenta la controlan dos personas. El backend rechaza el resto
 * de rutas con 403, así que esta pantalla es la puerta y no la cerradura.
 *
 * Se vuelve a pedir la actual en lugar de recordarla desde el inicio de sesión:
 * guardarla en el estado para ahorrar un campo la dejaría en memoria de la
 * aplicación, visible en las herramientas del navegador y en cualquier volcado
 * de error, a cambio de un teclado menos.
 */
import { ref } from "vue";
import { api } from "../api.js";
import { estado, salir } from "../estado.js";
import LogoMarca from "../componentes/LogoMarca.vue";

const actual = ref("");
const nueva = ref("");
const repetida = ref("");
const error = ref(null);
const guardando = ref(false);

async function enviar() {
    error.value = null;
    if (nueva.value !== repetida.value) {
        error.value = "Las dos contraseñas nuevas no coinciden.";
        return;
    }

    guardando.value = true;
    try {
        await api.cambiarClave({ actual: actual.value, nueva: nueva.value });
        // Cambiarla cierra todas las sesiones, incluida esta.
        estado.usuario = null;
        // El 403 de "hay que cambiar la contraseña" quedó en `estado.error` de
        // los intentos anteriores; dejarlo saludaría al usuario con la queja
        // justo después de hacerle caso.
        estado.error = null;
        estado.aviso = "Contraseña cambiada. Entra de nuevo con la nueva.";
    } catch (e) {
        error.value = e.message;
    } finally {
        guardando.value = false;
    }
}
</script>

<template>
    <div class="portada">
        <form class="acceso" @submit.prevent="enviar">
            <div class="acceso-marca">
                <LogoMarca :tamano="40" />
                <span class="marca-texto">Schedul<span class="marca-ia">AI</span></span>
            </div>
            <p class="acceso-nota">
                Entraste con la contraseña que puso el departamento académico. Hasta que la
                cambies, esa cuenta la conocen dos personas.
            </p>

            <label class="campo">
                <span>Contraseña actual</span>
                <input v-model="actual" type="password" autocomplete="current-password" required autofocus>
            </label>
            <label class="campo">
                <span>Nueva</span>
                <input v-model="nueva" type="password" autocomplete="new-password" required>
            </label>
            <label class="campo">
                <span>Repite la nueva</span>
                <input v-model="repetida" type="password" autocomplete="new-password" required>
            </label>

            <p v-if="error" class="formulario-error">{{ error }}</p>

            <button type="submit" class="btn btn-primary" :disabled="guardando">
                {{ guardando ? "Cambiando…" : "Cambiar y entrar" }}
            </button>
            <button type="button" class="btn btn-ghost btn-chico" @click="salir">Salir</button>
        </form>
    </div>
</template>
