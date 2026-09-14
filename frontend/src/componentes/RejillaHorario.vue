<script setup>
import { computed } from "vue";

/**
 * Rejilla semanal de un grupo: días en columnas, horas en filas.
 *
 * Una sesión de dos horas se dibuja como una sola celda con `rowspan`, y las
 * horas que ocupa se saltan. Repetir el bloque en cada hora haría creer que
 * son dos clases distintas.
 */
const props = defineProps({
    sesiones: { type: Array, required: true },
    rejilla: { type: Object, required: true },
    turno: { type: String, required: true },
    /** materiaId -> índice de tono, o `null` para tronco común. */
    tonos: { type: Map, required: true },
    /**
     * Rejilla de un docente y no de un grupo. Cambia qué se nombra en cada
     * bloque: el docente es siempre el mismo y sobra, mientras que el grupo y
     * el aula cambian en cada clase y son justo lo que hay que saber.
     */
    conGrupo: { type: Boolean, default: false },
    /** Deja pulsar un bloque para moverlo. Fuera del papel, siempre. */
    editable: { type: Boolean, default: false }
});

const emitir = defineEmits(["elegir"]);

const franja = computed(() => {
    const turno = props.rejilla.turnos.find((t) => t.id === props.turno) ?? props.rejilla.turnos[0];
    return Array.from({ length: turno.horaFin - turno.horaInicio }, (_, i) => turno.horaInicio + i);
});

/** `mapa[dia][hora]` -> sesión que empieza ahí, o `"ocupada"` si es continuación. */
const mapa = computed(() => {
    const celdas = {};
    for (const sesion of props.sesiones) {
        celdas[sesion.diaIndice] ??= {};
        celdas[sesion.diaIndice][sesion.horaInicio] = sesion;
        for (let h = sesion.horaInicio + 1; h < sesion.horaFin; h++) {
            celdas[sesion.diaIndice][h] = "ocupada";
        }
    }
    return celdas;
});

function celda(dia, hora) {
    return mapa.value[dia]?.[hora] ?? null;
}

function tonoDe(sesion) {
    const tono = props.tonos.get(sesion.materiaId);
    return tono === null || tono === undefined ? "clase-tono-base" : `clase-tono-${tono % 6}`;
}

function gruposDe(sesion) {
    return (sesion.grupoClaves ?? [sesion.grupoClave]).join(" + ");
}

function comoHora(h) {
    return `${String(h).padStart(2, "0")}:00`;
}
</script>

<template>
    <div class="rejilla-envoltura">
        <table class="rejilla">
            <thead>
                <tr>
                    <th class="rejilla-hora">Hora</th>
                    <th v-for="dia in rejilla.dias" :key="dia">{{ dia }}</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="hora in franja" :key="hora">
                    <th class="rejilla-hora">{{ comoHora(hora) }}</th>
                    <template v-for="(dia, d) in rejilla.dias" :key="dia">
                        <td v-if="celda(d, hora) === null" class="rejilla-libre"></td>
                        <td
                            v-else-if="celda(d, hora) !== 'ocupada'"
                            class="rejilla-clase"
                            :class="[tonoDe(celda(d, hora)), { 'es-editable': editable }]"
                            :rowspan="celda(d, hora).horaFin - celda(d, hora).horaInicio"
                            :role="editable ? 'button' : null"
                            :tabindex="editable ? 0 : null"
                            :title="editable ? 'Pulsa para moverla' : null"
                            @click="editable && emitir('elegir', celda(d, hora))"
                            @keydown.enter="editable && emitir('elegir', celda(d, hora))"
                        >
                            <span class="rejilla-materia">{{ celda(d, hora).materiaNombre }}</span>
                            <span class="rejilla-linea">
                                <template v-if="conGrupo">
                                    <!-- Una fusión se imparte a varios grupos a
                                         la vez: nombrarlos todos, porque el
                                         docente entra una vez a un solo salón. -->
                                    {{ gruposDe(celda(d, hora)) }}
                                </template>
                                <template v-else>{{ celda(d, hora).docenteNombre }}</template>
                                <span v-if="celda(d, hora).fusionada" class="rejilla-fusion">
                                    fusionada
                                </span>
                            </span>
                            <span class="rejilla-linea">
                                <!-- Para un grupo el aula solo se nombra cuando
                                     sale de la suya, es decir en laboratorio: el
                                     resto sería la misma etiqueta repetida en
                                     cada bloque. Para un docente siempre, porque
                                     es él quien rota de salón. -->
                                <span
                                    v-if="conGrupo || celda(d, hora).esAulaBase === false"
                                    class="rejilla-aula"
                                >{{ celda(d, hora).aulaClave }}</span>
                                {{ comoHora(celda(d, hora).horaInicio) }}–{{ comoHora(celda(d, hora).horaFin) }}
                            </span>
                        </td>
                    </template>
                </tr>
            </tbody>
        </table>
    </div>
</template>
