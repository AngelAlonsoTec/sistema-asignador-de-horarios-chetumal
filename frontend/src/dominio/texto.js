/**
 * Comparación de texto para buscar.
 *
 * En español se teclea sin acentos constantemente: quien busca "etica" espera
 * encontrar "Taller de Ética". Comparar en crudo lo dejaba fuera, y el
 * coordinador concluía que la materia no estaba.
 */

/**
 * Minúsculas y sin acentos. Los caracteres combinantes van por rango y no
 * literales, que es donde este código ya se rompió antes.
 *
 * La `ñ` se pliega a `n` de paso. Es una letra propia y no una vocal acentuada,
 * pero quien teclea "diseno" espera encontrar "Diseño"; que "año" y "ano"
 * colisionen no molesta a nadie buscando una materia.
 */
export function plano(texto) {
    return String(texto ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "");
}

/** ¿`aguja` aparece en `pajar`, ignorando acentos y mayúsculas? */
export function contiene(pajar, aguja) {
    const buscada = plano(aguja).trim();
    return buscada === "" || plano(pajar).includes(buscada);
}
