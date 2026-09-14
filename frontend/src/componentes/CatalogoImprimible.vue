<script setup>
/**
 * La carga académica en papel: lo que el departamento entrega.
 *
 * El horario ya se imprimía por grupo y por docente, pero el reparto no, y es un
 * documento con destinatarios —Servicios Escolares, cada coordinación, el propio
 * expediente—. Copiarlo a mano de la pantalla era el único camino.
 *
 * Dos hojas distintas porque responden a preguntas distintas: **por carrera**,
 * qué recibe cada coordinación; **por docente**, qué junta cada persona entre
 * todas. La segunda es la que nadie podía sacar de ningún lado.
 *
 * Escondida en pantalla y visible solo al imprimir, igual que `HorarioImprimible`.
 */
const props = defineProps({
    /** "catalogo", "carga" o "ambos": qué hojas entran en el papel. */
    alcance: { type: String, default: "catalogo" },
    carrera: { type: String, default: "" },
    carreraNombre: { type: String, default: "" },
    escenarioId: { type: String, default: "" },
    /** Filas del catálogo: una por materia y grupo. */
    filas: { type: Array, default: () => [] },
    /** Lo que cada docente junta en todo el instituto. */
    carga: { type: Array, default: () => [] }
});

const hoy = new Date().toLocaleDateString("es-MX", {
    day: "numeric", month: "long", year: "numeric"
});

/** Las clases agrupadas por grupo, como se leen en una hoja de carga. */
function porGrupo(filas) {
    const mapa = new Map();
    for (const f of filas) {
        if (!mapa.has(f.grupoClave)) {
            mapa.set(f.grupoClave, { clave: f.grupoClave, turno: f.turno, filas: [] });
        }
        mapa.get(f.grupoClave).filas.push(f);
    }
    return [...mapa.values()].sort((a, b) => a.clave.localeCompare(b.clave));
}

const horas = (filas) => filas.reduce((n, f) => n + (f.horasSemana ?? 0), 0);
</script>

<template>
    <div class="impresion">
        <article v-if="alcance !== 'carga'" class="hoja">
            <header class="hoja-cabeza">
                <div>
                    <h1 class="hoja-titulo">Carga académica · {{ carrera }}</h1>
                    <p class="hoja-sub">
                        {{ carreraNombre }}
                        <template v-if="escenarioId"> · {{ escenarioId }}</template>
                        · {{ hoy }}
                    </p>
                </div>
                <div class="hoja-meta">
                    <p><strong>{{ filas.length }} clases</strong></p>
                    <p>{{ horas(filas) }} horas semanales</p>
                    <p>{{ filas.filter((f) => !f.docenteId).length }} sin asignar</p>
                </div>
            </header>

            <table class="tabla-impresa">
                <thead>
                    <tr>
                        <th>Grupo</th>
                        <th>Clave</th>
                        <th>Materia</th>
                        <th class="numero">Hrs.</th>
                        <th>Imparte</th>
                    </tr>
                </thead>
                <tbody v-for="g in porGrupo(filas)" :key="g.clave">
                    <tr v-for="(f, i) in g.filas" :key="f.materiaId + f.grupoClave">
                        <!-- La clave del grupo una vez por bloque, como en las
                             hojas del instituto: repetirla en cada renglón hace
                             más difícil ver dónde empieza el siguiente. -->
                        <td class="grupo">
                            <template v-if="i === 0">{{ g.clave }}<br><small>{{ g.turno }}</small></template>
                        </td>
                        <td class="clave">{{ f.clave }}</td>
                        <td>{{ f.nombre }}</td>
                        <td class="numero">{{ f.horasSemana }}</td>
                        <td>{{ f.docenteNombre ?? "—" }}</td>
                    </tr>
                </tbody>
            </table>
        </article>

        <article v-if="alcance !== 'catalogo'" class="hoja">
            <header class="hoja-cabeza">
                <div>
                    <h1 class="hoja-titulo">Carga por docente</h1>
                    <p class="hoja-sub">Todas las coordinaciones del instituto · {{ hoy }}</p>
                </div>
                <div class="hoja-meta">
                    <p><strong>{{ carga.length }} docentes con clase</strong></p>
                    <p>{{ carga.reduce((n, c) => n + c.horas, 0) }} horas repartidas</p>
                </div>
            </header>

            <table class="tabla-impresa">
                <thead>
                    <tr>
                        <th>Docente</th>
                        <th class="numero">Horas</th>
                        <th class="numero">Máx.</th>
                        <th class="numero">Clases</th>
                        <th class="numero">Materias</th>
                        <th>Carreras</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="c in carga" :key="c.docenteId">
                        <td>{{ c.nombre }}</td>
                        <td class="numero">{{ c.horas }}</td>
                        <td class="numero">{{ c.horasMax }}</td>
                        <td class="numero">{{ c.clases }}</td>
                        <td class="numero">{{ c.materias }}</td>
                        <td>
                            {{ c.carreras.join(" · ") }}
                            <!-- Lo que hay que mirar antes de firmarla. -->
                            <template v-if="c.sobreHoras"> — pasado de horas</template>
                            <template v-if="c.sobreMaterias"> — pasado de materias</template>
                        </td>
                    </tr>
                </tbody>
            </table>
        </article>
    </div>
</template>
