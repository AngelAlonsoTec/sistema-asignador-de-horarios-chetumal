<script setup>
/**
 * Marca de SchedulAI.
 *
 * Cinco franjas horarias sobre una rejilla: tres completas y dos conectores
 * alternos. Leído de cerca es un horario semanal; de lejos, la S de Schedul.
 * El concepto es el producto mismo — bloques de clase colocados en una
 * cuadrícula — y no un símbolo genérico de calendario o de "inteligencia".
 *
 * Por debajo de 22 px la versión segmentada se ensucia, así que el logo se
 * simplifica solo: las franjas se vuelven barras enteras. Es la misma figura
 * con menos detalle, no otro logo.
 */
import { computed } from "vue";

const props = defineProps({
    tamano: { type: Number, default: 28 },
    /** Fuerza la versión simplificada; por omisión se decide por el tamaño. */
    compacto: { type: Boolean, default: null },
    /** Color de la figura. `currentColor` la hereda del contexto. */
    color: { type: String, default: "#17a673" }
});

const simplificado = computed(() => props.compacto ?? props.tamano < 22);

// Cinco filas de 5 de alto en una caja de 32, con 6.25 de paso.
const FILAS = [1.5, 7.75, 14, 20.25, 26.5];
const ALTO = 5;
const RADIO = 2;
const IZQUIERDA = 4;
const ANCHO = 24;
const CONECTOR = 6;

/** Las tres franjas completas, partidas en tres bloques como días. */
const SEGMENTOS = 3;
const HUECO = 2;
const ANCHO_BLOQUE = (ANCHO - HUECO * (SEGMENTOS - 1)) / SEGMENTOS;

const franjas = computed(() => {
    const filas = [FILAS[0], FILAS[2], FILAS[4]];
    if (simplificado.value) {
        return filas.map((y) => ({ x: IZQUIERDA, y, ancho: ANCHO }));
    }
    return filas.flatMap((y) =>
        Array.from({ length: SEGMENTOS }, (_, i) => ({
            x: IZQUIERDA + i * (ANCHO_BLOQUE + HUECO),
            y,
            ancho: ANCHO_BLOQUE
        }))
    );
});

// Los conectores alternan lado: son los que convierten tres barras en una S.
const conectores = computed(() => [
    { x: IZQUIERDA, y: FILAS[1] },
    { x: IZQUIERDA + ANCHO - CONECTOR, y: FILAS[3] }
]);
</script>

<template>
    <svg
        :width="tamano"
        :height="tamano"
        viewBox="0 0 32 32"
        role="img"
        aria-label="SchedulAI"
        focusable="false"
    >
        <rect
            v-for="(f, i) in franjas"
            :key="`f${i}`"
            :x="f.x"
            :y="f.y"
            :width="f.ancho"
            :height="ALTO"
            :rx="RADIO"
            :fill="color"
        />
        <rect
            v-for="(c, i) in conectores"
            :key="`c${i}`"
            :x="c.x"
            :y="c.y"
            :width="CONECTOR"
            :height="ALTO"
            :rx="RADIO"
            :fill="color"
            opacity="0.55"
        />
    </svg>
</template>
