//! El problema de horarios tal como lo recibe el motor, y la solución que
//! devuelve.
//!
//! Esta es deliberadamente la *frontera* del microservicio: no es el esquema de
//! almacenamiento. Los archivos JSON del backend describen la retícula y la
//! plantilla docente; aquí llega un problema ya resuelto de ambigüedades
//! (rejilla de tiempo explícita, grupos materializados, laboratorios marcados).
//! El backend hace esa traducción. El motor no lee disco ni conoce escenarios.
//!
//! Todo se indexa a `usize` al entrar: el evaluador corre millones de veces y
//! comparar cadenas ahí sería el cuello de botella. Los identificadores
//! originales se conservan solo para poder nombrarlos en la respuesta.

use crate::json::{self, Valor};
use std::collections::HashMap;

// ---------------------------------------------------------------- rejilla

#[derive(Debug, Clone)]
pub struct Turno {
    pub id: String,
    pub hora_inicio: u8,
    pub hora_fin: u8,
}

#[derive(Debug, Clone)]
pub struct Rejilla {
    pub dias: Vec<String>,
    pub turnos: Vec<Turno>,
    /// Horas seguidas como máximo en un mismo bloque. Una materia de 5 h se
    /// reparte en 2+2+1 con el valor 2.
    pub duracion_maxima_bloque: u8,
    /// Horas de clase que un docente puede dar en un mismo día.
    ///
    /// El otro tope diario, y no el mismo que el anterior: aquél limita una
    /// materia frente a un grupo, éste limita la jornada de una persona. Son
    /// las ocho horas laborables del día; el máximo semanal es su contrato y
    /// viaja en cada docente.
    pub max_horas_dia_docente: u8,
}

impl Rejilla {
    /// Casillas de la semana: días por horas. Es el tamaño de las máscaras de
    /// disponibilidad.
    pub fn casillas(&self) -> usize {
        let (base, fin) = self.rango_horas();
        self.dias.len() * (fin - base) as usize
    }

    /// Primera y última hora de toda la rejilla, para dimensionar las tablas
    /// de ocupación sin desperdiciar memoria en las horas que nadie usa.
    pub fn rango_horas(&self) -> (u8, u8) {
        let inicio = self.turnos.iter().map(|t| t.hora_inicio).min().unwrap_or(0);
        let fin = self.turnos.iter().map(|t| t.hora_fin).max().unwrap_or(24);
        (inicio, fin)
    }
}

// ---------------------------------------------------------------- entidades

#[derive(Debug, Clone)]
pub struct Materia {
    pub id: String,
    pub clave: String,
    pub nombre: String,
    pub horas_semana: u8,
    pub requiere_laboratorio: bool,
    pub es_de_especialidad: bool,
}

#[derive(Debug, Clone)]
pub struct Docente {
    pub id: String,
    pub nombre: String,
    pub horas_min: u16,
    pub horas_max: u16,
    pub max_materias: u16,
    pub max_grupos: u16,
    pub es_de_otra_area: bool,
    /// Horas en que puede dar clase, indexadas por `dia * horas + (hora - base)`.
    ///
    /// Llega resuelta desde el backend: ya trae descontadas las descargas
    /// administrativas y lo que otras carreras le ocuparon. El motor no sabe de
    /// turnos ni de comisiones, solo de horas libres, y eso sustituye a lo que
    /// antes eran tres conceptos sueltos (`turno`, `diasEvitar`, `horasEvitar`).
    pub disponible: Vec<bool>,
    /// Horas que prefiere no dar aunque pueda. Penalización blanda.
    pub evita: Vec<bool>,
    /// Cuánto se respeta su preferencia frente a la de otro. 0 es lo normal.
    ///
    /// La pone el coordinador, no se deduce de ningún dato. Cuando dos docentes
    /// evitan la misma hora y solo uno puede librarse, cede el de menos
    /// prioridad. No es una restricción dura: nadie tiene derecho a una hora
    /// concreta, y subir la prioridad de todos equivale a no subirla a nadie.
    pub prioridad: f64,
    /// Horas que **otra carrera ya pretende** de este docente.
    ///
    /// Se penalizan aparte de las no disponibles porque son de naturaleza
    /// distinta: una hora que el docente no declaró es imposible y punto; una
    /// que otra carrera pretende se puede negociar. El motor prefiere lo libre,
    /// pero si no alcanza toma la disputada y la deja visible como conflicto,
    /// en vez de rendirse y entregar un horario incompleto.
    pub en_disputa: Vec<bool>,
    /// Materias que puede impartir, por índice. Si está vacío el docente no es
    /// asignable a nada y el evaluador lo penaliza en cuanto se le asigne algo.
    pub capacitado: Vec<usize>,
}

#[derive(Debug, Clone)]
pub struct Grupo {
    /// `materia -> docente` que el departamento asignó a **este** grupo.
    ///
    /// Por grupo y no por materia: una materia con tres grupos puede llevarlos
    /// la misma persona o repartirse entre varias, y los dos casos existen.
    pub asignaciones: HashMap<usize, u16>,
    pub id: String,
    pub clave: String,
    pub semestre: u8,
    pub turno: usize,
    pub materias: Vec<usize>,
    /// Alumnos del grupo. Solo se usa para comprobar que quepan en el aula,
    /// sobre todo al fusionar: dos grupos juntos necesitan el doble de sillas.
    pub alumnos: u32,
    /// Aula fija del grupo. Los alumnos no cambian de salón: el docente es
    /// quien rota. Todas las materias del grupo se dan aquí salvo las que
    /// piden laboratorio, que es la única razón para salir del aula.
    ///
    /// La elige el backend, no el algoritmo: repartir aulas entre grupos es
    /// una decisión de la coordinación y tiene solución directa. Dejarla al
    /// motor solo agrandaría el espacio de búsqueda sin mejorar el horario.
    pub aula_base: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct Aula {
    pub id: String,
    pub clave: String,
    pub es_laboratorio: bool,
    /// Alumnos que caben. `None` = sin dato, y entonces no se comprueba: es
    /// preferible a inventar un número y rechazar horarios que sí caben.
    pub capacidad: Option<u32>,
    /// Horas en que otra carrera ya usa este espacio. Los salones son del
    /// plantel, así que dos carreras pueden pedir el mismo a la misma hora.
    pub ocupada: Vec<bool>,
}

/// Un bloque de clase por colocar: grupos y materia fijos, duración fija. Lo que
/// el algoritmo decide es el gen correspondiente (docente, aula, día y hora).
#[derive(Debug, Clone)]
pub struct Sesion {
    /// Docente que el departamento asignó a esta clase, si lo hizo.
    ///
    /// Cuando viene, el algoritmo **no elige docente**: solo coloca el bloque.
    /// El departamento no autoriza a un conjunto de capaces para que el motor
    /// escoja, decide quién se para frente a ese grupo. Sin asignar, se busca
    /// entre los capacitados, que es lo que había antes.
    pub docente_fijo: Option<u16>,
    /// Grupos que reciben la clase juntos. Casi siempre es uno; con varios es
    /// una **fusión**: grupos de carreras distintas que cursan la misma materia
    /// en la misma hora, con el mismo docente y en la misma aula.
    ///
    /// El primero es el principal y de él se toman el turno y el aula. Los
    /// demás ocupan su horario pero están de visita en el salón del principal.
    pub grupos: Vec<usize>,
    pub materia: usize,
    pub duracion: u8,
    /// La clase de la que este bloque forma parte: una materia frente a un
    /// grupo. Cinco horas se programan en tres bloques, pero son **una sola
    /// clase**, y la imparte una sola persona. Sin esto el algoritmo podía
    /// repartir los bloques de una misma materia entre dos docentes.
    pub clase: usize,
}

impl Sesion {
    #[inline]
    pub fn principal(&self) -> usize {
        self.grupos[0]
    }

    pub fn es_fusionada(&self) -> bool {
        self.grupos.len() > 1
    }
}

// ---------------------------------------------------------------- pesos y parámetros

/// Costo de cada violación. Las duras pesan órdenes de magnitud más que las
/// blandas: un horario con un empalme es inservible, uno con un hueco solo es
/// incómodo. Que sean configurables permite estudiar su efecto, que es
/// justamente una de las preguntas de la investigación.
#[derive(Debug, Clone)]
pub struct Pesos {
    pub docente_no_capacitado: f64,
    pub choque_docente: f64,
    pub choque_grupo: f64,
    pub choque_aula: f64,
    pub aula_inadecuada: f64,
    pub fuera_de_aula_base: f64,
    pub aula_insuficiente: f64,
    pub aula_ocupada_por_otros: f64,
    pub materia_repetida_dia: f64,
    pub hora_no_disponible: f64,
    pub hora_en_disputa: f64,
    pub exceso_materias: f64,
    pub exceso_grupos: f64,
    pub horas_bajo_minimo: f64,
    pub horas_sobre_maximo: f64,
    /// Horas de más en la jornada de un día. Ver `Rejilla::max_horas_dia_docente`.
    pub horas_dia_sobre_maximo: f64,
    pub hora_evitada: f64,
    pub hueco_grupo: f64,
    pub hueco_docente: f64,
    /// Cuánto inclina la prioridad el reparto de las horas evitadas.
    ///
    /// El valor por omisión está medido, no elegido a ojo: en 1 la herramienta
    /// casi no se nota, y en 20 los priorizados ya no mejoran pero los demás
    /// empeoran. En 0 la prioridad deja de tener efecto.
    pub prioridad: f64,
    pub especialidad_tardia: f64,
    pub otra_area_tardia: f64,
}

impl Default for Pesos {
    fn default() -> Self {
        Self {
            docente_no_capacitado: 1000.0,
            choque_docente: 1000.0,
            choque_grupo: 1000.0,
            choque_aula: 1000.0,
            aula_inadecuada: 500.0,
            fuera_de_aula_base: 500.0,
            aula_insuficiente: 600.0,
            aula_ocupada_por_otros: 700.0,
            materia_repetida_dia: 800.0,
            hora_no_disponible: 900.0,
            // Menos que la anterior a propósito: entre una hora que el docente
            // no tiene y una que otra carrera pretende, siempre la segunda.
            hora_en_disputa: 400.0,
            exceso_materias: 300.0,
            exceso_grupos: 300.0,
            horas_bajo_minimo: 20.0,
            horas_sobre_maximo: 100.0,
            // Igual que el semanal: son la misma clase de violación —horas de
            // más sobre un tope que no es del algoritmo sino del contrato— y
            // ordenarlas entre sí sería inventar una jerarquía que nadie fijó.
            horas_dia_sobre_maximo: 100.0,
            hora_evitada: 10.0,
            hueco_grupo: 3.0,
            // Más que el del grupo: el alumno con una hora libre se queda en el
            // campus, pero el docente con clase a las 7 y a las 13 pierde el día
            // entero, y es quien firma el horario o lo rechaza.
            hueco_docente: 8.0,
            prioridad: 5.0,
            especialidad_tardia: 1.0,
            otra_area_tardia: 1.0,
        }
    }
}

impl Pesos {
    fn desde(v: &Valor) -> Self {
        let d = Pesos::default();
        Self {
            docente_no_capacitado: v.real_o("docenteNoCapacitado", d.docente_no_capacitado),
            choque_docente: v.real_o("choqueDocente", d.choque_docente),
            choque_grupo: v.real_o("choqueGrupo", d.choque_grupo),
            choque_aula: v.real_o("choqueAula", d.choque_aula),
            aula_inadecuada: v.real_o("aulaInadecuada", d.aula_inadecuada),
            fuera_de_aula_base: v.real_o("fueraDeAulaBase", d.fuera_de_aula_base),
            aula_insuficiente: v.real_o("aulaInsuficiente", d.aula_insuficiente),
            aula_ocupada_por_otros: v.real_o("aulaOcupadaPorOtros", d.aula_ocupada_por_otros),
            materia_repetida_dia: v.real_o("materiaRepetidaDia", d.materia_repetida_dia),
            hora_no_disponible: v.real_o("horaNoDisponible", d.hora_no_disponible),
            hora_en_disputa: v.real_o("horaEnDisputa", d.hora_en_disputa),
            exceso_materias: v.real_o("excesoMaterias", d.exceso_materias),
            exceso_grupos: v.real_o("excesoGrupos", d.exceso_grupos),
            horas_bajo_minimo: v.real_o("horasBajoMinimo", d.horas_bajo_minimo),
            horas_sobre_maximo: v.real_o("horasSobreMaximo", d.horas_sobre_maximo),
            horas_dia_sobre_maximo: v.real_o("horasDiaSobreMaximo", d.horas_dia_sobre_maximo),
            hora_evitada: v.real_o("horaEvitada", d.hora_evitada),
            hueco_grupo: v.real_o("huecoGrupo", d.hueco_grupo),
            hueco_docente: v.real_o("huecoDocente", d.hueco_docente),
            prioridad: v.real_o("prioridad", d.prioridad).max(0.0),
            especialidad_tardia: v.real_o("especialidadTardia", d.especialidad_tardia),
            otra_area_tardia: v.real_o("otraAreaTardia", d.otra_area_tardia),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Parametros {
    pub islas: usize,
    pub poblacion_por_isla: usize,
    pub generaciones: usize,
    /// Generaciones entre migraciones. También define la longitud de una época:
    /// las islas corren en paralelo una época completa y se sincronizan al
    /// final, lo que mantiene el resultado reproducible.
    pub migracion_cada: usize,
    pub migrantes: usize,
    pub prob_cruce: f64,
    pub prob_mutacion: f64,
    pub elite: usize,
    pub torneo: usize,
    /// Intensidad de la búsqueda local que convierte al genético en memético.
    /// 0 lo desactiva y deja un genético puro, útil como línea base.
    pub busqueda_local: usize,
    pub semilla: u64,
    pub pesos: Pesos,
}

impl Default for Parametros {
    fn default() -> Self {
        Self {
            islas: 0, // 0 = tantas como núcleos disponibles
            poblacion_por_isla: 60,
            generaciones: 600,
            migracion_cada: 40,
            migrantes: 3,
            prob_cruce: 0.9,
            prob_mutacion: 0.12,
            elite: 2,
            torneo: 3,
            busqueda_local: 30,
            semilla: 20260910,
            pesos: Pesos::default(),
        }
    }
}

impl Parametros {
    fn desde(v: &Valor) -> Self {
        let d = Parametros::default();
        let islas = match v.usize_o("islas", d.islas) {
            0 => std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4),
            n => n,
        };
        Self {
            islas,
            poblacion_por_isla: v.usize_o("poblacionPorIsla", d.poblacion_por_isla).max(4),
            generaciones: v.usize_o("generaciones", d.generaciones),
            migracion_cada: v.usize_o("migracionCada", d.migracion_cada).max(1),
            migrantes: v.usize_o("migrantes", d.migrantes),
            prob_cruce: v.real_o("probCruce", d.prob_cruce).clamp(0.0, 1.0),
            prob_mutacion: v.real_o("probMutacion", d.prob_mutacion).clamp(0.0, 1.0),
            elite: v.usize_o("elite", d.elite).max(1),
            torneo: v.usize_o("torneo", d.torneo).max(2),
            busqueda_local: v.usize_o("busquedaLocal", d.busqueda_local),
            semilla: v.numero_de("semilla").map(|n| n as u64).unwrap_or(d.semilla),
            pesos: v.campo("pesos").map(Pesos::desde).unwrap_or(d.pesos),
        }
    }
}

// ---------------------------------------------------------------- problema

#[derive(Debug)]
pub struct Problema {
    pub rejilla: Rejilla,
    pub materias: Vec<Materia>,
    pub docentes: Vec<Docente>,
    pub grupos: Vec<Grupo>,
    pub aulas: Vec<Aula>,
    pub sesiones: Vec<Sesion>,
    pub parametros: Parametros,
    /// Por materia, los docentes capacitados. Es el inverso de
    /// `Docente::capacitado` y lo usa la inicialización para no proponer
    /// asignaciones imposibles desde la primera generación.
    pub docentes_por_materia: Vec<Vec<usize>>,
    pub aulas_normales: Vec<usize>,
    pub aulas_laboratorio: Vec<usize>,
    /// Los bloques de cada clase. Es el inverso de `Sesion::clase` y sirve para
    /// propagar el docente a todos los bloques cuando se cambia en uno.
    pub sesiones_de_clase: Vec<Vec<usize>>,
}

impl Problema {
    pub fn leer(entrada: &str) -> Result<Problema, String> {
        let v = json::leer(entrada)?;
        let rejilla = leer_rejilla(v.campo("rejilla").ok_or("falta 'rejilla'")?)?;

        let materias = leer_materias(v.lista_de("materias"))?;
        if materias.is_empty() {
            return Err("el problema no tiene materias".to_owned());
        }
        let indice_materia = indexar(materias.iter().map(|m| m.id.as_str()));

        let aulas = leer_aulas(v.lista_de("aulas"), &rejilla)?;
        if aulas.is_empty() {
            return Err("el problema no tiene aulas".to_owned());
        }

        let docentes = leer_docentes(v.lista_de("docentes"), &indice_materia, &rejilla)?;
        if docentes.is_empty() {
            return Err("el problema no tiene docentes".to_owned());
        }

        let indice_aula = indexar(aulas.iter().map(|a| a.id.as_str()));
        let indice_docente: HashMap<&str, u16> = docentes
            .iter()
            .enumerate()
            .map(|(i, d)| (d.id.as_str(), i as u16))
            .collect();
        let grupos = leer_grupos(
            v.lista_de("grupos"),
            &indice_materia,
            &indice_aula,
            &indice_docente,
            &rejilla,
        )?;
        if grupos.is_empty() {
            return Err("el problema no tiene grupos; sin grupos no hay nada que programar".to_owned());
        }

        let fusiones = leer_fusiones(v.lista_de("fusiones"), &indice_materia, &grupos)?;
        let sesiones = construir_sesiones(&grupos, &materias, &rejilla, &fusiones);
        if sesiones.is_empty() {
            return Err("ningún grupo tiene materias con horas por programar".to_owned());
        }

        let mut docentes_por_materia = vec![Vec::new(); materias.len()];
        for (i, docente) in docentes.iter().enumerate() {
            for &materia in &docente.capacitado {
                docentes_por_materia[materia].push(i);
            }
        }

        let mut sesiones_de_clase: Vec<Vec<usize>> = Vec::new();
        for (i, sesion) in sesiones.iter().enumerate() {
            if sesion.clase >= sesiones_de_clase.len() {
                sesiones_de_clase.resize(sesion.clase + 1, Vec::new());
            }
            sesiones_de_clase[sesion.clase].push(i);
        }

        let aulas_normales = (0..aulas.len()).filter(|&i| !aulas[i].es_laboratorio).collect::<Vec<_>>();
        let aulas_laboratorio = (0..aulas.len()).filter(|&i| aulas[i].es_laboratorio).collect::<Vec<_>>();

        let parametros = v.campo("parametros").map(Parametros::desde).unwrap_or_default();

        Ok(Problema {
            rejilla,
            materias,
            docentes,
            grupos,
            aulas,
            sesiones,
            parametros,
            docentes_por_materia,
            aulas_normales,
            aulas_laboratorio,
            sesiones_de_clase,
        })
    }

    /// Materias que ningún docente puede impartir. El motor no puede resolverlas
    /// y lo reporta en lugar de devolver un horario silenciosamente imposible.
    pub fn materias_sin_docente(&self) -> Vec<&str> {
        self.docentes_por_materia
            .iter()
            .enumerate()
            .filter(|(_, docentes)| docentes.is_empty())
            .map(|(i, _)| self.materias[i].id.as_str())
            .collect()
    }

    /// Advertencias que no impiden resolver pero explican por qué el resultado
    /// puede ser malo. Se devuelven junto con la solución.
    pub fn advertencias(&self) -> Vec<String> {
        let mut avisos = Vec::new();

        // Esta va primero porque es la única que hace imposible la factibilidad:
        // ningún horario puede asignar una materia que nadie puede impartir.
        let sin_docente = self.materias_sin_docente();
        if !sin_docente.is_empty() {
            avisos.push(format!(
                "{} materias no tienen ningún docente capacitado, así que ningún horario puede ser factible: {}.",
                sin_docente.len(),
                sin_docente.join(", ")
            ));
        }

        let horas_necesarias: u32 = self.sesiones.iter().map(|s| s.duracion as u32).sum();
        let capacidad: u32 = self.docentes.iter().map(|d| d.horas_max as u32).sum();
        if horas_necesarias > capacidad {
            avisos.push(format!(
                "La carga total ({horas_necesarias} h/semana) excede la capacidad docente máxima ({capacidad} h/semana)."
            ));
        }

        if self.aulas_laboratorio.is_empty()
            && self.materias.iter().any(|m| m.requiere_laboratorio)
        {
            avisos.push("Hay materias que requieren laboratorio y no se registró ninguno.".to_owned());
        }

        // Un grupo cuyas horas no caben en su turno hace imposible evitar los
        // empalmes, por buena que sea la búsqueda. Conviene decirlo con
        // nombre y número en vez de dejar que se lea como un mal resultado.
        for (g, grupo) in self.grupos.iter().enumerate() {
            let horas: u32 = self
                .sesiones
                .iter()
                .filter(|s| s.grupos.contains(&g))
                .map(|s| s.duracion as u32)
                .sum();
            let turno = &self.rejilla.turnos[grupo.turno];
            let ranuras = (turno.hora_fin - turno.hora_inicio) as u32 * self.rejilla.dias.len() as u32;
            if horas > ranuras {
                avisos.push(format!(
                    "El grupo {} necesita {horas} h/semana y su turno ({}) solo tiene {ranuras} ranuras: es imposible acomodarlo sin empalmes.",
                    grupo.clave, turno.id
                ));
            }
        }

        let sin_alternativa = self
            .docentes_por_materia
            .iter()
            .filter(|docentes| docentes.len() == 1)
            .count();
        if sin_alternativa > 0 {
            avisos.push(format!(
                "{sin_alternativa} materias tienen un único docente capacitado: la asignación docente queda forzada y el algoritmo no puede optimizarla."
            ));
        }

        avisos
    }
}

// ---------------------------------------------------------------- lectura

fn indexar<'a>(ids: impl Iterator<Item = &'a str>) -> HashMap<String, usize> {
    ids.enumerate().map(|(i, id)| (id.to_owned(), i)).collect()
}

fn leer_rejilla(v: &Valor) -> Result<Rejilla, String> {
    let dias = v.textos_de("dias");
    if dias.is_empty() {
        return Err("'rejilla.dias' está vacío".to_owned());
    }

    let mut turnos = Vec::new();
    for t in v.lista_de("turnos") {
        let id = t.texto_de("id").ok_or("un turno no tiene 'id'")?.to_owned();
        let hora_inicio = t.entero_o("horaInicio", -1);
        let hora_fin = t.entero_o("horaFin", -1);
        if !(0..=24).contains(&hora_inicio) || !(0..=24).contains(&hora_fin) || hora_fin <= hora_inicio {
            return Err(format!("el turno '{id}' tiene un rango de horas inválido"));
        }
        turnos.push(Turno { id, hora_inicio: hora_inicio as u8, hora_fin: hora_fin as u8 });
    }
    if turnos.is_empty() {
        return Err("'rejilla.turnos' está vacío".to_owned());
    }

    let duracion = v.usize_o("duracionMaximaBloque", 2).clamp(1, 8) as u8;
    // Sin el campo se asumen las ocho horas: es la regla, no una preferencia, y
    // un problema guardado antes de que existiera el campo se rige por ella
    // igual. Para desactivarla hay que pedir las 24 explícitamente.
    let jornada = v.usize_o("maxHorasDiaDocente", 8).clamp(1, 24) as u8;
    Ok(Rejilla { dias, turnos, duracion_maxima_bloque: duracion, max_horas_dia_docente: jornada })
}

fn leer_materias(xs: &[Valor]) -> Result<Vec<Materia>, String> {
    xs.iter()
        .map(|m| {
            let id = m.texto_de("id").ok_or("una materia no tiene 'id'")?.to_owned();
            let horas = m.entero_o("horasSemana", 0);
            if horas <= 0 {
                return Err(format!("la materia '{id}' no tiene horasSemana"));
            }
            Ok(Materia {
                clave: m.texto_de("clave").unwrap_or(&id).to_owned(),
                nombre: m.texto_de("nombre").unwrap_or(&id).to_owned(),
                horas_semana: horas.min(40) as u8,
                requiere_laboratorio: m.bool_o("requiereLaboratorio", false),
                // El motor solo necesita saber si es de especialidad, para la
                // regla de prioridad; cuál especialidad es asunto del backend.
                es_de_especialidad: m.campo("especialidadId").is_some(),
                id,
            })
        })
        .collect()
}

fn leer_aulas(xs: &[Valor], rejilla: &Rejilla) -> Result<Vec<Aula>, String> {
    xs.iter()
        .map(|a| {
            let id = a.texto_de("id").ok_or("un aula no tiene 'id'")?.to_owned();
            Ok(Aula {
                clave: a.texto_de("clave").unwrap_or(&id).to_owned(),
                es_laboratorio: a.texto_de("tipo") == Some("laboratorio"),
                capacidad: a.numero_de("capacidad").map(|n| n.max(0.0) as u32),
                ocupada: mascara(a.lista_de("ocupada"), rejilla),
                id,
            })
        })
        .collect()
}

fn leer_docentes(
    xs: &[Valor],
    indice_materia: &HashMap<String, usize>,
    rejilla: &Rejilla,
) -> Result<Vec<Docente>, String> {
    xs.iter()
        .map(|d| {
            let id = d.texto_de("id").ok_or("un docente no tiene 'id'")?.to_owned();

            // Las materias desconocidas se descartan en silencio: un escenario
            // puede haber borrado una materia que algún docente todavía lista.
            let capacitado = d
                .textos_de("materiasCapacitadas")
                .iter()
                .filter_map(|m| indice_materia.get(m).copied())
                .collect();

            // Sin bloques declarados se asume disponible siempre. Es lo menos
            // sorprendente: un docente recién capturado no debe quedar inservible
            // por no haber contestado todavía el formulario.
            let bloques = d.lista_de("disponible");
            let disponible = if bloques.is_empty() {
                vec![true; rejilla.casillas()]
            } else {
                mascara(bloques, rejilla)
            };

            Ok(Docente {
                nombre: d.texto_de("nombre").unwrap_or(&id).to_owned(),
                horas_min: d.entero_o("horasMin", 0).max(0) as u16,
                horas_max: d.entero_o("horasMax", 40).max(0) as u16,
                max_materias: d.entero_o("maxMaterias", 99).max(0) as u16,
                max_grupos: d.entero_o("maxGrupos", 99).max(0) as u16,
                es_de_otra_area: d.bool_o("esDeOtraArea", false),
                prioridad: d.real_o("prioridad", 0.0).max(0.0),
                disponible,
                evita: mascara(d.lista_de("evita"), rejilla),
                en_disputa: mascara(d.lista_de("enDisputa"), rejilla),
                capacitado,
                id,
            })
        })
        .collect()
}

/// Convierte bloques `{dia, inicio, fin}` en una máscara por casilla de la
/// rejilla. Los días y las horas fuera de rango se ignoran: la rejilla manda.
fn mascara(bloques: &[Valor], rejilla: &Rejilla) -> Vec<bool> {
    let (base, tope) = rejilla.rango_horas();
    let horas = (tope - base) as usize;
    let mut salida = vec![false; rejilla.casillas()];

    for bloque in bloques {
        let Some(dia) = bloque
            .texto_de("dia")
            .and_then(|d| rejilla.dias.iter().position(|x| x == d))
        else {
            continue;
        };
        let inicio = bloque.entero_o("inicio", base as i64).clamp(base as i64, tope as i64) as usize;
        let fin = bloque.entero_o("fin", tope as i64).clamp(base as i64, tope as i64) as usize;

        for h in inicio..fin {
            salida[dia * horas + (h - base as usize)] = true;
        }
    }
    salida
}

fn leer_grupos(
    xs: &[Valor],
    indice_materia: &HashMap<String, usize>,
    indice_aula: &HashMap<String, usize>,
    indice_docente: &HashMap<&str, u16>,
    rejilla: &Rejilla,
) -> Result<Vec<Grupo>, String> {
    xs.iter()
        .map(|g| {
            let id = g.texto_de("id").ok_or("un grupo no tiene 'id'")?.to_owned();
            let nombre_turno = g.texto_de("turno").unwrap_or(&rejilla.turnos[0].id);
            let turno = rejilla
                .turnos
                .iter()
                .position(|t| t.id == nombre_turno)
                .ok_or_else(|| format!("el grupo '{id}' usa el turno desconocido '{nombre_turno}'"))?;

            let materias = g
                .textos_de("materias")
                .iter()
                .filter_map(|m| indice_materia.get(m).copied())
                .collect();

            // Un aula desconocida se trata como "sin aula base": el motor la
            // elegirá y el diagnóstico lo reportará, en vez de tumbar la
            // corrida por un identificador viejo.
            let aula_base = g.texto_de("aulaId").and_then(|a| indice_aula.get(a).copied());

            // `asignaciones: {materiaId: docenteId}`. Lo que no venga se queda
            // sin asignar y el algoritmo elige entre los capacitados, que es el
            // comportamiento de antes: un escenario a medias sigue corriendo.
            let mut asignaciones = HashMap::new();
            if let Some(mapa) = g.campo("asignaciones") {
                for (materia, docente) in mapa.pares() {
                    let Some(&m) = indice_materia.get(materia.as_str()) else { continue };
                    let Some(id) = docente.texto() else { continue };
                    let Some(&d) = indice_docente.get(id) else {
                        return Err(format!(
                            "el grupo '{id_grupo}' tiene asignado a '{id}', que no está en la plantilla",
                            id_grupo = g.texto_de("id").unwrap_or("?")
                        ));
                    };
                    asignaciones.insert(m, d);
                }
            }

            Ok(Grupo {
                clave: g.texto_de("clave").unwrap_or(&id).to_owned(),
                semestre: g.entero_o("semestre", 0).clamp(0, 255) as u8,
                alumnos: g.entero_o("alumnos", 0).max(0) as u32,
                asignaciones,
                turno,
                materias,
                aula_base,
                id,
            })
        })
        .collect()
}

/// Lee un horario ya armado para volver a evaluarlo.
///
/// Es lo que sostiene el **ajuste manual**: el coordinador mueve una clase y hay
/// que decirle qué se rompió. Las reglas viven en el evaluador, así que la
/// comprobación se hace aquí y no reimplementada en el backend, donde se
/// separaría de ellas a la primera que cambie.
///
/// Llega la lista completa de sesiones —la misma que salió al generar, con el
/// cambio ya aplicado— y cada una se identifica por su `indice`. Lo que no venga
/// se queda como estaba.
pub fn leer_horario(problema: &Problema, v: &Valor) -> Result<Cromosoma, String> {
    let sesiones = v.lista_de("sesiones");
    if sesiones.is_empty() {
        return Err("no viene ningún horario que evaluar".to_owned());
    }

    let docentes: HashMap<&str, u16> = problema
        .docentes
        .iter()
        .enumerate()
        .map(|(i, d)| (d.id.as_str(), i as u16))
        .collect();
    let aulas: HashMap<&str, u16> = problema
        .aulas
        .iter()
        .enumerate()
        .map(|(i, a)| (a.id.as_str(), i as u16))
        .collect();

    // Se parte de un horario vacío y cada sesión llena su hueco: así una lista
    // incompleta se detecta en vez de dejar genes sin definir.
    let mut puestas = vec![false; problema.sesiones.len()];
    let mut salida: Cromosoma = vec![Gen { docente: 0, aula: 0, dia: 0, hora: 0 }; problema.sesiones.len()];

    for s in sesiones {
        let i = s.entero_o("indice", -1);
        if i < 0 || i as usize >= salida.len() {
            return Err(format!("la sesión {i} no existe en este horario"));
        }
        let i = i as usize;

        let id = s.texto_de("docenteId").ok_or("una sesión no dice su docente")?;
        let docente = *docentes
            .get(id)
            .ok_or_else(|| format!("el docente '{id}' no está en la plantilla"))?;

        let id = s.texto_de("aulaId").ok_or("una sesión no dice su espacio")?;
        let aula = *aulas
            .get(id)
            .ok_or_else(|| format!("el espacio '{id}' no existe"))?;

        let nombre = s.texto_de("dia").ok_or("una sesión no dice su día")?;
        let dia = problema
            .rejilla
            .dias
            .iter()
            .position(|d| d == nombre)
            .ok_or_else(|| format!("'{nombre}' no es un día de la semana laboral"))?;

        let hora = s.campo("horaInicio").and_then(|h| h.numero()).ok_or("una sesión no dice su hora")?;

        // El bloque tiene que caber en el turno del grupo: fuera de él, el
        // evaluador indexaría su tabla de ocupación fuera de rango.
        let propia = &problema.sesiones[i];
        let turno = &problema.rejilla.turnos[problema.grupos[propia.principal()].turno];
        let tope = turno.hora_fin.saturating_sub(propia.duracion);
        if hora < turno.hora_inicio as f64 || hora > tope as f64 {
            return Err(format!(
                "a las {hora}:00 no cabe un bloque de {} h en el turno {} ({}:00 a {}:00)",
                propia.duracion, turno.id, turno.hora_inicio, turno.hora_fin
            ));
        }

        // Quién imparte no es del coordinador. Si el departamento asignó esta
        // clase, un ajuste que cambie de docente no es mover una clase: es
        // deshacer una decisión ajena, y sale más barato decirlo que aplicarlo.
        if let Some(fijo) = propia.docente_fijo {
            if docente != fijo {
                return Err(format!(
                    "esa clase la imparte {} por decisión del departamento académico: \
                     para cambiarlo hay que pedírselo",
                    problema.docentes[fijo as usize].id
                ));
            }
        }

        salida[i] = Gen { docente, aula, dia: dia as u8, hora: hora as u8 };
        puestas[i] = true;
    }

    if let Some(falta) = puestas.iter().position(|p| !p) {
        return Err(format!("falta la sesión {falta}: el horario llega incompleto"));
    }

    // Una clase la imparte una sola persona, también cuando se edita a mano.
    // El algoritmo ya no puede partirla; a mano sí se podía, y un horario con
    // dos apellidos en la misma materia de un grupo no se puede aplicar.
    for bloques in &problema.sesiones_de_clase {
        let Some(&primero) = bloques.first() else { continue };
        if let Some(&otro) = bloques.iter().find(|&&j| salida[j].docente != salida[primero].docente) {
            let sesion = &problema.sesiones[primero];
            return Err(format!(
                "la misma clase no puede repartirse entre dos docentes: {} del grupo {} \
                 aparece con {} y con {}",
                problema.materias[sesion.materia].id,
                problema.grupos[sesion.principal()].clave,
                problema.docentes[salida[primero].docente as usize].id,
                problema.docentes[salida[otro].docente as usize].id
            ));
        }
    }

    Ok(salida)
}

/// Una materia que varios grupos cursan juntos.
#[derive(Debug, Clone)]
pub struct Fusion {
    pub materia: usize,
    pub grupos: Vec<usize>,
}

/// Lee las fusiones y comprueba que tengan sentido: los grupos deben existir,
/// cursar realmente esa materia y compartir turno. Una fusión entre turnos
/// distintos no es un horario malo, es imposible.
fn leer_fusiones(
    xs: &[Valor],
    indice_materia: &HashMap<String, usize>,
    grupos: &[Grupo],
) -> Result<Vec<Fusion>, String> {
    let indice_grupo: HashMap<&str, usize> = grupos
        .iter()
        .enumerate()
        .map(|(i, g)| (g.id.as_str(), i))
        .collect();

    let mut fusiones = Vec::new();
    for f in xs {
        let clave = f.texto_de("materiaId").ok_or("una fusión no tiene 'materiaId'")?;
        let materia = *indice_materia
            .get(clave)
            .ok_or_else(|| format!("la fusión usa la materia desconocida '{clave}'"))?;

        let mut suyos = Vec::new();
        for id in f.textos_de("grupos") {
            let g = *indice_grupo
                .get(id.as_str())
                .ok_or_else(|| format!("la fusión de '{clave}' usa el grupo desconocido '{id}'"))?;
            if !grupos[g].materias.contains(&materia) {
                return Err(format!("el grupo '{id}' no cursa '{clave}': no se puede fusionar"));
            }
            if suyos.contains(&g) {
                return Err(format!("la fusión de '{clave}' repite el grupo '{id}'"));
            }
            suyos.push(g);
        }

        if suyos.len() < 2 {
            return Err(format!("la fusión de '{clave}' necesita al menos dos grupos"));
        }
        let turno = grupos[suyos[0]].turno;
        if suyos.iter().any(|&g| grupos[g].turno != turno) {
            return Err(format!("la fusión de '{clave}' mezcla grupos de turnos distintos"));
        }

        fusiones.push(Fusion { materia, grupos: suyos });
    }
    Ok(fusiones)
}

/// Duración preferida de un bloque. El reglamento permite hasta tres horas
/// diarias de una materia, pero de una a dos es lo deseable, así que tres es
/// válvula de escape y no valor por omisión.
const BLOQUE_PREFERIDO: u8 = 2;

/// Parte las horas semanales de cada materia en bloques colocables.
///
/// Una materia no puede repetirse el mismo día, así que necesita tantos días
/// hábiles como bloques tenga. De ahí sale la regla: se usan bloques de dos
/// horas mientras alcancen los días de la semana, y solo cuando no alcanzan se
/// sube a tres. Una materia de cinco horas sale 2+2+1 en tres días, no 3+2 en
/// dos, porque la preferencia es la duración diaria, no el número de bloques.
///
/// El bloque se acota además al largo del turno del grupo. Sin ese tope, un
/// bloque más largo que el turno no cabría en ninguna hora válida y el
/// evaluador indexaría su tabla de ocupación fuera de rango.
fn construir_sesiones(
    grupos: &[Grupo],
    materias: &[Materia],
    rejilla: &Rejilla,
    fusiones: &[Fusion],
) -> Vec<Sesion> {
    let dias = rejilla.dias.len() as u16;
    let mut sesiones = Vec::new();

    // Una materia fusionada se programa una sola vez, desde su grupo principal;
    // los demás participantes la reciben en esa misma sesión. Este mapa dice, de
    // cada par (grupo, materia), a qué fusión pertenece.
    let mut de_fusion: HashMap<(usize, usize), usize> = HashMap::new();
    for (i, fusion) in fusiones.iter().enumerate() {
        for &g in &fusion.grupos {
            de_fusion.insert((g, fusion.materia), i);
        }
    }

    let mut clase = 0;

    for (g, grupo) in grupos.iter().enumerate() {
        let turno = &rejilla.turnos[grupo.turno];
        let techo = rejilla
            .duracion_maxima_bloque
            .min(turno.hora_fin - turno.hora_inicio)
            .max(1);

        for &m in &grupo.materias {
            let participantes = match de_fusion.get(&(g, m)) {
                Some(&i) => {
                    // Solo el principal la genera; el resto ya está incluido.
                    if fusiones[i].grupos[0] != g {
                        continue;
                    }
                    fusiones[i].grupos.clone()
                }
                None => vec![g],
            };

            // La asignación es del grupo principal: una clase la imparte una
            // persona, y en una fusión es la del grupo que la recibe en su aula.
            let asignado = grupo.asignaciones.get(&m).copied();

            let horas = materias[m].horas_semana;
            let tope = tope_para(horas, dias, techo);

            let mut restantes = horas;
            while restantes > 0 {
                let duracion = restantes.min(tope);
                sesiones.push(Sesion {
                    grupos: participantes.clone(),
                    materia: m,
                    duracion,
                    docente_fijo: asignado,
                    clase,
                });
                restantes -= duracion;
            }
            clase += 1;
        }
    }
    sesiones
}

/// El bloque más corto que permite repartir `horas` en los días disponibles,
/// sin pasar de `techo`. Devuelve `techo` si ni siquiera así alcanza: el
/// problema es infactible y lo reporta la validación, no este reparto.
fn tope_para(horas: u8, dias: u16, techo: u8) -> u8 {
    let cabe = |t: u8| t > 0 && (horas as u16).div_ceil(t as u16) <= dias;

    (BLOQUE_PREFERIDO.min(techo)..=techo)
        .find(|&t| cabe(t))
        .unwrap_or(techo)
}

// ---------------------------------------------------------------- solución

/// Un gen: las cuatro decisiones que toma el algoritmo para una sesión.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gen {
    pub docente: u16,
    pub aula: u16,
    pub dia: u8,
    pub hora: u8,
}

pub type Cromosoma = Vec<Gen>;

#[derive(Debug, Clone, Default)]
pub struct Diagnostico {
    pub docente_no_capacitado: u32,
    pub choque_docente: u32,
    pub choque_grupo: u32,
    pub choque_aula: u32,
    pub aula_inadecuada: u32,
    /// Clases de un grupo fuera de su aula asignada sin ser de laboratorio.
    pub fuera_de_aula_base: u32,
    /// Clases en un espacio donde no caben los alumnos.
    pub aula_insuficiente: u32,
    /// Horas de un espacio que otra carrera ya está usando.
    pub aula_ocupada_por_otros: u32,
    /// Bloques de una misma materia que caen otra vez el mismo día para el
    /// mismo grupo. Ver la nota en `aptitud.rs`: es lo que garantiza a la vez
    /// el tope de dos horas diarias y que esas horas vayan seguidas.
    pub materia_repetida_dia: u32,
    /// Horas asignadas que el docente no tiene disponibles: no las declaró, o
    /// las ocupa una descarga administrativa u otra carrera.
    pub hora_no_disponible: u32,
    /// Horas tomadas que otra carrera también pretende. No impiden aplicar el
    /// horario: hay que negociarlas, y por eso no cuentan para la factibilidad.
    pub hora_en_disputa: u32,
    pub exceso_materias: u32,
    pub exceso_grupos: u32,
    pub horas_bajo_minimo: u32,
    pub horas_sobre_maximo: u32,
    /// Horas que a un docente le sobran de la jornada en algún día. Se cuentan
    /// las horas que pisa, no los bloques: dos clases encimadas son una hora de
    /// jornada, y el empalme ya se castiga por su cuenta.
    pub horas_dia_sobre_maximo: u32,
    pub hora_evitada: u32,
    /// Horas libres intercaladas entre dos clases del mismo grupo en un día.
    pub huecos: u32,
    /// Las mismas, para el docente. Van aparte porque no son el mismo problema:
    /// un hueco de grupo es una hora muerta en el campus; uno de docente puede
    /// ser un viaje de ida y vuelta al tecnológico.
    pub huecos_docente: u32,
}

impl Diagnostico {
    /// Un horario es factible cuando no viola ninguna restricción dura. Las
    /// blandas degradan la calidad pero no lo vuelven inaplicable.
    pub fn factible(&self) -> bool {
        self.docente_no_capacitado == 0
            && self.choque_docente == 0
            && self.choque_grupo == 0
            && self.choque_aula == 0
            && self.aula_inadecuada == 0
            && self.fuera_de_aula_base == 0
            && self.aula_insuficiente == 0
            && self.aula_ocupada_por_otros == 0
            && self.materia_repetida_dia == 0
            && self.hora_no_disponible == 0
            && self.exceso_materias == 0
            && self.exceso_grupos == 0
            && self.horas_sobre_maximo == 0
            && self.horas_dia_sobre_maximo == 0
    }

    pub fn a_json(&self) -> Valor {
        json::objeto([
            ("docenteNoCapacitado", json::numero(self.docente_no_capacitado)),
            ("choqueDocente", json::numero(self.choque_docente)),
            ("choqueGrupo", json::numero(self.choque_grupo)),
            ("choqueAula", json::numero(self.choque_aula)),
            ("aulaInadecuada", json::numero(self.aula_inadecuada)),
            ("fueraDeAulaBase", json::numero(self.fuera_de_aula_base)),
            ("aulaInsuficiente", json::numero(self.aula_insuficiente)),
            ("aulaOcupadaPorOtros", json::numero(self.aula_ocupada_por_otros)),
            ("materiaRepetidaDia", json::numero(self.materia_repetida_dia)),
            ("horaNoDisponible", json::numero(self.hora_no_disponible)),
            ("horaEnDisputa", json::numero(self.hora_en_disputa)),
            ("excesoMaterias", json::numero(self.exceso_materias)),
            ("excesoGrupos", json::numero(self.exceso_grupos)),
            ("horasBajoMinimo", json::numero(self.horas_bajo_minimo)),
            ("horasSobreMaximo", json::numero(self.horas_sobre_maximo)),
            ("horasDiaSobreMaximo", json::numero(self.horas_dia_sobre_maximo)),
            ("horaEvitada", json::numero(self.hora_evitada)),
            ("huecos", json::numero(self.huecos)),
            ("huecosDocente", json::numero(self.huecos_docente)),
        ])
    }
}

/// Traduce el cromosoma ganador a identificadores y lo empaqueta con el informe
/// de la corrida. El backend lo reenvía al frontend sin reinterpretarlo.
pub fn solucion_a_json(
    problema: &Problema,
    cromosoma: &Cromosoma,
    aptitud: f64,
    diagnostico: &Diagnostico,
    generaciones: usize,
    milisegundos: u128,
    historial: &[f64],
) -> Valor {
    let sesiones = cromosoma
        .iter()
        .zip(&problema.sesiones)
        .enumerate()
        .map(|(i, (gen, sesion))| {
            let grupo = &problema.grupos[sesion.principal()];
            let materia = &problema.materias[sesion.materia];
            let docente = &problema.docentes[gen.docente as usize];
            let aula = &problema.aulas[gen.aula as usize];
            json::objeto([
                // El índice identifica la sesión de una corrida a otra: es lo
                // que permite decir "mueve ESTA" sin reenviar el horario entero.
                ("indice", json::numero(i as u32)),
                ("grupoId", json::texto(&grupo.id)),
                ("grupoClave", json::texto(&grupo.clave)),
                // Una sesión fusionada pertenece a varios grupos a la vez, así
                // que la interfaz filtra por esta lista y no por `grupoId`.
                (
                    "grupoIds",
                    Valor::Lista(
                        sesion
                            .grupos
                            .iter()
                            .map(|&g| json::texto(&problema.grupos[g].id))
                            .collect(),
                    ),
                ),
                // Las claves además de los ids: el horario de un docente nombra
                // a los grupos que recibe la clase, y "1A + 1B" es legible donde
                // un id no lo es.
                (
                    "grupoClaves",
                    Valor::Lista(
                        sesion
                            .grupos
                            .iter()
                            .map(|&g| json::texto(&problema.grupos[g].clave))
                            .collect(),
                    ),
                ),
                ("fusionada", Valor::Bool(sesion.es_fusionada())),
                (
                    "esAulaBase",
                    Valor::Bool(grupo.aula_base == Some(gen.aula as usize)),
                ),
                ("semestre", json::numero(grupo.semestre)),
                ("materiaId", json::texto(&materia.id)),
                ("materiaClave", json::texto(&materia.clave)),
                ("materiaNombre", json::texto(&materia.nombre)),
                ("docenteId", json::texto(&docente.id)),
                ("docenteNombre", json::texto(&docente.nombre)),
                ("aulaId", json::texto(&aula.id)),
                ("aulaClave", json::texto(&aula.clave)),
                ("dia", json::texto(&problema.rejilla.dias[gen.dia as usize])),
                ("diaIndice", json::numero(gen.dia)),
                ("horaInicio", json::numero(gen.hora)),
                ("horaFin", json::numero(gen.hora + sesion.duracion)),
            ])
        })
        .collect::<Vec<_>>();

    // Carga final por docente: es lo primero que revisa la coordinación, y
    // derivarla aquí evita que el frontend tenga que recalcularla.
    let mut horas = vec![0u32; problema.docentes.len()];
    for (gen, sesion) in cromosoma.iter().zip(&problema.sesiones) {
        horas[gen.docente as usize] += sesion.duracion as u32;
    }
    let carga = problema
        .docentes
        .iter()
        .zip(&horas)
        .map(|(docente, &asignadas)| {
            json::objeto([
                ("docenteId", json::texto(&docente.id)),
                ("docenteNombre", json::texto(&docente.nombre)),
                ("horasAsignadas", json::numero(asignadas)),
                ("horasMin", json::numero(docente.horas_min)),
                ("horasMax", json::numero(docente.horas_max)),
            ])
        })
        .collect::<Vec<_>>();

    json::objeto([
        ("aptitud", json::numero(aptitud)),
        ("factible", Valor::Bool(diagnostico.factible())),
        ("generaciones", json::entero(generaciones)),
        ("islas", json::entero(problema.parametros.islas)),
        ("milisegundos", json::numero(milisegundos as f64)),
        ("diagnostico", diagnostico.a_json()),
        ("sesiones", Valor::Lista(sesiones)),
        ("cargaDocente", Valor::Lista(carga)),
        (
            "historial",
            Valor::Lista(historial.iter().map(|&x| json::numero(x)).collect()),
        ),
        (
            "advertencias",
            Valor::Lista(problema.advertencias().into_iter().map(json::texto).collect()),
        ),
        (
            "materiasSinDocente",
            Valor::Lista(
                problema
                    .materias_sin_docente()
                    .into_iter()
                    .map(json::texto)
                    .collect(),
            ),
        ),
    ])
}

#[cfg(test)]
mod pruebas {
    use super::*;

    /// Un grupo, una materia de 4 h (dos bloques), un docente, un aula.
    const EJEMPLO: &str = r#"{
      "rejilla":{"dias":["lunes","martes"],
                 "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}],
                 "duracionMaximaBloque":2},
      "materias":[{"id":"m1","horasSemana":4}],
      "aulas":[{"id":"a1","tipo":"aula"}],
      "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                   "materiasCapacitadas":["m1"]}],
      "grupos":[{"id":"g1","semestre":1,"turno":"matutino","materias":["m1"]}]
    }"#;

    #[test]
    fn el_bloque_de_tres_horas_es_valvula_de_escape() {
        // Con cinco días hábiles, hasta 10 h caben en bloques de dos.
        assert_eq!(tope_para(4, 5, 3), 2, "4 h = 2+2");
        assert_eq!(tope_para(5, 5, 3), 2, "5 h = 2+2+1, no 3+2");
        assert_eq!(tope_para(10, 5, 3), 2, "10 h = cinco bloques de dos");
        // A partir de 11 h ya no alcanzan los días: ahí sí entra el tres.
        assert_eq!(tope_para(11, 5, 3), 3);
        assert_eq!(tope_para(15, 5, 3), 3);
        // Ni con tres cabe: se devuelve el techo y la validación lo bloquea.
        assert_eq!(tope_para(20, 5, 3), 3);
        // Con techo de dos nunca se sube, aunque no quepa.
        assert_eq!(tope_para(11, 5, 2), 2);
        // Pocos días obligan a bloques largos antes.
        assert_eq!(tope_para(5, 2, 3), 3);
    }

    #[test]
    fn parte_las_horas_en_bloques() {
        let materias = vec![Materia {
            id: "m".into(),
            clave: "M".into(),
            nombre: "M".into(),
            horas_semana: 5,
            requiere_laboratorio: false,
            es_de_especialidad: false,
        }];
        let grupos = vec![Grupo {
            asignaciones: HashMap::new(),
            id: "g".into(),
            clave: "G".into(),
            semestre: 1,
            turno: 0,
            materias: vec![0],
            alumnos: 0,
            aula_base: None,
        }];
        let rejilla = Rejilla {
            dias: vec!["lunes".into(), "martes".into(), "miercoles".into()],
            turnos: vec![Turno { id: "m".into(), hora_inicio: 7, hora_fin: 14 }],
            duracion_maxima_bloque: 3,
            max_horas_dia_docente: 8,
        };
        let sesiones = construir_sesiones(&grupos, &materias, &rejilla, &[]);
        assert_eq!(sesiones.iter().map(|s| s.duracion).collect::<Vec<_>>(), vec![2, 2, 1]);
        // La suma de los bloques debe ser exactamente las horas de la materia.
        assert_eq!(sesiones.iter().map(|s| s.duracion as u32).sum::<u32>(), 5);
    }

    #[test]
    fn la_mascara_de_disponibilidad_cubre_solo_lo_declarado() {
        let rejilla = Rejilla {
            dias: vec!["lunes".into(), "martes".into()],
            turnos: vec![Turno { id: "m".into(), hora_inicio: 7, hora_fin: 12 }],
            duracion_maxima_bloque: 2,
            max_horas_dia_docente: 8,
        };
        // 5 horas (7..12) por 2 días.
        assert_eq!(rejilla.casillas(), 10);

        let bloques = json::leer(r#"[{"dia":"martes","inicio":9,"fin":11}]"#).unwrap();
        let m = mascara(bloques.lista().unwrap(), &rejilla);

        // martes es el día 1: casillas 5..10, y 9-11 son los offsets 2 y 3.
        assert_eq!(m.iter().filter(|&&x| x).count(), 2);
        assert!(m[5 + 2] && m[5 + 3]);
        assert!(!m[5 + 1] && !m[5 + 4], "fuera del bloque");
        assert!(m[..5].iter().all(|&x| !x), "el lunes no se declaró");
    }

    #[test]
    fn la_mascara_recorta_lo_que_se_sale_de_la_rejilla() {
        let rejilla = Rejilla {
            dias: vec!["lunes".into()],
            turnos: vec![Turno { id: "m".into(), hora_inicio: 7, hora_fin: 12 }],
            duracion_maxima_bloque: 2,
            max_horas_dia_docente: 8,
        };
        // Un bloque de 0 a 23 se recorta a las horas que la rejilla tiene.
        let bloques = json::leer(r#"[{"dia":"lunes","inicio":0,"fin":23},
                                     {"dia":"sabado","inicio":7,"fin":9}]"#)
            .unwrap();
        let m = mascara(bloques.lista().unwrap(), &rejilla);
        assert_eq!(m.iter().filter(|&&x| x).count(), 5, "las cinco horas del día");
        // El sábado no está en la rejilla: se ignora en vez de desbordar.
        assert_eq!(m.len(), 5);
    }

    #[test]
    fn un_horario_ajustado_se_vuelve_a_leer() {
        let p = Problema::leer(EJEMPLO).unwrap();
        let base: Cromosoma = p
            .sesiones
            .iter()
            .map(|_| Gen { docente: 0, aula: 0, dia: 0, hora: 7 })
            .collect();

        // La lista completa, con la primera movida al martes a las 9.
        let sesiones: Vec<String> = base
            .iter()
            .enumerate()
            .map(|(i, _)| {
                let (dia, hora) = if i == 0 { ("martes", 9) } else { ("lunes", 7) };
                format!(
                    r#"{{"indice":{i},"docenteId":"d1","aulaId":"a1","dia":"{dia}","horaInicio":{hora}}}"#
                )
            })
            .collect();
        let cuerpo = format!(r#"{{"sesiones":[{}]}}"#, sesiones.join(","));
        let v = json::leer(&cuerpo).unwrap();

        let leido = leer_horario(&p, &v).unwrap();
        assert_eq!(leido.len(), p.sesiones.len());
        assert_eq!(leido[0].dia, 1, "martes");
        assert_eq!(leido[0].hora, 9);
    }

    #[test]
    fn un_ajuste_fuera_del_turno_se_rechaza_nombrando_el_motivo() {
        let p = Problema::leer(EJEMPLO).unwrap();
        // El turno acaba a las 14: un bloque a las 13 y media no cabe entero.
        let cuerpo = r#"{"sesiones":[{"indice":0,"docenteId":"d1","aulaId":"a1","dia":"lunes","horaInicio":13}]}"#;
        let e = leer_horario(&p, &json::leer(cuerpo).unwrap()).unwrap_err();
        assert!(e.contains("no cabe un bloque"), "{e}");
    }

    /// Como EJEMPLO pero con dos docentes y la clase asignada a uno de ellos.
    const EJEMPLO_ASIGNADO: &str = r#"{
      "rejilla":{"dias":["lunes","martes"],
                 "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}],
                 "duracionMaximaBloque":2},
      "materias":[{"id":"m1","horasSemana":4}],
      "aulas":[{"id":"a1","tipo":"aula"}],
      "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                   "materiasCapacitadas":["m1"]},
                  {"id":"d2","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                   "materiasCapacitadas":["m1"]}],
      "grupos":[{"id":"g1","clave":"1A","semestre":1,"turno":"matutino","materias":["m1"],
                 "asignaciones":{"m1":"d1"}}]
    }"#;

    #[test]
    fn ajustar_a_mano_no_puede_cambiar_al_docente_que_asignó_el_departamento() {
        // Mover una clase es del coordinador; decidir quién la imparte, no. Sin
        // esto el editor deshacía en dos clics lo que el departamento repartió.
        let p = Problema::leer(EJEMPLO_ASIGNADO).unwrap();
        let cuerpo = r#"{"sesiones":[
            {"indice":0,"docenteId":"d2","aulaId":"a1","dia":"lunes","horaInicio":7},
            {"indice":1,"docenteId":"d1","aulaId":"a1","dia":"martes","horaInicio":7}]}"#;
        let e = leer_horario(&p, &json::leer(cuerpo).unwrap()).unwrap_err();
        assert!(e.contains("departamento"), "{e}");
        assert!(e.contains("d1"), "el motivo tiene que nombrar a quien sí la imparte: {e}");
    }

    #[test]
    fn ajustar_a_mano_no_puede_partir_una_clase_entre_dos_docentes() {
        // Cuatro horas en dos bloques son una clase. Darle el martes a otra
        // persona produce un horario que no se puede aplicar.
        let p = Problema::leer(EJEMPLO).unwrap();
        let dos = EJEMPLO.replace(
            r#"[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                   "materiasCapacitadas":["m1"]}]"#,
            r#"[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                   "materiasCapacitadas":["m1"]},
                  {"id":"d2","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                   "materiasCapacitadas":["m1"]}]"#
        );
        assert_ne!(dos, EJEMPLO, "la sustitución tiene que aplicarse");
        let p2 = Problema::leer(&dos).unwrap();
        assert_eq!(p.sesiones.len(), 2, "cuatro horas en bloques de dos");

        let cuerpo = r#"{"sesiones":[
            {"indice":0,"docenteId":"d1","aulaId":"a1","dia":"lunes","horaInicio":7},
            {"indice":1,"docenteId":"d2","aulaId":"a1","dia":"martes","horaInicio":7}]}"#;
        let e = leer_horario(&p2, &json::leer(cuerpo).unwrap()).unwrap_err();
        assert!(e.contains("dos docentes"), "{e}");
        assert!(e.contains("1A") || e.contains("m1"), "tiene que decir qué clase: {e}");
    }

    #[test]
    fn mover_la_hora_sin_tocar_al_docente_sí_se_acepta() {
        let p = Problema::leer(EJEMPLO_ASIGNADO).unwrap();
        let cuerpo = r#"{"sesiones":[
            {"indice":0,"docenteId":"d1","aulaId":"a1","dia":"martes","horaInicio":9},
            {"indice":1,"docenteId":"d1","aulaId":"a1","dia":"lunes","horaInicio":7}]}"#;
        let leido = leer_horario(&p, &json::leer(cuerpo).unwrap()).expect("es un ajuste legítimo");
        assert_eq!(leido[0].hora, 9);
        assert_eq!(leido[0].dia, 1);
    }

    #[test]
    fn un_horario_incompleto_se_rechaza_en_vez_de_inventar() {
        // Sin esto quedarían genes sin definir y el resultado sería basura
        // presentada como un horario.
        let p = Problema::leer(EJEMPLO).unwrap();
        let cuerpo = r#"{"sesiones":[{"indice":0,"docenteId":"d1","aulaId":"a1","dia":"lunes","horaInicio":7}]}"#;
        let e = leer_horario(&p, &json::leer(cuerpo).unwrap()).unwrap_err();
        assert!(e.contains("incompleto"), "{e}");
    }

    #[test]
    fn un_recurso_que_no_existe_se_nombra() {
        let p = Problema::leer(EJEMPLO).unwrap();
        let cuerpo = r#"{"sesiones":[{"indice":0,"docenteId":"fantasma","aulaId":"a1","dia":"lunes","horaInicio":7}]}"#;
        let e = leer_horario(&p, &json::leer(cuerpo).unwrap()).unwrap_err();
        assert!(e.contains("fantasma"), "{e}");
    }

    #[test]
    fn rechaza_fusiones_imposibles() {
        let base = |fusiones: &str| {
            format!(
                r#"{{
                  "rejilla":{{"dias":["lunes"],
                             "turnos":[{{"id":"m","horaInicio":7,"horaFin":14}},
                                       {{"id":"v","horaInicio":14,"horaFin":22}}]}},
                  "materias":[{{"id":"m1","horasSemana":2}},{{"id":"m2","horasSemana":2}}],
                  "aulas":[{{"id":"a1"}}],
                  "docentes":[{{"id":"d1","materiasCapacitadas":["m1","m2"]}}],
                  "grupos":[{{"id":"g1","turno":"m","materias":["m1","m2"]}},
                            {{"id":"g2","turno":"m","materias":["m1"]}},
                            {{"id":"g3","turno":"v","materias":["m1"]}}],
                  "fusiones":{fusiones}
                }}"#
            )
        };
        let error = |f: &str| Problema::leer(&base(f)).unwrap_err();

        // Un grupo que no cursa la materia no puede fusionarse en ella.
        assert!(error(r#"[{"materiaId":"m2","grupos":["g1","g2"]}]"#).contains("no cursa"));
        // Turnos distintos: imposible, no solo indeseable.
        assert!(error(r#"[{"materiaId":"m1","grupos":["g1","g3"]}]"#).contains("turnos distintos"));
        // Una fusión de uno no es una fusión.
        assert!(error(r#"[{"materiaId":"m1","grupos":["g1"]}]"#).contains("al menos dos"));
        assert!(error(r#"[{"materiaId":"m1","grupos":["g1","g1"]}]"#).contains("repite"));
        assert!(error(r#"[{"materiaId":"fantasma","grupos":["g1","g2"]}]"#).contains("desconocida"));
        assert!(error(r#"[{"materiaId":"m1","grupos":["g1","gX"]}]"#).contains("desconocido"));

        // La válida sí pasa.
        assert!(Problema::leer(&base(r#"[{"materiaId":"m1","grupos":["g1","g2"]}]"#)).is_ok());
    }

    #[test]
    fn rechaza_un_problema_sin_grupos() {
        let entrada = r#"{
            "rejilla":{"dias":["lunes"],"turnos":[{"id":"m","horaInicio":7,"horaFin":14}]},
            "materias":[{"id":"m1","horasSemana":2}],
            "aulas":[{"id":"a1","tipo":"aula"}],
            "docentes":[{"id":"d1","materiasCapacitadas":["m1"]}],
            "grupos":[]
        }"#;
        let error = Problema::leer(entrada).unwrap_err();
        assert!(error.contains("grupos"), "mensaje inesperado: {error}");
    }

    #[test]
    fn rechaza_un_turno_invertido() {
        let entrada = r#"{
            "rejilla":{"dias":["lunes"],"turnos":[{"id":"m","horaInicio":14,"horaFin":7}]},
            "materias":[{"id":"m1","horasSemana":2}],
            "aulas":[{"id":"a1"}],
            "docentes":[{"id":"d1"}],
            "grupos":[{"id":"g1","turno":"m","materias":["m1"]}]
        }"#;
        assert!(Problema::leer(entrada).unwrap_err().contains("rango de horas"));
    }

    /// Un problema guardado antes de que existiera el campo se rige por la
    /// regla igual: las ocho horas no son una preferencia del motor.
    #[test]
    fn sin_jornada_declarada_se_asumen_ocho_horas() {
        let entrada = r#"{
            "rejilla":{"dias":["lunes"],"turnos":[{"id":"m","horaInicio":7,"horaFin":14}]},
            "materias":[{"id":"m1","horasSemana":2}],
            "aulas":[{"id":"a1"}],
            "docentes":[{"id":"d1","materiasCapacitadas":["m1"]}],
            "grupos":[{"id":"g1","turno":"m","materias":["m1"]}]
        }"#;
        let p = Problema::leer(entrada).unwrap();
        assert_eq!(p.rejilla.max_horas_dia_docente, 8);
    }
}
