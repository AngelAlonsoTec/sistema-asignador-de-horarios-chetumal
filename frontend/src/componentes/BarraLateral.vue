<script setup>
import { computed, ref } from "vue";
import { estado, cambiarCarrera, cerrarEscenario, irASeccion, coberturaActual, salir } from "../estado.js";
import LogoMarca from "./LogoMarca.vue";
import DialogoClave from "./DialogoClave.vue";

const cambiandoClave = ref(false);

defineProps({ secciones: { type: Array, required: true } });

const conteos = computed(() => {
    if (!estado.abierto) return {};
    const { docentes, materias, especialidades, aulas } = estado.abierto.datos;
    return {
        docentes: docentes.length,
        materias: materias.length,
        especialidades: especialidades.length,
        aulas: aulas.length,
        saturacion: null,
        // No cuentan nada: son listas que se consultan, no inventarios.
        "quien-imparte": null,
        ocupacion: null,
        // El de conciliación no cuenta cosas: avisa de lo que espera respuesta.
        conciliacion: estado.solicitudesPendientes || null,
        horario: null
    };
});

async function volver() {
    if (estado.sucio && !confirm("Hay cambios sin guardar. ¿Salir y descartarlos?")) return;
    cerrarEscenario();
}
</script>

<template>
    <aside class="lateral">
        <div class="lateral-marca">
            <LogoMarca :tamano="28" />
            <span class="marca-texto">Schedul<span class="marca-ia">AI</span></span>
        </div>

        <!-- Sin escenario abierto la barra elige carrera; con uno abierto, sección.
             Es el mismo espacio porque nunca hacen falta las dos a la vez. -->
        <template v-if="!estado.abierto">
            <p class="lateral-rotulo">Carrera</p>
            <nav class="lateral-nav">
                <button
                    v-for="carrera in estado.carreras"
                    :key="carrera"
                    class="lateral-item"
                    :class="{ 'is-activo': carrera === estado.carrera }"
                    @click="cambiarCarrera(carrera)"
                >
                    <span class="lateral-item-texto">{{ carrera }}</span>
                </button>
            </nav>
        </template>

        <template v-else>
            <button class="lateral-volver" @click="volver">
                <span aria-hidden="true">←</span> Todos los escenarios
            </button>

            <div class="lateral-escenario">
                <p class="lateral-escenario-nombre">{{ estado.abierto.nombre }}</p>
                <p class="lateral-escenario-meta">
                    {{ estado.carrera }}
                    <span v-if="estado.abierto.esBase" class="escenario-badge">Base</span>
                </p>
                <button
                    class="lateral-cobertura"
                    :class="coberturaActual.completa ? 'is-ok' : 'is-alerta'"
                    @click="irASeccion('materias', 'sin-docente')"
                >
                    <template v-if="coberturaActual.completa">
                        Cobertura completa
                    </template>
                    <template v-else>
                        {{ coberturaActual.sinDocente.length }} materias sin docente
                    </template>
                </button>
            </div>

            <p class="lateral-rotulo">Datos del escenario</p>
            <nav class="lateral-nav">
                <button
                    v-for="seccion in secciones"
                    :key="seccion.id"
                    class="lateral-item"
                    :class="{ 'is-activo': seccion.id === estado.seccion }"
                    @click="irASeccion(seccion.id)"
                >
                    <span class="lateral-item-texto">{{ seccion.etiqueta }}</span>
                    <span
                        v-if="conteos[seccion.id] != null"
                        class="lateral-item-conteo"
                        :class="{ 'is-aviso': seccion.id === 'conciliacion' }"
                    >{{ conteos[seccion.id] }}</span>
                </button>
            </nav>
        </template>

        <div class="lateral-pie">
            <div class="lateral-usuario">
                <div>
                    <span class="lateral-pie-linea lateral-usuario-nombre">
                        {{ estado.usuario?.nombre }}
                    </span>
                    <span class="lateral-pie-linea">
                        {{ estado.usuario?.carreras.join(" · ") || "sin carreras" }}
                    </span>
                </div>
                <div class="lateral-usuario-acciones">
                    <button type="button" class="btn btn-chico" @click="cambiandoClave = true">
                        Contraseña
                    </button>
                    <button type="button" class="btn btn-chico" @click="salir">Salir</button>
                </div>
            </div>
        </div>
    </aside>
    <DialogoClave :abierto="cambiandoClave" @cerrar="cambiandoClave = false" />
</template>
