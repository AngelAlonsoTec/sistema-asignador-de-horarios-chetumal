/**
 * Servidor mínimo de SchedulAI: sirve el frontend estático y expone los dos
 * endpoints de guardado que el navegador no puede hacer por sí solo (un
 * <script> no puede escribir de vuelta a un archivo en disco).
 *
 * Sin framework: son dos rutas, no vale la pena la dependencia. Para correrlo:
 *   node backend/server.js
 * y abrir http://localhost:4000/ — no uses Live Server para esto, porque
 * "Guardar cambios" necesita este servidor, no uno que solo sirva estáticos.
 */

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const FRONTEND = path.resolve(__dirname, "../frontend/src");
const DATA = path.resolve(__dirname, "data");
const PUERTO = 4000;

const TIPOS_MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8"
};

const servidor = http.createServer((req, res) => {
    manejar(req, res).catch((error) => {
        console.error(error);
        responder(res, 500, "Error interno del servidor.");
    });
});

function manejar(req, res) {
    if (req.method === "POST" && req.url === "/api/escenarios/guardar") return guardarEscenario(req, res);
    if (req.method === "POST" && req.url === "/api/escenarios/eliminar") return eliminarEscenario(req, res);
    if (req.method === "POST" && req.url === "/api/aulas/guardar") return guardarAulas(req, res);
    if (req.method === "GET") return servirArchivo(req, res);
    responder(res, 405, "Método no permitido.");
    return Promise.resolve();
}

// ---------- servir el frontend ----------

/**
 * El frontend sigue pidiendo "data/isic/..." como si fuera parte de su propio
 * árbol estático — solo este servidor sabe que en realidad vive en backend/data,
 * junto a lo único que puede escribirlo.
 */
async function servirArchivo(req, res) {
    const ruta = decodeURIComponent(req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0]);
    const esDato = ruta === "/data" || ruta.startsWith("/data/");
    const raiz = esDato ? DATA : FRONTEND;
    const absoluta = esDato ? path.join(DATA, ruta.slice("/data".length)) : path.join(FRONTEND, ruta);

    if (!dentroDe(raiz, absoluta)) return responder(res, 403, "Prohibido.");

    try {
        const contenido = await fs.readFile(absoluta);
        res.writeHead(200, { "Content-Type": TIPOS_MIME[path.extname(absoluta)] ?? "application/octet-stream" });
        res.end(contenido);
    } catch {
        responder(res, 404, "No encontrado.");
    }
}

// ---------- guardar un escenario ----------

/**
 * Un escenario es autocontenido: materias, docentes y semestres. Si el escenario
 * es nuevo (creado con "Nuevo Escenario" y hasta ahora solo existía en memoria),
 * esta misma ruta lo hace permanente: crea su carpeta y lo agrega al manifiesto.
 */
async function guardarEscenario(req, res) {
    const { carrera, id, meta, materias, docentes, semestres, especialidades } = await leerJson(req);
    if (!carrera || !id) return responder(res, 400, "Falta carrera o id del escenario.");

    const carpetaEscenario = path.join(DATA, carrera.toLowerCase(), "escenarios", id);
    if (!dentroDe(DATA, carpetaEscenario)) return responder(res, 400, "Ruta de escenario inválida.");

    await fs.mkdir(carpetaEscenario, { recursive: true });
    await Promise.all([
        escribirJson(path.join(carpetaEscenario, "materias.json"), materias),
        escribirJson(path.join(carpetaEscenario, "docentes.json"), docentes),
        escribirJson(path.join(carpetaEscenario, "semestres.json"), semestres),
        escribirJson(path.join(carpetaEscenario, "especialidades.json"), especialidades ?? [])
    ]);

    await actualizarIndice(carrera, meta);
    responder(res, 200, "Escenario guardado.");
}

/** Agrega el escenario al manifiesto si es nuevo; si ya existía, refresca su metadata. */
async function actualizarIndice(carrera, meta) {
    const rutaIndice = path.join(DATA, carrera.toLowerCase(), "escenarios", "index.json");
    const indice = await leerJsonDeArchivo(rutaIndice, []);

    const posicion = indice.findIndex((escenario) => escenario.id === meta.id);
    if (posicion === -1) indice.push(meta);
    else indice[posicion] = meta;

    await escribirJson(rutaIndice, indice);
}

/**
 * Borra un escenario: su carpeta y su entrada en el manifiesto. El caso base
 * no se puede borrar aquí tampoco, no solo en la UI — de lo contrario no
 * quedaría de dónde partir para crear otros escenarios.
 */
async function eliminarEscenario(req, res) {
    const { carrera, id } = await leerJson(req);
    if (!carrera || !id) return responder(res, 400, "Falta carrera o id del escenario.");

    const rutaIndice = path.join(DATA, carrera.toLowerCase(), "escenarios", "index.json");
    const indice = await leerJsonDeArchivo(rutaIndice, []);
    const entrada = indice.find((escenario) => escenario.id === id);

    if (entrada?.esBase) return responder(res, 400, "El caso base no se puede eliminar.");

    const carpetaEscenario = path.join(DATA, carrera.toLowerCase(), "escenarios", id);
    if (!dentroDe(DATA, carpetaEscenario)) return responder(res, 400, "Ruta de escenario inválida.");

    await fs.rm(carpetaEscenario, { recursive: true, force: true });
    await escribirJson(rutaIndice, indice.filter((escenario) => escenario.id !== id));

    responder(res, 200, "Escenario eliminado.");
}

// ---------- guardar aulas (compartidas, no por escenario) ----------

async function guardarAulas(req, res) {
    const { carrera, aulas } = await leerJson(req);
    if (!carrera) return responder(res, 400, "Falta carrera.");

    const archivo = path.join(DATA, carrera.toLowerCase(), "aulas.json");
    if (!dentroDe(DATA, archivo)) return responder(res, 400, "Ruta de aulas inválida.");

    await escribirJson(archivo, aulas);
    responder(res, 200, "Aulas guardadas.");
}

// ---------- utilidades ----------

/** Evita que una carrera o id con "../" se salga de data/. */
function dentroDe(raiz, absoluta) {
    return absoluta === raiz || absoluta.startsWith(raiz + path.sep);
}

async function escribirJson(ruta, datos) {
    await fs.writeFile(ruta, `${JSON.stringify(datos, null, 2)}\n`);
}

async function leerJsonDeArchivo(ruta, porDefecto) {
    try {
        return JSON.parse(await fs.readFile(ruta, "utf8"));
    } catch {
        return porDefecto;
    }
}

function leerJson(req) {
    return new Promise((resolve, reject) => {
        let cuerpo = "";
        req.on("data", (fragmento) => (cuerpo += fragmento));
        req.on("end", () => {
            try {
                resolve(JSON.parse(cuerpo));
            } catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}

function responder(res, codigo, mensaje) {
    res.writeHead(codigo, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(mensaje);
}

servidor.listen(PUERTO, () => {
    console.log(`SchedulAI: http://localhost:${PUERTO}`);
});
