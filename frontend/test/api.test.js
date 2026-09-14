/**
 * El cliente HTTP. Lo único que se prueba aquí es lo que no se ve al usarlo con
 * la sesión abierta: qué pasa cuando deja de estarlo.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { api, avisarSiCaduca } from "../src/api.js";

/** Un `fetch` de mentira que devuelve lo que se le diga. */
function responder(estado, cuerpo) {
    globalThis.fetch = async () => ({
        ok: estado >= 200 && estado < 300,
        status: estado,
        text: async () => (cuerpo === undefined ? "" : JSON.stringify(cuerpo))
    });
}

test("un 401 avisa de que la sesión se cayó, además de fallar", async () => {
    let avisos = 0;
    avisarSiCaduca(() => avisos++);

    responder(401, { error: "Hay que iniciar sesión." });
    await assert.rejects(() => api.docentes(), /Hay que iniciar sesión/);
    assert.equal(avisos, 1, "sin el aviso, la pantalla se queda con datos que ya no se pueden guardar");

    // Los demás errores son del trabajo, no de la sesión: no echan a nadie.
    responder(409, { error: "Esa carrera tiene horas apartadas." });
    await assert.rejects(() => api.docentes(), /horas apartadas/);
    assert.equal(avisos, 1);

    responder(200, []);
    assert.deepEqual(await api.docentes(), []);
    assert.equal(avisos, 1);

    avisarSiCaduca(null);
});

test("si el servidor no contesta, el mensaje lo dice en vez de reventar", async () => {
    globalThis.fetch = async () => {
        throw new Error("fetch failed");
    };
    await assert.rejects(() => api.docentes(), /No se pudo contactar al servidor/);
});
