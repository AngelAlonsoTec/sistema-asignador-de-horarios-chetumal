<script setup>
/**
 * El indicador de cobertura. Es un botón y no una etiqueta: al pulsarlo lleva a
 * las materias que provocaron la alerta, que es lo que se quiere hacer justo
 * después de verla.
 */
const props = defineProps({
    cobertura: { type: Object, required: true },
    pulsable: { type: Boolean, default: false }
});
defineEmits(["ir"]);
</script>

<template>
    <component
        :is="pulsable ? 'button' : 'span'"
        :type="pulsable ? 'button' : undefined"
        class="escenario-cobertura"
        :class="cobertura.completa ? 'is-ok' : 'is-alerta'"
        @click="pulsable && $emit('ir')"
    >
        <template v-if="cobertura.completa">
            Cobertura completa · {{ cobertura.total }} materias
        </template>
        <template v-else>
            {{ cobertura.sinDocente.length }} sin docente · {{ cobertura.cubiertas }}/{{ cobertura.total }}
        </template>
    </component>
</template>
