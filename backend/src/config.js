/**
 * Configuración por entorno. Los valores por omisión sirven para correr el
 * backend a mano fuera de Docker; docker-compose los sobrescribe.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));

export const PUERTO = Number(process.env.PUERTO ?? 4000);

/** Carpeta raíz de los datos. En el contenedor es un volumen montado. */
export const DATOS = path.resolve(process.env.DATOS_DIR ?? path.join(aqui, "..", "data"));

/** URL del motor. En Docker resuelve por el nombre del servicio. */
export const MOTOR_URL = process.env.MOTOR_URL ?? "http://localhost:7000";

/**
 * Tiempo máximo que se espera al motor. Una corrida grande puede tardar
 * bastante, y abortarla a los 30 s de un fetch por omisión sería peor que
 * esperar: el usuario ya pidió el horario y no hay nada que reintentar.
 */
export const MOTOR_TIMEOUT_MS = Number(process.env.MOTOR_TIMEOUT_MS ?? 600_000);

/**
 * Si el sistema se sirve tras HTTPS. Marca la cookie de sesión como `Secure`,
 * que impide al navegador mandarla por una conexión en claro.
 *
 * Por omisión está apagado porque el despliegue de desarrollo es http://, y una
 * cookie `Secure` sobre http se descarta en silencio: nadie podría entrar y el
 * error no diría por qué. En el servidor del plantel se enciende con
 * `CON_TLS=1`.
 */
export const CON_TLS = /^(1|true|si|sí)$/i.test(process.env.CON_TLS ?? "");

/**
 * Cada cuántas horas se respalda la base. En 0 se apaga.
 *
 * Va dentro del servicio y no en un cron del sistema porque el `.db` vive en un
 * volumen del contenedor: el cron del anfitrión no lo alcanza sin montar el
 * volumen otra vez, y quien despliega con `docker compose up` no va a
 * configurar nada más.
 */
export const HORAS_ENTRE_RESPALDOS = Number(process.env.HORAS_ENTRE_RESPALDOS ?? 12);

/**
 * Registra por consola cada petición atendida, con el patrón de ruta.
 *
 * Apagado por omisión: en marcha normal es ruido. Sirve para ver qué partes de
 * la API usa de verdad una sesión —o una herramienta de verificación— y cuáles
 * no toca nadie.
 */
export const REGISTRAR_PETICIONES = /^(1|true|si|sí)$/i.test(process.env.REGISTRAR_PETICIONES ?? "");
