//! Servidor HTTP/1.1 mínimo.
//!
//! El motor expone tres rutas. Un framework traería un runtime asíncrono
//! completo para eso, así que aquí va un hilo por conexión sobre `TcpListener`:
//! el cliente es un único backend, no un navegador abierto al mundo.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

/// Tope del cuerpo de la petición. Un problema de horarios grande ronda unos
/// cientos de kilobytes; 16 MB deja margen de sobra y evita que una petición
/// mal formada reserve memoria sin límite.
const MAX_CUERPO: usize = 16 * 1024 * 1024;

pub struct Peticion {
    pub metodo: String,
    pub ruta: String,
    pub cuerpo: String,
}

pub struct Respuesta {
    pub codigo: u16,
    pub tipo: &'static str,
    pub cuerpo: String,
}

impl Respuesta {
    pub fn json(cuerpo: String) -> Self {
        Self { codigo: 200, tipo: "application/json; charset=utf-8", cuerpo }
    }

    /// Error en el formato que el backend espera, para que pueda mostrarlo tal
    /// cual en la interfaz en vez de inventar un mensaje genérico.
    pub fn error(codigo: u16, mensaje: impl Into<String>) -> Self {
        let cuerpo = crate::json::objeto([("error", crate::json::texto(mensaje.into()))]);
        Self { codigo, tipo: "application/json; charset=utf-8", cuerpo: cuerpo.escribir() }
    }
}

pub fn servir<F>(puerto: u16, manejador: F) -> std::io::Result<()>
where
    F: Fn(&Peticion) -> Respuesta + Send + Sync + 'static,
{
    let escucha = TcpListener::bind(("0.0.0.0", puerto))?;
    let manejador = Arc::new(manejador);

    for conexion in escucha.incoming() {
        match conexion {
            Ok(flujo) => {
                let manejador = Arc::clone(&manejador);
                // Una conexión rota no debe tumbar el servidor: se atiende en su
                // propio hilo y cualquier error muere ahí.
                std::thread::spawn(move || {
                    if let Err(e) = atender(flujo, &*manejador) {
                        eprintln!("conexión terminada: {e}");
                    }
                });
            }
            Err(e) => eprintln!("no se pudo aceptar la conexión: {e}"),
        }
    }
    Ok(())
}

fn atender<F>(mut flujo: TcpStream, manejador: &F) -> std::io::Result<()>
where
    F: Fn(&Peticion) -> Respuesta,
{
    let respuesta = match leer_peticion(&mut flujo) {
        Ok(peticion) => manejador(&peticion),
        Err(mensaje) => Respuesta::error(400, mensaje),
    };
    escribir_respuesta(&mut flujo, &respuesta)
}

fn leer_peticion(flujo: &mut TcpStream) -> Result<Peticion, String> {
    let mut lector = BufReader::new(flujo);

    let mut linea = String::new();
    lector.read_line(&mut linea).map_err(|e| e.to_string())?;
    let mut partes = linea.split_whitespace();
    let metodo = partes.next().ok_or("petición vacía")?.to_owned();
    let ruta = partes.next().ok_or("falta la ruta")?.to_owned();

    let mut cabeceras = HashMap::new();
    loop {
        let mut linea = String::new();
        let leidos = lector.read_line(&mut linea).map_err(|e| e.to_string())?;
        if leidos == 0 || linea.trim().is_empty() {
            break;
        }
        if let Some((clave, valor)) = linea.split_once(':') {
            cabeceras.insert(clave.trim().to_ascii_lowercase(), valor.trim().to_owned());
        }
    }

    let largo: usize = cabeceras
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if largo > MAX_CUERPO {
        return Err(format!("cuerpo demasiado grande ({largo} bytes)"));
    }

    let mut cuerpo = vec![0u8; largo];
    lector.read_exact(&mut cuerpo).map_err(|e| e.to_string())?;
    let cuerpo = String::from_utf8(cuerpo).map_err(|_| "el cuerpo no es UTF-8 válido".to_owned())?;

    // La ruta se queda sin query string: ninguna de las tres rutas la usa.
    let ruta = ruta.split('?').next().unwrap_or("/").to_owned();
    Ok(Peticion { metodo, ruta, cuerpo })
}

fn escribir_respuesta(flujo: &mut TcpStream, respuesta: &Respuesta) -> std::io::Result<()> {
    let cuerpo = respuesta.cuerpo.as_bytes();
    let cabecera = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        respuesta.codigo,
        razon(respuesta.codigo),
        respuesta.tipo,
        cuerpo.len()
    );
    flujo.write_all(cabecera.as_bytes())?;
    flujo.write_all(cuerpo)?;
    flujo.flush()
}

fn razon(codigo: u16) -> &'static str {
    match codigo {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        422 => "Unprocessable Entity",
        _ => "Internal Server Error",
    }
}
