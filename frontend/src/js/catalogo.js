/**
 * Catálogo de carreras disponibles en el sistema.
 * La clave es el código que se usa como carpeta en data/<carrera>/.
 */
export const CARRERAS = {
    ISIC: "Ing. Sistemas Computacionales",
    ITIC: "Ing. en Tecnologías de la Información y Comunicaciones",
    IDAP: "Ing. en Desarrollo de Aplicaciones"
};

/** Código de la carrera que se muestra al abrir la pantalla. */
export const CARRERA_POR_DEFECTO = "ISIC";

/**
 * Nombre visible de una carrera. Si el código no está en el catálogo
 * devuelve el código tal cual, para no romper la vista.
 */
export function nombreCarrera(codigo) {
    return CARRERAS[codigo] ?? codigo;
}
