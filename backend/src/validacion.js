/**
 * Comprobaciones previas a generar un horario.
 *
 * La regla es que **no se genera nada con datos incompletos**. Antes había
 * advertencias: el motor entregaba un horario imposible y explicaba por qué.
 * Eso es peor que no entregar nada, porque un horario con materias sin docente
 * parece un resultado y no lo es, y quien lo revisa pierde el tiempo buscando
 * el error en la propuesta en vez de en los datos.
 *
 * Los bloqueos impiden generar. Las advertencias no: describen configuraciones
 * legítimas que conviene revisar.
 *
 * Cada bloqueo dice en qué sección se arregla, para que la interfaz pueda
 * llevar directo ahí en lugar de dejar al usuario buscándolo.
 */

import { contarDocentesPorMateria } from "./cobertura.js";
import { semestresDe } from "./periodo.js";

export function validarParaHorario({ datos, aulas, rejilla, grupos, paridad, ocupadas = [] }) {
    const bloqueos = [];
    const advertencias = [];

    const activos = new Set(semestresDe(paridad));
    const delPeriodo = datos.materias.filter((materia) => activos.has(materia.semestre));

    if (delPeriodo.length === 0) {
        bloqueos.push({
            codigo: "sin-materias-en-periodo",
            mensaje: `El escenario no tiene materias en ${etiqueta(paridad)}.`,
            seccion: "materias",
            detalle: []
        });
        // Sin materias del periodo, el resto de las comprobaciones no aporta:
        // fallarían todas y enterrarían la única que importa.
        return { listo: false, bloqueos, advertencias, resumen: resumenVacio(paridad) };
    }

    if (aulas.length === 0) {
        bloqueos.push({
            codigo: "sin-aulas",
            mensaje: "La carrera no tiene espacios registrados: no hay dónde colocar las clases.",
            seccion: "aulas",
            detalle: []
        });
    }

    if (datos.docentes.length === 0) {
        bloqueos.push({
            codigo: "sin-docentes",
            mensaje: "El escenario no tiene docentes.",
            seccion: "docentes",
            detalle: []
        });
    }

    if (grupos.length === 0) {
        bloqueos.push({
            codigo: "sin-grupos",
            mensaje: "La configuración no abre ningún grupo.",
            seccion: "horario",
            detalle: []
        });
    }

    // Solo se exige cobertura de lo que se va a programar. Una materia de un
    // semestre que este periodo no se imparte no tiene por qué bloquear.
    const enGrupos = new Set(grupos.flatMap((grupo) => grupo.materias));
    const aProgramar = delPeriodo.filter((materia) => enGrupos.has(materia.id));
    const conteo = contarDocentesPorMateria(aProgramar, datos.docentes);

    const sinDocente = aProgramar.filter((materia) => conteo.get(materia.id) === 0);
    if (sinDocente.length > 0) {
        bloqueos.push({
            codigo: "materias-sin-docente",
            mensaje: `${sinDocente.length} materias de este periodo no tienen ningún docente capacitado.`,
            seccion: "materias",
            detalle: sinDocente.map((materia) => `${materia.clave} · ${materia.nombre}`)
        });
    }

    const requierenLab = aProgramar.filter((materia) => materia.requiereLaboratorio === true);
    if (requierenLab.length > 0 && !aulas.some((aula) => aula.tipo === "laboratorio")) {
        bloqueos.push({
            codigo: "sin-laboratorios",
            mensaje: `${requierenLab.length} materias requieren laboratorio y no hay ninguno registrado.`,
            seccion: "aulas",
            detalle: requierenLab.map((materia) => `${materia.clave} · ${materia.nombre}`)
        });
    }

    // Una materia no puede repetirse el mismo día, así que necesita tantos días
    // hábiles como bloques tenga. Con el tope de tres horas diarias, una materia
    // de más de quince horas semanales no cabe en la semana por mucho que el
    // algoritmo busque, y conviene decirlo antes de correrlo.
    const tope = rejilla.duracionMaximaBloque ?? 3;
    const noCabenEnLaSemana = aProgramar.filter(
        (materia) => Math.ceil(materia.horasSemana / tope) > rejilla.dias.length
    );
    if (noCabenEnLaSemana.length > 0) {
        bloqueos.push({
            codigo: "materia-no-cabe-en-la-semana",
            mensaje:
                `${noCabenEnLaSemana.length} materias necesitan más días de los que tiene la semana: ` +
                `con un máximo de ${tope} h por día no alcanzan los ${rejilla.dias.length} días hábiles.`,
            seccion: "materias",
            detalle: noCabenEnLaSemana.map(
                (materia) =>
                    `${materia.clave} · ${materia.nombre}: ${materia.horasSemana} h necesitan ` +
                    `${Math.ceil(materia.horasSemana / tope)} días`
            )
        });
    }

    const horasDe = new Map(aProgramar.map((materia) => [materia.id, materia.horasSemana]));
    const noCaben = [];
    let horasTotales = 0;

    for (const grupo of grupos) {
        const horas = grupo.materias.reduce((suma, id) => suma + (horasDe.get(id) ?? 0), 0);
        horasTotales += horas;

        const turno = rejilla.turnos.find((t) => t.id === grupo.turno);
        const ranuras = turno ? (turno.horaFin - turno.horaInicio) * rejilla.dias.length : 0;
        if (horas > ranuras) {
            noCaben.push(
                `${grupo.clave}: ${horas} h no caben en ${ranuras} ranuras del turno ${grupo.turno}`
            );
        }
    }

    if (noCaben.length > 0) {
        bloqueos.push({
            codigo: "grupo-no-cabe",
            mensaje: `${noCaben.length} grupos tienen más horas de las que caben en su turno.`,
            seccion: "horario",
            detalle: noCaben
        });
    }

    // Cada grupo necesita su propia aula dentro de su turno. Entre turnos se
    // reutilizan, así que lo que manda es el turno más cargado.
    const sinAula = grupos.filter((grupo) => !grupo.aulaId);
    if (sinAula.length > 0) {
        const normales = aulas.filter((aula) => aula.tipo !== "laboratorio");
        const mayor = Math.max(0, ...normales.map((a) => a.capacidad ?? 0));

        // Quedarse sin aula tiene dos causas distintas y mandan a sitios
        // distintos: o no hay salón donde quepan los alumnos, o no quedan horas
        // libres en ninguno. Decir "faltan aulas" cuando lo que falta es cupo
        // manda a buscar salones que no arreglarían nada.
        const porCupo = sinAula.filter(
            (g) => mayor > 0 && g.alumnos > 0 && g.alumnos > mayor
        );
        const porHoras = sinAula.filter((g) => !porCupo.includes(g));

        if (porCupo.length > 0) {
            bloqueos.push({
                codigo: "aulas-sin-cupo",
                mensaje:
                    `${porCupo.length} grupos no caben en ningún salón: el mayor es de ${mayor} ` +
                    "alumnos.",
                seccion: "aulas",
                detalle: porCupo.map(
                    (g) => `${g.clave}: ${g.alumnos} alumnos y el aula más grande tiene ${mayor}`
                )
            });
        }
        if (porHoras.length > 0) {
            const horasDe = (turno) => {
                const t = rejilla.turnos.find((x) => x.id === turno);
                return t ? (t.horaFin - t.horaInicio) * rejilla.dias.length : 0;
            };
            // Un aula se comparte entre grupos con horarios distintos, así que
            // lo que se agota no son los salones sino sus horas.
            const porTurno = new Map();
            for (const grupo of grupos) {
                const suyo = porTurno.get(grupo.turno) ?? { grupos: 0, horas: 0 };
                suyo.grupos += 1;
                suyo.horas += grupo.horasSemana ?? 0;
                porTurno.set(grupo.turno, suyo);
            }
            bloqueos.push({
                codigo: "faltan-aulas",
                mensaje:
                    `${porHoras.length} grupos se quedaron sin aula: las ${normales.length} aulas ` +
                    "no tienen horas libres suficientes en su turno.",
                seccion: "aulas",
                detalle: [...porTurno]
                    .sort((a, b) => b[1].horas - a[1].horas)
                    .map(([turno, x]) =>
                        `${turno}: ${x.grupos} grupos piden ${x.horas} h y ${normales.length} aulas ` +
                        `ofrecen ${normales.length * horasDe(turno)} horas-aula`
                    )
            });
        }
    }

    // La capacidad es la del contrato: las horas que otra carrera pretende no
    // se restan, porque no están perdidas — están en disputa y se pueden pedir.
    const capacidad = datos.docentes.reduce((suma, docente) => suma + (docente.horasMax ?? 0), 0);

    if (ocupadas.length > 0) {
        const comprometidas = new Map();
        for (const o of ocupadas) {
            comprometidas.set(o.docenteId, (comprometidas.get(o.docenteId) ?? 0) + (o.fin - o.inicio));
        }
        const cuantas = [...comprometidas.values()].reduce((a, b) => a + b, 0);
        advertencias.push({
            codigo: "horas-comprometidas",
            mensaje:
                `Otras carreras pretenden ${cuantas} h de ${comprometidas.size} docentes en este ` +
                "periodo. El motor las evitará; si acaba usando alguna, aparecerá como conflicto.",
            detalle: []
        });
    }

    // Quién imparte cada clase lo decide el departamento. Mientras reparte, el
    // motor elige entre los capacitados —es un estado legítimo— pero conviene
    // decirlo: el coordinador tiene que saber cuánto de lo que va a salir es
    // decisión del departamento y cuánto lo eligió el algoritmo.
    const clases = grupos.reduce((n, grupo) => n + grupo.materias.length, 0);
    const sinAsignar = grupos.reduce(
        (n, grupo) => n + grupo.materias.filter((id) => !grupo.asignaciones?.[id]).length,
        0
    );
    if (sinAsignar > 0) {
        advertencias.push({
            codigo: "clases-sin-asignar",
            mensaje:
                `${sinAsignar} de ${clases} clases no tienen docente asignado por el departamento. ` +
                "El motor elegirá entre los capacitados; para fijar a alguien hay que pedírselo al " +
                "departamento académico.",
            detalle: []
        });
    }

    if (horasTotales > capacidad) {
        bloqueos.push({
            codigo: "capacidad-docente",
            mensaje:
                `La carga del periodo (${horasTotales} h/semana) excede la capacidad docente ` +
                `máxima (${capacidad} h/semana).`,
            seccion: "docentes",
            detalle: []
        });
    }

    // ---- advertencias ----

    const huerfanas = delPeriodo.filter((materia) => !enGrupos.has(materia.id));
    if (huerfanas.length > 0) {
        advertencias.push({
            codigo: "materias-sin-grupo",
            mensaje:
                `${huerfanas.length} materias del periodo no se programarán porque ningún grupo las cursa. ` +
                "Suele pasar cuando una especialidad tiene cero grupos.",
            detalle: huerfanas.map((materia) => `${materia.clave} · ${materia.nombre}`)
        });
    }

    // La restricción de capacidad existe y las aulas tienen su cupo, pero sin
    // alumnos no compara nada y el coordinador no tiene cómo enterarse: el
    // horario sale igual y parece comprobado. Importa sobre todo al fusionar,
    // que es donde dos grupos suman y pueden no caber.
    const sinAlumnos = grupos.filter((g) => !(g.alumnos > 0));
    if (sinAlumnos.length > 0) {
        const conCupo = aulas.filter((a) => a.capacidad != null).length;
        advertencias.push({
            codigo: "grupos-sin-alumnos",
            mensaje:
                `${sinAlumnos.length} de ${grupos.length} grupos no tienen alumnos capturados, así que ` +
                `no se comprobará que quepan en el aula` +
                (conCupo > 0 ? ` (${conCupo} aulas sí tienen cupo registrado).` : "."),
            seccion: "generar",
            detalle: sinAlumnos.map((g) => `${g.clave} · semestre ${g.semestre}`)
        });
    }

    const unicos = aProgramar.filter((materia) => conteo.get(materia.id) === 1);
    if (unicos.length > 0) {
        advertencias.push({
            codigo: "docente-unico",
            mensaje:
                `${unicos.length} materias tienen un único docente capacitado: su asignación queda ` +
                "forzada y el algoritmo no puede optimizarla.",
            detalle: []
        });
    }

    return {
        listo: bloqueos.length === 0,
        bloqueos,
        advertencias,
        resumen: {
            paridad,
            semestres: [...new Set(aProgramar.map((m) => m.semestre))].sort((a, b) => a - b),
            grupos: grupos.length,
            materias: aProgramar.length,
            // Clases, no materias: una materia con tres grupos son tres
            // decisiones del departamento, y es lo que se reparte.
            clases,
            sinAsignar,
            horasTotales,
            capacidadDocente: capacidad
        }
    };
}

function etiqueta(paridad) {
    return paridad === "pares" ? "los semestres pares" : "los semestres impares";
}

function resumenVacio(paridad) {
    return {
        paridad,
        semestres: [],
        grupos: 0,
        materias: 0,
        clases: 0,
        sinAsignar: 0,
        horasTotales: 0,
        capacidadDocente: 0
    };
}
