//! SchedulAI — motor de asignación de horarios.
//!
//! Microservicio sin estado: recibe un problema de horarios por HTTP, corre un
//! algoritmo memético paralelo y devuelve el mejor horario que encontró junto
//! con un diagnóstico de lo que quedó mal. No lee disco, no conoce escenarios y
//! no sabe que existe una base de datos: el backend de Node se encarga de eso.
//!
//! Rutas:
//!   GET  /api/salud     estado del servicio
//!   POST /api/resolver  problema -> horario
//!
//! Variables de entorno: PUERTO (4 000 por omisión en el contenedor: 7000).

mod aptitud;
mod azar;
mod genetico;
mod http;
mod islas;
mod json;
mod modelo;

use http::{Peticion, Respuesta};
use modelo::Problema;
use std::time::Instant;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let puerto: u16 = std::env::var("PUERTO")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(7000);

    let nucleos = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    println!("SchedulAI motor {VERSION} escuchando en :{puerto} ({nucleos} núcleos disponibles)");

    if let Err(e) = http::servir(puerto, enrutar) {
        eprintln!("el servidor no pudo arrancar: {e}");
        std::process::exit(1);
    }
}

fn enrutar(peticion: &Peticion) -> Respuesta {
    match (peticion.metodo.as_str(), peticion.ruta.as_str()) {
        ("GET", "/api/salud") | ("GET", "/") => salud(),
        ("POST", "/api/resolver") => resolver(&peticion.cuerpo),
        ("POST", "/api/evaluar") => evaluar(&peticion.cuerpo),
        ("POST", _) | ("GET", _) => Respuesta::error(404, "ruta desconocida"),
        _ => Respuesta::error(405, "método no permitido"),
    }
}

fn salud() -> Respuesta {
    let nucleos = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    Respuesta::json(
        json::objeto([
            ("estado", json::texto("ok")),
            ("servicio", json::texto("engine")),
            ("version", json::texto(VERSION)),
            ("nucleos", json::entero(nucleos)),
        ])
        .escribir(),
    )
}

/**
 * Vuelve a puntuar un horario ya armado, sin buscar nada.
 *
 * Es lo que sostiene el ajuste manual: el coordinador mueve una clase y el
 * motor dice qué se rompió, con las mismas reglas con las que la colocó. Sin
 * esto la comprobación habría que reescribirla en el backend, donde se
 * separaría de estas en cuanto una cambie.
 *
 * Devuelve lo mismo que `/api/resolver`, así que quien lo llama no distingue un
 * horario generado de uno ajustado: se aparta, se imprime y se recupera igual.
 */
fn evaluar(cuerpo: &str) -> Respuesta {
    let problema = match Problema::leer(cuerpo) {
        Ok(p) => p,
        Err(e) => return Respuesta::error(422, format!("problema inválido: {e}")),
    };
    let valor = match json::leer(cuerpo) {
        Ok(v) => v,
        Err(e) => return Respuesta::error(422, format!("cuerpo inválido: {e}")),
    };

    let cromosoma = match modelo::leer_horario(&problema, &valor) {
        Ok(c) => c,
        Err(e) => return Respuesta::error(422, e),
    };

    let reloj = Instant::now();
    let mut evaluador = aptitud::Evaluador::nuevo(&problema);
    let (puntaje, diagnostico) = evaluador.evaluar_con_detalle(&cromosoma);

    Respuesta::json(
        modelo::solucion_a_json(
            &problema,
            &cromosoma,
            puntaje,
            &diagnostico,
            0,
            reloj.elapsed().as_millis(),
            &[],
        )
        .escribir(),
    )
}

fn resolver(cuerpo: &str) -> Respuesta {
    // Un problema mal formado es culpa de quien lo envía, no un fallo del
    // motor: 422 con el motivo exacto, para que el backend lo muestre tal cual.
    let problema = match Problema::leer(cuerpo) {
        Ok(p) => p,
        Err(e) => return Respuesta::error(422, format!("problema inválido: {e}")),
    };

    let sin_docente = problema.materias_sin_docente();
    println!(
        "resolviendo: {} grupos, {} sesiones, {} docentes, {} aulas | {} islas x {} individuos x {} generaciones{}",
        problema.grupos.len(),
        problema.sesiones.len(),
        problema.docentes.len(),
        problema.aulas.len(),
        problema.parametros.islas,
        problema.parametros.poblacion_por_isla,
        problema.parametros.generaciones,
        if sin_docente.is_empty() {
            String::new()
        } else {
            format!(" | {} materias sin docente capacitado", sin_docente.len())
        }
    );

    let reloj = Instant::now();
    let resultado = islas::resolver(&problema);
    let milisegundos = reloj.elapsed().as_millis();

    println!(
        "listo en {milisegundos} ms: aptitud {:.2}, factible {}",
        resultado.aptitud,
        resultado.diagnostico.factible()
    );

    Respuesta::json(
        modelo::solucion_a_json(
            &problema,
            &resultado.cromosoma,
            resultado.aptitud,
            &resultado.diagnostico,
            resultado.generaciones,
            milisegundos,
            &resultado.historial,
        )
        .escribir(),
    )
}
