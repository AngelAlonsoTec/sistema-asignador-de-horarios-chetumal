import { claveAId } from "../edicion.js";

/**
 * Diálogo de alta/edición de un aula. `abrir()` devuelve una promesa:
 * resuelve con el aula capturada al guardar, o con `null` si se cancela.
 */
export function crearFormularioAula(el) {
    function abrir({ titulo, valores }) {
        el.titulo.textContent = titulo;
        el.clave.value = valores?.clave ?? "";
        el.tipo.value = valores?.tipo ?? "aula";
        el.error.hidden = true;

        el.dialogo.showModal();
        el.clave.focus();

        return new Promise((resolve) => {
            let guardado = false;

            function alEnviar(evento) {
                evento.preventDefault();
                try {
                    const aula = leer();
                    guardado = true;
                    el.dialogo.close();
                    resolve(aula);
                } catch (error) {
                    el.error.textContent = error.message;
                    el.error.hidden = false;
                }
            }

            function alCerrar() {
                el.form.removeEventListener("submit", alEnviar);
                el.dialogo.removeEventListener("close", alCerrar);
                if (!guardado) resolve(null);
            }

            el.form.addEventListener("submit", alEnviar);
            el.dialogo.addEventListener("close", alCerrar);
        });
    }

    function leer() {
        const clave = el.clave.value.trim().toUpperCase();
        if (!clave) throw new Error("La clave es obligatoria.");

        return { id: claveAId(clave), clave, tipo: el.tipo.value };
    }

    el.cancelar.addEventListener("click", () => el.dialogo.close());

    return { abrir };
}
