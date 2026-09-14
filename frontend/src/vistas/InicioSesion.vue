<script setup>
import { ref } from "vue";
import { estado, entrar } from "../estado.js";
import LogoMarca from "../componentes/LogoMarca.vue";

const usuario = ref("");
const clave = ref("");
const entrando = ref(false);

async function enviar() {
    entrando.value = true;
    await entrar({ usuario: usuario.value, clave: clave.value });
    entrando.value = false;
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
                Coordinación académica · TecNM Campus Chetumal
            </p>

            <label class="campo">
                <span>Usuario</span>
                <input v-model="usuario" type="text" autocomplete="username" required autofocus>
            </label>
            <label class="campo">
                <span>Contraseña</span>
                <input v-model="clave" type="password" autocomplete="current-password" required>
            </label>

            <p v-if="estado.aviso" class="banda banda-ok">{{ estado.aviso }}</p>
            <p v-if="estado.error" class="formulario-error">{{ estado.error }}</p>

            <button type="submit" class="btn btn-primary" :disabled="entrando">
                {{ entrando ? "Entrando…" : "Entrar" }}
            </button>
        </form>
    </div>
</template>
