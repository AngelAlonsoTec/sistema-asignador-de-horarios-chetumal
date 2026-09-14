<script setup>
import { computed, ref, onMounted } from "vue";
import { estado, comprobarSesion } from "./estado.js";
import BarraLateral from "./componentes/BarraLateral.vue";
import CabeceraApp from "./componentes/CabeceraApp.vue";
import ListaEscenarios from "./vistas/ListaEscenarios.vue";
import InicioSesion from "./vistas/InicioSesion.vue";
import CambioObligado from "./vistas/CambioObligado.vue";
import FormularioDocente from "./vistas/FormularioDocente.vue";
import VistaDepartamento from "./vistas/VistaDepartamento.vue";
import PanelDocentes from "./componentes/paneles/PanelDocentes.vue";
import PanelMaterias from "./componentes/paneles/PanelMaterias.vue";
import PanelEspecialidades from "./componentes/paneles/PanelEspecialidades.vue";
import PanelAulas from "./componentes/paneles/PanelAulas.vue";
import PanelHorario from "./componentes/paneles/PanelHorario.vue";
import PanelSaturacion from "./componentes/paneles/PanelSaturacion.vue";
import PanelAulasOcupacion from "./componentes/paneles/PanelAulasOcupacion.vue";
import PanelConciliacion from "./componentes/paneles/PanelConciliacion.vue";
import PanelQuienImparte from "./componentes/paneles/PanelQuienImparte.vue";

const SECCIONES = [
    {
        id: "docentes",
        etiqueta: "Docentes",
        panel: PanelDocentes,
        // Sin alta: la plantilla es del instituto y la administra el
        // departamento. Aquí se lee para poder generar y para pedir cambios.
        agregar: null,
        subtitulo: "Plantilla del instituto: carga permitida y qué puede impartir cada quien."
    },
    {
        id: "materias",
        etiqueta: "Materias",
        panel: PanelMaterias,
        agregar: "Agregar materia",
        subtitulo: "Retícula del escenario, agrupada por semestre y especialidad."
    },
    {
        id: "especialidades",
        etiqueta: "Especialidades",
        panel: PanelEspecialidades,
        agregar: "Agregar especialidad",
        subtitulo: "Módulos que la retícula cambia cada pocos años."
    },
    {
        id: "aulas",
        etiqueta: "Aulas y laboratorios",
        panel: PanelAulas,
        // Sin alta, como los docentes: los espacios son del plantel y editarlos
        // desde una carrera reemplazaba la lista entera. El botón seguía ahí
        // aunque el panel ya no expone `agregar`, así que no hacía nada.
        agregar: null,
        subtitulo: "Espacios del plantel. Los administra el departamento; aquí se consultan."
    },
    {
        id: "saturacion",
        etiqueta: "Saturación docente",
        panel: PanelSaturacion,
        agregar: null,
        subtitulo:
            "Horas catedrático del instituto: qué declaró cada docente y qué carrera ya las apartó."
    },
    {
        id: "ocupacion",
        etiqueta: "Ocupación de aulas",
        panel: PanelAulasOcupacion,
        agregar: null,
        subtitulo:
            "Qué carrera tiene tomada cada hora de cada espacio, antes de colocar nada."
    },
    {
        id: "quien-imparte",
        etiqueta: "Quién imparte qué",
        panel: PanelQuienImparte,
        agregar: null,
        subtitulo:
            "Lo que el departamento repartió para esta carrera, y dónde pedir un cambio."
    },
    {
        id: "conciliacion",
        etiqueta: "Conciliación",
        panel: PanelConciliacion,
        agregar: null,
        subtitulo: "Choques con otras carreras y peticiones de horas entre coordinaciones."
    },
    {
        // El horario no da de alta nada: se genera.
        id: "horario",
        etiqueta: "Generar horario",
        panel: PanelHorario,
        agregar: null,
        subtitulo: "Propuesta del motor genético, para revisar antes de aplicarla."
    }
];

/** Referencia al panel activo, para dispararle el alta desde la cabecera. */
const panel = ref(null);

/**
 * El enlace del docente llega como `?disponibilidad=TOKEN`. Es otra aplicación
 * en la práctica: sin sesión, sin barra lateral y sin acceso a nada más.
 */
const tokenDocente = new URLSearchParams(window.location.search).get("disponibilidad");

const seccionActiva = computed(() => SECCIONES.find((s) => s.id === estado.seccion) ?? SECCIONES[0]);

const cabecera = computed(() => {
    if (!estado.abierto) {
        return {
            titulo: `Escenarios de ${estado.carrera}`,
            subtitulo: "Variantes de los datos de la carrera para probar cambios antes de aplicarlos.",
            agregar: null
        };
    }
    return {
        titulo: seccionActiva.value.etiqueta,
        subtitulo: seccionActiva.value.subtitulo,
        agregar: seccionActiva.value.agregar
    };
});

onMounted(() => {
    if (!tokenDocente) comprobarSesion();
});

// Aviso del navegador al cerrar con cambios sin guardar: el escenario vive en
// memoria hasta que se guarda, así que recargar los pierde de verdad.
window.addEventListener("beforeunload", (evento) => {
    if (estado.sucio) evento.preventDefault();
});
</script>

<template>
    <FormularioDocente v-if="tokenDocente" :token="tokenDocente" />

    <p v-else-if="estado.comprobandoSesion" class="estado-vacio">Comprobando la sesión…</p>

    <InicioSesion v-else-if="!estado.usuario" />

    <!-- Con la contraseña de arranque puesta, la cuenta todavía la controla
         quien la dictó. No se entra a nada hasta cambiarla; el backend rechaza
         igual el resto de rutas, así que esto es la puerta, no la cerradura. -->
    <CambioObligado v-else-if="estado.usuario.debeCambiarClave" />

    <!-- El departamento académico hace otro trabajo: no arma horarios. -->
    <VistaDepartamento v-else-if="estado.usuario.rol === 'departamento'" />

    <div v-else class="app">
        <BarraLateral :secciones="SECCIONES" />

        <div class="principal">
            <CabeceraApp
                :titulo="cabecera.titulo"
                :subtitulo="cabecera.subtitulo"
                :agregar="cabecera.agregar"
                @agregar="panel?.agregar()"
            >
                <template v-if="!estado.abierto" #acciones>
                    <button class="btn btn-primary" @click="$refs.lista?.crear()">
                        Nuevo escenario
                    </button>
                </template>
            </CabeceraApp>

            <p v-if="estado.error" class="banda banda-error" role="alert">
                <span>{{ estado.error }}</span>
                <button type="button" class="banda-cerrar" aria-label="Cerrar" @click="estado.error = null">
                    ×
                </button>
            </p>
            <p v-if="estado.aviso" class="banda banda-ok" role="status">{{ estado.aviso }}</p>

            <div class="contenido">
                <ListaEscenarios v-if="!estado.abierto" ref="lista" />
                <!-- `key` recrea el panel al cambiar de sección, para que cada
                     uno arranque con su búsqueda y sus filtros limpios. -->
                <component
                    v-else
                    :is="seccionActiva.panel"
                    :key="estado.seccion"
                    ref="panel"
                    :filtro-inicial="estado.filtroPendiente"
                />
            </div>
        </div>
    </div>
</template>
