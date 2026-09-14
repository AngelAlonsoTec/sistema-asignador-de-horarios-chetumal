<script setup>
/**
 * Formulario de disponibilidad, tal como lo ve el docente.
 *
 * Entra por un enlace personal, sin cuenta ni contraseña, y no ve nada más que
 * su propia hoja: ni la plantilla, ni los horarios, ni sus descargas, que son
 * del departamento académico.
 */
import { ref, computed, onMounted } from "vue";
import { api } from "../api.js";
import LogoMarca from "../componentes/LogoMarca.vue";
import RejillaHorario from "../componentes/RejillaHorario.vue";

const props = defineProps({ token: { type: String, required: true } });

const datos = ref(null);
const dias = ref([]);
const error = ref(null);
const guardado = ref(false);
const guardando = ref(false);

/**
 * Lo que le tocó, de todas las carreras a la vez.
 *
 * Es la primera pregunta de cualquier docente —*¿qué me tocó?*— y hasta ahora no
 * la contestaba nadie: quien da clase en tres carreras tenía tres hojas
 * parciales, cada una en poder de un coordinador distinto.
 */
const horario = ref(null);
const seccion = ref("horario");

onMounted(async () => {
    try {
        const r = await api.abrirDisponibilidad(props.token);
        horario.value = await api.miHorario(props.token).catch(() => null);
        datos.value = r;
        dias.value = r.dias.map((dia) => {
            const suyo = r.declarada.find((b) => b.dia === dia);
            const evita = r.evitar.find((b) => b.dia === dia);
            return {
                dia,
                activo: Boolean(suyo),
                inicio: suyo?.inicio ?? 7,
                fin: suyo?.fin ?? 14,
                evitar: Boolean(evita),
                evitarInicio: evita?.inicio ?? 7,
                evitarFin: evita?.fin ?? 8
            };
        });
    } catch (e) {
        error.value = e.message;
    }
});

const horas = computed(() =>
    dias.value.filter((d) => d.activo).reduce((s, d) => s + Math.max(0, d.fin - d.inicio), 0)
);

/** El periodo que se enseña: el que más horas le ocupa. */
const periodo = computed(() => horario.value?.periodos?.[0] ?? null);
const tieneHorario = computed(() => (periodo.value?.bloques?.length ?? 0) > 0);

const PARIDADES = { impares: "Semestres impares", pares: "Semestres pares" };

/**
 * Sus bloques con la forma que entiende la rejilla. Se acota a las horas que de
 * verdad ocupa: quien solo da clase de tarde no necesita nueve filas vacías
 * arriba, y quien da en los dos turnos no cabría en la franja de uno.
 */
const rejilla = computed(() => {
    const bloques = periodo.value?.bloques ?? [];
    if (bloques.length === 0) return null;
    return {
        dias: horario.value.dias,
        turnos: [
            {
                id: "completo",
                // Sin margen arriba ni abajo: en pantalla una fila vacía es una
                // fila que hay que recorrer para llegar a la primera clase.
                horaInicio: Math.min(...bloques.map((b) => b.inicio)),
                horaFin: Math.max(...bloques.map((b) => b.fin))
            }
        ]
    };
});

const sesiones = computed(() =>
    (periodo.value?.bloques ?? []).map((b) => ({
        diaIndice: horario.value.dias.indexOf(b.dia),
        horaInicio: b.inicio,
        horaFin: b.fin,
        // La rejilla nombra la materia y, con `conGrupo`, el grupo y el aula:
        // el docente es siempre el mismo y sobra. La carrera sí hace falta,
        // porque el 1A de Sistemas y el de TI se llaman igual.
        materiaId: `${b.carrera}|${b.materia}`,
        materiaClave: b.materia,
        materiaNombre: `${b.materia} · ${b.carrera}`,
        // La carrera ya va en el nombre de la materia: repetirla aquí solo
        // hace más larga una celda que se lee de un vistazo.
        grupoClaves: [b.grupo],
        aulaClave: b.aula
    }))
);

/** Un tono por carrera: de un vistazo se ve dónde está cada mañana. */
const tonos = computed(() => {
    const carreras = [...new Set((periodo.value?.bloques ?? []).map((b) => b.carrera))].sort();
    return new Map(
        sesiones.value.map((s) => [s.materiaId, carreras.indexOf(s.materiaId.split("|")[0])])
    );
});

const horasClase = computed(() =>
    (periodo.value?.bloques ?? []).reduce((n, b) => n + (b.fin - b.inicio), 0)
);

const carrerasDe = computed(() =>
    [...new Set((periodo.value?.bloques ?? []).map((b) => b.carrera))].sort()
);

/**
 * Imprime la hoja oculta, no la pantalla. Es el mismo mecanismo que usan las
 * hojas del coordinador: `.impresion` está escondida en pantalla y es lo único
 * visible en papel, así que no hace falta una regla nueva.
 */
const imprimir = () => window.print();

async function enviar() {
    error.value = null;
    guardando.value = true;
    try {
        await api.guardarDisponibilidad(props.token, {
            declarada: dias.value
                .filter((d) => d.activo)
                .map(({ dia, inicio, fin }) => ({ dia, inicio: Number(inicio), fin: Number(fin) })),
            evitar: dias.value
                .filter((d) => d.activo && d.evitar)
                .map(({ dia, evitarInicio, evitarFin }) => ({
                    dia,
                    inicio: Number(evitarInicio),
                    fin: Number(evitarFin)
                }))
        });
        guardado.value = true;
    } catch (e) {
        error.value = e.message;
    } finally {
        guardando.value = false;
    }
}
</script>

<template>
    <div class="portada">
        <div class="acceso acceso-ancho" :class="{ 'acceso-semana': seccion === 'horario' && tieneHorario }">
            <div class="acceso-marca">
                <LogoMarca :tamano="34" />
                <span class="marca-texto">Schedul<span class="marca-ia">AI</span></span>
            </div>

            <p v-if="error && !datos" class="formulario-error">{{ error }}</p>

            <template v-else-if="datos">
                <div>
                    <h1 class="acceso-titulo">{{ datos.nombre }}</h1>
                    <p class="acceso-nota" style="margin-top: 4px">
                        Tu página: lo que te tocó esta semana y el horario del que la coordinación
                        puede tomar tus horas.
                    </p>
                </div>

                <!-- Dos cosas y no una lista de opciones: se ve lo que hay. -->
                <div class="pestanas-docente">
                    <button
                        type="button"
                        :class="{ 'is-activo': seccion === 'horario' }"
                        @click="seccion = 'horario'"
                    >
                        Mi horario
                        <span v-if="tieneHorario" class="pestana-conteo">{{ horasClase }} h</span>
                    </button>
                    <button
                        type="button"
                        :class="{ 'is-activo': seccion === 'disponibilidad' }"
                        @click="seccion = 'disponibilidad'"
                    >
                        Mi disponibilidad
                    </button>
                </div>

                <template v-if="seccion === 'horario'">
                    <template v-if="tieneHorario">
                        <div class="horario-docente-cabeza">
                            <div>
                                <h2 class="tarjeta-panel-titulo">
                                    {{ PARIDADES[periodo.paridad] ?? "Periodo en curso" }}
                                </h2>
                                <p class="campo-ayuda">
                                    {{ horasClase }} horas de clase en
                                    {{ carrerasDe.length === 1 ? "una carrera" : `${carrerasDe.length} carreras` }}
                                    ({{ carrerasDe.join(" · ") }}).
                                </p>
                            </div>
                            <!-- Mientras el periodo esté abierto esto es un
                                 borrador: decirlo evita que alguien organice su
                                 semana con algo que todavía puede moverse. -->
                            <span v-if="periodo.cerrado" class="etiqueta-suave">definitivo</span>
                            <span v-else class="violacion is-blanda">borrador, puede cambiar</span>
                        </div>

                        <div class="horario-docente-rejilla">
                            <RejillaHorario
                                :sesiones="sesiones"
                                :rejilla="rejilla"
                                turno="completo"
                                :tonos="tonos"
                                :con-grupo="true"
                            />
                        </div>

                        <div v-if="datos.descargas?.length ?? horario?.descargas?.length" class="campo-ayuda">
                            Además tienes
                            {{ (horario?.descargas ?? []).length }} bloque(s) de descarga administrativa,
                            que la coordinación no puede ocupar.
                        </div>

                        <button type="button" class="btn" @click="imprimir">Imprimir mi horario</button>

                        <!-- La hoja de papel: escondida en pantalla, y lo único
                             que se ve al imprimir. -->
                        <div class="impresion">
                            <article class="hoja">
                                <header class="hoja-cabeza">
                                    <div>
                                        <h1 class="hoja-titulo">{{ datos.nombre }}</h1>
                                        <p class="hoja-sub">
                                            {{ PARIDADES[periodo.paridad] ?? "Periodo en curso" }}
                                            · {{ carrerasDe.join(" · ") }}
                                            <template v-if="!periodo.cerrado"> · borrador</template>
                                        </p>
                                    </div>
                                    <div class="hoja-meta">
                                        <p>{{ horasClase }} horas semanales</p>
                                    </div>
                                </header>
                                <RejillaHorario
                                    :sesiones="sesiones"
                                    :rejilla="rejilla"
                                    turno="completo"
                                    :tonos="tonos"
                                    :con-grupo="true"
                                />
                            </article>
                        </div>
                    </template>

                    <p v-else class="estado-vacio">
                        Todavía no hay horario para ti. Aparecerá aquí en cuanto tu coordinación
                        arme el del periodo.
                    </p>
                </template>

                <template v-else>
                <p class="acceso-nota" style="margin: 0">
                    Marca los días que puedes dar clase y en qué horario. Esto no es tu horario:
                    es el rango del que la coordinación podrá tomar tus horas.
                </p>

                <p v-if="guardado" class="banda banda-ok" style="margin: 0">
                    Gracias, quedó registrado. Puedes cerrar esta página o cambiarlo cuando quieras.
                </p>

                <!-- Cada día en dos renglones: el horario arriba y la preferencia
                     debajo. En una sola línea no caben los cuatro campos sin
                     envolverse, y envueltos se pierde de qué rango es cada uno. -->
                <div class="franjas">
                    <div v-for="d in dias" :key="d.dia" class="dia-docente">
                        <div class="dia-docente-fila">
                            <label class="franja-dia">
                                <input v-model="d.activo" type="checkbox">
                                <span>{{ d.dia }}</span>
                            </label>

                            <template v-if="d.activo">
                                <input v-model.number="d.inicio" type="number" min="0" max="23" class="input-chico input-conteo">
                                <span class="franja-a">a</span>
                                <input v-model.number="d.fin" type="number" min="1" max="24" class="input-chico input-conteo">
                            </template>
                            <span v-else class="celda-tenue">no disponible</span>
                        </div>

                        <div v-if="d.activo" class="dia-docente-fila dia-docente-preferencia">
                            <label class="franja-evitar">
                                <input v-model="d.evitar" type="checkbox">
                                <span>si se puede, evitar</span>
                            </label>
                            <template v-if="d.evitar">
                                <input v-model.number="d.evitarInicio" type="number" min="0" max="23" class="input-chico input-conteo">
                                <span class="franja-a">a</span>
                                <input v-model.number="d.evitarFin" type="number" min="1" max="24" class="input-chico input-conteo">
                            </template>
                        </div>
                    </div>
                </div>

                <p class="campo-ayuda" style="margin: 0">Total declarado: {{ horas }} horas.</p>
                <p v-if="error" class="formulario-error">{{ error }}</p>

                <button type="button" class="btn btn-primary" :disabled="guardando" @click="enviar">
                    {{ guardando ? "Guardando…" : "Enviar disponibilidad" }}
                </button>
                </template>
            </template>

            <p v-else class="estado-vacio">Cargando…</p>
        </div>
    </div>
</template>
