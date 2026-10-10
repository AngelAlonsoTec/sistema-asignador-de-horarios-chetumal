/**
 * Comprobaciones previas a generar un horario.
 *
 * Tres categorías, y lo que las separa es qué se puede hacer al respecto:
 *
 * - **Bloqueos.** Faltan datos. No se genera nada: un horario sacado de datos
 *   incompletos parece un resultado y no lo es, y quien lo revisa pierde el
 *   tiempo buscando el error en la propuesta en vez de en los datos.
 * - **Necesidades.** Los datos están completos y no alcanzan. No falta
 *   capturar: falta gente. El mapeo del problema que entregó el departamento lo
 *   resuelve así —*"en caso de que no haya maestro para cubrir alguna materia
 *   por esta razón u otra, se deja esa materia para contratar a una persona por
 *   horas. Entonces se marca como una necesidad"*—, y es lo correcto: el
 *   horario sale con lo que se puede cubrir y lo que falta se entrega con
 *   nombre y con horas, que es lo que el departamento necesita para contratar.
 *   Bloquear aquí dejaba sin horario justo al plantel que tiene el déficit.
 * - **Advertencias.** Configuraciones legítimas que conviene revisar.
 *
 * Cada bloqueo y cada necesidad dicen en qué sección se atienden, para que la
 * interfaz pueda llevar directo ahí en lugar de dejar al usuario buscándolo.
 */

import { contarDocentesPorMateria } from "./cobertura.js";
import { semestresDe } from "./periodo.js";
import { MAX_MATERIAS } from "./tecnm.js";

export function validarParaHorario({ datos, aulas, rejilla, grupos, paridad, ocupadas = [] }) {
    const bloqueos = [];
    const necesidades = [];
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
        return { listo: false, bloqueos, necesidades, advertencias, resumen: resumenVacio(paridad) };
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

    // Las materias que nadie puede dar no bloquean: se apartan del horario y se
    // reportan como necesidad más abajo, cuando ya se sabe cuántas horas son.
    const sinDocente = aProgramar.filter((materia) => conteo.get(materia.id) === 0);
    const idsSinDocente = new Set(sinDocente.map((materia) => materia.id));

    // Salvo que no quede ninguna: apartarlas todas no deja horario que generar,
    // y eso sí es un bloqueo. No es el déficit de plantilla del que habla el
    // mapeo —es una plantilla que no cubre nada— y se arregla capturando.
    if (aProgramar.length > 0 && sinDocente.length === aProgramar.length) {
        bloqueos.push({
            codigo: "sin-materias-con-docente",
            mensaje:
                `Ninguna de las ${aProgramar.length} materias del periodo tiene quien la dé: ` +
                "no queda nada que programar.",
            seccion: "materias",
            detalle: sinDocente.map((materia) => `${materia.clave} · ${materia.nombre}`)
        });
    }

    // Fijar a alguien que no está autorizado para la materia no es media
    // decisión: el motor respeta lo que el departamento fija y no lo cambia, así
    // que la clase sale marcada como no capacitada y el horario entero queda
    // infactible sin que el coordinador pueda hacer nada con él. Y no se arregla
    // contratando —la materia sí tiene quien la dé—, así que es un bloqueo y no
    // una necesidad: hay que autorizar a esa persona o repartir la clase a otra.
    const porId = new Map(aProgramar.map((materia) => [materia.id, materia]));
    const autorizadas = new Map(
        datos.docentes.map((docente) => [docente.id, new Set(docente.materiasCapacitadas ?? [])])
    );
    const nombreDocente = new Map(datos.docentes.map((d) => [d.id, d.nombre ?? d.id]));
    const malAsignadas = [];
    for (const grupo of grupos) {
        for (const [materiaId, docenteId] of Object.entries(grupo.asignaciones ?? {})) {
            if (!porId.has(materiaId) || autorizadas.get(docenteId)?.has(materiaId)) continue;
            const materia = porId.get(materiaId);
            malAsignadas.push(
                `${materia.clave} · ${materia.nombre} en ${grupo.clave}: ` +
                    `${nombreDocente.get(docenteId) ?? docenteId} no está autorizado`
            );
        }
    }
    if (malAsignadas.length > 0) {
        bloqueos.push({
            codigo: "asignacion-sin-autorizacion",
            mensaje:
                `${malAsignadas.length} clases están asignadas a alguien que no está autorizado ` +
                "para esa materia. El motor no puede cambiarlas, así que el horario saldría sin " +
                "poder aplicarse.",
            seccion: "materias",
            detalle: malAsignadas
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
    // Las horas que hay que contratar, no las materias: una materia que cursan
    // tres grupos son tres clases, y se contratan las tres.
    let horasSinDocente = 0;

    for (const grupo of grupos) {
        const horas = grupo.materias.reduce((suma, id) => suma + (horasDe.get(id) ?? 0), 0);
        horasTotales += horas;
        horasSinDocente += grupo.materias
            .filter((id) => idsSinDocente.has(id))
            .reduce((suma, id) => suma + (horasDe.get(id) ?? 0), 0);

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

    // ---- necesidades ----

    // Lo que sí se va a programar: lo apartado por no tener quien lo dé no
    // llega al motor, así que tampoco cuenta contra la capacidad.
    const horasProgramables = horasTotales - horasSinDocente;

    if (sinDocente.length > 0) {
        necesidades.push({
            codigo: "materias-sin-docente",
            mensaje:
                `${sinDocente.length} materias no tienen a nadie autorizado para darlas ` +
                `(${horasSinDocente} h/semana). Se quedan fuera del horario: hay que autorizar ` +
                "a alguien de la plantilla o contratar por horas.",
            seccion: "materias",
            horas: horasSinDocente,
            detalle: sinDocente.map(
                (materia) => `${materia.clave} · ${materia.nombre}: ${materia.horasSemana} h`
            )
        });
    }

    if (horasProgramables > capacidad) {
        const faltan = horasProgramables - capacidad;
        necesidades.push({
            codigo: "capacidad-docente",
            mensaje:
                `Faltan ${faltan} h/semana de plantilla: lo que queda por programar son ` +
                `${horasProgramables} h y la capacidad máxima de los docentes es ${capacidad} h. ` +
                "El horario sale con esas horas encima del máximo de alguien hasta que se contrate.",
            seccion: "docentes",
            horas: faltan,
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

    // El tope de materias del artículo 155 lo puede romper el **reparto** sin que
    // nadie lo note. El departamento fija a alguien en cuatro materias distintas,
    // el motor respeta lo fijado y no lo puede mover, y entonces el horario sale
    // con `excesoMaterias` en todas las corridas: medido sobre ISIC, ocho
    // semillas con mil doscientas generaciones cada una, los empalmes y las horas
    // no disponibles cambian con la semilla y el exceso de materias aparece en
    // las ocho. El coordinador veía un número que no podía mover y lo leía como
    // un mal resultado del algoritmo.
    //
    // Es aviso y no bloqueo, como el resto de lo que sale del reglamento: un
    // plantel real tiene comisiones y plazas mixtas, y un sistema que se niegue a
    // programar por eso no se usa. Lo que no puede es callarlo.
    const materiasFijadas = new Map();
    for (const grupo of grupos) {
        for (const [materiaId, docenteId] of Object.entries(grupo.asignaciones ?? {})) {
            if (!porId.has(materiaId)) continue;
            if (!materiasFijadas.has(docenteId)) materiasFijadas.set(docenteId, new Set());
            materiasFijadas.get(docenteId).add(materiaId);
        }
    }
    const topeDe = new Map(
        datos.docentes.map((d) => [d.id, d.maxMaterias ?? MAX_MATERIAS])
    );
    const pasados = [...materiasFijadas]
        .map(([docenteId, suyas]) => ({
            docenteId,
            cuantas: suyas.size,
            tope: topeDe.get(docenteId) ?? MAX_MATERIAS,
            claves: [...suyas].map((id) => porId.get(id).clave).sort()
        }))
        .filter((x) => x.cuantas > x.tope)
        .sort((a, b) => b.cuantas - a.cuantas);

    if (pasados.length > 0) {
        advertencias.push({
            codigo: "reparto-sobre-el-tope-de-materias",
            mensaje:
                `${pasados.length} ${pasados.length === 1 ? "docente tiene" : "docentes tienen"} ` +
                "fijadas más materias distintas de las que su nombramiento permite. El motor " +
                "respeta lo que el departamento fija y no lo puede mover, así que el horario va a " +
                "salir con ese exceso por muchas veces que se genere: hay que pasarle una materia " +
                "a alguien más o subirle el tope a esa persona.",
            detalle: pasados.map(
                (x) =>
                    `${nombreDocente.get(x.docenteId) ?? x.docenteId}: ${x.cuantas} materias ` +
                    `fijadas y su tope son ${x.tope} — ${x.claves.join(", ")}`
            )
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
        necesidades,
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
            // Lo que de verdad se le pide al motor: la carga menos lo apartado.
            horasSinDocente,
            horasProgramables,
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
        horasSinDocente: 0,
        horasProgramables: 0,
        capacidadDocente: 0
    };
}
