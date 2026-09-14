/**
 * SchedulAI — API de datos.
 *
 * Microservicio de persistencia y catálogo: es el dueño de los archivos JSON y
 * el único que habla con el motor. No sirve el frontend (eso lo hace su propio
 * contenedor) y no calcula horarios (eso lo hace el motor).
 *
 * Sin dependencias externas: el módulo `http` de Node y nada más.
 */

import http from "node:http";
import { PUERTO, DATOS, MOTOR_URL, HORAS_ENTRE_RESPALDOS, REGISTRAR_PETICIONES } from "./config.js";
import { ErrorHttp, cabecerasCors, error } from "./http.js";
import { ABIERTAS, PUBLICAS, resolverRuta } from "./rutas.js";

/** Lo único que puede hacer quien aún no ha cambiado su contraseña. */
const PASO_OBLIGADO = new Set(["POST /api/sesion/clave", "DELETE /api/sesion", "GET /api/sesion"]);
import * as auth from "./auth.js";

const servidor = http.createServer((req, res) => {
    manejar(req, res).catch((e) => fallar(res, e, req));
});

async function manejar(req, res) {
    const ruta = new URL(req.url, "http://interno").pathname;

    // Preflight de CORS: el navegador lo manda antes de un PUT o un DELETE.
    if (req.method === "OPTIONS") {
        res.writeHead(204, cabecerasCors());
        return res.end();
    }

    const encontrada = resolverRuta(req.method, ruta);
    if (!encontrada) return error(res, 404, `No existe la ruta ${req.method} ${ruta}.`);
    if (!encontrada.manejador) {
        return error(res, 405, `${ruta} solo acepta ${encontrada.permitido}.`);
    }

    // Puerta única: todo exige sesión salvo lo declarado como abierto. Ponerlo
    // aquí y no en cada manejador evita que una ruta nueva nazca sin protección.
    const abierta =
        ABIERTAS.has(`${req.method} ${ruta}`) || PUBLICAS.some((patron) => patron.test(ruta));

    if (!abierta) {
        const usuario = auth.usuarioDe(req);
        if (!usuario) return error(res, 401, "Hay que iniciar sesión.");

        // Con la contraseña de arranque puesta, la cuenta todavía la controla
        // quien la dictó. Se bloquea aquí y no solo en la interfaz: si no, la
        // API quedaría abierta con una credencial que conocen dos personas.
        if (usuario.debeCambiarClave && !PASO_OBLIGADO.has(`${req.method} ${ruta}`)) {
            return error(res, 403, "Hay que cambiar la contraseña antes de usar el sistema.");
        }

        if (encontrada.params?.carrera) auth.exigirCarrera(usuario, encontrada.params.carrera);
        req.usuario = usuario;
    }

    if (REGISTRAR_PETICIONES) {
        // El patrón y no la ruta concreta: `/carreras/ISIC/...` y
        // `/carreras/ITIC/...` son la misma entrada de la tabla, y lo que
        // interesa saber es qué entradas se usan.
        console.log(`PETICION ${req.method} ${encontrada.patron ?? ruta}`);
    }
    await encontrada.manejador(req, res, encontrada.params);
}

function fallar(res, e, req) {
    if (e instanceof ErrorHttp) return error(res, e.codigo, e.message);
    // Un error no previsto sí se registra: es un defecto del backend, no del uso.
    console.error(`error no controlado en ${req.method} ${req.url}:`, e);
    error(res, 500, "Error interno del servidor.");
}

// Sin usuarios no se puede entrar, así que se crea uno de arranque y se avisa
// por consola. Es preferible a dejar el sistema inaccesible tras la migración.
if (!auth.hayUsuarios()) {
    const carreras = (await import("./almacen.js")).listarCarreras;
    const suyas = await carreras();
    auth.crearUsuario({
        id: "u-coord",
        nombre: "Coordinación",
        usuario: "coordinador",
        clave: "schedulai",
        carreras: suyas
    });
    console.log("  hay que cambiarla al entrar.");
    console.log(`  usuario inicial: coordinador / schedulai (carreras: ${suyas.join(", ") || "ninguna"})`);
}

// Respaldo periódico. Antes los datos eran JSON en git; ahora son un binario en
// un volumen, y una herramienta que hay que acordarse de invocar no es un
// respaldo. `unref()` para que no impida cerrar el proceso.
if (HORAS_ENTRE_RESPALDOS > 0) {
    const { respaldar } = await import("../herramientas/respaldar.js");
    const cada = HORAS_ENTRE_RESPALDOS * 60 * 60 * 1000;

    const tarea = () => {
        try {
            const { archivo } = respaldar();
            console.log(`  respaldo: ${archivo}`);
        } catch (e) {
            // Que falle un respaldo no debe tumbar el servicio, pero tiene que
            // verse: un respaldo que falla en silencio es peor que no tenerlo.
            console.error(`  respaldo FALLIDO: ${e.message}`);
        }
    };
    tarea();
    setInterval(tarea, cada).unref();
}

servidor.listen(PUERTO, () => {
    console.log(`SchedulAI backend en http://localhost:${PUERTO}`);
    console.log(`  datos: ${DATOS}`);
    console.log(`  motor: ${MOTOR_URL}`);
});
