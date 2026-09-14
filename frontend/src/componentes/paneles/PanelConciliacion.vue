<script setup>
/**
 * Conciliación entre coordinaciones.
 *
 * Todos trabajan en borrador, así que dos carreras pueden pretender la misma
 * hora del mismo docente. Aquí se ven esos choques y se resuelven como se
 * resuelven hoy —pidiendo— pero con registro: quién pidió qué, con qué motivo y
 * qué contestaron.
 */
import { ref, computed, onMounted } from "vue";
import {
    estado,
    verConflictos,
    verSolicitudes,
    solicitarHoras,
    responderSolicitud
} from "../../estado.js";
import { api } from "../../api.js";
import DialogoModal from "../DialogoModal.vue";

const conflictos = ref([]);

/**
 * Qué se pide. Una solicitud es de las horas de un docente o de las de un
 * salón: son los dos recursos que el instituto comparte, y la conversación —
 * quien las tiene cede o no— es la misma.
 */
const recurso = (s) =>
    s.aulaId ? `Aula ${s.aulaClave ?? s.aulaId}` : (s.docenteNombre ?? s.docenteId);

/**
 * Invitaciones a programar un horario conjunto.
 *
 * No son solicitudes de horas: aquella se resuelve en horas concretas, esta es
 * un permiso. Mientras esté aceptado, la anfitriona puede incluir ese escenario
 * en sus corridas; cualquiera de las dos lo puede retirar.
 */
const invitaciones = ref({ enviadas: [], recibidas: [] });
const carrerasAjenas = ref([]);
const invitando = ref(null);

async function cargarInvitaciones() {
    invitaciones.value = await api.invitaciones().catch(() => ({ enviadas: [], recibidas: [] }));
    // Del plantel y no de `api.carreras()`: esa devuelve solo las que llevo, y
    // para invitar hay que poder nombrar justamente las que no.
    const todas = await api.plantel().catch(() => []);
    const mias = new Set(estado.usuario?.carreras ?? []);
    carrerasAjenas.value = todas.filter((c) => !mias.has(c.codigo));
}

const invitacionesPendientes = computed(() =>
    invitaciones.value.recibidas.filter((i) => i.estado === "pendiente")
);

async function abrirInvitacion() {
    if (carrerasAjenas.value.length === 0) {
        estado.error = "Coordinas todas las carreras: no hay a quién invitar.";
        return;
    }
    invitando.value = { invitada: carrerasAjenas.value[0], escenarioId: "caso-base" };
}

async function enviarInvitacion() {
    const r = await api
        .invitar({ anfitriona: estado.carrera, ...invitando.value })
        .catch((e) => {
            estado.error = e.message;
            return null;
        });
    invitando.value = null;
    if (r) await cargarInvitaciones();
}

async function responderInvitacion(inv, acepta) {
    await api.responderInvitacion(inv.id, { acepta }).catch((e) => (estado.error = e.message));
    await cargarInvitaciones();
}

async function revocarInvitacion(inv) {
    if (!confirm(`¿Retirar el permiso entre ${inv.anfitriona} y ${inv.invitada}?`)) return;
    await api.revocarInvitacion(inv.id).catch((e) => (estado.error = e.message));
    await cargarInvitaciones();
}
const solicitudes = ref({ enviadas: [], recibidas: [] });
const paridad = ref("impares");
const pidiendo = ref(null);
const motivo = ref("");

async function cargar() {
    const [c, s] = await Promise.all([verConflictos({ paridad: paridad.value }), verSolicitudes()]);
    if (c) conflictos.value = c.conflictos;
    if (s) solicitudes.value = s;
}

onMounted(cargar);
onMounted(cargarInvitaciones);

const pendientes = computed(() => solicitudes.value.recibidas.filter((s) => s.estado === "pendiente"));

/** Un conflicto ya solicitado no se vuelve a pedir. */
function yaPedido(c, contra) {
    return solicitudes.value.enviadas.some(
        (s) =>
            s.estado === "pendiente" &&
            s.docenteId === c.docenteId &&
            s.dia === c.dia &&
            s.inicio === c.inicio &&
            s.fin === c.fin &&
            s.aCarrera === contra.carrera
    );
}

/**
 * Un choque entre dos carreras que lleva la misma persona no se negocia: se
 * decide. Se sueltan las horas del otro lado sin pasar por una solicitud que
 * esa misma persona tendría que responderse.
 */
async function resolverPropio(c, contra) {
    const texto =
        `Vas a soltar ${c.docenteNombre}, ${c.dia} ${comoHora(c.inicio)}–${comoHora(c.fin)}, ` +
        `del horario de ${contra.carrera} (${contra.grupo} / ${contra.materia}).` +
        `\n\nLas horas quedan para ${estado.carrera}. Habrá que regenerar el horario de ${contra.carrera}.`;
    if (!confirm(texto)) return;

    const r = await api
        .resolverPropio({
            cede: { carrera: contra.carrera, escenarioId: contra.escenarioId },
            bloque: { docenteId: c.docenteId, dia: c.dia, inicio: c.inicio, fin: c.fin }
        })
        .catch((e) => {
            estado.error = e.message;
            return null;
        });
    if (r) await cargar();
}

function abrirPeticion(c, contra) {
    pidiendo.value = { c, contra };
    motivo.value = "";
}

async function enviar() {
    const { c, contra } = pidiendo.value;
    const r = await solicitarHoras({
        de: { carrera: estado.carrera, escenarioId: estado.abierto.id },
        a: { carrera: contra.carrera, escenarioId: contra.escenarioId },
        docenteId: c.docenteId,
        dia: c.dia,
        inicio: c.inicio,
        fin: c.fin,
        motivo: motivo.value
    });
    pidiendo.value = null;
    if (r) await cargar();
}

async function responder(solicitud, acepta) {
    const texto = acepta
        ? prompt("Nota para quien la pidió (opcional):") ?? ""
        : prompt("¿Por qué no puedes cederla?") ?? "";
    await responderSolicitud(solicitud.id, acepta, texto);
    await cargar();
}

function comoHora(h) {
    return `${String(h).padStart(2, "0")}:00`;
}
</script>

<template>
    <div class="seccion-horario">
        <p class="panel-nota">
            Nadie bloquea a nadie: varias carreras pueden pretender las mismas horas de un docente.
            Donde eso pasa hay que ponerse de acuerdo, y aquí queda registrado.
        </p>

        <!-- Invitaciones a programar juntas: no son horas, es un permiso. -->
        <section v-if="invitacionesPendientes.length" class="tarjeta-panel">
            <header class="tarjeta-panel-cabeza">
                <div>
                    <h2 class="tarjeta-panel-titulo">
                        Te invitan a programar juntas ({{ invitacionesPendientes.length }})
                    </h2>
                    <p class="campo-ayuda">
                        Aceptar deja que esa coordinación incluya tu escenario en su horario, para
                        que las materias que comparten se impartan una sola vez. Puedes retirarlo
                        después.
                    </p>
                </div>
            </header>
            <div class="tarjeta-panel-cuerpo">
                <ul class="lista-solicitudes">
                    <li v-for="i in invitacionesPendientes" :key="i.id" class="solicitud">
                        <div>
                            <p class="solicitud-que">
                                {{ i.anfitriona }} quiere programar junto con {{ i.invitada }}
                            </p>
                            <p class="campo-ayuda" style="margin: 2px 0 0">
                                Usaría tu escenario «{{ i.escenarioId }}»
                            </p>
                        </div>
                        <div class="solicitud-acciones">
                            <button type="button" class="btn btn-chico" @click="responderInvitacion(i, false)">
                                No
                            </button>
                            <button
                                type="button"
                                class="btn btn-chico btn-primary"
                                @click="responderInvitacion(i, true)"
                            >Aceptar</button>
                        </div>
                    </li>
                </ul>
            </div>
        </section>

        <section class="tarjeta-panel">
            <header class="tarjeta-panel-cabeza">
                <div>
                    <h2 class="tarjeta-panel-titulo">Programar junto con otra coordinación</h2>
                    <p class="campo-ayuda">
                        Para compartir una clase con una carrera que lleva otra persona hace falta
                        su permiso: generar un horario conjunto es decidir el de las dos.
                    </p>
                </div>
                <button type="button" class="btn btn-chico" @click="abrirInvitacion">Invitar</button>
            </header>
            <div class="tarjeta-panel-cuerpo sin-relleno">
                <table class="tabla tabla-compacta">
                    <tbody>
                        <tr v-for="i in invitaciones.enviadas" :key="i.id">
                            <td class="celda-principal">{{ i.anfitriona }} + {{ i.invitada }}</td>
                            <td class="celda-tenue">{{ i.escenarioId }}</td>
                            <td>
                                <span
                                    class="violacion"
                                    :class="i.estado === 'aceptada' ? 'is-blanda' : 'is-dura'"
                                >{{ i.estado }}</span>
                            </td>
                            <td class="celda-acciones">
                                <button
                                    v-if="i.estado !== 'rechazada'"
                                    type="button"
                                    class="btn btn-chico"
                                    @click="revocarInvitacion(i)"
                                >Retirar</button>
                            </td>
                        </tr>
                        <tr v-if="invitaciones.enviadas.length === 0">
                            <td class="celda-tenue">Ninguna todavía.</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>

        <!-- Lo que me piden va primero: es lo que otro está esperando. -->
        <section v-if="pendientes.length" class="tarjeta-panel">
            <header class="tarjeta-panel-cabeza">
                <h2 class="tarjeta-panel-titulo">Te piden horas ({{ pendientes.length }})</h2>
            </header>
            <div class="tarjeta-panel-cuerpo">
                <ul class="lista-solicitudes">
                    <li v-for="s in pendientes" :key="s.id" class="solicitud">
                        <div>
                            <p class="solicitud-que">
                                <strong>{{ s.deCarrera }}</strong> pide
                                {{ recurso(s) }} ·
                                {{ s.dia }} de {{ comoHora(s.inicio) }} a {{ comoHora(s.fin) }}
                            </p>
                            <p class="campo-ayuda" style="margin: 2px 0 0">
                                {{ s.motivo || "Sin motivo" }}
                            </p>
                        </div>
                        <div class="solicitud-acciones">
                            <button type="button" class="btn btn-chico" @click="responder(s, false)">
                                No puedo
                            </button>
                            <button type="button" class="btn btn-chico btn-primary" @click="responder(s, true)">
                                Ceder
                            </button>
                        </div>
                    </li>
                </ul>
            </div>
        </section>

        <section class="tarjeta-panel">
            <header class="tarjeta-panel-cabeza">
                <div>
                    <h2 class="tarjeta-panel-titulo">Choques con otras carreras</h2>
                    <p class="campo-ayuda">
                        Horas que tu horario toma y otra carrera también pretende.
                    </p>
                </div>
                <button type="button" class="btn btn-chico" @click="cargar">Actualizar</button>
            </header>

            <div class="tarjeta-panel-cuerpo">
                <p v-if="conflictos.length === 0" class="estado-vacio">
                    Tu horario no choca con ninguna otra carrera.
                </p>

                <ul v-else class="lista-solicitudes">
                    <li v-for="(c, i) in conflictos" :key="i" class="solicitud">
                        <div>
                            <p class="solicitud-que">
                                {{ c.docenteNombre }} · {{ c.dia }}
                                {{ comoHora(c.inicio) }}–{{ comoHora(c.fin) }}
                            </p>
                            <p class="campo-ayuda" style="margin: 2px 0 0">
                                Tú: {{ c.mio.grupo }} / {{ c.mio.materia }} ·
                                <span v-for="o in c.contra" :key="o.carrera + o.grupo">
                                    {{ o.carrera }}: {{ o.grupo }} / {{ o.materia }}
                                </span>
                                <span v-if="c.propio" class="etiqueta-suave">también tuya</span>
                            </p>
                        </div>
                        <div class="solicitud-acciones">
                            <!-- Si las dos carreras son suyas no hay a quién
                                 pedirle nada: suelta las horas y sigue. -->
                            <template v-if="c.propio">
                                <button
                                    v-for="o in c.contra"
                                    :key="o.carrera"
                                    type="button"
                                    class="btn btn-chico"
                                    @click="resolverPropio(c, o)"
                                >Soltar las de {{ o.carrera }}</button>
                            </template>
                            <template v-else>
                                <button
                                    v-for="o in c.contra"
                                    :key="o.carrera"
                                    type="button"
                                    class="btn btn-chico"
                                    :disabled="yaPedido(c, o)"
                                    @click="abrirPeticion(c, o)"
                                >{{ yaPedido(c, o) ? "Ya solicitada" : `Pedir a ${o.carrera}` }}</button>
                            </template>
                        </div>
                    </li>
                </ul>
            </div>
        </section>

        <section v-if="solicitudes.enviadas.length" class="tarjeta-panel">
            <header class="tarjeta-panel-cabeza">
                <h2 class="tarjeta-panel-titulo">Lo que has pedido</h2>
            </header>
            <div class="tarjeta-panel-cuerpo sin-relleno">
                <table class="tabla tabla-compacta">
                    <thead>
                        <tr>
                            <th>A</th>
                            <th>Docente</th>
                            <th>Cuándo</th>
                            <th>Estado</th>
                            <th>Respuesta</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="s in solicitudes.enviadas" :key="s.id">
                            <td class="celda-principal">{{ s.aCarrera }}</td>
                            <td class="celda-tenue">{{ recurso(s) }}</td>
                            <td>{{ s.dia }} {{ comoHora(s.inicio) }}–{{ comoHora(s.fin) }}</td>
                            <td>
                                <span class="violacion" :class="{
                                    'is-dura': s.estado === 'rechazada',
                                    'is-blanda': s.estado !== 'rechazada'
                                }">{{ s.estado }}</span>
                            </td>
                            <td class="celda-tenue">{{ s.respuesta || "—" }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>

        <dialog v-if="pidiendo" class="dialogo" open>
            <form class="formulario" @submit.prevent="enviar">
                <h2 class="formulario-titulo">Pedir horas a {{ pidiendo.contra.carrera }}</h2>
                <p class="formulario-nota">
                    {{ pidiendo.c.docenteNombre }} · {{ pidiendo.c.dia }}
                    {{ comoHora(pidiendo.c.inicio) }}–{{ comoHora(pidiendo.c.fin) }}
                </p>
                <label class="campo">
                    <span>Motivo</span>
                    <input v-model="motivo" type="text" placeholder="Es el único docente de la materia" required>
                </label>
                <div class="formulario-acciones">
                    <button type="button" class="btn btn-ghost" @click="pidiendo = null">Cancelar</button>
                    <button type="submit" class="btn btn-primary">Enviar solicitud</button>
                </div>
            </form>
        </dialog>
        <DialogoModal
            :abierto="invitando !== null"
            titulo="Invitar a programar juntas"
            @cerrar="invitando = null"
            @enviar="enviarInvitacion"
        >
            <div v-if="invitando" class="campos">
                <p class="campo-ayuda">
                    {{ estado.carrera }} propone incluir el escenario de otra carrera en su horario.
                    Su coordinación tiene que aceptar.
                </p>
                <label class="campo">
                    <span class="campo-rotulo">Carrera</span>
                    <select v-model="invitando.invitada" class="campo-control">
                        <option v-for="c in carrerasAjenas" :key="c.codigo" :value="c.codigo">
                            {{ c.codigo }} — {{ c.nombre }}
                        </option>
                    </select>
                </label>
                <label class="campo">
                    <span class="campo-rotulo">Escenario suyo</span>
                    <input v-model="invitando.escenarioId" type="text" class="campo-control">
                    <span class="campo-ayuda">Normalmente «caso-base».</span>
                </label>
            </div>
        </DialogoModal>
    </div>
</template>
