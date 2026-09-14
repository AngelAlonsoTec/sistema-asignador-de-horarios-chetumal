/**
 * Entrar a SchedulAI desde una herramienta, sin saber qué contraseña tiene la
 * cuenta.
 *
 * Las cuentas nacen obligadas a cambiar la de arranque, y cada herramienta deja
 * la suya. Encadenar dos —verificar y luego simular— dejaba a la segunda fuera
 * con un error que parecía un fallo del sistema. La lista vive aquí y no
 * repetida en cada guion, que es donde se desincronizó.
 */

/** En orden: lo primero es una recién desplegada, luego lo que dejan las herramientas. */
export const CLAVES_CONOCIDAS = [
    "schedulai", "schedulai-verif", "simulacion2026", "verif2026",
    "decisiones2026", "normativa2026"
];

/** Cliente HTTP con su propia cookie. Cada actor es una sesión distinta. */
export function cliente(api) {
    let cookie = null;
    return async (ruta, { metodo = "GET", cuerpo } = {}) => {
        const r = await fetch(`${api}${ruta}`, {
            method: metodo,
            headers: {
                ...(cuerpo === undefined ? {} : { "Content-Type": "application/json" }),
                ...(cookie ? { Cookie: cookie } : {})
            },
            body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
        });
        const puesta = r.headers.get("set-cookie");
        if (puesta) cookie = puesta.split(";")[0];
        const texto = await r.text();
        try {
            return { estado: r.status, cuerpo: texto ? JSON.parse(texto) : null };
        } catch {
            return { estado: r.status, cuerpo: texto };
        }
    };
}

/**
 * Entra y, si la cuenta estrena contraseña, la cambia como haría una persona.
 * Devuelve `null` si ninguna conocida sirve, para que quien llama decida.
 */
export async function entrar(api, usuario, { nueva, extras = [] } = {}) {
    const destino = nueva ?? "schedulai-verif";
    for (const clave of [...extras, ...CLAVES_CONOCIDAS].filter(Boolean)) {
        const c = cliente(api);
        const r = await c("/sesion", { metodo: "POST", cuerpo: { usuario, clave } });
        if (r.estado !== 200) continue;

        if (r.cuerpo.debeCambiarClave) {
            await c("/sesion/clave", { metodo: "POST", cuerpo: { actual: clave, nueva: destino } });
            const otra = await c("/sesion", { metodo: "POST", cuerpo: { usuario, clave: destino } });
            return { c, perfil: otra.cuerpo, estrenada: true };
        }
        return { c, perfil: r.cuerpo, estrenada: false };
    }
    return null;
}
