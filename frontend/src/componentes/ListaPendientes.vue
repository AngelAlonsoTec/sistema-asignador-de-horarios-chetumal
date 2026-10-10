<script setup>
/**
 * Lista de cosas por atender antes o después de generar: los bloqueos —falta
 * capturar algo— y las necesidades —está todo capturado y no alcanza—.
 *
 * Son el mismo componente porque son la misma pieza de interfaz: un renglón que
 * dice qué pasa, un botón que enseña el detalle y otro que lleva a la sección
 * donde se atiende. Lo que cambia es el tono, y enumerarlas sin salida sería
 * igual de inútil que el horario imposible que evitan.
 */
import { ref } from "vue";
import { irASeccion } from "../estado.js";

const props = defineProps({
    items: { type: Array, default: () => [] },
    /** `seccion -> rótulo del botón`. Sin entrada no se ofrece el salto. */
    secciones: { type: Object, default: () => ({}) },
    tono: { type: String, default: "bloqueo" }
});

const abierto = ref(null);

const alternar = (codigo) => {
    abierto.value = abierto.value === codigo ? null : codigo;
};

/**
 * Llevar a la sección ya filtrada por lo que falta. Sin el filtro, "Ir a
 * Materias" deja al coordinador buscando a mano cuáles de ciento ochenta son
 * las que nadie puede dar.
 */
const atender = (item) => {
    irASeccion(item.seccion, item.codigo === "materias-sin-docente" ? "sin-docente" : null);
};
</script>

<template>
    <ul class="lista-bloqueos" :class="`lista-${tono}`">
        <li v-for="item in items" :key="item.codigo">
            <div class="bloqueo-fila">
                <span class="bloqueo-mensaje">{{ item.mensaje }}</span>
                <div class="bloqueo-acciones">
                    <button
                        v-if="item.detalle.length"
                        type="button"
                        class="btn btn-chico"
                        @click="alternar(item.codigo)"
                    >
                        {{ abierto === item.codigo ? "Ocultar" : `Ver ${item.detalle.length}` }}
                    </button>
                    <button
                        v-if="props.secciones[item.seccion]"
                        type="button"
                        class="btn btn-chico"
                        @click="atender(item)"
                    >Ir a {{ props.secciones[item.seccion] }}</button>
                </div>
            </div>
            <ul v-if="abierto === item.codigo" class="bloqueo-detalle">
                <li v-for="linea in item.detalle" :key="linea">{{ linea }}</li>
            </ul>
        </li>
    </ul>
</template>
