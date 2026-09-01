/**
 * Tabla simple para listar entidades. Se arma con la API del DOM y
 * textContent, nunca con innerHTML: los datos vienen de archivos que edita
 * el coordinador y no deben poder inyectar markup.
 */

/**
 * Una fila normal lleva `celdas`; una fila con `separador` es un subtítulo
 * que abarca todo el ancho y sirve para agrupar (ej. por semestre). `nivel: 2`
 * la dibuja como subgrupo dentro del anterior (ej. una especialidad dentro
 * de su semestre).
 *
 * @param {string[]} columnas - encabezados
 * @param {Array<{celdas?: Array<string|Node>, clase?: string, separador?: string, nivel?: number}>} filas
 */
export function crearTabla(columnas, filas) {
    const tabla = document.createElement("table");
    tabla.className = "tabla";
    tabla.appendChild(crearEncabezado(columnas));

    const cuerpo = document.createElement("tbody");
    for (const fila of filas) {
        cuerpo.appendChild(
            fila.separador
                ? crearSeparador(fila.separador, columnas.length, fila.nivel)
                : crearFila(fila)
        );
    }
    tabla.appendChild(cuerpo);

    return tabla;
}

function crearSeparador(titulo, columnas, nivel = 1) {
    const fila = document.createElement("tr");
    fila.className = nivel === 2 ? "fila-separador fila-subseparador" : "fila-separador";

    const celda = document.createElement("td");
    celda.colSpan = columnas;
    celda.textContent = titulo;

    fila.appendChild(celda);
    return fila;
}

function crearEncabezado(columnas) {
    const thead = document.createElement("thead");
    const fila = document.createElement("tr");

    for (const columna of columnas) {
        const celda = document.createElement("th");
        celda.textContent = columna;
        fila.appendChild(celda);
    }

    thead.appendChild(fila);
    return thead;
}

function crearFila({ celdas, clase }) {
    const fila = document.createElement("tr");
    if (clase) fila.className = clase;

    for (const contenido of celdas) {
        const celda = document.createElement("td");
        if (contenido instanceof Node) {
            celda.appendChild(contenido);
        } else {
            celda.textContent = contenido;
        }
        fila.appendChild(celda);
    }

    return fila;
}
