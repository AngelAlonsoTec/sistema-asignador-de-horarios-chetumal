/**
 * Horario que abarca varias carreras a la vez.
 *
 * Existe por la **fusión entre carreras**: dos carreras cursando juntas una
 * materia de tronco común, que es el caso más repetido en el tecnológico y el
 * único que el sistema no podía expresar. El motor sabe programar una sesión
 * compartida desde el principio, pero el problema que recibía llevaba solo los
 * grupos de una carrera, así que no había forma de nombrar al grupo de la otra.
 *
 * No basta con colar el grupo invitado en la sesión fusionada: si el motor no
 * conoce **el resto** de sus clases, le coloca la fusionada encima de ellas. Hay
 * que programar las dos carreras juntas o ninguna.
 *
 * **Quien genera debe coordinar todas las carreras que entren.** No es una
 * limitación técnica sino de responsabilidad: generar un horario multi-carrera
 * es decidir el de todas, y nadie debería decidir el de una carrera ajena desde
 * su propia pantalla. Para el caso de dos coordinadores distintos hace falta
 * antes un acuerdo, que es otra conversación.
 */

import { ErrorHttp } from "./http.js";

/**
 * Los ids de grupo se repiten entre carreras —ISIC e ITIC generan las dos un
 * `g-1a`— así que al juntarlos hay que distinguirlos. El prefijo es la carrera.
 */
export function prefijar(carrera, grupoId) {
    return `${carrera}:${grupoId}`;
}

/** La carrera de un grupo del conjunto, para repartir la reserva al final. */
export function carreraDe(grupoId) {
    const corte = String(grupoId).indexOf(":");
    return corte === -1 ? null : grupoId.slice(0, corte);
}

/**
 * Une los grupos y las materias de varias carreras en un solo problema.
 *
 * Las materias se unen **por id**: es lo que hace posible la fusión, porque dos
 * carreras que comparten una materia comparten su clave. Si dos la definen con
 * distintas horas a la semana no se puede programar una sola clase, y eso es un
 * dato que hay que corregir, no algo que el motor deba adivinar.
 */
export function unir(partes) {
    if (partes.length === 0) throw new ErrorHttp(400, "No hay ninguna carrera que programar.");

    const materias = new Map();
    const especialidades = new Map();
    const grupos = [];

    for (const { carrera, datos, grupos: suyos } of partes) {
        for (const materia of datos.materias) {
            const previa = materias.get(materia.id);
            if (previa && previa.horasSemana !== materia.horasSemana) {
                throw new ErrorHttp(
                    422,
                    `"${materia.clave}" tiene ${previa.horasSemana} h en ${previa.deCarrera} y ` +
                        `${materia.horasSemana} h en ${carrera}. Con horas distintas no puede ser ` +
                        "una sola clase: hay que igualarlas o no fusionarla."
                );
            }
            if (!previa) materias.set(materia.id, { ...materia, deCarrera: carrera });
        }

        // La especialidad es de una carrera: se prefija igual que el grupo para
        // que dos módulos homónimos no se confundan en la leyenda del horario.
        for (const esp of datos.especialidades ?? []) {
            especialidades.set(prefijar(carrera, esp.id), {
                ...esp,
                id: prefijar(carrera, esp.id),
                nombre: partes.length > 1 ? `${esp.nombre} (${carrera})` : esp.nombre
            });
        }

        for (const grupo of suyos) {
            grupos.push({
                ...grupo,
                id: prefijar(carrera, grupo.id),
                // La clave se queda limpia: de quién es lo dice `carrera`, y
                // meterlo también en el texto producía "ITIC · 1A ITIC" en la
                // hoja de saturación, que ya trae su propia columna de carrera.
                // Quien necesite distinguir compone las dos.
                clave: grupo.clave,
                carrera,
                especialidadId: grupo.especialidadId
                    ? prefijar(carrera, grupo.especialidadId)
                    : null
            });
        }
    }

    return {
        grupos,
        materias: [...materias.values()],
        especialidades: [...especialidades.values()]
    };
}

/**
 * Fusiones posibles entre carreras distintas: misma materia, mismo turno.
 *
 * Se separan de las de dentro de una carrera porque la decisión es otra. Juntar
 * a 7A y 7B de la misma carrera es cosa de un coordinador; juntar a ISIC con
 * ITIC afecta a dos planes de estudio, y quien lo aprueba quiere verlo aparte.
 */
export function candidatasEntreCarreras(materias, grupos) {
    const cubos = new Map();
    for (const grupo of grupos) {
        for (const materiaId of grupo.materias ?? []) {
            const llave = `${materiaId}|${grupo.turno}`;
            if (!cubos.has(llave)) cubos.set(llave, []);
            cubos.get(llave).push(grupo);
        }
    }

    const porId = new Map(materias.map((m) => [m.id, m]));
    const salida = [];
    for (const [llave, suyos] of cubos) {
        const carreras = new Set(suyos.map((g) => g.carrera));
        if (suyos.length < 2 || carreras.size < 2) continue;

        const materia = porId.get(llave.split("|")[0]);
        if (!materia) continue;
        salida.push({
            materiaId: materia.id,
            materiaClave: materia.clave,
            materiaNombre: materia.nombre,
            semestre: materia.semestre,
            turno: suyos[0].turno,
            carreras: [...carreras].sort(),
            grupos: suyos.map((g) => ({ id: g.id, clave: g.clave, alumnos: g.alumnos ?? null })),
            horasAhorradas: materia.horasSemana * (suyos.length - 1),
            alumnos: suyos.reduce((n, g) => n + (g.alumnos ?? 0), 0)
        });
    }
    return salida.sort((a, b) => b.horasAhorradas - a.horasAhorradas || a.semestre - b.semestre);
}

/**
 * Reparte las sesiones de un horario conjunto por carrera, para apartarlas.
 *
 * Una sesión fusionada es **una** hora catedrático: el docente entra una vez. Se
 * le carga a la carrera del grupo principal, que es la dueña del aula donde se
 * imparte; las demás la ven ocupada en la hoja, igual que cualquier otra hora
 * tomada.
 */
export function repartirPorCarrera(sesiones, porOmision) {
    const porCarrera = new Map();
    for (const sesion of sesiones) {
        // Un horario de una sola carrera no prefija sus grupos: no hay nada de
        // que distinguirlos. Sin este respaldo esas sesiones se perdían y
        // apartar vaciaba la reserva en silencio.
        const carrera = carreraDe(sesion.grupoId) ?? porOmision;
        if (!carrera) continue;
        if (!porCarrera.has(carrera)) porCarrera.set(carrera, []);
        porCarrera.get(carrera).push(sesion);
    }
    return porCarrera;
}
