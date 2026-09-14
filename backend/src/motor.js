/**
 * Cliente del motor de Rust.
 *
 * Es el único punto donde el backend habla con el otro servicio. Aísla dos
 * cosas: que el motor puede no estar arriba, y que sus errores deben llegar al
 * usuario tal como los explicó — el motor sabe por qué un problema es inválido
 * mucho mejor que este backend.
 */

import http from "node:http";
import { MOTOR_URL, MOTOR_TIMEOUT_MS } from "./config.js";
import { ErrorHttp } from "./http.js";

/**
 * La petición larga va por `node:http` y no por `fetch`.
 *
 * `fetch` corta sola a los cinco minutos sin importar el `AbortSignal`: es un
 * tiempo de espera de cabeceras de su cliente interno, no configurable desde
 * aquí. Una corrida grande del motor pasa de eso, y lo que llegaba entonces era
 * un `HeadersTimeoutError` que no dice nada y contradice a `MOTOR_TIMEOUT_MS`,
 * que quedaba de adorno. Con `node:http` el único plazo es el que se pide.
 *
 * `fetch` se queda para la sonda de salud, que tarda milisegundos.
 */
function pedirAlMotor(ruta, cuerpo, msLimite) {
    const destino = new URL(ruta, MOTOR_URL);
    const datos = Buffer.from(JSON.stringify(cuerpo));

    return new Promise((cumplir, fallar) => {
        const peticion = http.request(
            {
                hostname: destino.hostname,
                port: destino.port || 80,
                path: destino.pathname,
                method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": datos.length }
            },
            (respuesta) => {
                const trozos = [];
                respuesta.on("data", (t) => trozos.push(t));
                respuesta.on("end", () =>
                    cumplir({ estado: respuesta.statusCode, texto: Buffer.concat(trozos).toString() })
                );
            }
        );

        peticion.setTimeout(msLimite, () => {
            peticion.destroy(new Error(`no respondió en ${Math.round(msLimite / 1000)} s`));
        });
        peticion.on("error", fallar);
        peticion.end(datos);
    });
}

export async function estadoDelMotor() {
    try {
        const respuesta = await fetch(`${MOTOR_URL}/api/salud`, {
            signal: AbortSignal.timeout(3000)
        });
        if (!respuesta.ok) return { disponible: false, motivo: `HTTP ${respuesta.status}` };
        return { disponible: true, ...(await respuesta.json()) };
    } catch (e) {
        return { disponible: false, motivo: e.message };
    }
}

/**
 * Vuelve a puntuar un horario ya armado, sin buscar. Es el ajuste manual: las
 * reglas las aplica el motor, que es donde viven.
 */
export async function evaluar(problema) {
    return await llamar("/api/evaluar", problema, 30_000);
}

export async function resolver(problema) {
    return await llamar("/api/resolver", problema, MOTOR_TIMEOUT_MS);
}

async function llamar(ruta, problema, msLimite) {
    let respuesta;
    try {
        respuesta = await pedirAlMotor(ruta, problema, msLimite);
    } catch (e) {
        // El detalle técnico va al registro, no a la pantalla: a quien arma un
        // horario no le dice nada "getaddrinfo ENOTFOUND engine", y lo que
        // necesita saber es que no es culpa suya y a quién avisar.
        console.error(`motor inalcanzable en ${MOTOR_URL}: ${e.message}`);
        // 503 y no 500: el backend está bien, el que no responde es el motor.
        throw new ErrorHttp(
            503,
            "El generador de horarios no está disponible en este momento. " +
                "Lo demás sigue funcionando; avisa al departamento si tarda en volver."
        );
    }

    let cuerpo;
    try {
        cuerpo = JSON.parse(respuesta.texto);
    } catch {
        console.error(`el motor devolvió algo que no es JSON: ${respuesta.texto.slice(0, 300)}`);
        throw new ErrorHttp(
            502,
            "El generador de horarios contestó algo que no se entiende. Está en el registro."
        );
    }

    if (respuesta.estado < 200 || respuesta.estado >= 300) {
        throw new ErrorHttp(
            respuesta.estado === 422 ? 422 : 502,
            cuerpo.error ?? "El motor rechazó el problema."
        );
    }
    return cuerpo;
}
