<script setup>
/**
 * Tabla con encabezados de grupo intercalados en dos niveles.
 *
 * Los grupos se dibujan como filas dentro de la misma tabla, en vez de una
 * tabla por grupo: así todas las columnas quedan alineadas de arriba abajo, que
 * es lo que permite comparar un semestre con otro de un vistazo.
 *
 * El contenido de cada fila lo pone quien la usa, mediante el slot `fila`. Esta
 * componente solo aporta la estructura y el agrupado.
 */
defineProps({
    columnas: { type: Array, required: true },
    /** `[{ titulo?, nivel?, items: [] }]`. Sin `titulo` no se dibuja encabezado. */
    grupos: { type: Array, required: true },
    vacio: { type: String, default: "No hay nada que mostrar." },
    claveDe: { type: Function, default: (item) => item.id }
});
</script>

<template>
    <!-- La tabla va dentro de un panel blanco: el contenido se desplaza sobre
         el fondo tintado de la aplicación, y sin la superficie propia las filas
         quedarían flotando. -->
    <div class="panel">
        <p v-if="grupos.every((grupo) => grupo.items.length === 0)" class="estado-vacio">{{ vacio }}</p>

        <table v-else class="tabla">
            <thead>
                <tr>
                    <th v-for="columna in columnas" :key="columna">{{ columna }}</th>
                </tr>
            </thead>
            <tbody>
                <template v-for="(grupo, g) in grupos" :key="grupo.titulo ?? g">
                    <tr
                        v-if="grupo.titulo"
                        class="fila-separador"
                        :class="{ 'fila-subseparador': grupo.nivel === 2 }"
                    >
                        <td :colspan="columnas.length">{{ grupo.titulo }}</td>
                    </tr>
                    <tr v-for="item in grupo.items" :key="claveDe(item)" :class="item.__clase">
                        <slot name="fila" :item="item" />
                    </tr>
                </template>
            </tbody>
        </table>
    </div>
</template>
