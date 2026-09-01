/**
 * Escenarios: variantes editables de un caso base.
 *
 * El manifiesto (escenarios/index.json) y los datos de cada escenario vienen de
 * data/<carrera>/, vía repositorio.js. Un escenario nuevo parte siempre de uno
 * existente (nadie captura 46 materias a mano); hasta que se guarda con el
 * backend (ver guardar.js), vive solo en memoria y se pierde al recargar.
 */

import { cargarIndiceEscenarios, cargarDatosEscenario, cargarAulas, invalidarCache } from "./repositorio.js";
import { calcularCobertura } from "./cobertura.js";

/** Escenarios creados en esta sesión que aún no se han guardado: id → { meta, datos }. */
const escenariosEnMemoria = new Map();

/**
 * Escenarios de una carrera, cada uno con su propio resumen de cobertura.
 * Devuelve [] si la carrera no tiene escenarios todavía.
 */
export async function obtenerEscenariosPorCarrera(carrera) {
    const metas = [...(await cargarIndiceEscenarios(carrera).catch(() => [])), ...extrasEnMemoria(carrera)];
    if (metas.length === 0) return [];

    // Más nuevo primero. Las fechas son ISO (YYYY-MM-DD), así que el orden
    // de texto ya es el orden cronológico.
    metas.sort((a, b) => b.fecha.localeCompare(a.fecha));

    return Promise.all(
        metas.map(async (meta) => ({
            ...meta,
            cobertura: (await resumirEscenario(carrera, meta.id)).cobertura
        }))
    );
}

/** Un escenario con el dataset completo que necesita la pantalla de detalle. */
export async function obtenerEscenario(carrera, id) {
    const meta = await buscarMeta(carrera, id);
    const { datos, cobertura } = await resumirEscenario(carrera, id);
    return { ...meta, datos, cobertura };
}

/**
 * Olvida un escenario recién borrado: la copia en memoria y, sobre todo, el
 * índice cacheado. Sin invalidar el caché el escenario desaparece del disco
 * pero sigue listándose hasta recargar la página.
 */
export function olvidarEscenario(carrera, id) {
    escenariosEnMemoria.delete(id);
    invalidarCache(carrera, id);
}

/**
 * Crea un escenario nuevo. Si se indica `basadoEnId`, parte de los datos de
 * ese escenario (nadie captura 46 materias a mano); si no, arranca vacío
 * (las aulas siguen viniendo del catálogo compartido, no son parte de esto).
 * Rechaza nombres repetidos en vez de inventar uno: es el coordinador quien
 * debe decidir cómo se llama su escenario, no el sistema.
 */
export async function crearEscenario(carrera, { basadoEnId, nombre }) {
    const nombreFinal = nombre.trim();
    if (!nombreFinal) throw new Error("El nombre es obligatorio.");

    const existentes = [...(await cargarIndiceEscenarios(carrera).catch(() => [])), ...extrasEnMemoria(carrera)];
    if (existentes.some((escenario) => escenario.nombre === nombreFinal)) {
        throw new Error(`Ya existe un escenario llamado "${nombreFinal}".`);
    }

    const datos = basadoEnId
        ? clonar((await obtenerEscenario(carrera, basadoEnId)).datos)
        : await datosVacios(carrera);

    const idsUsados = new Set(existentes.map((escenario) => escenario.id));
    const nuevo = {
        id: generarId(nombreFinal, idsUsados),
        carrera,
        nombre: nombreFinal,
        fecha: hoyIso(),
        esBase: false
    };

    escenariosEnMemoria.set(nuevo.id, { meta: nuevo, datos });
    return nuevo;
}

async function datosVacios(carrera) {
    return {
        materias: [], docentes: [], semestres: [], especialidades: [],
        aulas: await cargarAulas(carrera)
    };
}

async function resumirEscenario(carrera, id) {
    const datos = await obtenerDatos(carrera, id);
    return { datos, cobertura: calcularCobertura(datos.materias, datos.docentes) };
}

function obtenerDatos(carrera, id) {
    const enMemoria = escenariosEnMemoria.get(id);
    return enMemoria ? enMemoria.datos : cargarDatosEscenario(carrera, id);
}

async function buscarMeta(carrera, id) {
    const enMemoria = escenariosEnMemoria.get(id);
    if (enMemoria) return enMemoria.meta;

    const indice = await cargarIndiceEscenarios(carrera);
    const meta = indice.find((candidato) => candidato.id === id);
    if (!meta) throw new Error(`No existe el escenario ${id}`);
    return meta;
}

function extrasEnMemoria(carrera) {
    return [...escenariosEnMemoria.values()]
        .filter((escenario) => escenario.meta.carrera === carrera)
        .map((escenario) => escenario.meta);
}

/** "Especialidad IA" → "especialidad-ia"; agrega un sufijo si ya está en uso. */
function generarId(nombre, idsUsados) {
    const base = nombre
        .trim()
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "escenario";

    let candidato = base;
    for (let n = 2; idsUsados.has(candidato); n++) {
        candidato = `${base}-${n}`;
    }
    return candidato;
}

function clonar(datos) {
    return structuredClone(datos);
}

function hoyIso() {
    return new Date().toISOString().slice(0, 10);
}
