//! Los operadores evolutivos y la evolución de una isla.
//!
//! Una isla es una población independiente con su propio generador
//! pseudoaleatorio y su propio evaluador. No comparte memoria con las demás: la
//! única comunicación es la migración, que ocurre fuera de aquí (ver `islas.rs`)
//! cuando todos los hilos ya se detuvieron. Por eso `evolucionar` no necesita
//! candado alguno.
//!
//! La búsqueda local al final de cada generación es lo que lo hace *memético* y
//! no solo genético: el cruce y la mutación exploran a lo ancho, el escalador
//! refina al mejor individuo. Con `busquedaLocal: 0` queda el genético puro,
//! que sirve como línea base para comparar.

use crate::aptitud::Evaluador;
use crate::azar::Azar;
use crate::modelo::{Cromosoma, Diagnostico, Gen, Problema, Sesion};

pub struct Isla<'p> {
    p: &'p Problema,
    evaluador: Evaluador<'p>,
    azar: Azar,
    poblacion: Vec<Cromosoma>,
    aptitudes: Vec<f64>,
    /// Reserva para no asignar una población nueva en cada generación.
    siguiente: Vec<Cromosoma>,
    orden: Vec<usize>,
    /// Reserva para la lista de genes en conflicto, reutilizada cada generación.
    conflictivos: Vec<usize>,
    mejor: Cromosoma,
    mejor_aptitud: f64,
}

impl<'p> Isla<'p> {
    pub fn nueva(p: &'p Problema, semilla: u64) -> Self {
        let mut azar = Azar::nuevo(semilla);
        let tamano = p.parametros.poblacion_por_isla;

        let poblacion: Vec<Cromosoma> = (0..tamano).map(|_| cromosoma_al_azar(p, &mut azar)).collect();

        let mut evaluador = Evaluador::nuevo(p);
        let aptitudes: Vec<f64> = poblacion.iter().map(|c| evaluador.evaluar(c)).collect();

        let (mejor_i, &mejor_aptitud) = aptitudes
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| a.total_cmp(b))
            .expect("la población no puede estar vacía");

        Self {
            mejor: poblacion[mejor_i].clone(),
            mejor_aptitud,
            siguiente: Vec::with_capacity(tamano),
            orden: (0..tamano).collect(),
            conflictivos: Vec::new(),
            poblacion,
            aptitudes,
            evaluador,
            azar,
            p,
        }
    }

    pub fn mejor(&self) -> (&Cromosoma, f64) {
        (&self.mejor, self.mejor_aptitud)
    }

    pub fn diagnosticar(&mut self, cromosoma: &Cromosoma) -> (f64, Diagnostico) {
        self.evaluador.evaluar_con_detalle(cromosoma)
    }

    /// Los `cuantos` mejores individuos, para enviarlos a otra isla.
    pub fn mejores(&mut self, cuantos: usize) -> Vec<Cromosoma> {
        self.ordenar();
        self.orden
            .iter()
            .take(cuantos.min(self.poblacion.len()))
            .map(|&i| self.poblacion[i].clone())
            .collect()
    }

    /// Reemplaza a los peores individuos por los recién llegados de otra isla.
    /// Sustituir a los peores y no a los mejores es lo que evita que la
    /// migración destruya el progreso local.
    pub fn recibir(&mut self, visitantes: &[Cromosoma]) {
        self.ordenar();
        for (i, visitante) in visitantes.iter().enumerate() {
            if i >= self.orden.len() {
                break;
            }
            let destino = self.orden[self.orden.len() - 1 - i];
            self.poblacion[destino] = visitante.clone();
            self.aptitudes[destino] = self.evaluador.evaluar(visitante);
        }
        self.refrescar_mejor();
    }

    pub fn evolucionar(&mut self, generaciones: usize) {
        let params = &self.p.parametros;
        let tamano = self.poblacion.len();
        let elite = params.elite.min(tamano);

        for _ in 0..generaciones {
            self.ordenar();

            self.siguiente.clear();
            for i in 0..elite {
                self.siguiente.push(self.poblacion[self.orden[i]].clone());
            }

            while self.siguiente.len() < tamano {
                let padre = self.torneo();
                let madre = self.torneo();
                let mut hijo = if self.azar.ocurre(params.prob_cruce) {
                    self.cruzar(padre, madre)
                } else {
                    self.poblacion[padre].clone()
                };
                self.mutar(&mut hijo);
                self.siguiente.push(hijo);
            }

            std::mem::swap(&mut self.poblacion, &mut self.siguiente);
            for i in 0..self.poblacion.len() {
                self.aptitudes[i] = self.evaluador.evaluar(&self.poblacion[i]);
            }

            self.refrescar_mejor();

            if params.busqueda_local > 0 {
                self.refinar_al_mejor(params.busqueda_local);
            }
        }
    }

    /// Índices de la población ordenados de mejor a peor.
    fn ordenar(&mut self) {
        let aptitudes = &self.aptitudes;
        self.orden.clear();
        self.orden.extend(0..self.poblacion.len());
        self.orden.sort_unstable_by(|&a, &b| aptitudes[a].total_cmp(&aptitudes[b]));
    }

    fn refrescar_mejor(&mut self) {
        if let Some((i, &aptitud)) = self
            .aptitudes
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| a.total_cmp(b))
        {
            if aptitud < self.mejor_aptitud {
                self.mejor_aptitud = aptitud;
                self.mejor.clear();
                self.mejor.extend_from_slice(&self.poblacion[i]);
            }
        }
    }

    /// Torneo: se eligen `torneo` candidatos al azar y gana el mejor. La presión
    /// de selección se ajusta con el tamaño del torneo, sin necesidad de
    /// normalizar aptitudes, que aquí son costos y no caben en una ruleta.
    fn torneo(&mut self) -> usize {
        let mut mejor = self.azar.indice(self.poblacion.len());
        for _ in 1..self.p.parametros.torneo {
            let reto = self.azar.indice(self.poblacion.len());
            if self.aptitudes[reto] < self.aptitudes[mejor] {
                mejor = reto;
            }
        }
        mejor
    }

    /// Cruce uniforme gen a gen. Cada gen es una decisión completa y coherente
    /// (docente, aula, día y hora de una sesión), así que mezclarlos enteros
    /// nunca produce un gen inválido; un cruce por puntos dentro del gen sí.
    fn cruzar(&mut self, padre: usize, madre: usize) -> Cromosoma {
        let largo = self.poblacion[padre].len();
        let mut hijo = Vec::with_capacity(largo);
        for i in 0..largo {
            let origen = if self.azar.ocurre(0.5) { padre } else { madre };
            hijo.push(self.poblacion[origen][i]);
        }
        // Tomar unos bloques del padre y otros de la madre puede dejar una
        // misma clase con dos docentes. Se unifica al del primer bloque.
        unificar_docentes(self.p, &mut hijo);
        hijo
    }

    /// Mutación por atributo: cambia docente, aula, día u hora de una sesión,
    /// no el gen completo. Un cambio pequeño permite afinar un horario casi
    /// bueno, que es la situación normal después de unas cuantas generaciones.
    fn mutar(&mut self, cromosoma: &mut Cromosoma) {
        let prob = self.p.parametros.prob_mutacion;
        for i in 0..cromosoma.len() {
            if self.azar.ocurre(prob) {
                let antes = cromosoma[i].docente;
                mutar_gen(self.p, &self.p.sesiones[i], &mut cromosoma[i], &mut self.azar);
                // Cambiar de docente es cambiar quién imparte la clase entera,
                // no quién da el bloque del martes.
                if cromosoma[i].docente != antes {
                    fijar_docente(self.p, cromosoma, i, cromosoma[i].docente);
                }
            }
        }
    }

    /// La parte memética: refina al mejor individuo en dos movimientos de
    /// naturaleza distinta.
    ///
    /// Primero una **reparación dirigida**, que es lo que de verdad rompe los
    /// estancamientos. Con 144 sesiones, que la mutación al azar caiga justo en
    /// la que choca es improbable, y el algoritmo se queda con dos o tres
    /// empalmes indefinidamente por más generaciones que se le den. Aquí se
    /// pregunta al evaluador qué genes están en conflicto y se explora de forma
    /// exhaustiva el vecindario de uno de ellos.
    ///
    /// Después una escalada al azar, que es barata y sirve para las
    /// restricciones blandas: huecos, días evitados, prioridades de horario.
    fn refinar_al_mejor(&mut self, intentos: usize) {
        if self.mejor.is_empty() {
            return;
        }
        let mut candidato = self.mejor.clone();
        let mut costo = self.mejor_aptitud;

        let mut conflictivos = std::mem::take(&mut self.conflictivos);
        self.evaluador.conflictivos(&candidato, &mut conflictivos);
        if !conflictivos.is_empty() {
            let i = conflictivos[self.azar.indice(conflictivos.len())];
            costo = self.reparar(&mut candidato, i, costo);
        }
        self.conflictivos = conflictivos;

        for _ in 0..intentos {
            let i = self.azar.indice(candidato.len());
            let anterior = candidato[i];
            mutar_gen(self.p, &self.p.sesiones[i], &mut candidato[i], &mut self.azar);
            // Cambiar de docente es cambiar quién imparte la clase entera. Por
            // el invariante, todos sus bloques traían el docente anterior, así
            // que deshacer es volver a ponerlo en todos.
            let docente = candidato[i].docente;
            let cambio_docente = docente != anterior.docente;
            if cambio_docente {
                fijar_docente(self.p, &mut candidato, i, docente);
            }

            let nuevo = self.evaluador.evaluar(&candidato);
            if nuevo < costo {
                costo = nuevo;
            } else {
                candidato[i] = anterior;
                if cambio_docente {
                    fijar_docente(self.p, &mut candidato, i, anterior.docente);
                }
            }
        }

        if costo < self.mejor_aptitud {
            self.mejor_aptitud = costo;
            self.mejor.clear();
            self.mejor.extend_from_slice(&candidato);
            // El refinado entra a la población reemplazando al peor, para que el
            // cruce pueda aprovecharlo en la generación siguiente.
            self.ordenar();
            if let Some(&peor) = self.orden.last() {
                self.poblacion[peor] = candidato;
                self.aptitudes[peor] = costo;
            }
        }
    }

    /// Mejor valor posible para el gen `i`, explorando un atributo a la vez:
    /// todas sus ranuras válidas, luego todos sus docentes capacitados, luego
    /// todas sus aulas admisibles.
    ///
    /// Es descenso por coordenadas, no fuerza bruta sobre el producto de los
    /// cuatro atributos: eso serían decenas de miles de evaluaciones por gen.
    /// Así son unas cien, y alcanza porque los empalmes casi siempre se
    /// resuelven moviendo una sola cosa.
    fn reparar(&mut self, cromosoma: &mut Cromosoma, i: usize, costo_inicial: f64) -> f64 {
        // `self.p` es una referencia compartida con vida propia: copiarla suelta
        // el préstamo de `self` y permite usar el evaluador dentro de los ciclos.
        let p = self.p;
        let sesion = &p.sesiones[i];
        let turno = &p.rejilla.turnos[p.grupos[sesion.principal()].turno];

        let mut mejor_gen = cromosoma[i];
        let mut mejor_costo = costo_inicial;

        let ultima = turno
            .hora_fin
            .saturating_sub(sesion.duracion)
            .max(turno.hora_inicio);
        for dia in 0..p.rejilla.dias.len() as u8 {
            for hora in turno.hora_inicio..=ultima {
                cromosoma[i].dia = dia;
                cromosoma[i].hora = hora;
                let costo = self.evaluador.evaluar(cromosoma);
                if costo < mejor_costo {
                    mejor_costo = costo;
                    mejor_gen = cromosoma[i];
                }
            }
        }
        cromosoma[i] = mejor_gen;

        // El docente solo se busca si nadie lo asignó. Probar otros cuando el
        // departamento ya decidió sería proponer un horario que contradice esa
        // decisión, y la búsqueda local lo elegiría por puntuar mejor.
        if sesion.docente_fijo.is_none() {
            // Probar un docente es moverlo en todos los bloques de la clase: si
            // solo se cambiara este, la mejora vendría de partir la clase entre
            // dos personas, que es justo lo que no puede pasar.
            let mut mejor_docente = mejor_gen.docente;
            for &docente in &p.docentes_por_materia[sesion.materia] {
                fijar_docente(p, cromosoma, i, docente as u16);
                let costo = self.evaluador.evaluar(cromosoma);
                if costo < mejor_costo {
                    mejor_costo = costo;
                    mejor_docente = docente as u16;
                }
            }
            fijar_docente(p, cromosoma, i, mejor_docente);
            mejor_gen = cromosoma[i];
        }

        // Si el aula la fija el grupo, no hay vecindario que explorar aquí.
        let aulas: &[usize] = if !aula_es_libre(p, &sesion) {
            &[]
        } else if p.materias[sesion.materia].requiere_laboratorio {
            &p.aulas_laboratorio
        } else {
            &p.aulas_normales
        };
        for &aula in aulas {
            cromosoma[i].aula = aula as u16;
            let costo = self.evaluador.evaluar(cromosoma);
            if costo < mejor_costo {
                mejor_costo = costo;
                mejor_gen = cromosoma[i];
            }
        }
        cromosoma[i] = mejor_gen;

        mejor_costo
    }

}

// ---------------------------------------------------------------- construcción de genes

/// Docente al azar entre los capacitados para la materia. Si nadie puede
/// impartirla se toma cualquiera: el evaluador lo penaliza y el informe final
/// reporta la materia sin cobertura, en vez de fallar aquí y no entregar nada.
fn docente_para(p: &Problema, materia: usize, azar: &mut Azar) -> u16 {
    match azar.elegir(&p.docentes_por_materia[materia]) {
        Some(&d) => d as u16,
        None => azar.indice(p.docentes.len()) as u16,
    }
}

/// Aula de una sesión.
///
/// Si la materia no pide laboratorio, es el aula fija del grupo: no hay nada
/// que decidir, porque los alumnos no cambian de salón. Solo las materias de
/// laboratorio eligen, y ahí sí conviene explorar.
///
/// Fijarla por construcción, en vez de penalizar después, quita un atributo
/// entero del espacio de búsqueda para la mayoría de las sesiones.
fn aula_para(p: &Problema, sesion: &Sesion, azar: &mut Azar) -> u16 {
    let requiere = p.materias[sesion.materia].requiere_laboratorio;

    if !requiere {
        if let Some(base) = p.grupos[sesion.principal()].aula_base {
            return base as u16;
        }
    }

    let candidatas = if requiere && !p.aulas_laboratorio.is_empty() {
        &p.aulas_laboratorio
    } else if !requiere && !p.aulas_normales.is_empty() {
        &p.aulas_normales
    } else {
        return azar.indice(p.aulas.len()) as u16;
    };
    *azar.elegir(candidatas).expect("la lista no está vacía") as u16
}

/// Un gen solo puede mutar por los atributos que de verdad varían. Si el aula
/// está fijada por el grupo, sortearla desperdiciaría una de cada cuatro
/// mutaciones en un cambio que no cambia nada.
fn aula_es_libre(p: &Problema, sesion: &Sesion) -> bool {
    p.materias[sesion.materia].requiere_laboratorio || p.grupos[sesion.principal()].aula_base.is_none()
}

/// Hora de inicio válida: la sesión completa cae dentro del turno del grupo.
/// Esta es la única restricción que se garantiza por construcción en lugar de
/// penalizarse. Colocar una clase fuera del turno de su grupo no es un horario
/// malo, es un horario sin sentido, y dejar que el algoritmo lo explore solo
/// desperdicia generaciones. Además mantiene los índices del evaluador en rango.
fn hora_para(p: &Problema, sesion: &Sesion, azar: &mut Azar) -> u8 {
    let turno = &p.rejilla.turnos[p.grupos[sesion.principal()].turno];
    let ultima = turno.hora_fin.saturating_sub(sesion.duracion).max(turno.hora_inicio);
    azar.entre(turno.hora_inicio as usize, ultima as usize) as u8
}

fn gen_al_azar(p: &Problema, sesion: &Sesion, azar: &mut Azar) -> Gen {
    Gen {
        // Con docente asignado no hay nada que elegir: el departamento ya lo
        // decidió y el algoritmo solo coloca el bloque.
        docente: sesion.docente_fijo.unwrap_or_else(|| docente_para(p, sesion.materia, azar)),
        aula: aula_para(p, sesion, azar),
        dia: azar.indice(p.rejilla.dias.len()) as u8,
        hora: hora_para(p, sesion, azar),
    }
}

fn mutar_gen(p: &Problema, sesion: &Sesion, gen: &mut Gen, azar: &mut Azar) {
    let libre = aula_es_libre(p, sesion);
    // Con docente asignado, mutarlo produciría un horario que contradice al
    // departamento. Se sortea entre lo que sí se puede mover.
    let fijo = sesion.docente_fijo.is_some();
    let opciones = (if libre { 4 } else { 3 }) - usize::from(fijo);
    let elegida = azar.indice(opciones) + usize::from(fijo);
    match elegida {
        0 => gen.docente = docente_para(p, sesion.materia, azar),
        1 => gen.dia = azar.indice(p.rejilla.dias.len()) as u8,
        2 => gen.hora = hora_para(p, sesion, azar),
        _ => gen.aula = aula_para(p, sesion, azar),
    }
}

/// Pone `docente` en todos los bloques de la clase a la que pertenece la sesión
/// `i`. Una materia de cinco horas se programa en tres bloques; los tres los da
/// la misma persona, porque son la misma clase.
fn fijar_docente(p: &Problema, cromosoma: &mut Cromosoma, i: usize, docente: u16) {
    for &j in &p.sesiones_de_clase[p.sesiones[i].clase] {
        cromosoma[j].docente = docente;
    }
}

/// Deja cada clase con un solo docente: el del primero de sus bloques.
fn unificar_docentes(p: &Problema, cromosoma: &mut Cromosoma) {
    for bloques in &p.sesiones_de_clase {
        let Some(&primero) = bloques.first() else { continue };
        let docente = cromosoma[primero].docente;
        for &j in &bloques[1..] {
            cromosoma[j].docente = docente;
        }
    }
}

pub fn cromosoma_al_azar(p: &Problema, azar: &mut Azar) -> Cromosoma {
    let mut cromosoma: Cromosoma = p.sesiones.iter().map(|s| gen_al_azar(p, s, azar)).collect();
    unificar_docentes(p, &mut cromosoma);
    cromosoma
}

#[cfg(test)]
mod pruebas {
    use super::*;

    /// Dos docentes capaces de la misma materia y uno asignado por grupo.
    const ASIGNADO: &str = r#"{
      "rejilla":{"dias":["lunes","martes"],
                 "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}],
                 "duracionMaximaBloque":2},
      "materias":[{"id":"m1","horasSemana":4}],
      "aulas":[{"id":"a1","tipo":"aula"},{"id":"a2","tipo":"aula"}],
      "docentes":[
        {"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
         "materiasCapacitadas":["m1"]},
        {"id":"d2","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
         "materiasCapacitadas":["m1"]}],
      "grupos":[
        {"id":"g1","clave":"1A","semestre":1,"turno":"matutino","materias":["m1"],
         "asignaciones":{"m1":"d2"}},
        {"id":"g2","clave":"1B","semestre":1,"turno":"matutino","materias":["m1"],
         "asignaciones":{"m1":"d1"}}]
    }"#;

    #[test]
    fn con_docente_asignado_el_algoritmo_no_lo_cambia() {
        // El departamento decide quién se para frente al grupo; el motor solo
        // coloca el bloque. Probar otros docentes sería proponer un horario que
        // contradice esa decisión.
        let p = Problema::leer(ASIGNADO).unwrap();
        let asignado: Vec<Option<u16>> = p.sesiones.iter().map(|s| s.docente_fijo).collect();
        assert!(asignado.iter().all(Option::is_some), "las cuatro sesiones vienen asignadas");

        let mut isla = Isla::nueva(&p, 1);
        isla.evolucionar(200);
        for (gen, esperado) in isla.mejor().0.iter().zip(&asignado) {
            assert_eq!(Some(gen.docente), *esperado, "cambió un docente asignado");
        }
    }

    #[test]
    fn una_materia_se_reparte_entre_dos_grupos_con_docentes_distintos() {
        // 1A lo da d2 y 1B lo da d1: el caso que el modelo por grupo permite.
        let p = Problema::leer(ASIGNADO).unwrap();
        let de = |clave: &str| {
            p.sesiones
                .iter()
                .filter(|s| p.grupos[s.principal()].clave == clave)
                .map(|s| s.docente_fijo.unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(de("1A"), vec![1, 1], "d2 es el índice 1");
        assert_eq!(de("1B"), vec![0, 0], "d1 es el índice 0");
    }

    /// Todos los bloques de cada clase llevan el mismo docente.
    fn clases_enteras(p: &Problema, c: &Cromosoma) -> bool {
        p.sesiones_de_clase
            .iter()
            .all(|b| b.windows(2).all(|x| c[x[0]].docente == c[x[1]].docente))
    }

    #[test]
    fn una_clase_sin_asignar_la_imparte_una_sola_persona() {
        // El departamento puede no haber repartido todavía. Que elija el motor
        // no significa que la materia la den dos personas a medias: los bloques
        // de una clase son una clase, y la imparte alguien.
        // m1 son cuatro horas en bloques de dos: dos bloques por grupo.
        let sin = ASIGNADO
            .replace(r#""asignaciones":{"m1":"d2"}"#, r#""alumnos":0"#)
            .replace(r#""asignaciones":{"m1":"d1"}"#, r#""alumnos":0"#);
        let p = Problema::leer(&sin).unwrap();
        assert!(p.sesiones_de_clase.iter().any(|b| b.len() > 1));
        let mut isla = Isla::nueva(&p, 7);
        isla.evolucionar(30);
        let (mejor, _) = isla.mejor();
        assert!(clases_enteras(&p, mejor), "una clase quedó repartida entre varios docentes");
    }

    #[test]
    fn sin_asignar_el_algoritmo_sigue_eligiendo() {
        // Un escenario a medias tiene que seguir corriendo: es el estado normal
        // mientras el departamento reparte.
        // Se quitan las asignaciones dejando el resto igual.
        let sin = ASIGNADO
            .replace(r#""asignaciones":{"m1":"d2"}"#, r#""alumnos":0"#)
            .replace(r#""asignaciones":{"m1":"d1"}"#, r#""alumnos":0"#);
        let p = Problema::leer(&sin).unwrap();
        assert!(p.sesiones.iter().all(|s| s.docente_fijo.is_none()));
    }

    #[test]
    fn un_docente_asignado_que_no_existe_se_rechaza_nombrandolo() {
        let malo = ASIGNADO.replace(r#""m1":"d2""#, r#""m1":"fantasma""#);
        let e = Problema::leer(&malo).unwrap_err();
        assert!(e.contains("fantasma"), "{e}");
    }

    fn problema() -> Problema {
        Problema::leer(
            r#"{
              "parametros":{"islas":1,"poblacionPorIsla":20,"semilla":1},
              "rejilla":{"dias":["lunes","martes","miercoles"],
                         "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}],
                         "duracionMaximaBloque":2},
              "materias":[
                {"id":"m1","horasSemana":5},
                {"id":"m2","horasSemana":4,"requiereLaboratorio":true},
                {"id":"m3","horasSemana":3}],
              "aulas":[{"id":"a1","tipo":"aula"},{"id":"a2","tipo":"aula"},
                       {"id":"lab1","tipo":"laboratorio"}],
              "docentes":[
                {"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                 "materiasCapacitadas":["m1","m2"]},
                {"id":"d2","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                 "materiasCapacitadas":["m2","m3"]}],
              "grupos":[{"id":"g1","semestre":1,"turno":"matutino",
                         "materias":["m1","m2","m3"]}]
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn los_genes_nacen_dentro_del_turno() {
        let p = problema();
        let mut azar = Azar::nuevo(42);
        for _ in 0..2_000 {
            let c = cromosoma_al_azar(&p, &mut azar);
            for (gen, sesion) in c.iter().zip(&p.sesiones) {
                assert!(gen.hora >= 7, "hora {} antes del turno", gen.hora);
                assert!(
                    gen.hora + sesion.duracion <= 14,
                    "la sesión de {} h que inicia a las {} se sale del turno",
                    sesion.duracion,
                    gen.hora
                );
                assert!((gen.dia as usize) < p.rejilla.dias.len());
                assert!((gen.docente as usize) < p.docentes.len());
                assert!((gen.aula as usize) < p.aulas.len());
            }
        }
    }

    #[test]
    fn la_inicializacion_respeta_capacitacion_y_tipo_de_aula() {
        let p = problema();
        let mut azar = Azar::nuevo(7);
        for _ in 0..500 {
            let c = cromosoma_al_azar(&p, &mut azar);
            for (gen, sesion) in c.iter().zip(&p.sesiones) {
                assert!(
                    p.docentes[gen.docente as usize].capacitado.contains(&sesion.materia),
                    "asignó un docente no capacitado en la inicialización"
                );
                assert_eq!(
                    p.materias[sesion.materia].requiere_laboratorio,
                    p.aulas[gen.aula as usize].es_laboratorio,
                    "el tipo de aula no coincide con lo que pide la materia"
                );
            }
        }
    }

    #[test]
    fn el_aula_del_grupo_es_fija_por_construccion() {
        // No se penaliza y luego se espera que el algoritmo lo aprenda: las
        // materias que no son de laboratorio nacen y se quedan en el aula del
        // grupo, pase lo que pase con la mutación.
        let p = Problema::leer(
            r#"{
              "parametros":{"islas":1,"poblacionPorIsla":10,"semilla":1},
              "rejilla":{"dias":["lunes","martes","miercoles"],
                         "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}],
                         "duracionMaximaBloque":2},
              "materias":[{"id":"m1","horasSemana":4},
                          {"id":"m2","horasSemana":4,"requiereLaboratorio":true}],
              "aulas":[{"id":"a1","tipo":"aula"},{"id":"a2","tipo":"aula"},
                       {"id":"l1","tipo":"laboratorio"},{"id":"l2","tipo":"laboratorio"}],
              "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,
                           "maxGrupos":9,"materiasCapacitadas":["m1","m2"]}],
              "grupos":[{"id":"g1","semestre":1,"turno":"matutino",
                         "aulaId":"a2","materias":["m1","m2"]}]
            }"#,
        )
        .unwrap();
        let base = p.grupos[0].aula_base.unwrap() as u16;

        let mut azar = Azar::nuevo(9);
        let mut c = cromosoma_al_azar(&p, &mut azar);
        let revisar = |c: &Cromosoma| {
            for (gen, sesion) in c.iter().zip(&p.sesiones) {
                if p.materias[sesion.materia].requiere_laboratorio {
                    assert!(p.aulas[gen.aula as usize].es_laboratorio, "laboratorio esperado");
                } else {
                    assert_eq!(gen.aula, base, "el grupo salió de su aula");
                }
            }
        };
        revisar(&c);

        for _ in 0..20_000 {
            let i = azar.indice(c.len());
            mutar_gen(&p, &p.sesiones[i], &mut c[i], &mut azar);
            revisar(&c);
        }
    }

    #[test]
    fn la_mutacion_mantiene_los_genes_validos() {
        let p = problema();
        let mut azar = Azar::nuevo(3);
        let mut c = cromosoma_al_azar(&p, &mut azar);
        for _ in 0..20_000 {
            let i = azar.indice(c.len());
            mutar_gen(&p, &p.sesiones[i], &mut c[i], &mut azar);
            let sesion = &p.sesiones[i];
            assert!(c[i].hora >= 7 && c[i].hora + sesion.duracion <= 14);
            assert!((c[i].dia as usize) < p.rejilla.dias.len());
            assert!((c[i].docente as usize) < p.docentes.len());
            assert!((c[i].aula as usize) < p.aulas.len());
        }
    }

    #[test]
    fn el_elitismo_nunca_empeora_al_mejor() {
        let p = problema();
        let mut isla = Isla::nueva(&p, 5);
        let inicial = isla.mejor().1;
        for _ in 0..10 {
            let antes = isla.mejor().1;
            isla.evolucionar(5);
            assert!(isla.mejor().1 <= antes, "{} > {}", isla.mejor().1, antes);
        }
        assert!(isla.mejor().1 <= inicial);
    }

    #[test]
    fn evolucionar_mejora_de_verdad() {
        let p = problema();
        let mut isla = Isla::nueva(&p, 11);
        let inicial = isla.mejor().1;
        isla.evolucionar(150);
        assert!(
            isla.mejor().1 < inicial,
            "150 generaciones no mejoraron nada ({inicial} -> {})",
            isla.mejor().1
        );
    }

    #[test]
    fn ni_el_refinado_parte_una_clase_entre_dos_docentes() {
        // La escalada al azar del refinado muta un gen suelto: si no propagara
        // el docente al resto de la clase, encontraría "mejoras" que consisten
        // en que el martes lo dé otra persona.
        let p = problema();
        let mut isla = Isla::nueva(&p, 11);
        isla.evolucionar(150);
        assert!(clases_enteras(&p, isla.mejor().0), "el refinado partió una clase");
    }

    #[test]
    fn la_misma_semilla_da_el_mismo_resultado() {
        let p = problema();
        let mut a = Isla::nueva(&p, 77);
        let mut b = Isla::nueva(&p, 77);
        a.evolucionar(60);
        b.evolucionar(60);
        assert_eq!(a.mejor().1, b.mejor().1);
        assert_eq!(a.mejor().0, b.mejor().0);
    }
}
