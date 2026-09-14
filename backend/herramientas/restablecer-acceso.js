#!/usr/bin/env node
/**
 * Devuelve todas las cuentas a la contraseña de arranque.
 *
 * No es parte del producto: es para el despliegue de demostración. Las
 * herramientas de verificación entran con cada cuenta y, como el sistema obliga
 * a estrenar contraseña, cada pasada deja la suya. Después de correrlas ya nadie
 * sabe con qué entrar desde la pantalla.
 *
 * Usa el mismo `reiniciarClave` que el departamento —así la contraseña se cifra
 * como todas las demás, sin copiar aquí la derivación— y después quita la
 * obligación de cambiarla, que en una demostración solo estorba. De paso
 * reactiva lo que las herramientas hayan dejado retirado.
 *
 *   node herramientas/restablecer-acceso.js [clave]
 */

import { bd } from "../src/bd.js";
import { listarUsuarios, reiniciarClave } from "../src/auth.js";

const CLAVE = process.argv[2] ?? "schedulai";

const cuentas = listarUsuarios();
for (const c of cuentas) reiniciarClave({ usuarioId: c.id, nueva: CLAVE });
bd().prepare("UPDATE usuarios SET debe_cambiar_clave = 0").run();

console.log(`${cuentas.length} cuentas con la clave "${CLAVE}":`);
console.log("  " + cuentas.map((c) => c.usuario).join(", "));
