/**
 * Persistencia real de un escenario: llama al backend mínimo (backend/server.js),
 * que es el único que puede escribir de vuelta a los .json en disco. Sin él
 * corriendo, estas peticiones fallan — por eso escenario-detalle.js reporta el
 * error en vez de fingir que se guardó.
 */

export async function guardarEscenario(escenario) {
    await post("/api/escenarios/guardar", {
        carrera: escenario.carrera,
        id: escenario.id,
        meta: { id: escenario.id, carrera: escenario.carrera, nombre: escenario.nombre, fecha: escenario.fecha, esBase: escenario.esBase },
        materias: escenario.datos.materias,
        docentes: escenario.datos.docentes,
        semestres: escenario.datos.semestres,
        especialidades: escenario.datos.especialidades
    });
}

/** Las aulas son compartidas entre escenarios de una carrera, no van con el escenario. */
export async function guardarAulas(escenario) {
    await post("/api/aulas/guardar", { carrera: escenario.carrera, aulas: escenario.datos.aulas });
}

export async function eliminarEscenario(carrera, id) {
    await post("/api/escenarios/eliminar", { carrera, id });
}

async function post(ruta, cuerpo) {
    const respuesta = await fetch(ruta, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo)
    });
    if (!respuesta.ok) {
        throw new Error(await respuesta.text());
    }
}
