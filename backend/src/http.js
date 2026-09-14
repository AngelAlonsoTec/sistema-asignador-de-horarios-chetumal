/**
 * Utilidades del servidor: leer el cuerpo, responder JSON y el enrutador por
 * patrón. Es lo que en otro proyecto aportaría Express; aquí son sesenta líneas
 * y evitan una dependencia con su propio árbol de actualizaciones.
 */

/**
 * Origen del frontend en desarrollo. En producción nginx lo sirve como mismo
 * origen y esto no se usa.
 */
const ORIGEN_PERMITIDO = process.env.ORIGEN_FRONTEND ?? "http://localhost:5273";

/** Tope del cuerpo de una petición: un escenario grande no llega a 1 MB. */
const MAX_CUERPO = 8 * 1024 * 1024;

export function responder(res, codigo, datos, extra = {}) {
    const cuerpo = JSON.stringify(datos);
    res.writeHead(codigo, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(cuerpo),
        ...cabecerasCors(),
        ...extra
    });
    res.end(cuerpo);
}

export function error(res, codigo, mensaje) {
    responder(res, codigo, { error: mensaje });
}

/**
 * CORS abierto. Es una herramienta local de un solo usuario: en desarrollo el
 * frontend corre en el puerto de Vite y en producción nginx lo sirve como mismo
 * origen, así que no hay un origen fijo que valga la pena declarar.
 */
export function cabecerasCors() {
    return {
        // Con sesión por cookie no vale el comodín: el navegador rechaza
        // `*` cuando la petición lleva credenciales.
        "Access-Control-Allow-Origin": ORIGEN_PERMITIDO,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    };
}

export function leerCuerpo(req) {
    return new Promise((resolve, reject) => {
        const trozos = [];
        let total = 0;

        req.on("data", (trozo) => {
            total += trozo.length;
            if (total > MAX_CUERPO) {
                reject(new ErrorHttp(413, "El cuerpo de la petición es demasiado grande."));
                req.destroy();
                return;
            }
            trozos.push(trozo);
        });

        req.on("end", () => {
            const texto = Buffer.concat(trozos).toString("utf8");
            if (!texto) return resolve({});
            try {
                resolve(JSON.parse(texto));
            } catch {
                reject(new ErrorHttp(400, "El cuerpo no es JSON válido."));
            }
        });

        req.on("error", reject);
    });
}

/** Error con código HTTP: permite fallar desde cualquier capa sin pasarse `res`. */
export class ErrorHttp extends Error {
    constructor(codigo, mensaje) {
        super(mensaje);
        this.codigo = codigo;
    }
}

/**
 * Enrutador por patrón: `/api/carreras/:carrera/escenarios/:id` contra la URL
 * real, devolviendo los parámetros nombrados. Sin expresiones regulares
 * armadas al vuelo, que son difíciles de leer y fáciles de romper.
 */
export function coincide(patron, ruta) {
    const esperado = patron.split("/");
    const recibido = ruta.split("/");
    if (esperado.length !== recibido.length) return null;

    const params = {};
    for (let i = 0; i < esperado.length; i++) {
        if (esperado[i].startsWith(":")) {
            const valor = decodeURIComponent(recibido[i]);
            if (!valor) return null;
            params[esperado[i].slice(1)] = valor;
        } else if (esperado[i] !== recibido[i]) {
            return null;
        }
    }
    return params;
}
