/**
 * Reglas de los escenarios: crear, clonar y resumir.
 *
 * Un escenario es una variante completa e independiente de los datos de una
 * carrera. La operación importante es clonar: nadie captura cincuenta materias
 * a mano, así que un escenario nuevo casi siempre parte de otro.
 */

import * as almacen from "./almacen.js";
import { calcularCobertura } from "./cobertura.js";
import { ErrorHttp } from "./http.js";

/** El índice de escenarios con la cobertura de cada uno ya calculada. */
export async function listarConCobertura(carrera) {
    const indice = await almacen.leerIndice(carrera);

    const escenarios = await Promise.all(
        indice.map(async (meta) => {
            try {
                const datos = await almacen.leerEscenario(carrera, meta.id);
                return {
                    ...meta,
                    cobertura: calcularCobertura(datos.materias, datos.docentes),
                    conteo: {
                        materias: datos.materias.length,
                        docentes: datos.docentes.length,
                        especialidades: datos.especialidades.length
                    }
                };
            } catch {
                // Un escenario listado cuya carpeta ya no está no debe tumbar
                // la pantalla completa: se marca y el resto se muestra igual.
                return { ...meta, roto: true };
            }
        })
    );

    // Más reciente primero. Las fechas son ISO, así que el orden de texto ya es
    // el cronológico.
    return escenarios.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
}

export async function obtener(carrera, id) {
    const meta = await almacen.buscarMeta(carrera, id);
    const datos = await almacen.leerEscenario(carrera, id);
    return { ...meta, datos, cobertura: calcularCobertura(datos.materias, datos.docentes) };
}

export async function crear(carrera, { nombre, basadoEn }) {
    const limpio = String(nombre ?? "").trim();
    if (!limpio) throw new ErrorHttp(400, "El nombre es obligatorio.");

    const indice = await almacen.leerIndice(carrera);
    // Se rechaza el duplicado en vez de renombrar solo: quien decide cómo se
    // llama un escenario es la coordinación, no el sistema.
    if (indice.some((escenario) => escenario.nombre === limpio)) {
        throw new ErrorHttp(409, `Ya existe un escenario llamado "${limpio}".`);
    }

    // Los docentes no se copian: son del instituto, no del escenario.
    const datos = basadoEn
        ? await almacen.leerEscenario(carrera, basadoEn)
        : { materias: [], semestres: [], especialidades: [] };

    const meta = {
        id: generarId(limpio, new Set(indice.map((escenario) => escenario.id))),
        carrera: carrera.toUpperCase(),
        nombre: limpio,
        fecha: new Date().toISOString().slice(0, 10),
        // El primero de una carrera es su base: una carrera sin base es un
        // estado roto —el departamento reparte contra el base— y no debería
        // poder crearse. Los siguientes nacen como variantes, y la coordinación
        // mueve la marca cuando una pasa a ser la buena.
        esBase: indice.length === 0
    };

    // Primero el índice y después los datos. Al revés —como estaba— las
    // materias copiadas se insertaban apuntando a un escenario que todavía no
    // existía, y la clave foránea lo rechazaba: **crear a partir de otro
    // escenario fallaba siempre** que el original tuviera materias, que es el
    // caso normal y el que la interfaz preselecciona. Sin `basadoEn` los datos
    // van vacíos, no hay nada que insertar y por eso nunca se notó.
    //
    // Se guarda de inmediato: un escenario que solo existiera en memoria
    // desaparecería al recargar, y "crear" debe ser un hecho permanente.
    await almacen.registrarEnIndice(carrera, meta);
    try {
        await almacen.guardarEscenario(carrera, meta.id, datos);
    } catch (e) {
        // Si la copia falla, no se deja un escenario registrado y vacío: eso es
        // peor que no haberlo creado, porque parece bueno.
        await almacen.eliminarEscenario(carrera, meta.id).catch(() => {});
        throw e;
    }
    return meta;
}

export async function eliminar(carrera, id) {
    const meta = await almacen.buscarMeta(carrera, id);
    // El caso base se protege también aquí, no solo en la interfaz: si se
    // borrara no quedaría de dónde partir para crear los demás.
    if (meta.esBase) throw new ErrorHttp(400, "El caso base no se puede eliminar.");
    await almacen.eliminarEscenario(carrera, id);
}

/**
 * Marca cuál de los escenarios es **el bueno**: el que va a producción.
 *
 * Hasta ahora `esBase` se ponía al sembrar y no se podía mover, así que una
 * coordinación que trabajaba en una variante no tenía forma de decirlo, y el
 * departamento —que reparte contra el escenario base— acababa adivinando. Con
 * tres escenarios y solo uno configurado, un borrador de prueba se llevaba el
 * catálogo por delante.
 *
 * Es exclusivo: marcar uno desmarca al anterior. Dos bases serían dos verdades.
 */
export async function marcarBase(carrera, id) {
    const indice = await almacen.leerIndice(carrera);
    const meta = indice.find((e) => e.id === id);
    if (!meta) throw new ErrorHttp(404, `No existe el escenario ${id}.`);

    for (const otro of indice) {
        const esElNuevo = otro.id === id;
        if (Boolean(otro.esBase) === esElNuevo) continue;
        await almacen.registrarEnIndice(carrera, { ...otro, esBase: esElNuevo });
    }
    return { ...meta, esBase: true };
}

export async function guardar(carrera, id, datos) {
    const meta = await almacen.buscarMeta(carrera, id);
    await almacen.guardarEscenario(carrera, id, datos);
    await almacen.registrarEnIndice(carrera, { ...meta, fecha: new Date().toISOString().slice(0, 10) });
}

/** "Especialidad IA" -> "especialidad-ia"; agrega un sufijo si ya está en uso. */
export function generarId(nombre, idsUsados) {
    const base =
        nombre
            .trim()
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "escenario";

    let candidato = base;
    for (let n = 2; idsUsados.has(candidato); n++) candidato = `${base}-${n}`;
    return candidato;
}
