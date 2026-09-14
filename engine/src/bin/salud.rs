//! Sonda de salud para el `healthcheck` de Docker.
//!
//! La imagen del motor es `scratch`-adyacente: no trae curl ni wget, así que la
//! sonda viaja como un segundo binario. Es independiente a propósito — no
//! comparte módulos con el motor, porque debe poder responder incluso si el
//! motor está ocupado resolviendo.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

fn main() {
    let puerto = std::env::var("PUERTO").unwrap_or_else(|_| "7000".to_owned());

    match consultar(&puerto) {
        Ok(true) => std::process::exit(0),
        Ok(false) => {
            eprintln!("el motor respondió algo distinto de 200");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("el motor no respondió: {e}");
            std::process::exit(1);
        }
    }
}

fn consultar(puerto: &str) -> std::io::Result<bool> {
    let mut flujo = TcpStream::connect(format!("127.0.0.1:{puerto}"))?;
    flujo.set_read_timeout(Some(Duration::from_secs(3)))?;
    flujo.set_write_timeout(Some(Duration::from_secs(3)))?;
    flujo.write_all(b"GET /api/salud HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;

    let mut respuesta = String::new();
    flujo.read_to_string(&mut respuesta)?;
    Ok(respuesta.starts_with("HTTP/1.1 200"))
}
