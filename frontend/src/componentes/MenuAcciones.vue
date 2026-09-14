<script setup>
/**
 * Menú de desbordamiento anclado a la esquina de una tarjeta.
 *
 * Las acciones destructivas viven aquí en lugar de junto al botón principal:
 * quedan a un clic de distancia y no compiten visualmente con "Abrir", que es
 * lo que se quiere hacer el noventa por ciento de las veces.
 */
import { ref, onMounted, onBeforeUnmount } from "vue";

defineProps({ acciones: { type: Array, required: true } });
const emitir = defineEmits(["elegir"]);

const abierto = ref(false);
const raiz = ref(null);

function alternar() {
    abierto.value = !abierto.value;
}

function elegir(accion) {
    abierto.value = false;
    emitir("elegir", accion);
}

// Cerrar al hacer clic afuera: no hay que acordarse de volver a presionar el
// botón, y evita que el menú quede abierto encima de otra tarjeta.
function alClicFuera(evento) {
    if (raiz.value && !raiz.value.contains(evento.target)) abierto.value = false;
}
function alEscape(evento) {
    if (evento.key === "Escape") abierto.value = false;
}

onMounted(() => {
    document.addEventListener("click", alClicFuera);
    document.addEventListener("keydown", alEscape);
});
onBeforeUnmount(() => {
    document.removeEventListener("click", alClicFuera);
    document.removeEventListener("keydown", alEscape);
});
</script>

<template>
    <div ref="raiz" class="escenario-menu">
        <button
            type="button"
            class="btn-menu"
            aria-haspopup="true"
            :aria-expanded="abierto"
            aria-label="Más acciones"
            @click="alternar"
        >⋮</button>

        <div v-show="abierto" class="menu-desplegable">
            <button
                v-for="accion in acciones"
                :key="accion.id"
                type="button"
                class="menu-item"
                :class="{ 'menu-item-peligro': accion.peligro }"
                @click="elegir(accion.id)"
            >{{ accion.etiqueta }}</button>
        </div>
    </div>
</template>
