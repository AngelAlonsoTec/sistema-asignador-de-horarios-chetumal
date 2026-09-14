//! Evaluación de un horario: cuánto viola y cuánto cuesta.
//!
//! Es la función que más se ejecuta con diferencia — población por generaciones
//! por islas — así que está escrita para no reservar memoria: el `Evaluador`
//! conserva sus tablas de trabajo y las reutiliza en cada llamada. Cada hilo
//! tiene el suyo, de modo que no comparten nada y no hace falta sincronizar.

use crate::modelo::{Cromosoma, Diagnostico, Problema};

pub struct Evaluador<'p> {
    p: &'p Problema,
    hora_base: usize,
    horas: usize,
    dias: usize,
    ocupacion_docente: Vec<u16>,
    ocupacion_grupo: Vec<u16>,
    ocupacion_aula: Vec<u16>,
    horas_docente: Vec<u32>,
    materias_docente: Vec<u16>,
    grupos_docente: Vec<u16>,
    /// Bloques por (grupo, materia, día). El reglamento pide que una materia no
    /// pase de dos horas diarias y que esas horas vayan seguidas; como cada
    /// bloque ya es de una o dos horas contiguas por construcción, ambas cosas
    /// se cumplen con una sola regla: un bloque por materia y día. Repetir día
    /// es lo único que puede romperlas.
    dia_materia: Vec<u8>,
    /// Marcas de "este docente ya tiene esta materia / este grupo", para contar
    /// distintos sin ordenar ni reservar.
    visto_materia: Vec<bool>,
    visto_grupo: Vec<bool>,
    /// Tabla de capacitación docente x materia. Evita recorrer una lista por
    /// cada gen de cada individuo de cada generación.
    capacitado: Vec<bool>,
}

impl<'p> Evaluador<'p> {
    pub fn nuevo(p: &'p Problema) -> Self {
        let (base, fin) = p.rejilla.rango_horas();
        let horas = (fin - base) as usize;
        let dias = p.rejilla.dias.len();

        let mut capacitado = vec![false; p.docentes.len() * p.materias.len()];
        for (d, docente) in p.docentes.iter().enumerate() {
            for &m in &docente.capacitado {
                capacitado[d * p.materias.len() + m] = true;
            }
        }

        Self {
            hora_base: base as usize,
            horas,
            dias,
            ocupacion_docente: vec![0; p.docentes.len() * dias * horas],
            ocupacion_grupo: vec![0; p.grupos.len() * dias * horas],
            ocupacion_aula: vec![0; p.aulas.len() * dias * horas],
            horas_docente: vec![0; p.docentes.len()],
            materias_docente: vec![0; p.docentes.len()],
            grupos_docente: vec![0; p.docentes.len()],
            dia_materia: vec![0; p.grupos.len() * p.materias.len() * dias],
            visto_materia: vec![false; p.docentes.len() * p.materias.len()],
            visto_grupo: vec![false; p.docentes.len() * p.grupos.len()],
            capacitado,
            p,
        }
    }

    #[inline]
    fn ranura(&self, entidad: usize, dia: usize, hora: usize) -> usize {
        (entidad * self.dias + dia) * self.horas + (hora - self.hora_base)
    }

    fn limpiar(&mut self) {
        self.ocupacion_docente.fill(0);
        self.ocupacion_grupo.fill(0);
        self.ocupacion_aula.fill(0);
        self.horas_docente.fill(0);
        self.materias_docente.fill(0);
        self.grupos_docente.fill(0);
        self.visto_materia.fill(false);
        self.visto_grupo.fill(false);
        self.dia_materia.fill(0);
    }

    /// Posición de (grupo, materia, día) en la tabla de repeticiones.
    #[inline]
    fn casilla_dia(&self, grupo: usize, materia: usize, dia: usize, n_materias: usize) -> usize {
        (grupo * n_materias + materia) * self.dias + dia
    }

    /// Costo del cromosoma. Menor es mejor; 0 es un horario perfecto.
    pub fn evaluar(&mut self, cromosoma: &Cromosoma) -> f64 {
        self.evaluar_con_detalle(cromosoma).0
    }

    pub fn evaluar_con_detalle(&mut self, cromosoma: &Cromosoma) -> (f64, Diagnostico) {
        self.limpiar();
        let mut d = Diagnostico::default();
        let pesos = &self.p.parametros.pesos;
        let n_materias = self.p.materias.len();
        let n_grupos = self.p.grupos.len();
        let mut blandas = 0.0;

        for (gen, sesion) in cromosoma.iter().zip(&self.p.sesiones) {
            let docente = gen.docente as usize;
            let aula = gen.aula as usize;
            let dia = gen.dia as usize;
            let hora = gen.hora as usize;
            let duracion = sesion.duracion as usize;

            if !self.capacitado[docente * n_materias + sesion.materia] {
                d.docente_no_capacitado += 1;
            }

            // Las materias de laboratorio salen del aula del grupo; el resto
            // no. Son dos comprobaciones distintas sobre el mismo gen.
            if self.p.materias[sesion.materia].requiere_laboratorio {
                if !self.p.aulas[aula].es_laboratorio {
                    d.aula_inadecuada += 1;
                }
            } else if let Some(base) = self.p.grupos[sesion.principal()].aula_base {
                if aula != base {
                    d.fuera_de_aula_base += 1;
                }
            }

            // Capacidad: al fusionar, el aula tiene que aguantar a todos los
            // grupos juntos. Sin dato de capacidad no se comprueba nada.
            if let Some(cupo) = self.p.aulas[aula].capacidad {
                let alumnos: u32 = sesion.grupos.iter().map(|&g| self.p.grupos[g].alumnos).sum();
                if alumnos > cupo {
                    d.aula_insuficiente += 1;
                }
            }

            // Disponibilidad: una hora que el docente no declaró, o que le
            // ocupan una descarga administrativa u otra carrera, no se puede
            // usar. Es dura, y sustituye a lo que antes eran el turno y los
            // días evitados por separado.
            let d0 = dia * self.horas;
            for h in hora..hora + duracion {
                let casilla = d0 + (h - self.hora_base);
                if !self.p.docentes[docente].disponible[casilla] {
                    d.hora_no_disponible += 1;
                }
                if self.p.docentes[docente].evita.get(casilla).copied().unwrap_or(false) {
                    d.hora_evitada += 1;
                    // El conteo es igual para todos porque es un diagnóstico;
                    // lo que pesa distinto es lo que cuesta. Así, entre dos
                    // horas evitadas, el motor le quita la suya al docente con
                    // prioridad solo cuando no queda más remedio.
                    blandas += pesos.hora_evitada
                        * (1.0 + self.p.docentes[docente].prioridad * pesos.prioridad);
                }
                if self.p.docentes[docente].en_disputa.get(casilla).copied().unwrap_or(false) {
                    d.hora_en_disputa += 1;
                }
            }

            // Una fusión ocupa el horario de todos los grupos que la reciben,
            // así que la regla de "una materia por día" se comprueba en cada uno.
            for &grupo in &sesion.grupos {
                let casilla = self.casilla_dia(grupo, sesion.materia, dia, n_materias);
                if self.dia_materia[casilla] > 0 {
                    d.materia_repetida_dia += 1;
                }
                self.dia_materia[casilla] += 1;
            }

            // Empalmes. Se cuentan al ocupar: si la ranura ya estaba tomada,
            // eso es exactamente un choque. Evita recorrer las tablas después.
            for h in hora..hora + duracion {
                let r = self.ranura(docente, dia, h);
                if self.ocupacion_docente[r] > 0 {
                    d.choque_docente += 1;
                }
                self.ocupacion_docente[r] += 1;

                for &grupo in &sesion.grupos {
                    let r = self.ranura(grupo, dia, h);
                    if self.ocupacion_grupo[r] > 0 {
                        d.choque_grupo += 1;
                    }
                    self.ocupacion_grupo[r] += 1;
                }

                let r = self.ranura(aula, dia, h);
                if self.ocupacion_aula[r] > 0 {
                    d.choque_aula += 1;
                }
                self.ocupacion_aula[r] += 1;

                // Los salones son del plantel: otra carrera puede tenerlo
                // tomado a esta misma hora.
                let casilla = d0 + (h - self.hora_base);
                if self.p.aulas[aula].ocupada.get(casilla).copied().unwrap_or(false) {
                    d.aula_ocupada_por_otros += 1;
                }
            }

            self.horas_docente[docente] += duracion as u32;

            let marca = docente * n_materias + sesion.materia;
            if !self.visto_materia[marca] {
                self.visto_materia[marca] = true;
                self.materias_docente[docente] += 1;
            }
            // Para el límite de grupos del docente, una fusión cuenta como uno:
            // es una sola clase impartida, y penalizarla como varias castigaría
            // justo lo que la fusión viene a ahorrar.
            let marca = docente * n_grupos + sesion.principal();
            if !self.visto_grupo[marca] {
                self.visto_grupo[marca] = true;
                self.grupos_docente[docente] += 1;
            }

            // Reglas de prioridad del departamento: las materias de especialidad
            // y los docentes de otras áreas eligen horario primero, lo que se
            // traduce en preferir las primeras horas del turno.
            let inicio_turno =
                self.p.rejilla.turnos[self.p.grupos[sesion.principal()].turno].hora_inicio as usize;
            let tardanza = hora.saturating_sub(inicio_turno) as f64;
            if self.p.materias[sesion.materia].es_de_especialidad {
                blandas += pesos.especialidad_tardia * tardanza;
            }
            if self.p.docentes[docente].es_de_otra_area {
                blandas += pesos.otra_area_tardia * tardanza;
            }
        }

        for (i, docente) in self.p.docentes.iter().enumerate() {
            if self.materias_docente[i] > docente.max_materias {
                d.exceso_materias += (self.materias_docente[i] - docente.max_materias) as u32;
            }
            if self.grupos_docente[i] > docente.max_grupos {
                d.exceso_grupos += (self.grupos_docente[i] - docente.max_grupos) as u32;
            }

            let asignadas = self.horas_docente[i];
            if asignadas > docente.horas_max as u32 {
                d.horas_sobre_maximo += asignadas - docente.horas_max as u32;
            }
            // El mínimo solo aplica si al docente se le asignó algo: un docente
            // sin carga es una decisión de la coordinación, no un defecto del
            // horario, y penalizarlo empujaría a repartir clases sin motivo.
            if asignadas > 0 && asignadas < docente.horas_min as u32 {
                d.horas_bajo_minimo += docente.horas_min as u32 - asignadas;
            }
        }

        d.huecos = huecos_en(&self.ocupacion_grupo, self.p.grupos.len(), self.dias, self.horas);
        d.huecos_docente =
            huecos_en(&self.ocupacion_docente, self.p.docentes.len(), self.dias, self.horas);

        let duras = pesos.docente_no_capacitado * d.docente_no_capacitado as f64
            + pesos.choque_docente * d.choque_docente as f64
            + pesos.choque_grupo * d.choque_grupo as f64
            + pesos.choque_aula * d.choque_aula as f64
            + pesos.aula_inadecuada * d.aula_inadecuada as f64
            + pesos.fuera_de_aula_base * d.fuera_de_aula_base as f64
            + pesos.aula_insuficiente * d.aula_insuficiente as f64
            + pesos.aula_ocupada_por_otros * d.aula_ocupada_por_otros as f64
            + pesos.materia_repetida_dia * d.materia_repetida_dia as f64
            + pesos.hora_no_disponible * d.hora_no_disponible as f64
            + pesos.exceso_materias * d.exceso_materias as f64
            + pesos.exceso_grupos * d.exceso_grupos as f64
            + pesos.horas_sobre_maximo * d.horas_sobre_maximo as f64;

        // La disputa no entra en las duras: el horario se puede aplicar si el
        // otro coordinador cede. Pesa fuerte para que el motor la evite, pero
        // no vuelve infactible el resultado.
        let medias = pesos.horas_bajo_minimo * d.horas_bajo_minimo as f64
            + pesos.hora_en_disputa * d.hora_en_disputa as f64;

        // `hora_evitada` no aparece aquí: ya entró en `blandas`, ponderada por
        // la antigüedad de cada docente.
        let suaves = pesos.hueco_grupo * d.huecos as f64
            + pesos.hueco_docente * d.huecos_docente as f64
            + blandas;

        (duras + medias + suaves, d)
    }

    /// Índices de los genes que participan en alguna violación dura.
    ///
    /// La mutación al azar repara empalmes por casualidad, y eso estanca la
    /// búsqueda: con 144 sesiones, la probabilidad de tocar justo la que choca
    /// es baja. Saber *cuáles* genes están mal permite que la búsqueda local
    /// vaya directo a ellos, que es la diferencia entre quedarse en tres
    /// empalmes para siempre y cerrarlos.
    pub fn conflictivos(&mut self, cromosoma: &Cromosoma, salida: &mut Vec<usize>) {
        salida.clear();
        self.evaluar(cromosoma);
        let n_materias = self.p.materias.len();

        for (i, (gen, sesion)) in cromosoma.iter().zip(&self.p.sesiones).enumerate() {
            let docente = gen.docente as usize;
            let aula = gen.aula as usize;
            let dia = gen.dia as usize;

            let no_capacitado = !self.capacitado[docente * n_materias + sesion.materia];
            let aula_mala = if self.p.materias[sesion.materia].requiere_laboratorio {
                !self.p.aulas[aula].es_laboratorio
            } else {
                matches!(self.p.grupos[sesion.principal()].aula_base, Some(base) if aula != base)
            };

            // Una ranura con más de un ocupante señala a todos los genes que la
            // comparten, no solo al último en llegar: mover cualquiera de ellos
            // deshace el empalme.
            let inicio = gen.hora as usize;
            let empalmado = (inicio..inicio + sesion.duracion as usize).any(|h| {
                self.ocupacion_docente[self.ranura(docente, dia, h)] > 1
                    || self.ocupacion_aula[self.ranura(aula, dia, h)] > 1
                    || sesion
                        .grupos
                        .iter()
                        .any(|&g| self.ocupacion_grupo[self.ranura(g, dia, h)] > 1)
            });

            let repetido = sesion.grupos.iter().any(|&g| {
                self.dia_materia[self.casilla_dia(g, sesion.materia, dia, n_materias)] > 1
            });

            if no_capacitado || aula_mala || empalmado || repetido {
                salida.push(i);
            }
        }
    }

}

/// Horas libres intercaladas entre la primera y la última clase de un día.
///
/// Las horas antes de la primera y después de la última no cuentan: esas no son
/// huecos, son el inicio y el final de la jornada. Sirve igual para grupos y
/// para docentes porque las dos tablas de ocupación tienen la misma forma.
fn huecos_en(ocupacion: &[u16], cuantos: usize, dias: usize, horas: usize) -> u32 {
    let mut total = 0;
    for i in 0..cuantos {
        for dia in 0..dias {
            let base = (i * dias + dia) * horas;
            let franja = &ocupacion[base..base + horas];
            let primera = franja.iter().position(|&x| x > 0);
            let ultima = franja.iter().rposition(|&x| x > 0);
            if let (Some(a), Some(b)) = (primera, ultima) {
                total += franja[a..=b].iter().filter(|&&x| x == 0).count() as u32;
            }
        }
    }
    total
}

#[cfg(test)]
mod pruebas {
    use super::*;
    use crate::modelo::{Gen, Problema};

    fn problema_de_prueba() -> Problema {
        // Un grupo, dos materias de 2 h, dos docentes, dos aulas, dos días.
        Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes","martes"],
                         "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}],
                         "duracionMaximaBloque":2},
              "materias":[
                {"id":"m1","horasSemana":2},
                {"id":"m2","horasSemana":2,"requiereLaboratorio":true}],
              "aulas":[{"id":"a1","tipo":"aula"},{"id":"lab1","tipo":"laboratorio"}],
              "docentes":[
                {"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                 "materiasCapacitadas":["m1","m2"],
                 "disponibilidad":{"turno":"matutino","diasEvitar":[],"horasEvitar":[]}},
                {"id":"d2","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                 "materiasCapacitadas":[]}],
              "grupos":[{"id":"g1","semestre":1,"turno":"matutino","materias":["m1","m2"]}]
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn horario_perfecto_cuesta_cero() {
        let p = problema_de_prueba();
        let mut e = Evaluador::nuevo(&p);
        // m1 el lunes 7-9 en aula; m2 el martes 7-9 en laboratorio.
        let cromosoma = vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 1, dia: 1, hora: 7 },
        ];
        let (costo, d) = e.evaluar_con_detalle(&cromosoma);
        assert_eq!(costo, 0.0, "diagnóstico: {d:?}");
        assert!(d.factible());
    }

    #[test]
    fn detecta_empalme_de_grupo_docente_y_aula() {
        let p = problema_de_prueba();
        let mut e = Evaluador::nuevo(&p);
        // Las dos sesiones exactamente encima: mismo grupo, docente y aula.
        let cromosoma = vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
        ];
        let (_, d) = e.evaluar_con_detalle(&cromosoma);
        assert_eq!(d.choque_grupo, 2, "dos horas empalmadas");
        assert_eq!(d.choque_docente, 2);
        assert_eq!(d.choque_aula, 2);
        assert!(!d.factible());
    }

    #[test]
    fn detecta_empalme_parcial() {
        let p = problema_de_prueba();
        let mut e = Evaluador::nuevo(&p);
        // 7-9 y 8-10: se solapan una sola hora.
        let cromosoma = vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 1, dia: 0, hora: 8 },
        ];
        let (_, d) = e.evaluar_con_detalle(&cromosoma);
        assert_eq!(d.choque_grupo, 1);
    }

    #[test]
    fn detecta_docente_no_capacitado_y_aula_inadecuada() {
        let p = problema_de_prueba();
        let mut e = Evaluador::nuevo(&p);
        // d2 no puede dar nada, y m2 necesita laboratorio pero recibe aula.
        let cromosoma = vec![
            Gen { docente: 1, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 0, dia: 1, hora: 7 },
        ];
        let (_, d) = e.evaluar_con_detalle(&cromosoma);
        assert_eq!(d.docente_no_capacitado, 1);
        assert_eq!(d.aula_inadecuada, 1);
    }

    #[test]
    fn penaliza_la_misma_materia_dos_veces_en_un_dia() {
        // Un problema con una materia de 4 h: se parte en dos bloques de 2 h,
        // que deben caer en días distintos.
        let p = Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes","martes"],
                         "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}],
                         "duracionMaximaBloque":2},
              "materias":[{"id":"m1","horasSemana":4}],
              "aulas":[{"id":"a1","tipo":"aula"}],
              "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,
                           "maxGrupos":9,"materiasCapacitadas":["m1"]}],
              "grupos":[{"id":"g1","semestre":1,"turno":"matutino","materias":["m1"]}]
            }"#,
        )
        .unwrap();
        assert_eq!(p.sesiones.len(), 2, "4 h con tope de 2 son dos bloques");

        let mut e = Evaluador::nuevo(&p);

        // Los dos bloques el mismo día, aunque no se empalmen: 7-9 y 10-12.
        // Son cuatro horas de la materia en un día, y además separadas.
        let (_, d) = e.evaluar_con_detalle(&vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 0, dia: 0, hora: 10 },
        ]);
        assert_eq!(d.materia_repetida_dia, 1);
        assert_eq!(d.choque_grupo, 0, "no se empalman, el problema es otro");
        assert!(!d.factible());

        // Repartidos en dos días: correcto.
        let (_, d) = e.evaluar_con_detalle(&vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 0, dia: 1, hora: 7 },
        ]);
        assert_eq!(d.materia_repetida_dia, 0);
        assert!(d.factible(), "{d:?}");
    }

    #[test]
    fn una_hora_no_declarada_es_restriccion_dura() {
        // El docente solo declaró el martes; la descarga del lunes ya viene
        // descontada por el backend, así que aquí simplemente no aparece.
        let p = Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes","martes"],
                         "turnos":[{"id":"m","horaInicio":7,"horaFin":12}],
                         "duracionMaximaBloque":2},
              "materias":[{"id":"m1","horasSemana":2}],
              "aulas":[{"id":"a1","tipo":"aula"}],
              "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                           "materiasCapacitadas":["m1"],
                           "disponible":[{"dia":"martes","inicio":7,"fin":12}],
                           "evita":[{"dia":"martes","inicio":11,"fin":12}]}],
              "grupos":[{"id":"g1","semestre":1,"turno":"m","materias":["m1"]}]
            }"#,
        )
        .unwrap();
        let mut e = Evaluador::nuevo(&p);

        // Martes a las 7: dentro de lo declarado.
        let (costo, d) = e.evaluar_con_detalle(&vec![Gen { docente: 0, aula: 0, dia: 1, hora: 7 }]);
        assert_eq!(d.hora_no_disponible, 0);
        assert_eq!(costo, 0.0, "{d:?}");

        // Lunes: no lo declaró. Las dos horas del bloque cuentan.
        let (_, d) = e.evaluar_con_detalle(&vec![Gen { docente: 0, aula: 0, dia: 0, hora: 7 }]);
        assert_eq!(d.hora_no_disponible, 2);
        assert!(!d.factible(), "una hora que no tiene no es negociable");

        // Martes a las 10-12: puede, pero pidió evitar las 11.
        let (_, d) = e.evaluar_con_detalle(&vec![Gen { docente: 0, aula: 0, dia: 1, hora: 10 }]);
        assert_eq!(d.hora_no_disponible, 0);
        assert_eq!(d.hora_evitada, 1);
        assert!(d.factible(), "evitar es preferencia, no impedimento");
    }

    #[test]
    fn la_hora_en_disputa_pesa_pero_no_impide_aplicar() {
        let p = Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes","martes"],
                         "turnos":[{"id":"m","horaInicio":7,"horaFin":12}],
                         "duracionMaximaBloque":2},
              "materias":[{"id":"m1","horasSemana":2}],
              "aulas":[{"id":"a1","tipo":"aula"}],
              "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                           "materiasCapacitadas":["m1"],
                           "disponible":[{"dia":"lunes","inicio":7,"fin":12},
                                         {"dia":"martes","inicio":7,"fin":12}],
                           "enDisputa":[{"dia":"lunes","inicio":7,"fin":9}]}],
              "grupos":[{"id":"g1","semestre":1,"turno":"m","materias":["m1"]}]
            }"#,
        )
        .unwrap();
        let mut e = Evaluador::nuevo(&p);

        // Martes: libre de verdad, sin costo.
        let (costo, d) = e.evaluar_con_detalle(&vec![Gen { docente: 0, aula: 0, dia: 1, hora: 7 }]);
        assert_eq!(d.hora_en_disputa, 0);
        assert_eq!(costo, 0.0);

        // Lunes 7-9: otra carrera la pretende. Cuesta, pero el horario sigue
        // siendo aplicable: basta con que el otro coordinador ceda.
        let (costo, d) = e.evaluar_con_detalle(&vec![Gen { docente: 0, aula: 0, dia: 0, hora: 7 }]);
        assert_eq!(d.hora_en_disputa, 2);
        assert_eq!(d.hora_no_disponible, 0);
        assert!(costo > 0.0);
        assert!(d.factible(), "la disputa se negocia, no invalida");
    }

    #[test]
    fn entre_disputada_y_no_disponible_gana_la_disputada() {
        // Las dos son duras para el buscador, pero una se puede negociar y la
        // otra no. El peso tiene que reflejarlo.
        let p = Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes","martes"],
                         "turnos":[{"id":"m","horaInicio":7,"horaFin":12}]},
              "materias":[{"id":"m1","horasSemana":2}],
              "aulas":[{"id":"a1","tipo":"aula"}],
              "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                           "materiasCapacitadas":["m1"],
                           "disponible":[{"dia":"lunes","inicio":7,"fin":12}],
                           "enDisputa":[{"dia":"lunes","inicio":7,"fin":12}]}],
              "grupos":[{"id":"g1","semestre":1,"turno":"m","materias":["m1"]}]
            }"#,
        )
        .unwrap();
        let mut e = Evaluador::nuevo(&p);
        let disputada = e.evaluar(&vec![Gen { docente: 0, aula: 0, dia: 0, hora: 7 }]);
        let inexistente = e.evaluar(&vec![Gen { docente: 0, aula: 0, dia: 1, hora: 7 }]);
        assert!(disputada < inexistente, "{disputada} debería costar menos que {inexistente}");
    }

    #[test]
    fn la_fusion_necesita_un_aula_que_aguante_a_los_dos_grupos() {
        // a1 cabe 30, a2 cabe 70. Dos grupos de 30 fusionados son 60.
        let p = Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes"],"turnos":[{"id":"m","horaInicio":7,"horaFin":12}]},
              "materias":[{"id":"m1","horasSemana":2}],
              "aulas":[{"id":"a1","tipo":"aula","capacidad":30},
                       {"id":"a2","tipo":"aula","capacidad":70}],
              "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                           "materiasCapacitadas":["m1"]}],
              "grupos":[{"id":"g1","turno":"m","alumnos":30,"materias":["m1"]},
                        {"id":"g2","turno":"m","alumnos":30,"materias":["m1"]}],
              "fusiones":[{"materiaId":"m1","grupos":["g1","g2"]}]
            }"#,
        )
        .unwrap();
        let mut e = Evaluador::nuevo(&p);

        // En a1 no caben los 60.
        let (_, d) = e.evaluar_con_detalle(&vec![Gen { docente: 0, aula: 0, dia: 0, hora: 7 }]);
        assert_eq!(d.aula_insuficiente, 1);
        assert!(!d.factible());

        // En a2 sí.
        let (_, d) = e.evaluar_con_detalle(&vec![Gen { docente: 0, aula: 1, dia: 0, hora: 7 }]);
        assert_eq!(d.aula_insuficiente, 0);
        assert!(d.factible(), "{d:?}");
    }

    #[test]
    fn sin_capacidad_registrada_no_se_comprueba_nada() {
        // Un aula sin dato no debe rechazar horarios que probablemente caben.
        let p = Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes"],"turnos":[{"id":"m","horaInicio":7,"horaFin":12}]},
              "materias":[{"id":"m1","horasSemana":2}],
              "aulas":[{"id":"a1","tipo":"aula"}],
              "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                           "materiasCapacitadas":["m1"]}],
              "grupos":[{"id":"g1","turno":"m","alumnos":500,"materias":["m1"]}]
            }"#,
        )
        .unwrap();
        let mut e = Evaluador::nuevo(&p);
        let (_, d) = e.evaluar_con_detalle(&vec![Gen { docente: 0, aula: 0, dia: 0, hora: 7 }]);
        assert_eq!(d.aula_insuficiente, 0);
    }

    #[test]
    fn un_aula_que_usa_otra_carrera_no_esta_libre() {
        let p = Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes","martes"],"turnos":[{"id":"m","horaInicio":7,"horaFin":12}]},
              "materias":[{"id":"m1","horasSemana":2}],
              "aulas":[{"id":"a1","tipo":"aula","ocupada":[{"dia":"lunes","inicio":7,"fin":9}]}],
              "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                           "materiasCapacitadas":["m1"]}],
              "grupos":[{"id":"g1","turno":"m","materias":["m1"]}]
            }"#,
        )
        .unwrap();
        let mut e = Evaluador::nuevo(&p);

        let (_, d) = e.evaluar_con_detalle(&vec![Gen { docente: 0, aula: 0, dia: 0, hora: 7 }]);
        assert_eq!(d.aula_ocupada_por_otros, 2, "las dos horas del bloque");
        assert!(!d.factible());

        let (_, d) = e.evaluar_con_detalle(&vec![Gen { docente: 0, aula: 0, dia: 1, hora: 7 }]);
        assert_eq!(d.aula_ocupada_por_otros, 0);
    }

    #[test]
    fn una_fusion_ocupa_el_horario_de_todos_sus_grupos() {
        // g1 y g2 cursan m1 juntos; m2 solo la lleva g1.
        let p = Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes","martes"],
                         "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}],
                         "duracionMaximaBloque":2},
              "materias":[{"id":"m1","horasSemana":2},{"id":"m2","horasSemana":2}],
              "aulas":[{"id":"a1","tipo":"aula"},{"id":"a2","tipo":"aula"}],
              "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,
                           "maxGrupos":9,"materiasCapacitadas":["m1","m2"]}],
              "grupos":[{"id":"g1","semestre":1,"turno":"matutino","materias":["m1","m2"]},
                        {"id":"g2","semestre":1,"turno":"matutino","materias":["m1"]}],
              "fusiones":[{"materiaId":"m1","grupos":["g1","g2"]}]
            }"#,
        )
        .unwrap();

        // m1 se programa una sola vez para los dos grupos: 2 sesiones, no 3.
        assert_eq!(p.sesiones.len(), 2, "{:?}", p.sesiones);
        let fusionada = p.sesiones.iter().find(|s| s.es_fusionada()).unwrap();
        assert_eq!(fusionada.grupos, vec![0, 1]);

        let mut e = Evaluador::nuevo(&p);
        let i = p.sesiones.iter().position(|s| s.es_fusionada()).unwrap();

        // La fusión el lunes 7-9 y la otra materia de g1 el martes: sin choques.
        let mut c = vec![Gen { docente: 0, aula: 0, dia: 0, hora: 7 }; 2];
        c[1 - i] = Gen { docente: 0, aula: 0, dia: 1, hora: 7 };
        let (_, d) = e.evaluar_con_detalle(&c);
        assert_eq!(d.choque_grupo, 0, "{d:?}");

        // Ahora las dos el lunes a la misma hora: g1 recibe las dos clases a la
        // vez, así que hay empalme aunque una sea fusionada.
        let c = vec![Gen { docente: 0, aula: 0, dia: 0, hora: 7 }; 2];
        let (_, d) = e.evaluar_con_detalle(&c);
        assert_eq!(d.choque_grupo, 2, "dos horas empalmadas en g1");
    }

    #[test]
    fn la_fusion_cuenta_como_un_grupo_para_el_docente() {
        let p = Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes","martes"],
                         "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}]},
              "materias":[{"id":"m1","horasSemana":2}],
              "aulas":[{"id":"a1","tipo":"aula"}],
              "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,
                           "maxGrupos":1,"materiasCapacitadas":["m1"]}],
              "grupos":[{"id":"g1","semestre":1,"turno":"matutino","materias":["m1"]},
                        {"id":"g2","semestre":1,"turno":"matutino","materias":["m1"]}],
              "fusiones":[{"materiaId":"m1","grupos":["g1","g2"]}]
            }"#,
        )
        .unwrap();
        let mut e = Evaluador::nuevo(&p);
        // maxGrupos es 1. Atender dos grupos fusionados es una sola clase
        // impartida, así que no debe excederlo.
        let (_, d) = e.evaluar_con_detalle(&vec![Gen { docente: 0, aula: 0, dia: 0, hora: 7 }]);
        assert_eq!(d.exceso_grupos, 0, "{d:?}");
    }

    #[test]
    fn el_grupo_no_sale_de_su_aula_salvo_al_laboratorio() {
        // g1 tiene asignada el aula a2. m1 es normal, m2 pide laboratorio.
        let p = Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes","martes"],
                         "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}],
                         "duracionMaximaBloque":2},
              "materias":[{"id":"m1","horasSemana":2},
                          {"id":"m2","horasSemana":2,"requiereLaboratorio":true}],
              "aulas":[{"id":"a1","tipo":"aula"},{"id":"a2","tipo":"aula"},
                       {"id":"lab1","tipo":"laboratorio"}],
              "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,
                           "maxGrupos":9,"materiasCapacitadas":["m1","m2"]}],
              "grupos":[{"id":"g1","semestre":1,"turno":"matutino",
                         "aulaId":"a2","materias":["m1","m2"]}]
            }"#,
        )
        .unwrap();
        assert_eq!(p.grupos[0].aula_base, Some(1), "a2 es el indice 1");

        let mut e = Evaluador::nuevo(&p);

        // Correcto: la normal en su aula, la de laboratorio en el laboratorio.
        let (costo, d) = e.evaluar_con_detalle(&vec![
            Gen { docente: 0, aula: 1, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 2, dia: 1, hora: 7 },
        ]);
        assert_eq!(d.fuera_de_aula_base, 0);
        assert_eq!(d.aula_inadecuada, 0);
        assert_eq!(costo, 0.0, "{d:?}");

        // La materia normal en otra aula libre: sigue siendo un aula, pero no
        // la suya, y el grupo tendría que mudarse.
        let (_, d) = e.evaluar_con_detalle(&vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 2, dia: 1, hora: 7 },
        ]);
        assert_eq!(d.fuera_de_aula_base, 1);
        assert!(!d.factible());

        // La de laboratorio metida en el aula base: eso es aula inadecuada, no
        // "fuera de su aula".
        let (_, d) = e.evaluar_con_detalle(&vec![
            Gen { docente: 0, aula: 1, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 1, dia: 1, hora: 7 },
        ]);
        assert_eq!(d.aula_inadecuada, 1);
        assert_eq!(d.fuera_de_aula_base, 0);
    }

    #[test]
    fn sin_aula_base_el_grupo_no_queda_penalizado() {
        // Un grupo sin aulaId deja la decisión al motor: no debe penalizarse
        // por "salir" de un aula que nunca se le asignó.
        let p = problema_de_prueba();
        assert_eq!(p.grupos[0].aula_base, None);
        let mut e = Evaluador::nuevo(&p);
        let (_, d) = e.evaluar_con_detalle(&vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 1, dia: 1, hora: 7 },
        ]);
        assert_eq!(d.fuera_de_aula_base, 0);
    }

    #[test]
    fn los_bloques_ocupan_horas_seguidas() {
        // La contigüidad no se penaliza: es estructural. Un bloque de 2 h ocupa
        // la hora de inicio y la siguiente, nunca dos sueltas.
        let p = problema_de_prueba();
        let mut e = Evaluador::nuevo(&p);
        let cromosoma = vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 1, dia: 0, hora: 8 },
        ];
        let (_, d) = e.evaluar_con_detalle(&cromosoma);
        // Si el bloque de 7 no ocupara también las 8, no habría empalme.
        assert_eq!(d.choque_grupo, 1, "el bloque de 2 h debe ocupar 7 y 8");
    }

    #[test]
    fn una_materia_de_una_hora_no_se_repite_sola() {
        let p = problema_de_prueba();
        let mut e = Evaluador::nuevo(&p);
        let (_, d) = e.evaluar_con_detalle(&vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 1, dia: 1, hora: 7 },
        ]);
        assert_eq!(d.materia_repetida_dia, 0);
    }

    #[test]
    fn cuenta_huecos_solo_entre_clases() {
        let p = problema_de_prueba();
        let mut e = Evaluador::nuevo(&p);
        // Mismo día: 7-9 y 11-13. Quedan dos horas muertas en medio (9 y 10).
        let cromosoma = vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 1, dia: 0, hora: 11 },
        ];
        let (_, d) = e.evaluar_con_detalle(&cromosoma);
        assert_eq!(d.huecos, 2);

        // Contiguas: sin huecos.
        let cromosoma = vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 1, dia: 0, hora: 9 },
        ];
        let (_, d) = e.evaluar_con_detalle(&cromosoma);
        assert_eq!(d.huecos, 0);
    }

    #[test]
    fn entre_dos_horas_evitadas_cede_el_de_menos_prioridad() {
        // Dos docentes igual de capaces, los dos evitan la misma hora. Solo uno
        // puede librarse: al que el coordinador le puso prioridad.
        let p = Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes"],
                         "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}],
                         "duracionMaximaBloque":2},
              "materias":[{"id":"m1","horasSemana":2}],
              "aulas":[{"id":"a1","tipo":"aula"}],
              "docentes":[
                {"id":"sinPrioridad","prioridad":0,"horasMin":0,"horasMax":40,
                 "maxMaterias":9,"maxGrupos":9,"materiasCapacitadas":["m1"],
                 "evita":[{"dia":"lunes","inicio":7,"fin":9}]},
                {"id":"conPrioridad","prioridad":2,"horasMin":0,"horasMax":40,
                 "maxMaterias":9,"maxGrupos":9,"materiasCapacitadas":["m1"],
                 "evita":[{"dia":"lunes","inicio":7,"fin":9}]}],
              "grupos":[{"id":"g1","semestre":1,"turno":"matutino","materias":["m1"]}]
            }"#,
        )
        .unwrap();
        let mut e = Evaluador::nuevo(&p);

        let en_hora_mala = |docente: u16| vec![Gen { docente, aula: 0, dia: 0, hora: 7 }];
        let (coste_sin, d1) = e.evaluar_con_detalle(&en_hora_mala(0));
        let (coste_con, d2) = e.evaluar_con_detalle(&en_hora_mala(1));

        assert_eq!(d1.hora_evitada, 2, "el diagnóstico cuenta horas, no privilegios");
        assert_eq!(d2.hora_evitada, 2);
        assert!(
            coste_sin < coste_con,
            "sacrificar al de menos prioridad tiene que costar menos: {coste_sin} vs {coste_con}"
        );
    }

    #[test]
    fn sin_prioridad_declarada_todos_pesan_igual() {
        // El campo es opcional: sin él, la regla no debe inventar un orden.
        let p = Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes"],
                         "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}],
                         "duracionMaximaBloque":2},
              "materias":[{"id":"m1","horasSemana":2}],
              "aulas":[{"id":"a1","tipo":"aula"}],
              "docentes":[
                {"id":"a","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                 "materiasCapacitadas":["m1"],"evita":[{"dia":"lunes","inicio":7,"fin":9}]},
                {"id":"b","horasMin":0,"horasMax":40,"maxMaterias":9,"maxGrupos":9,
                 "materiasCapacitadas":["m1"],"evita":[{"dia":"lunes","inicio":7,"fin":9}]}],
              "grupos":[{"id":"g1","semestre":1,"turno":"matutino","materias":["m1"]}]
            }"#,
        )
        .unwrap();
        let mut e = Evaluador::nuevo(&p);

        let (a, _) = e.evaluar_con_detalle(&vec![Gen { docente: 0, aula: 0, dia: 0, hora: 7 }]);
        let (b, _) = e.evaluar_con_detalle(&vec![Gen { docente: 1, aula: 0, dia: 0, hora: 7 }]);
        assert_eq!(a, b);
    }

    #[test]
    fn el_hueco_del_docente_se_cuenta_aunque_el_grupo_no_lo_tenga() {
        // Dos grupos distintos, un solo docente. El grupo no ve hueco —cada uno
        // tiene una sola clase— pero el docente se queda esperando dos horas
        // entre una y otra, que es justo el caso que el conteo por grupo no ve.
        let p = Problema::leer(
            r#"{
              "rejilla":{"dias":["lunes"],
                         "turnos":[{"id":"matutino","horaInicio":7,"horaFin":14}],
                         "duracionMaximaBloque":2},
              "materias":[{"id":"m1","horasSemana":2}],
              "aulas":[{"id":"a1","tipo":"aula"},{"id":"a2","tipo":"aula"}],
              "docentes":[{"id":"d1","horasMin":0,"horasMax":40,"maxMaterias":9,
                           "maxGrupos":9,"materiasCapacitadas":["m1"]}],
              "grupos":[{"id":"g1","semestre":1,"turno":"matutino","materias":["m1"]},
                        {"id":"g2","semestre":1,"turno":"matutino","materias":["m1"]}]
            }"#,
        )
        .unwrap();
        let mut e = Evaluador::nuevo(&p);

        // 7-9 con un grupo, 11-13 con el otro.
        let separadas = vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 1, dia: 0, hora: 11 },
        ];
        let (aptitud_separadas, d) = e.evaluar_con_detalle(&separadas);
        assert_eq!(d.huecos, 0, "ningún grupo tiene hora muerta");
        assert_eq!(d.huecos_docente, 2, "el docente sí: las 9 y las 10");

        // Seguidas: el docente entra una vez y se va.
        let seguidas = vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 1, dia: 0, hora: 9 },
        ];
        let (aptitud_seguidas, d) = e.evaluar_con_detalle(&seguidas);
        assert_eq!(d.huecos_docente, 0);
        assert!(
            aptitud_seguidas < aptitud_separadas,
            "juntarle las clases al docente tiene que puntuar mejor"
        );
    }

    #[test]
    fn evaluar_no_arrastra_estado_entre_llamadas() {
        let p = problema_de_prueba();
        let mut e = Evaluador::nuevo(&p);
        let malo = vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
        ];
        let bueno = vec![
            Gen { docente: 0, aula: 0, dia: 0, hora: 7 },
            Gen { docente: 0, aula: 1, dia: 1, hora: 7 },
        ];
        e.evaluar(&malo);
        // Si las tablas no se limpiaran, este saldría contaminado por el anterior.
        assert_eq!(e.evaluar(&bueno), 0.0);
        assert_eq!(e.evaluar(&bueno), 0.0);
    }
}
