<script setup>
import { ref, computed } from "vue";
import { estado, abrirEscenario, crearEscenario, eliminarEscenario, marcarBase } from "../estado.js";
import MenuAcciones from "../componentes/MenuAcciones.vue";
import DialogoModal from "../componentes/DialogoModal.vue";

const creando = ref(false);
const nombre = ref("");
const basadoEn = ref("");
const errorForm = ref(null);

const candidatos = computed(() => estado.escenarios.filter((escenario) => !escenario.roto));

function crear() {
    nombre.value = "";
    // Preseleccionar el caso base: partir de cero casi nunca es lo que se
    // quiere, porque implicaría capturar la retícula completa a mano.
    basadoEn.value = candidatos.value.find((escenario) => escenario.esBase)?.id ?? "";
    errorForm.value = null;
    creando.value = true;
}

async function confirmarCreacion() {
    if (!nombre.value.trim()) {
        errorForm.value = "El nombre es obligatorio.";
        return;
    }
    errorForm.value = null;
    const meta = await crearEscenario({ nombre: nombre.value, basadoEn: basadoEn.value || null });
    if (meta) creando.value = false;
    else errorForm.value = estado.error;
}

function alElegir(escenario, accion) {
    if (accion === "base") return confirmarBase(escenario);
    return confirmarBorrado(escenario);
}

/**
 * Se pregunta porque no es un cambio de etiqueta: el departamento reparte
 * contra el base, así que mover la marca mueve también el catálogo que ve.
 */
async function confirmarBase(escenario) {
    const texto =
        `"${escenario.nombre}" pasaría a ser el escenario base de ${estado.carrera}. ` +
        "El departamento reparte los docentes contra él: su catálogo pasará a mostrar " +
        "los grupos y las materias de este escenario. ¿Seguir?";
    if (!window.confirm(texto)) return;
    await marcarBase(escenario.id);
}

async function confirmarBorrado(escenario) {
    const mensaje =
        `¿Eliminar el escenario "${escenario.nombre}"?\n\n` +
        "Se borran sus materias, docentes y especialidades. Esta acción no se puede deshacer.";
    if (confirm(mensaje)) await eliminarEscenario(escenario.id);
}

function porcentaje(cobertura) {
    return cobertura.total === 0 ? 0 : Math.round((cobertura.cubiertas / cobertura.total) * 100);
}

defineExpose({ crear });
</script>

<template>
    <p v-if="estado.cargando && estado.escenarios.length === 0" class="estado-vacio">Cargando…</p>

    <div v-else-if="estado.escenarios.length === 0" class="estado-vacio-grande">
        <p class="estado-vacio-titulo">Esta carrera no tiene escenarios</p>
        <p>Crea el primero para empezar a capturar la retícula y la plantilla docente.</p>
        <button class="btn btn-primary" @click="crear">Nuevo escenario</button>
    </div>

    <ul v-else class="tarjetas">
        <li v-for="escenario in estado.escenarios" :key="escenario.id" class="tarjeta">
            <header class="tarjeta-cabeza">
                <div class="tarjeta-identidad">
                    <h2 class="tarjeta-nombre">{{ escenario.nombre }}</h2>
                    <!-- No es una etiqueta decorativa: el departamento reparte
                         los docentes contra el escenario base, así que cuál lo
                         sea decide también sobre qué grupos se reparte. -->
                    <span v-if="escenario.esBase" class="escenario-badge" title="El que va a producción">
                        Base
                    </span>
                </div>
                <MenuAcciones
                    v-if="!escenario.esBase"
                    :acciones="[
                        { id: 'base', etiqueta: 'Marcar como base' },
                        { id: 'eliminar', etiqueta: 'Eliminar escenario', peligro: true }
                    ]"
                    @elegir="alElegir(escenario, $event)"
                />
            </header>

            <p class="tarjeta-fecha">Actualizado el {{ escenario.fecha }}</p>

            <p v-if="escenario.roto" class="tarjeta-roto">
                Los archivos de este escenario no se encontraron en disco.
            </p>

            <template v-else>
                <dl class="tarjeta-cifras">
                    <div>
                        <dt>Materias</dt>
                        <dd>{{ escenario.conteo.materias }}</dd>
                    </div>
                    <div>
                        <dt>Docentes</dt>
                        <dd>{{ escenario.conteo.docentes }}</dd>
                    </div>
                    <div>
                        <dt>Especialidades</dt>
                        <dd>{{ escenario.conteo.especialidades }}</dd>
                    </div>
                </dl>

                <!-- Una barra y no solo un número: la proporción de materias
                     cubiertas se lee de un vistazo y se compara entre tarjetas. -->
                <div class="tarjeta-cobertura">
                    <div class="cobertura-encabezado">
                        <span>Cobertura docente</span>
                        <span :class="escenario.cobertura.completa ? 'texto-ok' : 'texto-alerta'">
                            {{ escenario.cobertura.cubiertas }}/{{ escenario.cobertura.total }}
                        </span>
                    </div>
                    <div class="cobertura-barra">
                        <span
                            class="cobertura-relleno"
                            :class="escenario.cobertura.completa ? 'is-ok' : 'is-alerta'"
                            :style="{ width: `${porcentaje(escenario.cobertura)}%` }"
                        ></span>
                    </div>
                    <p v-if="!escenario.cobertura.completa" class="cobertura-detalle">
                        {{ escenario.cobertura.sinDocente.length }} materias sin ningún docente capacitado
                    </p>
                </div>
            </template>

            <footer class="tarjeta-pie">
                <button class="btn btn-info" :disabled="escenario.roto" @click="abrirEscenario(escenario.id)">
                    Abrir escenario
                </button>
            </footer>
        </li>
    </ul>

    <DialogoModal
        :abierto="creando"
        titulo="Nuevo escenario"
        @cerrar="creando = false"
        @enviar="confirmarCreacion"
    >
        <label class="campo">
            <span>Nombre</span>
            <input v-model="nombre" type="text" placeholder="Ej. Especialidad IA 2027" required>
        </label>
        <label class="campo">
            <span>Basado en</span>
            <select v-model="basadoEn">
                <option value="">Sin caso base (vacío)</option>
                <option v-for="opcion in candidatos" :key="opcion.id" :value="opcion.id">
                    {{ opcion.nombre }}
                </option>
            </select>
        </label>
        <p class="campo-ayuda">
            Copiar un escenario existente evita capturar la retícula completa otra vez. A partir
            de ese momento los dos evolucionan por separado.
        </p>
        <p v-if="errorForm" class="formulario-error">{{ errorForm }}</p>

        <template #acciones>
            <button type="submit" class="btn btn-primary">Crear escenario</button>
        </template>
    </DialogoModal>
</template>
