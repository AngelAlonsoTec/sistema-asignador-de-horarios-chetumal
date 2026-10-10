<script setup>
import { computed } from "vue";
import RejillaHorario from "./RejillaHorario.vue";

/**
 * El horario en papel.
 *
 * Existe porque el producto del trabajo de un coordinador se reparte: los
 * alumnos reciben el de su grupo y los docentes el suyo. Hasta ahora el horario
 * solo vivía dentro de una pestaña.
 *
 * Se dibujan **todos** los grupos y docentes a la vez, no el visible: imprimir
 * de uno en uno son treinta pasadas por el navegador. En pantalla no se ve nada
 * — el bloque entero es `display: none` fuera de `@media print`.
 */
const props = defineProps({
    resultado: { type: Object, required: true },
    tonos: { type: Map, required: true },
    carrera: { type: String, default: "" },
    escenario: { type: String, default: "" },
    paridad: { type: String, default: "" },
    /** "grupos", "docentes" o "ambos". */
    alcance: { type: String, default: "grupos" },
    /**
     * La retícula, para poder nombrar lo que falta. Un horario apartado antes
     * de que los grupos viajaran con sus materias no trae con qué comparar, y
     * entonces no se avisa de nada: es preferible a inventar un faltante.
     */
    materias: { type: Array, default: () => [] }
});

const sesionesDe = (predicado) => props.resultado.sesiones.filter(predicado);

const porId = computed(() => new Map(props.materias.map((m) => [m.id, m])));

/**
 * Materias que el grupo cursa y el horario no trae.
 *
 * La hoja impresa es lo que llega al alumno, y un hueco en la rejilla no se
 * distingue de una hora libre. Si una clase se quedó fuera —porque nadie está
 * autorizado para darla y hay que contratar— tiene que decirlo el papel, no
 * solo la pantalla de quien generó.
 */
const faltantesDe = (grupo, sesiones) => {
    if (!Array.isArray(grupo.materias)) return [];
    const puestas = new Set(sesiones.map((s) => s.materiaId));
    return grupo.materias
        .filter((id) => !puestas.has(id))
        .map((id) => porId.value.get(id) ?? { id, clave: id, nombre: id });
};

const porGrupo = computed(() =>
    props.resultado.grupos.map((grupo) => {
        const sesiones = sesionesDe((s) => (s.grupoIds ?? [s.grupoId]).includes(grupo.id));
        return { grupo, sesiones, faltantes: faltantesDe(grupo, sesiones) };
    })
);

/**
 * La rejilla de un docente no puede ser la de un turno: da clase en los dos, y
 * con la de un grupo sus clases del otro turno caerían fuera de la tabla.
 *
 * Tampoco es el día entero. Un docente que solo trabaja de tarde recibiría una
 * hoja con nueve filas vacías arriba, que además no cabe en una página: la
 * rejilla se parte y el pie queda solo en la siguiente. Se acota a las horas
 * que de verdad ocupa, con una de respiro a cada lado.
 */
function rejillaDe(sesiones) {
    const turnos = props.resultado.rejilla.turnos;
    const [diaInicio, diaFin] = [
        Math.min(...turnos.map((t) => t.horaInicio)),
        Math.max(...turnos.map((t) => t.horaFin))
    ];

    return {
        ...props.resultado.rejilla,
        turnos: [
            {
                id: "completo",
                horaInicio: Math.max(diaInicio, Math.min(...sesiones.map((s) => s.horaInicio)) - 1),
                horaFin: Math.min(diaFin, Math.max(...sesiones.map((s) => s.horaFin)) + 1)
            }
        ]
    };
}

const porDocente = computed(() => {
    const nombres = new Map();
    for (const s of props.resultado.sesiones) nombres.set(s.docenteId, s.docenteNombre);

    return [...nombres]
        .map(([id, nombre]) => {
            const sesiones = sesionesDe((s) => s.docenteId === id);
            return { id, nombre, sesiones, rejilla: rejillaDe(sesiones) };
        })
        .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
});

const horas = (sesiones) => sesiones.reduce((n, s) => n + (s.horaFin - s.horaInicio), 0);

const conGrupos = computed(() => props.alcance !== "docentes");
const conDocentes = computed(() => props.alcance !== "grupos");
</script>

<template>
    <div class="impresion">
        <template v-if="conGrupos">
            <article v-for="{ grupo, sesiones, faltantes } in porGrupo" :key="grupo.id" class="hoja">
                <header class="hoja-cabeza">
                    <div>
                        <!-- En un horario conjunto el 1A de una carrera y el
                             de la otra se llaman igual: manda la del grupo. -->
                        <h1 class="hoja-titulo">
                            Grupo {{ grupo.clave }}<template v-if="grupo.carrera"> · {{ grupo.carrera }}</template>
                        </h1>
                        <p class="hoja-sub">
                            {{ grupo.carrera ?? carrera }} · {{ escenario }} · Semestre {{ grupo.semestre }}
                            · {{ grupo.turno }}
                            <template v-if="grupo.especialidad"> · {{ grupo.especialidad }}</template>
                        </p>
                    </div>
                    <div class="hoja-meta">
                        <p v-if="grupo.aulaClave"><strong>Aula {{ grupo.aulaClave }}</strong></p>
                        <p>{{ horas(sesiones) }} horas semanales</p>
                    </div>
                </header>

                <RejillaHorario
                    :sesiones="sesiones"
                    :rejilla="resultado.rejilla"
                    :turno="grupo.turno"
                    :tonos="tonos"
                />

                <p v-if="faltantes.length" class="hoja-faltan">
                    <strong>Faltan por asignar:</strong>
                    <span v-for="(m, i) in faltantes" :key="m.id">
                        <template v-if="i > 0"> · </template>{{ m.clave }} {{ m.nombre }}<template
                            v-if="m.horasSemana"> ({{ m.horasSemana }} h)</template>
                    </span>
                    — el grupo las cursa y este horario todavía no las incluye.
                </p>

                <p class="hoja-pie">
                    Periodo <span class="hoja-paridad">{{ paridad }}</span> · Generado con SchedulAI
                </p>
            </article>
        </template>

        <template v-if="conDocentes">
            <article v-for="docente in porDocente" :key="docente.id" class="hoja">
                <header class="hoja-cabeza">
                    <div>
                        <h1 class="hoja-titulo">{{ docente.nombre }}</h1>
                        <p class="hoja-sub">{{ carrera }} · {{ escenario }}</p>
                    </div>
                    <div class="hoja-meta">
                        <p><strong>{{ horas(docente.sesiones) }} horas</strong></p>
                        <p>{{ docente.sesiones.length }} bloques</p>
                    </div>
                </header>

                <!-- El docente rota entre grupos, así que aquí el dato que falta
                     es a quién le da clase y dónde: va dentro de cada bloque. -->
                <RejillaHorario
                    :sesiones="docente.sesiones"
                    :rejilla="docente.rejilla"
                    turno="completo"
                    :tonos="tonos"
                    con-grupo
                />

                <p class="hoja-pie">
                    Periodo <span class="hoja-paridad">{{ paridad }}</span> · Generado con SchedulAI
                </p>
            </article>
        </template>
    </div>
</template>
