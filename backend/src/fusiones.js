/**
 * Fusión: una materia que varios grupos cursan juntos, en una sola clase.
 *
 * El motor sabe programarlas desde la fase 0, pero nadie las proponía: había
 * que declararlas a mano por API, así que la capacidad existía y no se usaba.
 * Esto las busca.
 *
 * **Alcance: dentro de una carrera.** El caso que más se repite en el
 * tecnológico —dos carreras cursando juntas una materia de tronco común— hoy no
 * se puede expresar: el problema que recibe el motor solo lleva los grupos de la
 * carrera abierta, y los ids ni siquiera son únicos entre carreras (ISIC e ITIC
 * generan las dos un `g-1a`). Hace falta generar un horario que abarque varias
 * carreras a la vez, que es otra fase. Dentro de una carrera sí hay caso y es
 * frecuente: en séptimo, los grupos de Desarrollo Web y de Negocios Digitales
 * comparten todo el tronco común del semestre.
 */

/**
 * Materias que más de un grupo cursa en el mismo turno.
 *
 * El turno es condición, no preferencia: una clase ocurre una vez, y dos grupos
 * en turnos distintos no pueden recibirla. Se piden dos grupos como mínimo
 * porque una "fusión" de uno no es nada.
 */
export function candidatas(materias, grupos) {
    const porMateria = new Map(materias.map((m) => [m.id, m]));
    const cubos = new Map();

    for (const grupo of grupos) {
        for (const materiaId of grupo.materias ?? []) {
            const llave = `${materiaId}|${grupo.turno}`;
            if (!cubos.has(llave)) cubos.set(llave, []);
            cubos.get(llave).push(grupo);
        }
    }

    const salida = [];
    for (const [llave, suyos] of cubos) {
        if (suyos.length < 2) continue;
        const materia = porMateria.get(llave.split("|")[0]);
        if (!materia) continue;

        salida.push({
            materiaId: materia.id,
            materiaClave: materia.clave,
            materiaNombre: materia.nombre,
            semestre: materia.semestre,
            turno: suyos[0].turno,
            grupos: suyos.map((g) => ({ id: g.id, clave: g.clave, alumnos: g.alumnos ?? null })),
            // Lo que se ahorra: la clase se imparte una vez en lugar de N.
            horasAhorradas: materia.horasSemana * (suyos.length - 1),
            alumnos: suyos.reduce((n, g) => n + (g.alumnos ?? 0), 0),
            // Una fusión es **una** clase, así que la imparte una sola persona:
            // la del grupo principal. Si el departamento puso a alguien distinto
            // en cada grupo, fusionar deja fuera una de sus decisiones, y eso
            // hay que decirlo antes de marcar la casilla, no después.
            docentesDistintos: new Set(
                suyos.map((g) => g.asignaciones?.[materia.id]).filter(Boolean)
            ).size > 1
        });
    }

    return salida.sort(
        (a, b) => b.horasAhorradas - a.horasAhorradas || a.semestre - b.semestre
    );
}

/**
 * Deja pasar solo las fusiones que el motor va a aceptar.
 *
 * El motor rechaza el problema entero si una fusión nombra un grupo que no
 * existe o que no cursa esa materia — y con razón, porque es un dato mal. Pero
 * esas referencias se rompen solas al cambiar los grupos de la petición: quien
 * eligió fusionar 7A y 7B y luego cerró 7B no cometió ningún error, y perder el
 * horario por eso sería absurdo. Se descartan en silencio las que quedaron sin
 * sentido y se informa de ellas aparte.
 */
export function depurar(pedidas, grupos) {
    const porId = new Map(grupos.map((g) => [g.id, g]));
    const validas = [];
    const descartadas = [];

    for (const fusion of pedidas ?? []) {
        const suyos = (fusion.grupos ?? [])
            .map((id) => porId.get(id))
            .filter((g) => g && (g.materias ?? []).includes(fusion.materiaId));

        const turnos = new Set(suyos.map((g) => g.turno));
        if (suyos.length < 2 || turnos.size > 1) {
            descartadas.push({
                materiaId: fusion.materiaId,
                grupos: fusion.grupos ?? [],
                motivo:
                    turnos.size > 1
                        ? "los grupos quedaron en turnos distintos"
                        : "ya no hay dos grupos que cursen esa materia"
            });
            continue;
        }
        validas.push({ materiaId: fusion.materiaId, grupos: suyos.map((g) => g.id) });
    }

    return { validas, descartadas };
}
