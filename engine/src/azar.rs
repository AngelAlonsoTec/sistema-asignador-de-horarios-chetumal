//! Generador pseudoaleatorio propio.
//!
//! La biblioteca estándar no trae uno, y el motor necesita además que sea
//! *reproducible*: con la misma semilla, la misma corrida. Eso es un requisito
//! experimental, no una comodidad — sin él no se pueden comparar dos
//! configuraciones del algoritmo y atribuir la diferencia a los parámetros.
//!
//! Es `xorshift64*`, suficiente para un algoritmo evolutivo y muy rápido. No
//! sirve para criptografía y aquí no hace falta que sirva.

pub struct Azar {
    estado: u64,
}

impl Azar {
    pub fn nuevo(semilla: u64) -> Self {
        // La semilla 0 deja a xorshift en un punto fijo: siempre devolvería 0.
        // splitmix64 la dispersa primero, de modo que semillas contiguas
        // (1, 2, 3... una por isla) produzcan secuencias sin parentesco.
        Self { estado: revolver(if semilla == 0 { 0x9E3779B97F4A7C15 } else { semilla }) }
    }

    pub fn siguiente(&mut self) -> u64 {
        let mut x = self.estado;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.estado = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }

    /// Entero en `[0, tope)`. Devuelve 0 si `tope` es 0, para que quien indexe
    /// una colección vacía no provoque un pánico aquí sino donde corresponde.
    pub fn indice(&mut self, tope: usize) -> usize {
        if tope == 0 {
            return 0;
        }
        // Rechazo para evitar el sesgo del módulo cuando `tope` no divide a 2^64.
        let limite = u64::MAX - (u64::MAX % tope as u64);
        loop {
            let n = self.siguiente();
            if n < limite {
                return (n % tope as u64) as usize;
            }
        }
    }

    /// Entero en `[desde, hasta]`, ambos inclusive.
    pub fn entre(&mut self, desde: usize, hasta: usize) -> usize {
        if hasta <= desde {
            return desde;
        }
        desde + self.indice(hasta - desde + 1)
    }

    /// Real en `[0, 1)`. Usa los 53 bits que caben exactos en un f64.
    pub fn real(&mut self) -> f64 {
        (self.siguiente() >> 11) as f64 / (1u64 << 53) as f64
    }

    pub fn ocurre(&mut self, probabilidad: f64) -> bool {
        self.real() < probabilidad
    }

    /// Elemento al azar, o `None` si está vacío.
    pub fn elegir<'a, T>(&mut self, xs: &'a [T]) -> Option<&'a T> {
        if xs.is_empty() {
            None
        } else {
            Some(&xs[self.indice(xs.len())])
        }
    }
}

fn revolver(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn reproducible_con_la_misma_semilla() {
        let a: Vec<u64> = (0..50).map(|_| Azar::nuevo(7).siguiente()).take(1).collect();
        let mut x = Azar::nuevo(7);
        let mut y = Azar::nuevo(7);
        assert_eq!(
            (0..100).map(|_| x.siguiente()).collect::<Vec<_>>(),
            (0..100).map(|_| y.siguiente()).collect::<Vec<_>>()
        );
        assert!(!a.is_empty());
    }

    #[test]
    fn semillas_distintas_divergen() {
        let mut x = Azar::nuevo(1);
        let mut y = Azar::nuevo(2);
        let a: Vec<u64> = (0..20).map(|_| x.siguiente()).collect();
        let b: Vec<u64> = (0..20).map(|_| y.siguiente()).collect();
        assert_ne!(a, b);
    }

    #[test]
    fn semilla_cero_no_se_estanca() {
        let mut x = Azar::nuevo(0);
        let valores: Vec<u64> = (0..10).map(|_| x.siguiente()).collect();
        assert!(valores.iter().any(|&n| n != 0));
    }

    #[test]
    fn indice_dentro_del_rango() {
        let mut x = Azar::nuevo(99);
        for _ in 0..10_000 {
            assert!(x.indice(7) < 7);
            let n = x.entre(3, 5);
            assert!((3..=5).contains(&n));
        }
        assert_eq!(x.indice(0), 0);
        assert_eq!(x.entre(4, 4), 4);
    }

    #[test]
    fn real_en_cero_uno() {
        let mut x = Azar::nuevo(5);
        for _ in 0..10_000 {
            let r = x.real();
            assert!((0.0..1.0).contains(&r));
        }
    }

    #[test]
    fn la_media_se_acerca_a_un_medio() {
        let mut x = Azar::nuevo(123);
        let n = 200_000;
        let suma: f64 = (0..n).map(|_| x.real()).sum();
        assert!((suma / n as f64 - 0.5).abs() < 0.01);
    }
}
