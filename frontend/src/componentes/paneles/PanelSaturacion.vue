<script setup>
/**
 * La hoja de saturación de horas catedrático.
 *
 * Es el documento que hoy viaja en Excel entre coordinaciones, con la diferencia
 * de que aquí cada celda dice quién la tomó. Los espacios libres son el gris de
 * esa hoja: las horas que el docente declaró y nadie ha apartado todavía.
 *
 * La plantilla es institucional, así que esta pantalla muestra horas que otras
 * carreras pretenden y que este coordinador no puede tocar.
 */
import { ref, computed, onMounted, watch } from "vue";
import { contiene } from "../../dominio/texto.js";
import { estado, verSaturacion } from "../../estado.js";
import { api } from "../../api.js";

const ESTADOS = {
    no_declarada: { etiqueta: "No la declaró", clase: "celda-no-declarada" },
    descarga: { etiqueta: "Descarga administrativa", clase: "celda-descarga" },
    libre: { etiqueta: "Libre", clase: "celda-libre" },
    ocupada: { etiqueta: "Apartada", clase: "celda-ocupada" }
};

const datos = ref(null);
const elegido = ref(null);
const busqueda = ref("");
const historial = ref([]);

async function cargar() {
    const r = await verSaturacion({ paridad: estado.filtroPendiente ?? undefined });
    if (!r) return;
    datos.value = r;
    elegido.value ??= r.hojas[0]?.docenteId ?? null;
}

onMounted(cargar);

const hojas = computed(() => {
    const aguja = busqueda.value.trim();
    const todas = datos.value?.hojas ?? [];
    return todas.filter((h) => contiene(h.nombre, aguja));
});

const hoja = computed(() => datos.value?.hojas.find((h) => h.docenteId === elegido.value));

/**
 * La rejilla dice quién tiene cada hora ahora. El historial dice quién la tuvo
 * antes, que es lo que hace falta cuando dos coordinadores recuerdan distinto.
 */
watch(elegido, async (id) => {
    historial.value = id ? await api.historialSaturacion({ docenteId: id, limite: 25 }).catch(() => []) : [];
}, { immediate: true });

const ACCIONES = {
    apartada: { etiqueta: "apartó", clase: "is-blanda" },
    liberada: { etiqueta: "soltó", clase: "is-blanda" },
    cedida: { etiqueta: "cedió", clase: "is-dura" }
};

function cuando(iso) {
    return new Date(iso).toLocaleString("es-MX", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
    });
}

/** La respuesta viene por día; la rejilla se lee mejor con las horas en filas. */
const filas = computed(() => {
    if (!hoja.value) return [];
    const total = hoja.value.dias[0]?.horas.length ?? 0;
    return Array.from({ length: total }, (_, i) => ({
        hora: hoja.value.horaBase + i,
        celdas: hoja.value.dias.map((d) => d.horas[i])
    }));
});

const totalOcupadas = computed(() =>
    (datos.value?.hojas ?? []).reduce((suma, h) => suma + h.resumen.ocupadas, 0)
);

function claseDe(celda) {
    const base = ESTADOS[celda.estado]?.clase ?? "";
    return celda.estado === "libre" && celda.evitada ? `${base} is-evitada` : base;
}

function tituloDe(celda) {
    if (celda.estado === "descarga") return `Descarga: ${celda.motivo}`;
    if (celda.estado === "ocupada") {
        return `${celda.carrera} · ${celda.grupo} · ${celda.materia}`;
    }
    if (celda.estado === "libre" && celda.evitada) return "Libre, pero pidió evitarla";
    return ESTADOS[celda.estado]?.etiqueta ?? "";
}

function comoHora(h) {
    return `${String(h).padStart(2, "0")}:00`;
}
</script>

<template>
    <div class="seccion-horario">
        <p class="panel-nota">
            La plantilla docente es del instituto: estas horas se comparten con las demás carreras.
            Lo que aparezca apartado por otra carrera no está disponible aquí.
        </p>

        <p v-if="!datos" class="estado-vacio">Cargando la hoja…</p>

        <template v-else>
            <div class="cifras">
                <div class="cifra">
                    <p class="cifra-rotulo">Docentes</p>
                    <p class="cifra-valor">{{ datos.hojas.length }}</p>
                </div>
                <div class="cifra">
                    <p class="cifra-rotulo">Horas apartadas</p>
                    <p class="cifra-valor">{{ totalOcupadas }}</p>
                    <p class="cifra-nota">en todo el instituto</p>
                </div>
                <div class="cifra">
                    <p class="cifra-rotulo">Horas libres</p>
                    <p class="cifra-valor">
                        {{ datos.hojas.reduce((s, h) => s + h.resumen.libres, 0) }}
                    </p>
                    <p class="cifra-nota">el gris de la hoja</p>
                </div>
            </div>

            <section class="tarjeta-panel" style="margin-top: 24px">
                <header class="tarjeta-panel-cabeza">
                    <h2 class="tarjeta-panel-titulo">Docente</h2>
                    <input
                        v-model="busqueda"
                        type="search"
                        class="input-busqueda"
                        style="flex: 0 1 320px"
                        placeholder="Buscar docente…"
                        aria-label="Buscar docente"
                    >
                </header>

                <div class="tarjeta-panel-cuerpo">
                    <div class="selector-grupos">
                        <button
                            v-for="h in hojas"
                            :key="h.docenteId"
                            type="button"
                            class="grupo-pastilla pastilla-docente"
                            :class="{ 'is-activo': h.docenteId === elegido }"
                            @click="elegido = h.docenteId"
                        >
                            <span class="grupo-pastilla-clave">{{ h.nombre }}</span>
                            <span class="grupo-pastilla-turno">
                                {{ h.resumen.libres }} libres · {{ h.resumen.ocupadas }} apartadas
                            </span>
                        </button>
                    </div>
                </div>
            </section>

            <section v-if="hoja" class="tarjeta-panel">
                <header class="tarjeta-panel-cabeza">
                    <div>
                        <h2 class="tarjeta-panel-titulo">{{ hoja.nombre }}</h2>
                        <p class="campo-ayuda">
                            {{ hoja.resumen.declaradas }} h declaradas ·
                            {{ hoja.resumen.descarga }} de descarga ·
                            {{ hoja.resumen.ocupadas }} apartadas ·
                            <strong>{{ hoja.resumen.libres }} libres</strong>
                        </p>
                    </div>
                    <div class="leyenda">
                        <span v-for="(e, clave) in ESTADOS" :key="clave" class="leyenda-item">
                            <span class="leyenda-muestra leyenda-saturacion" :class="e.clase"></span>
                            {{ e.etiqueta }}
                        </span>
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
                                    :class="claseDe(celda)"
                                    :title="tituloDe(celda)"
                                >
                                    <template v-if="celda.estado === 'ocupada'">
                                        <span class="celda-carrera">{{ celda.carrera }}</span>
                                        <span class="celda-detalle">{{ celda.grupo }}</span>
                                    </template>
                                    <span v-else-if="celda.estado === 'descarga'" class="celda-detalle">
                                        {{ celda.motivo }}
                                    </span>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            <section v-if="hoja" class="tarjeta-panel">
                <header class="tarjeta-panel-cabeza">
                    <div>
                        <h2 class="tarjeta-panel-titulo">Qué ha pasado con estas horas</h2>
                        <p class="campo-ayuda">
                            Lo más reciente primero. Sirve para resolver el "yo tenía esa hora".
                        </p>
                    </div>
                </header>
                <div class="tarjeta-panel-cuerpo">
                    <p v-if="historial.length === 0" class="estado-vacio">
                        Nadie ha apartado ni soltado horas de este docente todavía.
                    </p>
                    <ul v-else class="lista-historial">
                        <li v-for="(h, i) in historial" :key="i">
                            <span class="historial-momento">{{ cuando(h.momento) }}</span>
                            <span class="violacion" :class="ACCIONES[h.accion].clase">
                                {{ h.carrera }} {{ ACCIONES[h.accion].etiqueta }}
                            </span>
                            <span>
                                {{ h.dia }} {{ comoHora(h.inicio) }}–{{ comoHora(h.fin) }}
                                <span v-if="h.grupoClave" class="celda-tenue">
                                    · {{ h.grupoClave }} / {{ h.materiaClave }}
                                </span>
                            </span>
                            <span v-if="h.nota" class="historial-nota">{{ h.nota }}</span>
                        </li>
                    </ul>
                </div>
            </section>
        </template>
    </div>
</template>
