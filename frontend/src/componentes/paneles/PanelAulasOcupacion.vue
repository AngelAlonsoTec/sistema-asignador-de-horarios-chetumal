<script setup>
/**
 * Ocupación de las aulas: la misma hoja, para el otro recurso compartido.
 *
 * Los docentes tenían la suya desde hace semanas y las aulas no, aunque son
 * igual de compartidas: la que ocupa 1A por la mañana la quiere otro grupo por
 * la tarde. El dato ya viajaba al motor —por eso sabe marcar
 * `aulaOcupadaPorOtros`— pero solo se veía como violación **después** de
 * generar, que es tarde: para entonces ya hay que rehacer el horario.
 *
 * Un aula no declara disponibilidad: existe todo el día hábil. Así que aquí no
 * hay gris de "no la ofreció"; lo que distingue una hora tomada es **quién** la
 * tiene, porque la propia se mueve y la ajena se negocia.
 */
import { ref, computed, onMounted } from "vue";
import { contiene } from "../../dominio/texto.js";
import { estado, solicitarHoras } from "../../estado.js";
import { api } from "../../api.js";
import DialogoModal from "../DialogoModal.vue";

const datos = ref(null);
const elegida = ref(null);
const busqueda = ref("");
const soloConHuecos = ref(false);

async function cargar() {
    datos.value = await api
        .ocupacionDeAulas({ paridad: estado.filtroPendiente ?? undefined })
        .catch(() => null);
    elegida.value ??= datos.value?.hojas[0]?.aulaId ?? null;
}
onMounted(cargar);

const hojas = computed(() => {
    const todas = datos.value?.hojas ?? [];
    return todas.filter(
        (h) =>
            contiene(`${h.clave} ${h.tipo}`, busqueda.value) &&
            (!soloConHuecos.value || h.resumen.libres > 0)
    );
});

const hoja = computed(() => datos.value?.hojas.find((h) => h.aulaId === elegida.value));

/** La respuesta viene por día; la rejilla se lee mejor con las horas en filas. */
const filas = computed(() => {
    if (!hoja.value) return [];
    const total = hoja.value.dias[0]?.horas.length ?? 0;
    return Array.from({ length: total }, (_, i) => ({
        hora: hoja.value.horaBase + i,
        celdas: hoja.value.dias.map((d) => d.horas[i])
    }));
});

const totales = computed(() => {
    const todas = datos.value?.hojas ?? [];
    return {
        aulas: todas.length,
        ocupadas: todas.reduce((s, h) => s + h.resumen.ocupadas, 0),
        libres: todas.reduce((s, h) => s + h.resumen.libres, 0),
        // Las que nadie ha tocado: son el margen real que queda en el plantel.
        vacias: todas.filter((h) => h.resumen.ocupadas === 0).length
    };
});

/**
 * Propia y ajena se pintan distinto a propósito: la propia se mueve cambiando
 * el horario, la ajena exige hablar con otra coordinación.
 */
function claseDe(celda) {
    if (celda.estado !== "ocupada") return "celda-libre";
    return celda.propia ? "celda-ocupada" : "celda-ocupada is-ajena";
}

function tituloDe(celda) {
    if (celda.estado !== "ocupada") return "Libre";
    const de = celda.propia ? "tuya" : "de otra coordinación";
    return `${celda.carrera} · ${celda.grupo} · ${celda.materia} (${de})`;
}

const comoHora = (h) => `${String(h).padStart(2, "0")}:00`;

/**
 * Pedir un salón que tiene otra coordinación.
 *
 * Con los docentes el choque se detecta solo —dos carreras pueden pretender la
 * misma hora y queda en disputa—; con un aula ocupada el motor simplemente no
 * la usa, así que nadie choca y nadie se entera. Aquí es donde se ve que el
 * salón que hace falta lo tiene otro, y por eso es desde donde se pide.
 */
const pidiendo = ref(null);

function pedir(celda, hora) {
    if (celda.estado !== "ocupada" || celda.propia) return;
    pidiendo.value = {
        aulaId: hoja.value.aulaId,
        clave: hoja.value.clave,
        dia: diaDe(celda),
        inicio: hora,
        fin: hora + 1,
        carrera: celda.carrera,
        escenarioId: celda.escenarioId,
        grupo: celda.grupo,
        materia: celda.materia,
        motivo: ""
    };
}

/** De qué día es una celda: la rejilla se dibuja por horas, no por días. */
function diaDe(celda) {
    for (const d of hoja.value?.dias ?? []) {
        if (d.horas.includes(celda)) return d.dia;
    }
    return null;
}

async function enviarPeticion() {
    const p = pidiendo.value;
    if (!p.motivo.trim()) {
        estado.error = "Hace falta un motivo: es lo que va a leer la otra coordinación.";
        return;
    }
    const hecho = await solicitarHoras({
        de: { carrera: estado.carrera, escenarioId: estado.abierto.id },
        a: { carrera: p.carrera, escenarioId: p.escenarioId },
        aulaId: p.aulaId,
        dia: p.dia,
        inicio: Number(p.inicio),
        fin: Number(p.fin),
        motivo: p.motivo.trim()
    });
    if (hecho) {
        pidiendo.value = null;
        await cargar();
    }
}
</script>

<template>
    <div class="seccion-horario">
        <p class="panel-nota">
            Las aulas son del plantel, como los docentes: una hora tomada por otra carrera no está
            disponible aquí. Mirarlo antes de generar evita descubrirlo como choque después.
        </p>

        <p v-if="!datos" class="estado-vacio">Cargando la ocupación…</p>

        <template v-else>
            <div class="cifras">
                <div class="cifra">
                    <p class="cifra-rotulo">Espacios</p>
                    <p class="cifra-valor">{{ totales.aulas }}</p>
                </div>
                <div class="cifra">
                    <p class="cifra-rotulo">Horas tomadas</p>
                    <p class="cifra-valor">{{ totales.ocupadas }}</p>
                    <p class="cifra-nota">por todas las carreras</p>
                </div>
                <div class="cifra">
                    <p class="cifra-rotulo">Horas libres</p>
                    <p class="cifra-valor">{{ totales.libres }}</p>
                </div>
                <div class="cifra">
                    <p class="cifra-rotulo">Sin tocar</p>
                    <p class="cifra-valor">{{ totales.vacias }}</p>
                    <p class="cifra-nota">espacios que nadie usa</p>
                </div>
            </div>

            <section class="tarjeta-panel" style="margin-top: 24px">
                <header class="tarjeta-panel-cabeza">
                    <h2 class="tarjeta-panel-titulo">Espacio</h2>
                    <div class="tarjeta-panel-acciones">
                        <label class="franja-evitar">
                            <input v-model="soloConHuecos" type="checkbox">
                            <span>solo con horas libres</span>
                        </label>
                        <input
                            v-model="busqueda"
                            type="search"
                            class="input-busqueda"
                            style="flex: 0 1 260px"
                            placeholder="Buscar espacio…"
                            aria-label="Buscar espacio"
                        >
                    </div>
                </header>

                <div class="tarjeta-panel-cuerpo">
                    <div class="selector-grupos">
                        <button
                            v-for="h in hojas"
                            :key="h.aulaId"
                            type="button"
                            class="grupo-pastilla pastilla-docente"
                            :class="{ 'is-activo': h.aulaId === elegida }"
                            @click="elegida = h.aulaId"
                        >
                            <span class="grupo-pastilla-clave">{{ h.clave }}</span>
                            <span class="grupo-pastilla-turno">
                                {{ h.resumen.libres }} libres · {{ h.resumen.ocupadas }} tomadas
                            </span>
                        </button>
                    </div>
                    <p v-if="hojas.length === 0" class="estado-vacio">Ningún espacio coincide.</p>
                </div>
            </section>

            <section v-if="hoja" class="tarjeta-panel">
                <header class="tarjeta-panel-cabeza">
                    <div>
                        <h2 class="tarjeta-panel-titulo">
                            {{ hoja.clave }}
                            <span class="celda-tenue">
                                {{ hoja.tipo === "laboratorio" ? "laboratorio" : "aula" }}
                            </span>
                        </h2>
                        <p class="campo-ayuda">
                            {{ hoja.capacidad ? `${hoja.capacidad} alumnos · ` : "sin cupo registrado · " }}
                            {{ hoja.resumen.ocupadas }} de {{ hoja.resumen.hábiles }} horas tomadas ·
                            <strong>{{ hoja.resumen.libres }} libres</strong>
                            <template v-if="hoja.resumen.carreras.length">
                                · la usan {{ hoja.resumen.carreras.join(", ") }}
                            </template>
                        </p>
                    </div>
                    <div class="leyenda">
                        <span class="leyenda-item">
                            <span class="leyenda-muestra leyenda-saturacion celda-libre"></span>
                            Libre
                        </span>
                        <span class="leyenda-item">
                            <span class="leyenda-muestra leyenda-saturacion celda-ocupada"></span>
                            Tuya
                        </span>
                        <span class="leyenda-item">
                            <span class="leyenda-muestra leyenda-saturacion celda-ocupada is-ajena"></span>
                            De otra carrera
                        </span>
                        <span class="leyenda-item celda-tenue">pulsa una ajena para pedirla</span>
                    </div>
                </header>

                <div class="rejilla-envoltura">
                    <table class="rejilla rejilla-saturacion">
                        <thead>
                            <tr>
                                <th class="rejilla-hora">Hora</th>
                                <th v-for="d in hoja.dias" :key="d.dia">{{ d.dia }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="fila in filas" :key="fila.hora">
                                <th class="rejilla-hora">{{ comoHora(fila.hora) }}</th>
                                <td
                                    v-for="(celda, i) in fila.celdas"
                                    :key="i"
                                    :class="[claseDe(celda), { 'is-pedible': celda.estado === 'ocupada' && !celda.propia }]"
                                    :title="celda.estado === 'ocupada' && !celda.propia
                                        ? `${tituloDe(celda)} — pulsa para pedirla`
                                        : tituloDe(celda)"
                                    @click="pedir(celda, fila.hora)"
                                >
                                    <template v-if="celda.estado === 'ocupada'">
                                        <span class="celda-carrera">{{ celda.carrera }}</span>
                                        <span class="celda-detalle">{{ celda.grupo }}</span>
                                    </template>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>
        </template>

        <DialogoModal
            :abierto="pidiendo !== null"
            :titulo="pidiendo ? `Pedir el aula ${pidiendo.clave}` : ''"
            @cerrar="pidiendo = null"
            @enviar="enviarPeticion"
        >
            <div v-if="pidiendo" class="campos">
                <p class="campo-ayuda">
                    {{ pidiendo.carrera }} la tiene el {{ pidiendo.dia }} para {{ pidiendo.grupo }}
                    ({{ pidiendo.materia }}). Si cede, esas horas se sueltan de su reserva y quedan
                    libres para ti; queda registrado quién pidió qué y qué contestaron.
                </p>
                <div class="campo-fila">
                    <label class="campo">
                        <span class="campo-rotulo">Desde</span>
                        <input v-model.number="pidiendo.inicio" type="number" min="0" max="23" class="campo-control">
                    </label>
                    <label class="campo">
                        <span class="campo-rotulo">Hasta</span>
                        <input v-model.number="pidiendo.fin" type="number" min="1" max="24" class="campo-control">
                    </label>
                </div>
                <label class="campo">
                    <span class="campo-rotulo">Motivo</span>
                    <textarea v-model="pidiendo.motivo" class="campo-control" rows="3"
                        placeholder="Por ejemplo: es el único salón con cupo para 1A a esa hora."></textarea>
                </label>
            </div>
        </DialogoModal>
    </div>
</template>
