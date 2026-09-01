/**
 * Diálogo de creación de un escenario nuevo: siempre parte de uno existente
 * ("basado en"), porque nadie va a capturar 46 materias desde cero.
 * `abrir()` devuelve una promesa: resuelve con { nombre, basadoEnId } al
 * guardar, o con `null` si se cancela.
 */
export function crearFormularioEscenario(el) {
    function abrir({ escenarios }) {
        el.nombre.value = "";
        el.error.hidden = true;
        el.basadoEn.replaceChildren(
            crearOpcionSinBase(),
            ...escenarios.map((escenario) => {
                const opcion = document.createElement("option");
                opcion.value = escenario.id;
                opcion.textContent = escenario.nombre;
                return opcion;
            })
        );
        const base = escenarios.find((escenario) => escenario.esBase) ?? escenarios[0];
        if (base) el.basadoEn.value = base.id;

        el.dialogo.showModal();
        el.nombre.focus();

        return new Promise((resolve) => {
            let guardado = false;

            function alEnviar(evento) {
                evento.preventDefault();
                const nombre = el.nombre.value.trim();
                if (!nombre) {
                    el.error.textContent = "El nombre es obligatorio.";
                    el.error.hidden = false;
                    return;
                }
                guardado = true;
                el.dialogo.close();
                resolve({ nombre, basadoEnId: el.basadoEn.value });
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

    el.cancelar.addEventListener("click", () => el.dialogo.close());

    return { abrir };
}

function crearOpcionSinBase() {
    const opcion = document.createElement("option");
    opcion.value = "";
    opcion.textContent = "Sin caso base";
    return opcion;
}
