/**
 * Mutaciones sobre el dataset de un escenario abierto (materias y docentes).
 * Funciones puras sobre `datos` en memoria: no tocan el DOM ni el disco.
 * Persistir los cambios es trabajo del botón "Guardar cambios" (ver guardar.js
 * y backend/server.js), porque un navegador no puede escribir de vuelta a los
 * .json del escenario por sí solo.
 */

/** "ACF-0901" → "acf_0901". Mismo criterio que ya usan los datos existentes. */
export function claveAId(clave) {
    return clave.trim().toLowerCase().replace(/-/g, "_");
}

/** "Inteligencia Artificial" → "inteligencia-artificial", único entre las existentes. */
export function nombreAIdEspecialidad(nombre, idsUsados) {
    const base = nombre
        .trim()
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "especialidad";

    let candidato = base;
    for (let n = 2; idsUsados.has(candidato); n++) {
        candidato = `${base}-${n}`;
    }
    return candidato;
}

/** Los docentes no tienen clave visible; su id es puramente interno. */
/**
 * El siguiente id libre de la plantilla. Ya no hay alta, baja ni edición de
 * docentes aquí: la plantilla es del instituto y la administra el departamento
 * desde su pantalla. Esto queda porque el id lo sigue poniendo el cliente —el
 * alta manda la plantilla completa— y es la única regla de forma que tiene.
 */
export function siguienteIdDocente(docentes) {
    const numeros = docentes.map((docente) => Number(docente.id.match(/\d+/)?.[0] ?? 0));
    const siguiente = (numeros.length ? Math.max(...numeros) : 0) + 1;
    return `doc${String(siguiente).padStart(3, "0")}`;
}

export function agregarMateria(datos, materia) {
    if (datos.materias.some((existente) => existente.id === materia.id)) {
        throw new Error(`Ya existe una materia con la clave ${materia.clave}.`);
    }
    datos.materias.push(materia);
}

export function editarMateria(datos, id, cambios) {
    const materia = datos.materias.find((candidata) => candidata.id === id);
    if (!materia) throw new Error(`No existe la materia ${id}.`);

    if (cambios.id && cambios.id !== id && datos.materias.some((otra) => otra.id === cambios.id)) {
        throw new Error(`Ya existe una materia con la clave ${cambios.clave}.`);
    }
    Object.assign(materia, cambios);
}

/**
 * Quita la materia y, con ella, cualquier referencia colgante en
 * `materiasCapacitadas`: si un docente quedara "capacitado" para una
 * materia que ya no existe, el validador de cobertura mentiría.
 */
export function eliminarMateria(datos, id) {
    const indice = datos.materias.findIndex((materia) => materia.id === id);
    if (indice === -1) throw new Error(`No existe la materia ${id}.`);

    datos.materias.splice(indice, 1);
    for (const docente of datos.docentes) {
        const posicion = docente.materiasCapacitadas.indexOf(id);
        if (posicion !== -1) docente.materiasCapacitadas.splice(posicion, 1);
    }
}

/**
 * Una especialidad es un módulo con nombre que agrupa materias y que la
 * retícula cambia cada pocos años. Es entidad propia, y no un string repetido
 * en cada materia, para poder renombrarla, listarla y medir su cobertura sin
 * depender de que el texto se haya escrito igual las N veces.
 */
export function agregarEspecialidad(datos, especialidad, materiaIds) {
    if (datos.especialidades.some((otra) => otra.id === especialidad.id)) {
        throw new Error(`Ya existe una especialidad llamada "${especialidad.nombre}".`);
    }
    datos.especialidades.push(especialidad);
    asignarMaterias(datos, especialidad.id, materiaIds);
}

export function editarEspecialidad(datos, id, cambios, materiaIds) {
    const especialidad = datos.especialidades.find((candidata) => candidata.id === id);
    if (!especialidad) throw new Error(`No existe la especialidad ${id}.`);

    if (datos.especialidades.some((otra) => otra.id !== id && otra.nombre === cambios.nombre)) {
        throw new Error(`Ya existe una especialidad llamada "${cambios.nombre}".`);
    }
    Object.assign(especialidad, cambios);
    asignarMaterias(datos, id, materiaIds);
}

/**
 * Borra la especialidad y desliga sus materias, que vuelven a tronco común.
 * No las elimina: son materias reales de la retícula, y borrarlas en cascada
 * desde un botón que dice "eliminar especialidad" sería una sorpresa cara.
 */
export function eliminarEspecialidad(datos, id) {
    const indice = datos.especialidades.findIndex((especialidad) => especialidad.id === id);
    if (indice === -1) throw new Error(`No existe la especialidad ${id}.`);

    datos.especialidades.splice(indice, 1);
    asignarMaterias(datos, id, []);
}

/** Deja exactamente `materiaIds` apuntando a la especialidad: liga y desliga. */
function asignarMaterias(datos, especialidadId, materiaIds) {
    const elegidas = new Set(materiaIds ?? []);

    for (const materia of datos.materias) {
        if (elegidas.has(materia.id)) materia.especialidadId = especialidadId;
        else if (materia.especialidadId === especialidadId) materia.especialidadId = null;
    }
}

/**
 * Vista inversa de `materiasCapacitadas`: en vez de abrir cada docente para
 * marcar sus materias, se parte de la materia y se eligen sus docentes. Es el
 * mismo dato escrito desde el otro lado, no una copia aparte.
 */
export function asignarDocentesAMateria(datos, materiaId, docenteIds) {
    const elegidos = new Set(docenteIds);

    for (const docente of datos.docentes) {
        const posicion = docente.materiasCapacitadas.indexOf(materiaId);
        if (elegidos.has(docente.id) && posicion === -1) docente.materiasCapacitadas.push(materiaId);
        if (!elegidos.has(docente.id) && posicion !== -1) docente.materiasCapacitadas.splice(posicion, 1);
    }
}

export function agregarAula(datos, aula) {
    if (datos.aulas.some((existente) => existente.id === aula.id)) {
        throw new Error(`Ya existe un aula con la clave ${aula.clave}.`);
    }
    datos.aulas.push(aula);
}

export function editarAula(datos, id, cambios) {
    const aula = datos.aulas.find((candidata) => candidata.id === id);
    if (!aula) throw new Error(`No existe el aula ${id}.`);

    if (cambios.id && cambios.id !== id && datos.aulas.some((otra) => otra.id === cambios.id)) {
        throw new Error(`Ya existe un aula con la clave ${cambios.clave}.`);
    }
    Object.assign(aula, cambios);
}

export function eliminarAula(datos, id) {
    const indice = datos.aulas.findIndex((aula) => aula.id === id);
    if (indice === -1) throw new Error(`No existe el aula ${id}.`);
    datos.aulas.splice(indice, 1);
}
