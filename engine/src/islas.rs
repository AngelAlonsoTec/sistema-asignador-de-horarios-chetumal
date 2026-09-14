//! Modelo de islas: el paralelismo del motor.
//!
//! En lugar de una población grande repartida entre hilos, se corren varias
//! poblaciones independientes que de vez en cuando intercambian individuos. Es
//! la forma natural de paralelizar un algoritmo evolutivo, porque cada isla
//! trabaja sobre su propia memoria y no hay nada que sincronizar dentro de una
//! generación, y además mejora la calidad de la búsqueda: cada isla converge
//! hacia un óptimo local distinto y la migración comparte los hallazgos.
//!
//! La sincronización es **por épocas**: todas las islas evolucionan el mismo
//! número de generaciones, los hilos se unen, y solo entonces migran. Eso cuesta
//! una barrera cada `migracionCada` generaciones y compra algo que vale más para
//! una tesis que ese poco de tiempo: el resultado no depende del orden en que el
//! sistema operativo planificó los hilos, así que la misma semilla da
//! exactamente el mismo horario, con 1 hilo o con 16.

use crate::genetico::Isla;
use crate::modelo::{Cromosoma, Diagnostico, Problema};

pub struct Resultado {
    pub cromosoma: Cromosoma,
    pub aptitud: f64,
    pub diagnostico: Diagnostico,
    pub generaciones: usize,
    /// Mejor aptitud global al final de cada época. Es la curva de convergencia
    /// que se grafica en la interfaz.
    pub historial: Vec<f64>,
}

pub fn resolver(problema: &Problema) -> Resultado {
    let params = &problema.parametros;
    let cuantas = params.islas.max(1);

    // Una semilla derivada por isla, no la misma: si todas arrancaran igual
    // explorarían lo mismo y el paralelismo no aportaría diversidad. Derivarlas
    // de la semilla base mantiene la corrida reproducible.
    let mut islas: Vec<Isla> = (0..cuantas)
        .map(|i| Isla::nueva(problema, params.semilla.wrapping_add((i as u64).wrapping_mul(0x9E3779B97F4A7C15))))
        .collect();

    let mut historial = Vec::new();
    let mut restantes = params.generaciones;

    while restantes > 0 {
        let tanda = params.migracion_cada.min(restantes);

        // Aquí está todo el paralelismo. `scope` garantiza que los hilos
        // terminan antes de devolver el control, lo que permite prestarle a
        // cada uno una referencia mutable a su isla sin `Arc` ni `Mutex`.
        std::thread::scope(|ambito| {
            for isla in islas.iter_mut() {
                ambito.spawn(move || isla.evolucionar(tanda));
            }
        });

        restantes -= tanda;
        historial.push(mejor_aptitud(&islas));

        if restantes > 0 && cuantas > 1 && params.migrantes > 0 {
            migrar_en_anillo(&mut islas, params.migrantes);
        }
    }

    // Si no se pidió ninguna generación, el resultado es la mejor población
    // inicial: sigue siendo una respuesta válida y deja medir el punto de
    // partida sin caso especial.
    if historial.is_empty() {
        historial.push(mejor_aptitud(&islas));
    }

    let ganadora = indice_de_la_mejor(&islas);
    let cromosoma = islas[ganadora].mejor().0.clone();
    let (aptitud, diagnostico) = islas[ganadora].diagnosticar(&cromosoma);

    Resultado {
        cromosoma,
        aptitud,
        diagnostico,
        generaciones: params.generaciones,
        historial,
    }
}

/// Anillo: la isla `i` manda sus mejores a la `i+1`. Se recolecta todo antes de
/// repartir, porque si no la isla 1 recibiría a los migrantes de la 0 y los
/// reenviaría a la 2 en la misma ronda.
fn migrar_en_anillo(islas: &mut [Isla], migrantes: usize) {
    let emigrantes: Vec<Vec<Cromosoma>> = islas.iter_mut().map(|isla| isla.mejores(migrantes)).collect();
    let total = islas.len();
    for (i, grupo) in emigrantes.iter().enumerate() {
        islas[(i + 1) % total].recibir(grupo);
    }
}

fn mejor_aptitud(islas: &[Isla]) -> f64 {
    islas
        .iter()
        .map(|isla| isla.mejor().1)
        .min_by(|a, b| a.total_cmp(b))
        .unwrap_or(f64::INFINITY)
}

fn indice_de_la_mejor(islas: &[Isla]) -> usize {
    islas
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| a.mejor().1.total_cmp(&b.mejor().1))
        .map(|(i, _)| i)
        .unwrap_or(0)
}

#[cfg(test)]
mod pruebas {
    use super::*;

    fn problema(islas: usize, generaciones: usize, semilla: u64) -> Problema {
        let entrada = format!(
            r#"{{
              "parametros":{{"islas":{islas},"poblacionPorIsla":24,
                            "generaciones":{generaciones},"migracionCada":10,
                            "migrantes":2,"semilla":{semilla}}},
              "rejilla":{{"dias":["lunes","martes","miercoles","jueves","viernes"],
                         "turnos":[{{"id":"matutino","horaInicio":7,"horaFin":14}}],
                         "duracionMaximaBloque":2}},
              "materias":[
                {{"id":"m1","horasSemana":5}},{{"id":"m2","horasSemana":4}},
                {{"id":"m3","horasSemana":4}},{{"id":"m4","horasSemana":3}},
                {{"id":"m5","horasSemana":5,"requiereLaboratorio":true}}],
              "aulas":[{{"id":"a1","tipo":"aula"}},{{"id":"a2","tipo":"aula"}},
                       {{"id":"lab1","tipo":"laboratorio"}}],
              "docentes":[
                {{"id":"d1","horasMin":0,"horasMax":24,"maxMaterias":4,"maxGrupos":5,
                  "materiasCapacitadas":["m1","m2","m3"]}},
                {{"id":"d2","horasMin":0,"horasMax":24,"maxMaterias":4,"maxGrupos":5,
                  "materiasCapacitadas":["m3","m4","m5"]}},
                {{"id":"d3","horasMin":0,"horasMax":24,"maxMaterias":4,"maxGrupos":5,
                  "materiasCapacitadas":["m1","m4","m5"]}}],
              "grupos":[
                {{"id":"g1","semestre":1,"turno":"matutino","materias":["m1","m2","m3"]}},
                {{"id":"g2","semestre":3,"turno":"matutino","materias":["m4","m5"]}}]
            }}"#
        );
        Problema::leer(&entrada).unwrap()
    }

    #[test]
    fn encuentra_un_horario_factible() {
        let p = problema(4, 400, 2026);
        let r = resolver(&p);
        assert!(
            r.diagnostico.factible(),
            "no logró factibilidad: aptitud {} diagnóstico {:?}",
            r.aptitud,
            r.diagnostico
        );
        // Toda sesión del problema debe tener su gen correspondiente.
        assert_eq!(r.cromosoma.len(), p.sesiones.len());
    }

    #[test]
    fn el_resultado_no_depende_del_numero_de_hilos() {
        // La misma semilla y el mismo número de islas deben dar el mismo
        // horario, corra donde corra. Esto es lo que hace reproducible la
        // experimentación.
        let a = resolver(&problema(4, 200, 99));
        let b = resolver(&problema(4, 200, 99));
        assert_eq!(a.aptitud, b.aptitud);
        assert_eq!(a.cromosoma, b.cromosoma);
        assert_eq!(a.historial, b.historial);
    }

    #[test]
    fn semillas_distintas_exploran_distinto() {
        let a = resolver(&problema(2, 100, 1));
        let b = resolver(&problema(2, 100, 2));
        assert_ne!(a.cromosoma, b.cromosoma);
    }

    #[test]
    fn el_historial_es_monotono_decreciente() {
        let r = resolver(&problema(4, 300, 5));
        for par in r.historial.windows(2) {
            assert!(
                par[1] <= par[0],
                "la mejor aptitud global empeoró: {} -> {}",
                par[0],
                par[1]
            );
        }
        assert_eq!(*r.historial.last().unwrap(), r.aptitud);
    }

    #[test]
    fn cero_generaciones_sigue_devolviendo_un_horario() {
        let p = problema(2, 0, 3);
        let r = resolver(&p);
        assert_eq!(r.cromosoma.len(), p.sesiones.len());
        assert_eq!(r.historial.len(), 1);
    }

    /// Un grupo cuyas materias llenan 30 de las 35 ranuras del turno: encajarlas
    /// sin empalmes exige mover sesiones concretas, no tropezarse con la
    /// solución. Sin la reparación dirigida este caso se estanca con empalmes.
    #[test]
    fn resuelve_un_horario_apretado() {
        let entrada = r#"{
          "parametros":{"islas":2,"poblacionPorIsla":40,"generaciones":400,
                        "migracionCada":40,"migrantes":2,"semilla":4242,
                        "busquedaLocal":30},
          "rejilla":{"dias":["lunes","martes","miercoles","jueves","viernes"],
                     "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}],
                     "duracionMaximaBloque":2},
          "materias":[
            {"id":"m1","horasSemana":5},{"id":"m2","horasSemana":5},
            {"id":"m3","horasSemana":5},{"id":"m4","horasSemana":5},
            {"id":"m5","horasSemana":5},{"id":"m6","horasSemana":5}],
          "aulas":[{"id":"a1","tipo":"aula"},{"id":"a2","tipo":"aula"}],
          "docentes":[
            {"id":"d1","horasMin":0,"horasMax":30,"maxMaterias":9,"maxGrupos":9,
             "materiasCapacitadas":["m1","m2","m3"]},
            {"id":"d2","horasMin":0,"horasMax":30,"maxMaterias":9,"maxGrupos":9,
             "materiasCapacitadas":["m4","m5","m6"]}],
          "grupos":[{"id":"g1","semestre":1,"turno":"matutino",
                     "materias":["m1","m2","m3","m4","m5","m6"]}]
        }"#;
        let p = Problema::leer(entrada).unwrap();
        assert_eq!(p.sesiones.iter().map(|s| s.duracion as u32).sum::<u32>(), 30);

        let r = resolver(&p);
        assert_eq!(
            r.diagnostico.choque_grupo, 0,
            "quedaron empalmes de grupo: {:?}",
            r.diagnostico
        );
        assert_eq!(r.diagnostico.choque_docente, 0, "quedaron empalmes de docente");
        assert!(r.diagnostico.factible(), "no es factible: {:?}", r.diagnostico);
    }

    #[test]
    fn una_sola_isla_tambien_funciona() {
        let r = resolver(&problema(1, 150, 8));
        assert!(r.aptitud.is_finite());
    }
}
