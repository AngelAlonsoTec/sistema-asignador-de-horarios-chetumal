<script setup>
/**
 * Quién imparte cada clase de esta carrera, visto por el coordinador.
 *
 * Lo decide el departamento y aquí no se edita: se **lee** y, cuando no sirve,
 * se pide el cambio. Antes de esto el coordinador solo veía un número —"29 de
 * 41 clases sin docente asignado"— y para saber cuáles tenía que abrir una
 * pantalla que no es suya. Y si el docente asignado no le encajaba, el sistema
 * le decía que lo pidiera sin darle dónde.
 */
import { ref, computed, onMounted } from "vue";
import { estado } from "../../estado.js";
import { api } from "../../api.js";
import { contiene } from "../../dominio/texto.js";
import { alcanza } from "../../dominio/turnos.js";
import DialogoModal from "../DialogoModal.vue";

const catalogo = ref(null);
const peticiones = ref([]);
const docentes = ref([]);
const busca = ref("");
const cargando = ref(true);
const pidiendo = ref(null);

async function cargar() {
    cargando.value = true;
    try {
        [catalogo.value, peticiones.value, docentes.value] = await Promise.all([
            api.catalogoDe(estado.carrera).catch(() => null),
            api.cambios().catch(() => []),
            api.docentes().catch(() => [])
        ]);
    } finally {
        cargando.value = false;
    }
}
onMounted(cargar);

/** Las peticiones de esta carrera, por clase, para marcar la fila. */
const pendientePorClase = computed(() => {
    const mapa = new Map();
    for (const p of peticiones.value) {
        if (p.carrera !== estado.carrera || p.estado !== "pendiente") continue;
        mapa.set(`${p.materiaId}|${p.grupoClave}`, p);
    }
    return mapa;
});

/**
 * Las clases agrupadas por grupo, como se reparten. Es la misma forma que ve el
 * departamento: así los dos hablan de lo mismo cuando hay que discutirlo.
 */
const grupos = computed(() => {
    const visibles = (catalogo.value?.filas ?? []).filter((f) =>
        contiene(`${f.clave} ${f.nombre} ${f.docenteNombre ?? ""}`, busca.value)
    );
    const porGrupo = new Map();
    for (const f of visibles) {
        if (!porGrupo.has(f.grupoClave)) {
            porGrupo.set(f.grupoClave, { clave: f.grupoClave, turno: f.turno, filas: [] });
        }
        porGrupo.get(f.grupoClave).filas.push(f);
    }
    return [...porGrupo.values()].sort((a, b) => a.clave.localeCompare(b.clave));
});

const sinAsignar = computed(
    () => (catalogo.value?.filas ?? []).filter((f) => !f.docenteId).length
);

/**
 * Asignaciones que se quedaron sin clase: casi siempre porque esta misma
 * coordinación cerró un grupo o quitó una materia después de que el
 * departamento repartiera. Verlas es lo que permite avisar de que hay que
 * volver a repartir eso.
 */
const huerfanas = computed(() => catalogo.value?.huerfanas ?? []);
const total = computed(() => (catalogo.value?.filas ?? []).length);

/** Las peticiones de esta carrera, lo pendiente primero. */
const mias = computed(() =>
    peticiones.value
        .filter((p) => p.carrera === estado.carrera)
        .sort((a, b) => (a.estado === "pendiente" ? -1 : 1) - (b.estado === "pendiente" ? -1 : 1))
);

function abrirPeticion(fila) {
    pidiendo.value = {
        materiaId: fila.materiaId,
        grupoClave: fila.grupoClave,
        titulo: `${fila.clave} · ${fila.nombre}`,
        turno: fila.turno,
        horasSemana: fila.horasSemana,
        actual: fila.docenteNombre,
        propuesto: "",
        motivo: ""
    };
}

/** Si quien tiene la clase declaró horas en el turno de ese grupo. */
function alcanceDe(fila) {
    const d = docentes.value.find((x) => x.id === fila.docenteId);
    return d ? alcanza(d, fila.turno, fila.horasSemana) : { puede: true };
}

/**
 * Quién podría darla: los autorizados, y primero los que además declaran horas
 * en el turno del grupo. Proponer a alguien que no las tiene es proponer algo
 * que el horario no va a poder colocar.
 */
const candidatos = computed(() => {
    const p = pidiendo.value;
    if (!p) return [];
    return docentes.value
        .filter((d) => (d.materiasCapacitadas ?? []).includes(p.materiaId))
        .map((d) => ({ ...d, alcance: alcanza(d, p.turno, p.horasSemana) }))
        .sort(
            (a, b) => Number(b.alcance.puede) - Number(a.alcance.puede) || a.nombre.localeCompare(b.nombre)
        );
});

async function enviar() {
    estado.error = null;
    try {
        await api.pedirCambio({
            carrera: estado.carrera,
            materiaId: pidiendo.value.materiaId,
            grupoClave: pidiendo.value.grupoClave,
            propuesto: pidiendo.value.propuesto || null,
            motivo: pidiendo.value.motivo
        });
        pidiendo.value = null;
        await cargar();
    } catch (e) {
        estado.error = e.message;
    }
}

async function retirar(id) {
    estado.error = null;
    try {
        await api.retirarCambio(id);
        await cargar();
    } catch (e) {
        estado.error = e.message;
    }
}
</script>

<template>
    <div class="seccion-horario">
        <section class="tarjeta-panel">
            <header class="tarjeta-panel-cabeza">
                <div>
                    <h2 class="tarjeta-panel-titulo">Quién imparte cada clase</h2>
                    <p class="campo-ayuda">
                        Lo decide el departamento académico. Aquí se consulta y, si no encaja con
                        el horario que necesitas, se pide el cambio: lo que tú decides es cuándo
                        cae en la semana, no quién la da.
                    </p>
                </div>
                <input
                    v-model="busca"
                    type="search"
                    class="input-busqueda"
                    style="flex: 0 1 240px"
                    placeholder="Buscar materia o docente…"
                >
            </header>

            <div class="tarjeta-panel-cuerpo">
                <p v-if="cargando" class="estado-vacio">Cargando…</p>
                <p v-else-if="sinAsignar === 0 && total > 0" class="campo-ayuda">
                    Las {{ total }} clases tienen a alguien al frente.
                </p>
                <p v-else-if="total > 0" class="campo-ayuda">
                    <strong>{{ sinAsignar }} de {{ total }}</strong> clases todavía no tienen
                    docente asignado. El generador elegirá entre los autorizados; para fijar a
                    alguien hay que pedírselo al departamento.
                </p>

                <!-- Aparte de la cuenta anterior y no en su cadena: son dos
                     cosas distintas y pueden pasar a la vez. -->
                <p v-if="huerfanas.length" class="campo-ayuda">
                    <strong>{{ huerfanas.length }}</strong> asignaciones del departamento se
                    quedaron sin clase al cambiar la retícula o los grupos
                    ({{ huerfanas.map((h) => `${h.grupoClave} · ${h.docenteNombre}`).join(", ") }}).
                    No estorban: si esa clase vuelve a abrirse, vuelven con ella.
                </p>
            </div>

            <div v-if="catalogo" class="tarjeta-panel-cuerpo sin-relleno">
                <table class="tabla">
                    <thead>
                        <tr>
                            <th>Materia</th>
                            <th>Horas</th>
                            <th>La imparte</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody v-for="g in grupos" :key="g.clave">
                        <tr class="fila-grupo">
                            <th colspan="4">
                                Grupo {{ g.clave }} <span class="celda-tenue">{{ g.turno }}</span>
                            </th>
                        </tr>
                        <tr v-for="f in g.filas" :key="f.materiaId + f.grupoClave">
                            <td class="celda-principal">
                                {{ f.nombre }}
                                <span class="celda-tenue">{{ f.clave }}</span>
                            </td>
                            <td class="celda-tenue celda-numero">{{ f.horasSemana }}</td>
                            <td>
                                <div class="celda-marcas">
                                    <span v-if="f.docenteId" class="chip-carrera is-activo">
                                        {{ f.docenteNombre }}
                                    </span>
                                    <span v-else class="violacion is-blanda">la elige el generador</span>
                                    <span v-if="f.docenteId && !alcanceDe(f).puede" class="violacion is-dura">
                                        {{ alcanceDe(f).motivo }}
                                    </span>
                                    <span
                                        v-if="pendientePorClase.has(f.materiaId + '|' + f.grupoClave)"
                                        class="etiqueta-suave"
                                    >cambio pedido</span>
                                </div>
                            </td>
                            <td class="celda-acciones">
                                <button
                                    type="button"
                                    class="btn btn-chico"
                                    :disabled="pendientePorClase.has(f.materiaId + '|' + f.grupoClave)"
                                    @click="abrirPeticion(f)"
                                >Pedir cambio</button>
                            </td>
                        </tr>
                    </tbody>
                    <tbody v-if="grupos.length === 0 && !cargando">
                        <tr><td class="celda-tenue" colspan="4">Ninguna clase coincide.</td></tr>
                    </tbody>
                </table>
            </div>
        </section>

        <section v-if="mias.length" class="tarjeta-panel">
            <header class="tarjeta-panel-cabeza">
                <h2 class="tarjeta-panel-titulo">Lo que le has pedido al departamento</h2>
            </header>
            <div class="tarjeta-panel-cuerpo sin-relleno">
                <table class="tabla">
                    <tbody>
                        <tr v-for="p in mias" :key="p.id">
                            <td class="celda-principal">
                                {{ p.materia }}
                                <span class="celda-tenue">grupo {{ p.grupoClave }}</span>
                            </td>
                            <td class="celda-tenue">{{ p.motivo }}</td>
                            <td>
                                <span v-if="p.estado === 'pendiente'" class="etiqueta-suave">esperando</span>
                                <span v-else-if="p.estado === 'aceptada'" class="chip-carrera is-activo">
                                    aceptada · {{ p.propuestoNombre ?? "ya no está en la plantilla" }}
                                </span>
                                <span v-else class="violacion is-blanda">no</span>
                                <span v-if="p.respuesta" class="celda-tenue"> · {{ p.respuesta }}</span>
                            </td>
                            <td class="celda-acciones">
                                <button
                                    v-if="p.estado === 'pendiente'"
                                    type="button"
                                    class="btn btn-chico"
                                    @click="retirar(p.id)"
                                >Retirar</button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>

        <DialogoModal
            :abierto="pidiendo !== null"
            :titulo="pidiendo ? `Pedir otro docente para ${pidiendo.titulo}` : ''"
            @cerrar="pidiendo = null"
            @enviar="enviar"
        >
            <div v-if="pidiendo" class="campos">
                <p class="campo-ayuda">
                    Grupo {{ pidiendo.grupoClave }}.
                    <template v-if="pidiendo.actual">La imparte {{ pidiendo.actual }}.</template>
                    <template v-else>Todavía no tiene a nadie asignado.</template>
                    Lo resuelve el departamento académico; aquí queda el registro de qué pediste y
                    por qué.
                </p>
                <label class="campo">
                    <span class="campo-rotulo">Motivo</span>
                    <textarea
                        v-model="pidiendo.motivo"
                        class="campo-control"
                        rows="3"
                        placeholder="Por ejemplo: sus horas libres no coinciden con las del grupo."
                    ></textarea>
                    <span class="campo-ayuda">Es lo que el departamento va a leer para decidir.</span>
                </label>
                <label class="campo">
                    <span class="campo-rotulo">A quién propones (opcional)</span>
                    <select v-model="pidiendo.propuesto" class="campo-control">
                        <option value="">Que lo decida el departamento</option>
                        <option v-for="d in candidatos" :key="d.id" :value="d.id">
                            {{ d.nombre }}<template v-if="!d.alcance.puede"> — {{ d.alcance.motivo }}</template>
                        </option>
                    </select>
                    <span class="campo-ayuda">
                        Solo salen quienes están autorizados para esa materia. Aceptar sin propuesta
                        obliga al departamento a decir a quién se la da.
                    </span>
                </label>
            </div>
        </DialogoModal>
    </div>
</template>
