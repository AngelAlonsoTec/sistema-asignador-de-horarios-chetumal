/**
 * Si un docente puede estar en el turno de un grupo.
 *
 * El artículo 157 del Reglamento Interior de Trabajo fija las actividades
 * docentes de 7 a 22 horas, y dentro de esa franja cada quien declara las suyas.
 * Asignar a alguien que solo declaró tardes un grupo de la mañana no es ilegal
 * —el departamento puede saber algo que el sistema no— pero sí es una decisión
 * que el horario no va a poder cumplir, y eso se ve mejor antes de tomarla que
 * después, en un diagnóstico de veinte horas imposibles.
 */

/** Las mismas franjas que usa el backend para armar la rejilla. */
export const TURNOS = {
    matutino: { inicio: 7, fin: 14 },
    vespertino: { inicio: 14, fin: 22 }
};

/** Horas que el docente declara dentro de una franja. */
export function horasEn(docente, turno) {
    const franja = TURNOS[turno];
    if (!franja) return null;
    return (docente?.disponibilidad?.declarada ?? []).reduce(
        (n, b) => n + Math.max(0, Math.min(b.fin, franja.fin) - Math.max(b.inicio, franja.inicio)),
        0
    );
}

/**
 * `true` si declara alguna hora en ese turno. Sin turno conocido no se opina:
 * decir que no cubre algo que no se sabe sería peor que callarse.
 */
export function cubre(docente, turno) {
    const horas = horasEn(docente, turno);
    return horas === null ? true : horas > 0;
}

/** Días distintos en los que declara alguna hora dentro del turno. */
export function diasEn(docente, turno) {
    const franja = TURNOS[turno];
    if (!franja) return null;
    return new Set(
        (docente?.disponibilidad?.declarada ?? [])
            .filter((b) => Math.min(b.fin, franja.fin) > Math.max(b.inicio, franja.inicio))
            .map((b) => b.dia)
    ).size;
}

/** Bloques en que se reparte una materia: de dos horas mientras se pueda. */
export const bloquesDe = (horasSemana) => Math.ceil((horasSemana ?? 0) / 2);

/**
 * Si esa persona **puede** dar esa clase con lo que declaró.
 *
 * No basta con tener horas en el turno: una materia no se repite el mismo día,
 * así que necesita tantos días distintos como bloques tenga la materia. Alguien
 * que solo declaró los lunes no puede con una materia de cinco horas por mucho
 * que le sobren horas ese día, y verlo al asignar ahorra descubrirlo después en
 * un diagnóstico de horas imposibles.
 */
export function alcanza(docente, turno, horasSemana) {
    const horas = horasEn(docente, turno);
    if (horas === null) return { puede: true };
    const dias = diasEn(docente, turno);
    const bloques = bloquesDe(horasSemana);
    if (horas === 0) return { puede: false, motivo: `no declaró horas de ${turno}` };
    if (horas < (horasSemana ?? 0)) {
        return { puede: false, motivo: `solo declara ${horas} h de ${turno} y la materia son ${horasSemana}` };
    }
    if (dias < bloques) {
        return {
            puede: false,
            motivo: `declara ${dias} día(s) de ${turno} y la materia necesita ${bloques}`
        };
    }
    return { puede: true };
}
