/**
 * Las reglas de carga docente del TecNM, en un solo sitio.
 *
 * Hasta ahora los topes del sistema —cuántas horas, cuántas materias, en qué
 * franja del día— eran números elegidos por parecer razonables. No lo eran: hay
 * un reglamento federal que los fija, y lo que el sistema impide o avisa tiene
 * que salir de ahí y no de una suposición.
 *
 * Fuente: **Reglamento Interior de Trabajo del Personal Docente de los
 * Institutos Tecnológicos** (TecNM), que es el que rige al Campus Chetumal como
 * a cualquier otro instituto del subsistema.
 *
 * Lo que se toma de él:
 *
 * - **Artículo 143**: horas de clase frente a grupo de los profesores de carrera
 *   de educación superior, por categoría y dedicación.
 * - **Artículo 144**: lo mismo para los profesores investigadores, que dan menos
 *   clase porque el resto del tiempo va a sus proyectos.
 * - **Artículo 146**: lo mismo para los técnicos docentes de enseñanza superior.
 * - **Artículo 147**: las horas asignadas se ajustan al límite de su categoría
 *   "sin que la diferencia exceda de dos horas". Lo que no es clase son
 *   actividades de apoyo a la docencia.
 * - **Artículo 155**: los de asignatura laboran entre 1 y 19 horas, y **en
 *   ningún caso se les asignarán más de tres materias diferentes**.
 * - **Artículo 156**: los de carrera laboran 40, 30 o 20 horas según dedicación,
 *   con el mismo tope de **tres materias diferentes**.
 * - **Artículo 157**: las actividades docentes diarias van **de las 7 a las 22
 *   horas, de lunes a viernes**.
 *
 * El reglamento manda sobre lo que dice; en lo que calla —cuántos grupos, cuánto
 * dura un bloque— el sistema sigue usando la práctica del plantel, y se dice
 * cuál es cuál.
 */

/** Artículo 155 y 156: el tope es el mismo para asignatura y para carrera. */
export const MAX_MATERIAS = 3;

/** Artículo 147: la carga puede quedar a dos horas del número de su categoría. */
export const AJUSTE_MAXIMO = 2;

/** Artículo 157. La rejilla del sistema sale de aquí, no de una costumbre. */
export const JORNADA = { horaInicio: 7, horaFin: 22, dias: 5 };

/**
 * Horas de clase que un docente puede dar en un mismo día.
 *
 * El reglamento fija la franja (art. 157) y el total semanal (art. 143 y
 * siguientes), pero no dice cuánto de ese total cabe en un día. Lo dice el
 * mapeo del problema que entregó el departamento: *"Horas máximo laborables:
 * 8 hrs al día"*. Son horas de jornada, no de una materia —el tope de una
 * materia frente a un grupo son tres y vive en la rejilla—, y viaja al motor
 * dentro de ella porque es quien reparte los días.
 */
export const MAX_HORAS_DIA_DOCENTE = 8;

/** Artículo 155: el nombramiento de asignatura va de 1 a 19 horas. */
export const ASIGNATURA = { min: 1, max: 19 };

/**
 * Horas de clase frente a grupo por categoría y dedicación.
 *
 * Nótese que **el titular da menos clase que el asistente**: no es un error de
 * captura, es lo que dice el artículo 143. A mayor categoría, más tiempo va a
 * las otras funciones del artículo 27 —programas de estudio, capacitación,
 * tutorías— y menos al aula.
 */
export const HORAS_FRENTE_A_GRUPO = {
    // Artículo 143, profesores de carrera de educación superior.
    titular: { "tiempo completo": 22, "tres cuartos": 16, "medio tiempo": 12 },
    asociado: { "tiempo completo": 24, "tres cuartos": 18, "medio tiempo": 12 },
    asistente: { "tiempo completo": 26, "tres cuartos": 20, "medio tiempo": 14 },
    // Artículo 144: el resto de su tiempo va a los proyectos de investigación.
    investigador: { "tiempo completo": 12, "tres cuartos": 10, "medio tiempo": 6 },
    // Artículo 146, técnicos docentes de enseñanza superior.
    "tecnico-docente": { "tiempo completo": 36, "tres cuartos": 28, "medio tiempo": 18 }
};

export const DEDICACIONES = ["tiempo completo", "tres cuartos", "medio tiempo", "asignatura"];

const normalizar = (t) =>
    String(t ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .trim();

/**
 * Las horas frente a grupo que le tocan según el reglamento, o `null` si su
 * categoría no está en las tablas —un nombramiento de asignatura no tiene un
 * número fijo: depende de las horas que diga su nombramiento—.
 */
export function horasDeReglamento(categoria, dedicacion) {
    const fila = HORAS_FRENTE_A_GRUPO[normalizar(categoria)];
    if (!fila) return null;
    return fila[normalizar(dedicacion)] ?? null;
}

/**
 * Qué no cuadra entre lo capturado y el reglamento.
 *
 * Son **avisos, no bloqueos**. Un plantel real tiene excepciones —comisiones,
 * plazas mixtas, nombramientos en trámite— y un sistema que se niegue a
 * programar por eso no se usa. Lo que no puede es callarlas.
 */
export function revisar(docente) {
    const avisos = [];
    const dedicacion = normalizar(docente.dedicacion);
    const esAsignatura = dedicacion === "asignatura" || normalizar(docente.categoria) === "asignatura";

    if ((docente.maxMaterias ?? 0) > MAX_MATERIAS) {
        avisos.push({
            codigo: "materias-sobre-reglamento",
            articulo: esAsignatura ? "155" : "156",
            mensaje:
                `${docente.maxMaterias} materias distintas: el reglamento no permite asignar ` +
                `más de ${MAX_MATERIAS}.`
        });
    }

    if (esAsignatura) {
        const horas = docente.horasMax ?? 0;
        if (horas < ASIGNATURA.min || horas > ASIGNATURA.max) {
            avisos.push({
                codigo: "asignatura-fuera-de-rango",
                articulo: "155",
                mensaje:
                    `${horas} horas: un nombramiento de asignatura va de ${ASIGNATURA.min} ` +
                    `a ${ASIGNATURA.max}.`
            });
        }
        return avisos;
    }

    const esperadas = horasDeReglamento(docente.categoria, docente.dedicacion);
    if (esperadas === null) {
        // No se inventa un número: se dice que falta el dato para poder compararlo.
        if (!docente.dedicacion) {
            avisos.push({
                codigo: "sin-dedicacion",
                articulo: "143",
                mensaje:
                    "Sin dedicación registrada no se puede saber cuántas horas frente a grupo " +
                    "le tocan: tiempo completo, tres cuartos o medio tiempo."
            });
        }
        return avisos;
    }

    const diferencia = Math.abs((docente.horasMax ?? 0) - esperadas);
    if (diferencia > AJUSTE_MAXIMO) {
        avisos.push({
            codigo: "horas-fuera-de-reglamento",
            articulo: "143 y 147",
            mensaje:
                `${docente.horasMax} horas frente a grupo, y a un ${normalizar(docente.categoria)} ` +
                `de ${normalizar(docente.dedicacion)} le corresponden ${esperadas} ` +
                `(el ajuste permitido es de ${AJUSTE_MAXIMO} horas).`
        });
    }
    return avisos;
}

/** La revisión de toda la plantilla, para la pantalla del departamento. */
export function revisarPlantilla(docentes) {
    return docentes
        .map((d) => ({
            docenteId: d.id,
            nombre: d.nombre,
            categoria: d.categoria,
            dedicacion: d.dedicacion ?? null,
            horasMax: d.horasMax,
            maxMaterias: d.maxMaterias,
            esperadas: horasDeReglamento(d.categoria, d.dedicacion),
            avisos: revisar(d)
        }))
        .filter((r) => r.avisos.length > 0);
}
