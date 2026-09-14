//! JSON mínimo: lectura, escritura y acceso por campo.
//!
//! Existe para no añadir `serde` por un solo formato de intercambio. Cubre lo
//! que el motor necesita y nada más: sin derivación de macros, sin
//! deserialización genérica. `modelo.rs` traduce a mano de `Valor` a structs.

use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq)]
pub enum Valor {
    Nulo,
    Bool(bool),
    Numero(f64),
    Texto(String),
    Lista(Vec<Valor>),
    Objeto(Vec<(String, Valor)>),
}

// ---------------------------------------------------------------- acceso

impl Valor {
    /// Campo de un objeto. `Nulo` se trata como ausente, de modo que un
    /// `especialidadId: null` y un campo omitido se comporten igual.
    pub fn campo(&self, nombre: &str) -> Option<&Valor> {
        match self {
            Valor::Objeto(pares) => pares
                .iter()
                .find(|(clave, _)| clave == nombre)
                .map(|(_, valor)| valor)
                .filter(|valor| !matches!(valor, Valor::Nulo)),
            _ => None,
        }
    }

    /// Los pares de un objeto, o nada si no lo es. Para mapas cuyas claves no
    /// se conocen de antemano, como `{materiaId: docenteId}`.
    pub fn pares(&self) -> &[(String, Valor)] {
        match self {
            Valor::Objeto(campos) => campos,
            _ => &[],
        }
    }

    pub fn texto(&self) -> Option<&str> {
        match self {
            Valor::Texto(s) => Some(s),
            _ => None,
        }
    }

    pub fn numero(&self) -> Option<f64> {
        match self {
            Valor::Numero(n) => Some(*n),
            _ => None,
        }
    }

    pub fn booleano(&self) -> Option<bool> {
        match self {
            Valor::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn lista(&self) -> Option<&[Valor]> {
        match self {
            Valor::Lista(xs) => Some(xs),
            _ => None,
        }
    }

    /// Lista de un campo, o vacía si no está. Evita un `match` en cada uso:
    /// para el motor, "sin días a evitar" y "campo ausente" son lo mismo.
    pub fn lista_de(&self, nombre: &str) -> &[Valor] {
        self.campo(nombre).and_then(Valor::lista).unwrap_or(&[])
    }

    pub fn texto_de(&self, nombre: &str) -> Option<&str> {
        self.campo(nombre).and_then(Valor::texto)
    }

    pub fn numero_de(&self, nombre: &str) -> Option<f64> {
        self.campo(nombre).and_then(Valor::numero)
    }

    pub fn entero_o(&self, nombre: &str, por_omision: i64) -> i64 {
        self.numero_de(nombre).map(|n| n as i64).unwrap_or(por_omision)
    }

    pub fn usize_o(&self, nombre: &str, por_omision: usize) -> usize {
        match self.numero_de(nombre) {
            Some(n) if n >= 0.0 => n as usize,
            _ => por_omision,
        }
    }

    pub fn real_o(&self, nombre: &str, por_omision: f64) -> f64 {
        self.numero_de(nombre).unwrap_or(por_omision)
    }

    pub fn bool_o(&self, nombre: &str, por_omision: bool) -> bool {
        self.campo(nombre).and_then(Valor::booleano).unwrap_or(por_omision)
    }

    /// Textos de una lista de textos, descartando lo que no lo sea.
    pub fn textos_de(&self, nombre: &str) -> Vec<String> {
        self.lista_de(nombre)
            .iter()
            .filter_map(Valor::texto)
            .map(str::to_owned)
            .collect()
    }
}

// ---------------------------------------------------------------- escritura

impl Valor {
    pub fn escribir(&self) -> String {
        let mut salida = String::new();
        self.escribir_en(&mut salida);
        salida
    }

    fn escribir_en(&self, salida: &mut String) {
        match self {
            Valor::Nulo => salida.push_str("null"),
            Valor::Bool(true) => salida.push_str("true"),
            Valor::Bool(false) => salida.push_str("false"),
            Valor::Numero(n) => escribir_numero(*n, salida),
            Valor::Texto(s) => escribir_texto(s, salida),
            Valor::Lista(xs) => {
                salida.push('[');
                for (i, x) in xs.iter().enumerate() {
                    if i > 0 {
                        salida.push(',');
                    }
                    x.escribir_en(salida);
                }
                salida.push(']');
            }
            Valor::Objeto(pares) => {
                salida.push('{');
                for (i, (clave, valor)) in pares.iter().enumerate() {
                    if i > 0 {
                        salida.push(',');
                    }
                    escribir_texto(clave, salida);
                    salida.push(':');
                    valor.escribir_en(salida);
                }
                salida.push('}');
            }
        }
    }
}

/// JSON no admite NaN ni infinitos; se emiten como `null` en lugar de producir
/// un documento que el cliente no podría parsear.
fn escribir_numero(n: f64, salida: &mut String) {
    if !n.is_finite() {
        salida.push_str("null");
    } else if n.fract() == 0.0 && n.abs() < 1e15 {
        let _ = write!(salida, "{}", n as i64);
    } else {
        let _ = write!(salida, "{n}");
    }
}

fn escribir_texto(s: &str, salida: &mut String) {
    salida.push('"');
    for c in s.chars() {
        match c {
            '"' => salida.push_str("\\\""),
            '\\' => salida.push_str("\\\\"),
            '\n' => salida.push_str("\\n"),
            '\r' => salida.push_str("\\r"),
            '\t' => salida.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(salida, "\\u{:04x}", c as u32);
            }
            c => salida.push(c),
        }
    }
    salida.push('"');
}

// ---------------------------------------------------------------- ayudas de construcción

/// `objeto([("clave", valor), ...])`, para no repetir `.to_string()` en cada clave.
pub fn objeto<const N: usize>(pares: [(&str, Valor); N]) -> Valor {
    Valor::Objeto(
        pares
            .into_iter()
            .map(|(clave, valor)| (clave.to_owned(), valor))
            .collect(),
    )
}

pub fn texto(s: impl Into<String>) -> Valor {
    Valor::Texto(s.into())
}

pub fn numero(n: impl Into<f64>) -> Valor {
    Valor::Numero(n.into())
}

pub fn entero(n: usize) -> Valor {
    Valor::Numero(n as f64)
}

// ---------------------------------------------------------------- lectura

pub fn leer(entrada: &str) -> Result<Valor, String> {
    let bytes: Vec<char> = entrada.chars().collect();
    let mut lector = Lector { bytes: &bytes, i: 0 };
    lector.espacios();
    let valor = lector.valor()?;
    lector.espacios();
    if lector.i < lector.bytes.len() {
        return Err(format!("sobra contenido en la posición {}", lector.i));
    }
    Ok(valor)
}

struct Lector<'a> {
    bytes: &'a [char],
    i: usize,
}

impl Lector<'_> {
    fn espacios(&mut self) {
        while matches!(self.bytes.get(self.i), Some(' ' | '\t' | '\n' | '\r')) {
            self.i += 1;
        }
    }

    fn actual(&self) -> Option<char> {
        self.bytes.get(self.i).copied()
    }

    fn esperar(&mut self, c: char) -> Result<(), String> {
        if self.actual() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("se esperaba '{c}' en la posición {}", self.i))
        }
    }

    fn literal(&mut self, palabra: &str, valor: Valor) -> Result<Valor, String> {
        if self.bytes[self.i..].starts_with(&palabra.chars().collect::<Vec<_>>()[..]) {
            self.i += palabra.chars().count();
            Ok(valor)
        } else {
            Err(format!("literal inválido en la posición {}", self.i))
        }
    }

    fn valor(&mut self) -> Result<Valor, String> {
        match self.actual() {
            Some('{') => self.objeto(),
            Some('[') => self.lista(),
            Some('"') => self.texto().map(Valor::Texto),
            Some('t') => self.literal("true", Valor::Bool(true)),
            Some('f') => self.literal("false", Valor::Bool(false)),
            Some('n') => self.literal("null", Valor::Nulo),
            Some(c) if c == '-' || c.is_ascii_digit() => self.numero(),
            Some(c) => Err(format!("carácter inesperado '{c}' en la posición {}", self.i)),
            None => Err("documento truncado".to_owned()),
        }
    }

    fn objeto(&mut self) -> Result<Valor, String> {
        self.esperar('{')?;
        let mut pares = Vec::new();
        self.espacios();
        if self.actual() == Some('}') {
            self.i += 1;
            return Ok(Valor::Objeto(pares));
        }
        loop {
            self.espacios();
            let clave = self.texto()?;
            self.espacios();
            self.esperar(':')?;
            self.espacios();
            pares.push((clave, self.valor()?));
            self.espacios();
            match self.actual() {
                Some(',') => self.i += 1,
                Some('}') => {
                    self.i += 1;
                    return Ok(Valor::Objeto(pares));
                }
                _ => return Err(format!("se esperaba ',' o '}}' en la posición {}", self.i)),
            }
        }
    }

    fn lista(&mut self) -> Result<Valor, String> {
        self.esperar('[')?;
        let mut xs = Vec::new();
        self.espacios();
        if self.actual() == Some(']') {
            self.i += 1;
            return Ok(Valor::Lista(xs));
        }
        loop {
            self.espacios();
            xs.push(self.valor()?);
            self.espacios();
            match self.actual() {
                Some(',') => self.i += 1,
                Some(']') => {
                    self.i += 1;
                    return Ok(Valor::Lista(xs));
                }
                _ => return Err(format!("se esperaba ',' o ']' en la posición {}", self.i)),
            }
        }
    }

    fn texto(&mut self) -> Result<String, String> {
        self.esperar('"')?;
        let mut s = String::new();
        loop {
            match self.actual() {
                None => return Err("cadena sin cerrar".to_owned()),
                Some('"') => {
                    self.i += 1;
                    return Ok(s);
                }
                Some('\\') => {
                    self.i += 1;
                    let escape = self.actual().ok_or("escape truncado")?;
                    self.i += 1;
                    match escape {
                        '"' => s.push('"'),
                        '\\' => s.push('\\'),
                        '/' => s.push('/'),
                        'b' => s.push('\u{8}'),
                        'f' => s.push('\u{c}'),
                        'n' => s.push('\n'),
                        'r' => s.push('\r'),
                        't' => s.push('\t'),
                        'u' => s.push(self.escape_unicode()?),
                        otro => return Err(format!("escape desconocido '\\{otro}'")),
                    }
                }
                Some(c) => {
                    s.push(c);
                    self.i += 1;
                }
            }
        }
    }

    /// `\uXXXX`, incluyendo el par suplente que JSON usa para los caracteres
    /// fuera del plano básico.
    fn escape_unicode(&mut self) -> Result<char, String> {
        let alto = self.cuatro_hex()?;
        if !(0xD800..0xDC00).contains(&alto) {
            return char::from_u32(alto).ok_or_else(|| format!("escape unicode inválido {alto:04x}"));
        }
        if self.actual() != Some('\\') {
            return Err("par suplente incompleto".to_owned());
        }
        self.i += 1;
        self.esperar('u')?;
        let bajo = self.cuatro_hex()?;
        if !(0xDC00..0xE000).contains(&bajo) {
            return Err("par suplente inválido".to_owned());
        }
        let punto = 0x10000 + ((alto - 0xD800) << 10) + (bajo - 0xDC00);
        char::from_u32(punto).ok_or_else(|| format!("punto de código inválido {punto:x}"))
    }

    fn cuatro_hex(&mut self) -> Result<u32, String> {
        let mut n = 0u32;
        for _ in 0..4 {
            let c = self.actual().ok_or("escape unicode truncado")?;
            let d = c.to_digit(16).ok_or_else(|| format!("'{c}' no es hexadecimal"))?;
            n = n * 16 + d;
            self.i += 1;
        }
        Ok(n)
    }

    fn numero(&mut self) -> Result<Valor, String> {
        let inicio = self.i;
        if self.actual() == Some('-') {
            self.i += 1;
        }
        while matches!(self.actual(), Some(c) if c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
        {
            self.i += 1;
        }
        let texto: String = self.bytes[inicio..self.i].iter().collect();
        texto
            .parse::<f64>()
            .map(Valor::Numero)
            .map_err(|_| format!("número inválido '{texto}'"))
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn lee_objeto_anidado() {
        let v = leer(r#"{"a":[1,2.5,-3],"b":{"c":null},"d":true}"#).unwrap();
        assert_eq!(v.lista_de("a").len(), 3);
        assert_eq!(v.lista_de("a")[1].numero(), Some(2.5));
        // null se comporta como ausente.
        assert!(v.campo("b").unwrap().campo("c").is_none());
        assert_eq!(v.bool_o("d", false), true);
    }

    #[test]
    fn respeta_escapes_y_acentos() {
        let v = leer(r#"{"n":"Cálculo\t\"Dif\"","e":"😀"}"#).unwrap();
        assert_eq!(v.texto_de("n"), Some("Cálculo\t\"Dif\""));
        assert_eq!(v.texto_de("e"), Some("😀"));
    }

    #[test]
    fn ida_y_vuelta() {
        let original = r#"{"a":1,"b":"x\ny","c":[true,false,null],"d":1.5}"#;
        let v = leer(original).unwrap();
        assert_eq!(leer(&v.escribir()).unwrap(), v);
    }

    #[test]
    fn enteros_sin_punto_decimal() {
        assert_eq!(numero(5.0).escribir(), "5");
        assert_eq!(entero(42).escribir(), "42");
    }

    #[test]
    fn rechaza_basura() {
        assert!(leer("{").is_err());
        assert!(leer(r#"{"a":1}sobra"#).is_err());
        assert!(leer(r#"{"a":}"#).is_err());
    }
}
