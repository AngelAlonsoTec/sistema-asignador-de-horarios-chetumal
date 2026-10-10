<img src="frontend/public/logo.svg" width="52" alt="">

# SchedulAI

Sistema de apoyo a la programación de horarios del TecNM Campus Chetumal.
Tres servicios independientes: una interfaz en Vue, una API de datos en Node y
un motor genético paralelo en Rust.

![Vue](https://img.shields.io/badge/frontend-Vue%203-333)
![Node](https://img.shields.io/badge/backend-Node%2022-333)
![Rust](https://img.shields.io/badge/engine-Rust-333)
![Docker](https://img.shields.io/badge/orquestaci%C3%B3n-Docker%20Compose-333)

## Arquitectura

```
navegador
    │
    ▼
frontend  :8080   Vue 3 + Vite, servido por nginx, que además reenvía /api
    │
    ▼
backend   :4000   API de datos. Dueño de los JSON. Único cliente del motor.
    │
    ▼
engine    (interno)  Algoritmo memético paralelo. Sin estado, sin disco.
```

Cada servicio es autónomo: no comparten código, se comunican solo por HTTP y
cada uno se construye, prueba y despliega por separado. El motor no se publica
al exterior; únicamente el backend lo alcanza.

El reparto de responsabilidades es estricto. El **backend** es el único que
escribe en disco. El **motor** recibe un problema y devuelve un horario: no sabe
qué es un escenario ni dónde viven los datos. El **frontend** no calcula reglas
de negocio; muestra lo que los otros dos deciden.

## Arranque

```bash
docker compose up --build
```

- Interfaz: <http://localhost:8080>
- API: <http://localhost:4000/api/salud>

Los escenarios viven en `backend/data/`, montado como volumen: sobreviven a un
`docker compose down` y a cualquier reconstrucción de imágenes.

### Sin Docker

```bash
cd engine   && cargo run --release              # motor  :7000
cd engine   && cargo test --release             # 70 pruebas
cd backend  && npm start                        # API    :4000
cd frontend && npm install && npm run dev       # web    :5173
cd frontend && npm test                         # 26 + 21 pruebas
```

## Servicios

### engine — motor genético

Algoritmo memético con modelo de islas. **Cero dependencias externas:** JSON,
HTTP y generador pseudoaleatorio escritos sobre la biblioteca estándar. Eso hace
que la imagen se construya sin red en segundos y que no haya árbol de
dependencias que auditar.

- **Cromosoma**: un gen por bloque de clase. Cada gen decide docente, aula, día
  y hora. Grupo, materia y duración son fijos, no evolucionan.
- **Paralelismo**: `std::thread::scope`, una isla por hilo, migración en anillo.
  La sincronización es por épocas, así que **la misma semilla da exactamente el
  mismo horario** sin importar cuántos hilos corran. Sin eso no se pueden
  comparar dos configuraciones y atribuir la diferencia a los parámetros.
- **Búsqueda local dirigida**: el evaluador reporta qué genes están en conflicto
  y el refinamiento explora su vecindario de forma exhaustiva. Es lo que hace al
  algoritmo memético y no solo genético, y en la práctica es la diferencia entre
  cerrar los empalmes y quedarse estancado en tres para siempre.

Restricciones duras: capacitación docente, disponibilidad horaria del docente,
empalmes de docente, grupo y aula, tipo y **capacidad** del espacio, aulas que
usa otra carrera, permanencia del grupo en su aula, límites de materias y
grupos, horas sobre el máximo semanal, **más de ocho horas de clase en un mismo
día**, y una materia no puede repetirse el mismo día para el mismo grupo.

Esa última cubre dos reglas con una sola comprobación. El reglamento pide que
una materia no pase de tres horas diarias y que esas horas vayan seguidas; como
cada bloque ya es contiguo por construcción, basta con impedir que dos bloques
de la misma materia caigan el mismo día. No es teórica: al desactivarla, una
corrida sobre los datos reales dejó cinco días con horas de más.

**Tres horas es el techo, no lo deseable.** El reparto usa bloques de dos
mientras alcancen los días hábiles y solo sube a tres cuando no alcanzan: una
materia de cinco horas sale 2+2+1 en tres días, no 3+2 en dos. La preferencia se
expresa al construir los bloques, no penalizando después.

### Fusión

Una materia puede impartirse **a varios grupos a la vez**: una sola clase, un
docente, un aula. Se declara con `fusiones: [{ materiaId, grupos: [...] }]` y el
motor la programa una vez ocupando el horario de todos los participantes.

**Qué se propone solo.** La validación devuelve `fusionesPosibles`: las materias
que más de un grupo cursa en el mismo turno, ordenadas por lo que ahorran. El
coordinador marca las que quiera antes de generar. En `especialidades-2026` salen
cinco —los grupos 7A y 7B comparten todo el tronco común de séptimo— y aplicarlas
bajan el horario de 158 a 134 horas-clase, sin romper ninguna restricción dura.

Una fusión que nombra un grupo que ya no se abre **no tumba el horario**: se
descarta y se informa. Es un dato que quedó viejo al cambiar los grupos, no un
error de quien la pidió.

**Entre carreras.** Es el caso que el tecnológico más repite, y funciona
programando las dos carreras **en un solo horario**. No basta con colar el grupo
invitado en la sesión compartida: si el motor no conoce el resto de sus clases,
le pone la fusionada encima. O se programan juntas, o ninguna.

Los ids de grupo se repiten entre carreras —ISIC e ITIC generan las dos un
`g-1a`— así que al unirlos se prefijan con la carrera (`ISIC:g-1a`), y las claves
visibles pasan a "1A ISIC". Las materias se unen **por id**, que es lo que hace
posible la fusión; si dos carreras definen la misma con distintas horas a la
semana se rechaza nombrándola, porque no puede ser una sola clase.

Al apartar, cada carrera se queda con las sesiones de sus grupos. Una fusionada
es **una** hora catedrático —el docente entra una vez— y se le carga a la carrera
del grupo principal, dueña del aula; las demás la ven ocupada en la hoja.

**Con otra coordinación hace falta su permiso.** Generar un horario conjunto es
decidir el de las dos, así que si la otra carrera la lleva otra persona, esta
tiene que aceptar una **invitación**. Es distinta de una solicitud de horas:
aquella se resuelve en horas concretas y deja rastro en la hoja; esta es un
permiso que vale mientras esté aceptado y que **cualquiera de las dos partes
puede retirar**. Quien lleva ambas carreras no invita a nadie: no hay a quién
pedirle permiso.

Medido sobre ISIC + ITIC juntas, nueve grupos y 1 500 generaciones:

| | Bloques | Horas-clase | Fusionadas | Factible |
|---|---|---|---|---|
| Sin fusionar | 112 | 206 | 0 | **No** — 3 horas no disponibles, 1 exceso de materias |
| Con las 18 fusiones | 68 | 125 | 44 | Sí, cero restricciones duras |

Es el resultado que justifica la fusión: con la plantilla del instituto, las dos
carreras juntas **no caben** si cada una imparte su propia sección de las
materias comunes. Fusionarlas no es un ahorro cosmético, es lo que hace el
horario posible.

Los grupos fusionados deben cursar esa materia y compartir turno; si no, se
rechaza. Para el límite de grupos del docente cuenta como **uno**: es una sola
clase impartida, y contarla como varias castigaría justo lo que la fusión ahorra.

La **capacidad** sí se comprueba, y sobre la suma de los grupos de la sesión:
dos grupos de treinta no caben en un salón de treinta. Un aula sin capacidad
registrada no restringe nada — inventarle un número y rechazar horarios que sí
caben sería peor que no saberlo.
Restricciones blandas: horas bajo el mínimo, horas que el docente pidió evitar,
horas muertas —de grupo y **de docente**, separadas— y las prioridades de
horario del departamento. Todos los pesos son configurables por petición.

Las horas muertas se cuentan aparte para cada uno porque no son el mismo
problema: un alumno con una hora libre se queda en el campus, pero un docente
con clase a las 7 y a las 13 pierde el día. Por eso `huecoDocente` pesa 8 contra
los 3 de `huecoGrupo`. Medido sobre `especialidades-2026` con ocho semillas:

| `huecoDocente` | Huecos de docente | Huecos de grupo | Factibles |
|---|---|---|---|
| 0 | 7-20 (mediana 13) | 0-7 (mediana 3.5) | 3/8 |
| 8 | 2-5 (mediana 4) | 2-6 (mediana 4) | 6/8 |

### Prioridad docente

La antigüedad del docente se muestra junto al selector, en años de servicio. No
la usa el sistema: la usa **la persona** que decide a quién cuidar.

Cuando dos docentes evitan la misma hora y solo uno puede librarse, alguien
tiene que ceder. **Quién, lo decide el coordinador**, no un dato derivado: la
prioridad es una herramienta suya, se pone desde la columna *Prioridad* del
panel de docentes y tiene tres niveles —Normal, Alta, Máxima—.

Tres y con nombre, no un número libre: el coordinador sabe "a este hay que
cuidarlo", no cuánto exactamente, y una escala abierta acaba con todos en el
máximo, que equivale a que nadie la tenga.

**Va por carrera.** Es un juicio sobre el propio horario, así que priorizar a
alguien en ISIC no se lo impone a quien coordina ITIC. La plantilla docente sigue
siendo del instituto y no se toca: la prioridad vive en `docente_prioridad`,
colgando de la carrera. Se guarda al momento, no con el botón del escenario,
porque no es dato del escenario.

En el motor multiplica el peso de `horaEvitada` por `1 + prioridad × pesos.prioridad`.
El diagnóstico sigue contando horas y no privilegios: lo que cambia es lo que
cuestan. Con `pesos.prioridad: 0` la herramienta deja de tener efecto.

`pesos.prioridad` vale **5** por omisión, y ese número está medido. Marcando
Máxima a los tres docentes que más horas evitadas cargaban, sobre ocho semillas:

| `pesos.prioridad` | Los tres priorizados | Los demás | Total |
|---|---|---|---|
| 0 | 37 | 23 | 60 |
| 1 | 30 | 29 | 59 |
| **5** | **23** | **29** | **52** |
| 20 | 21 | 33 | 54 |

En 1 la herramienta casi no se nota; en 20 los priorizados ya no mejoran y los
demás empeoran. La regla **reparte, no quita**: el total apenas se mueve, y es lo
correcto — el horario no se vuelve más fácil porque alguien tenga prioridad. Uno
de los tres bajó menos que los otros dos, y con esta varianza de semilla no hay
nada que concluir de eso.

### Verificación de aceptación

```bash
node backend/herramientas/verificar.js [http://localhost:8080]
```

Doscientas trece comprobaciones contra un despliegue **vivo**: HTTP real,
sesiones reales, la base de verdad. Cubren **las 69 rutas de la API**, medido y no
supuesto: con `REGISTRAR_PETICIONES=1` el backend registra el patrón de cada
petición atendida, y el diff contra la tabla de rutas dice cuáles no toca nadie.
La primera medición dio 59 %, y las veintidós que faltaban incluían cosas como
importar disponibilidad, reiniciar una contraseña o cerrar sesión. No sustituye a las pruebas unitarias —esas comprueban
piezas— sino a la revisión manual, recorriendo los caminos completos: alta de
carrera y de cuentas, aislamiento entre coordinaciones, el portero que impide
generar con datos incompletos, generar y apartar, recuperar el horario, la
contención entre dos carreras con su solicitud y su cesión, el historial, el
horario conjunto con su invitación, el formulario del docente y el cierre de
periodo.

Dos de sus secciones no comprueban una función sino una avería. **"Dos a la
vez"** lanza cuatro asignaciones simultáneas sobre la misma carrera y comprueba
que entran todas: es la razón de que el almacenamiento sea SQLite y no archivos.
**"Cuando el motor no está"** solo corre si el motor está caído de verdad —no lo
tumba— y entonces exige que Generar responda 503 y con una frase para una
persona, no con `getaddrinfo ENOTFOUND engine`.

Trabaja sobre carreras propias (`ZZ*`) y las cierra al terminar. Es repetible:
tres corridas seguidas dan el mismo resultado, que es lo que separa una prueba de
una anécdota.
Entra como `depto`; si esa cuenta ya cambió su contraseña, se le pasa la suya con
`CLAVE_DEPTO=... node backend/herramientas/verificar.js`.

Encontró un fallo que las pruebas unitarias no veían: al añadir el horario
conjunto, apartar un horario de **una sola** carrera dejaba de reservar nada
—`repartirPorCarrera` descartaba las sesiones sin prefijo— después de haber
borrado la reserva anterior. Vaciaba la hoja en silencio.

### Simulación de un periodo

```bash
node backend/herramientas/simular.js [http://localhost:8080]
```

**Doce actos** narrados contra el sistema vivo, en el orden en que ocurren: el
departamento abre el periodo, un docente declara su horario por su enlace, **el
departamento reparte quién imparte cada clase**, Sistemas y TI arma el de sus
tres carreras, **descubre que quien le pusieron no le cuadra y pide el cambio**,
Administración llega después y encuentra la plantilla mordida, las dos chocan
sobre el mismo docente, se piden y se ceden las horas, **se mira qué aulas
quedan libres antes de colocar nada**, el coordinador mueve una clase a mano,
**el docente abre su enlace y ve su semana entera** y el departamento cierra.

Los cuatro actos nuevos son los que el relato no contaba: empezaba armando
horarios sin que nadie hubiera repartido, que es justo lo primero que pasa.

Es distinto de la verificación: aquella comprueba que cada cosa funcione, esta
muestra cómo se usan **juntas**. Sirve para enseñar el sistema y para notar
comportamientos raros que ninguna prueba aislada delata.

Cuando el motor no produce ningún choque —porque prefiere horas libres, que es su
trabajo— el relato lo **provoca** apartando a propósito una hora ajena, y lo dice.
Es lo que pasa en la realidad cuando una coordinación insiste en un docente
concreto, y sin eso el acto central no se vería nunca.

### Plantilla contra el reglamento

```bash
node backend/herramientas/normalizar-plantilla.js [http://localhost:8080] [--escribir] [--horas]
```

Sin `--escribir` solo dice qué cambiaría, como `migrar-docentes.js`. Ajusta el
tope de tres materias —que el reglamento no deja a criterio— y deduce la
dedicación que falte; las horas solo con `--horas`, porque ahí sí hay margen
legítimo. Lo que no cuadre y no se ajuste queda enumerado con su artículo: es
trabajo del departamento, no del guion.

### Repartir el plantel entero

```bash
node backend/herramientas/sembrar-reparto.js            # mide y no escribe
node backend/herramientas/sembrar-reparto.js --escribir
node backend/herramientas/sembrar-reparto.js --vaciar
```

**No es una función del producto**: quién imparte cada clase lo decide una
persona. Es un sembrador de banco, como `sembrar-plantel.js`, para poder medir el
sistema con las ciento cincuenta clases repartidas sin pedirle a nadie ciento
cincuenta decisiones a mano. Respeta lo mismo que respetaría quien reparte —los
topes del reglamento, la autorización, y que pueda de verdad con el turno y los
días— y **dice qué no cabe y por qué**, distinguiendo "nadie puede con ella" de
"a quien puede ya no le cabe", que es la diferencia entre faltar permisos y
faltar gente.

Medido con el banco actual: de 150 clases entran 91; las 59 restantes son 253
horas-clase que treinta docentes no pueden cubrir. Once de las trece carreras
generan horario factible en 5,1 segundos entre todas; las dos últimas se bloquean
por falta de aulas en el turno matutino.

### Decisiones que se contradicen

```bash
node backend/herramientas/decisiones.js [http://localhost:8080]
```

El tercer eje. La verificación comprueba que cada cosa funcione y la simulación
cuenta cómo se usan juntas; esto pregunta **qué pasa cuando dos decisiones
legítimas no caben a la vez**, que es donde se rompen los sistemas de
coordinación.

Sube por niveles y cada uno supone el anterior:

| Nivel | Qué mezcla | Ejemplo |
|---|---|---|
| 1 | Una decisión | El departamento asigna una clase y el motor la respeta |
| 2 | Varias del mismo actor | La misma persona en dos grupos, y en dos carreras: la carga las junta |
| 3 | Decisiones que se contradicen | Asignar a quien no está autorizado, a quien no tiene horas, o más horas de las que tiene contratadas |
| 4 | Dos coordinaciones y el departamento | Las dos quieren al mismo docente a la misma hora: disputa, petición y cesión |

Monta su propio plantel mínimo —dos carreras `DD*`, dos cuentas `dd-*` y tres
docentes de prueba con disponibilidad y autorizaciones a medida— porque forzar
una contradicción exige controlar esos datos. Devuelve la plantilla del instituto
tal cual estaba, pase lo que pase.

**La regla que sale de todo esto**: una contradicción no se impide, se **nombra**.
El departamento puede asignar a alguien que no da esa materia o que no tiene
horas —son sus dos registros y puede tener uno atrasado—; lo que el sistema hace
es entregar el horario y decir exactamente por dónde no cuadra, en vez de
rechazar la decisión o, peor, cambiarla por su cuenta.

**La excepción son las decisiones de otro.** Un ajuste a mano que cambie el
docente de una clase asignada se rechaza con un 422 que nombra al departamento:
mover una clase es del coordinador, decidir quién la imparte no.

### Qué partes de la API se usan

```bash
REGISTRAR_PETICIONES=1   # en el backend
```

Registra por consola el **patrón** de cada ruta atendida —no la ruta concreta,
porque `/carreras/ISIC/…` y `/carreras/ITIC/…` son la misma entrada de la tabla—.
Sirve para medir qué cubre una herramienta de prueba y qué no toca nadie: una
ruta que ninguna prueba llama es una que se rompe en silencio.

### backend — API de datos

Servidor HTTP sin dependencias, sobre **SQLite** (`node:sqlite`, incluido en
Node). Traduce un escenario al problema que entiende el motor y administra la
identidad de los coordinadores.

El almacenamiento es SQLite y no archivos porque el sistema es multiusuario: dos
guardados simultáneos sobre el mismo archivo lo dejan a medias, y las escrituras
que borran y reinsertan van en transacción.

**Lo que eso resuelve y lo que no**, medido con escrituras simultáneas de verdad:
doce asignaciones a la vez entran las doce; dos coordinaciones generando y
apartando a la vez apartan las dos; seis guardados simultáneos de la plantilla
completa dejan exactamente treinta docentes y la base íntegra. Lo que **no**
resuelve es la *actualización perdida*: `PUT /api/docentes` manda la plantilla
entera, así que si dos personas editan a dos docentes distintos al mismo tiempo,
gana el último y el otro cambio desaparece sin avisar. Hoy el riesgo es acotado
—la plantilla solo la escribe el departamento— pero es una propiedad del diseño,
no algo que SQLite arregle.

**Sesión.** `scrypt` para las contraseñas y token aleatorio en cookie
`HttpOnly; SameSite=Lax`, todo con `node:crypto`. Un coordinador lleva de 1 a N
carreras y solo opera las suyas; la hoja de saturación la ve completa.

La sesión **caduca a las 12 h y lo comprueba el servidor**. `Max-Age` en la
cookie solo le pide al navegador que la borre: un token copiado seguiría
entrando. Se mide desde que se creó y no desde el último uso, porque renovar en
cada petición mantendría vivo un token robado, que es lo que hay que evitar. Al
entrar se barren las vencidas, así la tabla no crece sin fin.

Con `CON_TLS=1` la cookie sale además como `Secure`. Está apagado por omisión
porque el despliegue de desarrollo es `http://`, y una cookie `Secure` sobre
http se descarta en silencio: nadie podría entrar y el error no diría por qué.

**El catálogo: quién imparte qué.** La sección que responde la pregunta con la
que el jefe de departamento se sienta a repartir — *quién le da cada clase a
esta coordinación*. Se elige la carrera y salen sus grupos, uno debajo de otro,
con las materias que lleva cada uno y quién las imparte.

**La unidad es la clase, no la materia.** Una materia frente a un grupo es una
decisión; si el semestre abre tres grupos, son tres. Pueden ser de la misma
persona o de tres distintas, y las dos cosas se ven aquí igual de claras. Y son
independientes entre carreras: que alguien dé Cálculo en Sistemas no dice nada
de quién lo da en TI.

Elegir abre la lista de la plantilla con **la carga que cada quien ya lleva
encima** —horas y clases, sumadas de todas las coordinaciones— porque es el dato
que hace falta justo en el momento de sumarle una más. Los autorizados para esa
materia salen primero; los demás no se esconden, se marcan: la autorización es
un registro del propio departamento y puede ir atrasada, así que asignar a
alguien sin ella es una decisión visible y no un descuido.

**No hay horas en ninguna parte de esta pantalla, a propósito.** El departamento
dice quién imparte qué; cuántas horas y en qué momento de la semana lo resuelve
el coordinador con el generador.

Dejar una clase sin nadie **se permite**: el departamento puede estar a medias
de repartir, y entonces el motor elige por su cuenta entre los autorizados. Lo
que no puede es pasar desapercibido, y por eso se cuenta en la barra lateral y
en rojo junto a la carrera.

**Una clase la imparte una sola persona.** Cinco horas se programan en tres
bloques, pero son una clase: el motor mueve los bloques juntos cuando prueba
docentes, y ni el cruce ni el refinado pueden dejar el martes a nombre de otro.
Antes sí podía, y el horario salía con dos apellidos en la misma materia de un
grupo, que no es un horario que se pueda aplicar.

**Contra qué grupos se reparte.** El departamento asigna para el periodo, no
para un "qué pasaría si", así que la referencia es el escenario base. Pero los
grupos no existen hasta que el coordinador declara cuántos abre cada semestre, y
esa configuración vive en el escenario donde la guardó: se toma la del base si
ya está configurado, y si no la más reciente. Sin esto el departamento repartía
1A y el coordinador generaba con 1A y 1B.

**Carga acumulada.** Asignar a alguien en dos carreras son dos decisiones
independientes; la persona no lo es. La segunda sección suma lo que cada docente
junta entre todas las coordinaciones —horas, clases, materias, en qué carreras—
y marca en rojo a quien se pasó de lo suyo. Es lo que evita descubrir en marzo
que alguien quedó con cuarenta horas repartidas entre cuatro coordinaciones.

**Autorizar docentes.** La ficha del docente sigue siendo donde se dice qué
puede dar cada quien, y el catálogo son sesenta y siete materias con trece
carreras, así que lleva buscador y un "solo las suyas". El filtro **no oculta
las ya autorizadas**: quitarle una sin verla en la lista sería fácil de hacer
sin querer.

Buscar ignora acentos, porque en español se teclea sin ellos: "etica" encuentra
"Taller de Ética" y "diseno" encuentra "Diseño". Vale para todos los buscadores
de la aplicación, no solo este.

**Pedir un cambio de docente.** El modelo reparte la decisión en dos —el
departamento dice quién imparte cada clase y el coordinador decide cuándo cae en
la semana— y eso está bien repartido, pero dejaba al coordinador sin salida
cuando el quién no le sirve: la persona no tiene huecos donde él los necesita.
El ajuste a mano le contesta que se lo pida al departamento; `peticion_cambio`
es el sitio donde pedirlo.

Es deliberadamente distinto de la conciliación. Aquella negocia **horas** entre
iguales y quien las tiene cede o no; esta sube una decisión a quien la tomó, y
por eso no se "cede": **aceptar es decir a quién se le da la clase**, y el
cambio queda aplicado en el mismo gesto. Aceptar sin elegir a nadie —o eligiendo
a quien ya la imparte— se rechaza: sería marcar como resuelto algo que no
cambió, y la coordinación volvería a pedirlo mañana.

Para poder pedir hay que poder ver, así que el coordinador lee el catálogo de
**sus** carreras: qué clases tienen a alguien al frente y cuáles decidirá el
motor. Escribirlo sigue siendo del departamento.

**El docente ve su horario.** Su enlace personal abría solo el formulario de
disponibilidad, así que la pregunta que hace primero —*¿qué me tocó?*— no la
contestaba nadie. Y la hoja imprimible sale del horario de una carrera: quien da
clase en tres tenía tres hojas parciales, cada una en poder de un coordinador
distinto. `GET /api/mi-horario/:token` arma la semana desde la saturación, que
es la tabla donde confluyen todas, y la misma página la imprime.

Mientras el periodo esté abierto eso es un **borrador** y se dice con todas las
letras: alguien que organiza su semana con un horario que todavía puede moverse
tiene derecho a saberlo.

**Las reglas salen del reglamento, no de una suposición.** Los topes del sistema
—cuántas horas, cuántas materias, en qué franja del día— estaban elegidos por
parecer razonables, y eso no basta: hay un reglamento federal que los fija.
`src/tecnm.js` los reúne con su artículo, del **Reglamento Interior de Trabajo
del Personal Docente de los Institutos Tecnológicos**, que rige al Campus
Chetumal como a cualquier otro instituto del subsistema.

| De dónde sale | Qué dice | Dónde se aplica |
|---|---|---|
| **Art. 143** | Horas frente a grupo por categoría y dedicación: titular de tiempo completo 22, asociado 24, asistente 26; tres cuartos 16/18/20; medio tiempo 12/12/14 | Se compara con `horasMax` y se avisa si no cuadra |
| **Art. 144** | Profesor investigador: 12, 10 y 6 | Misma tabla |
| **Art. 146** | Técnico docente de superior: 36, 28 y 18 | Misma tabla |
| **Art. 147** | La carga se ajusta al número de su categoría "sin que la diferencia exceda de dos horas" | Tolerancia de ±2 h antes de avisar |
| **Art. 155** | Asignatura: de 1 a 19 horas, y **nunca más de tres materias diferentes** | `maxMaterias` por omisión, y aviso si se captura más |
| **Art. 156** | De carrera: 40, 30 o 20 horas, con el mismo tope de tres materias | Igual |
| **Art. 157** | Actividades docentes **de 7 a 22 horas, de lunes a viernes** | Es la rejilla. El corte entre turnos no lo fija el reglamento sino el plantel: matutino 7-13, vespertino 13-22 |

Nótese que **el titular da menos clase que el asistente**. No es un error de
captura: a mayor categoría, más tiempo va a las otras funciones del artículo 27
—programas de estudio, capacitación, tutorías— y menos al aula.

Un tope más no sale del reglamento sino del mapeo del problema que entregó el
departamento: **ocho horas de clase como máximo en un mismo día**. El reglamento
fija la franja y el total semanal, pero no cuánto de ese total cabe en un día.
Es `tecnm.MAX_HORAS_DIA_DOCENTE`, viaja al motor dentro de la rejilla, y ahí sí
es restricción dura: nadie firma un horario con nueve horas seguidas un martes.

**Son avisos, no bloqueos.** Un plantel real tiene comisiones, plazas mixtas y
nombramientos en trámite; un sistema que se niegue a programar por eso no se usa.
Lo que no puede es que los topes sean números inventados. `GET
/api/plantel/normativa` devuelve las tablas y a quién no le cuadran, con el
artículo de cada aviso, y `herramientas/normalizar-plantilla.js` ajusta lo que el
reglamento no deja a criterio —el tope de tres materias— y **solo enumera** lo
demás.

**Dónde se captura.** El nombramiento —categoría, dedicación, nivel, horas
frente a grupo y topes— se edita en la ficha del docente, dentro de la pantalla
del departamento. Antes no se podía: esos campos venían sembrados y no había
formulario que los tocara, así que la dedicación, que es la mitad de lo que
decide las horas del artículo 143, no existía ni como dato ni como campo.

Al cambiar categoría o dedicación **se propone** lo que dice el reglamento y se
puede dejar otra cosa; lo que quede fuera de la norma se señala con su artículo,
en la ficha y en un resumen sobre la tabla de la plantilla. La interfaz no lleva
su propia copia de las tablas: las pide a `GET /api/plantel/normativa`, porque
una segunda versión envejecería aparte de la que el sistema aplica y acabaría
proponiendo horas que luego se marcan como mal.

**Cuál escenario es el bueno.** El departamento reparte contra el escenario
**base**, así que cuál lo sea no es una etiqueta: decide sobre qué grupos se
reparte. Antes se ponía al sembrar y no se podía mover, de modo que el catálogo
lo adivinaba —*el base si estaba configurado, si no el último configurado*— y un
borrador de prueba se lo llevaba por delante en cuanto alguien le guardaba una
configuración. Ahora la coordinación lo marca desde la lista de escenarios, es
exclusivo, el primero de una carrera nace siéndolo, y el catálogo va detrás sin
heurísticas.

**Una decisión sin clase no se borra ni se cuenta.** El reparto apunta a materias
y grupos que administra la coordinación: si cierra un grupo o quita una materia
después de repartir, esa asignación se queda sin nada a lo que aplicarse.
Borrarla sería tirar una decisión ajena —si el grupo vuelve a abrirse sigue
valiendo, y vuelve sola— pero contarla era peor: la **carga acumulada** incluía
clases que ya no existen, que es justo el número que el departamento usa para
decidir y para entregar. Ahora la carga se arma del catálogo vivo y las
huérfanas se nombran aparte.

**Repartir ciento cincuenta clases.** Son ciento cincuenta decisiones y el caso
más común es que la misma persona lleve **todos** los grupos de una materia: de
una en una son tres diálogos idénticos para decir lo mismo. La casilla *"aplicar
a los N grupos que cursan esta materia"* las toma juntas, y siguen siendo
decisiones por clase — cada una deja su propia constancia.

El reparto **se hereda** de un periodo al siguiente, porque la asignación no
lleva periodo: el departamento reparte para el que está en curso. Casi siempre es
lo que se quiere; cuando no, **Vaciar** quita el de una carrera de golpe y deja
el registro de lo que había, que hasta ahora exigía quitar setenta clases a mano.

**Quién cambió esto, y cuándo.** Las horas ya tenían su historia en
`saturacion_historial` y las decisiones no, así que esa pregunta no la contestaba
nadie. `asignacion_historial` anota cada cambio en la misma transacción que lo
provoca —quién la tenía, quién la tiene, quién lo hizo y por qué— y solo cuando
de verdad cambió: registrar un "cambio" de alguien por sí mismo llenaría la
historia de ruido. Un cambio hecho a petición de una coordinación lo dice, y se
consulta donde se decide: al abrir una clase, plegado, junto a los candidatos.

**La carga académica en papel.** El horario se imprimía por grupo y por docente;
el reparto no, y es un documento con destinatarios —Servicios Escolares, cada
coordinación, el expediente—. Dos hojas, porque responden a preguntas distintas:
**por carrera**, qué recibe cada coordinación, con el formato de las hojas del
instituto —grupo, clave, materia, horas, quién la imparte—; y **por docente**, lo
que cada persona junta entre todas, que es la que nadie podía sacar de ningún
lado.

**Un aula, varios grupos, horas distintas.** Los alumnos no se mueven de su
salón: cada grupo tiene su aula base. Pero **si el grupo de ingeniería termina a
las cuatro, el de arquitectura entra a las cuatro** — el intercambio es por
franja horaria, no por turno completo. El sistema repartía un aula por grupo y
por turno entero, que es más grueso que la realidad y dejaba dos carreras sin
salón con veintidós grupos matutinos contra dieciséis aulas.

Ahora el reparto es por **presupuesto de horas**: un aula de matutino tiene seis
horas por cinco días, y dos grupos la comparten si entre los dos caben. Primero
se busca un salón vacío —nadie mete dos grupos en un aula habiendo una libre— y
al compartir se elige **la más vacía**, no la primera que quepa: meter un grupo
en el salón más lleno del plantel deja al motor sin margen y acaba en horas
encimadas aunque en el papel cupieran. Lo mismo con las horas que otra carrera ya
tiene: se **descuentan** del presupuesto en vez de descartar el aula entera, que
es lo que agotaba los salones con trece carreras.

Quien resuelve que no se pisen es el motor: `choqueAula` es restricción dura, así
que dos grupos en un salón tienen que entrelazarse o el horario no sale.

**La fusión es la otra combinación**, y es distinta: ahí los dos grupos están
**a la misma hora en el mismo salón**, con un solo docente, porque es una sola
clase. El grupo visitante se mueve al aula del principal solo para esa clase y
conserva la suya para el resto; el cupo se comprueba sobre la **suma** de los dos
grupos, porque dos grupos de treinta no caben en un salón de treinta.

**Pedir un salón.** Los dos recursos del instituto se comparten, y hasta ahora
solo uno se podía negociar: las horas de un docente se piden y se ceden, las de
un aula se tomaban por orden de llegada. Ahora van por el mismo sitio —la misma
tabla, la misma bandeja, el mismo historial— porque es la misma conversación:
quien las tiene cede o no.

La diferencia está en cómo se llega. Dos carreras **pueden** pretender la misma
hora de un docente a la vez: queda en disputa y el sistema la nombra. Un aula
ocupada, en cambio, el motor no la usa, así que nadie choca y nadie se entera —
por eso se pide desde la **hoja de ocupación**, pulsando la hora que tiene la
otra carrera. Ceder suelta esas horas de su reserva de verdad, igual que con un
docente.

**Quedarse sin aula tiene dos causas y se dicen distinto.** `aulas-sin-cupo`
—*"8 grupos no caben en ningún salón: el mayor es de 40 alumnos"*— pide salones
más grandes; `faltan-aulas` —*"las 16 aulas no tienen horas libres suficientes en
su turno"*— pide más salones u horarios más repartidos. Antes los dos casos daban
el mismo mensaje, el segundo, y con grupos de 45 alumnos mandaba a buscar aulas
que no habrían arreglado nada.

**La ocupación de las aulas.** Los docentes tenían su hoja de saturación desde
hace semanas y las aulas no, aunque son igual de compartidas: la que ocupa 1A por
la mañana la quiere otro grupo por la tarde. El dato ya viajaba al motor —por eso
sabe marcar `aulaOcupadaPorOtros`— pero solo se veía como violación **después**
de generar, que es tarde: para entonces hay que rehacer el horario.

La sección **Ocupación de aulas** es la misma rejilla que la de docentes, con dos
diferencias que vienen del recurso. Un aula no declara disponibilidad —existe
todo el día hábil— así que no hay gris de "no la ofreció": o está libre o está
tomada. Y lo que importa de una tomada es **quién** la tiene, porque la propia se
mueve cambiando el horario y la ajena hay que ir a negociarla; van con fondo
distinto y rayado, para que se distingan de un vistazo en una rejilla de setenta
y cinco celdas y no solo por el color.

**Quién administra la plantilla, también en la interfaz.** El alta de docente se
quedó donde estaba cuando la plantilla pasó al departamento —en el panel del
coordinador— y ahí ya no guardaba nada: `PUT /escenarios/:id` manda materias,
semestres y especialidades, y el docente dejó de vivir en el escenario. Se podía
capturar a una persona entera, marcar el escenario como sucio y perderla al
recargar. Ahora el alta está en la pantalla del departamento, que es quien
contrata, y el panel del coordinador **lee**: sin alta, sin edición y sin el
botón que no hacía nada.

No se pide la disponibilidad al dar de alta: la declara el propio docente por su
enlace, que es el modelo. Lo demás —descargas, autorizaciones— se añade en cuanto
existe la ficha.

**Quién puede dar esa clase, antes de asignarla.** Tener horas en el turno no
basta: una materia no se repite el mismo día, así que hacen falta tantos días
declarados como bloques tenga. Alguien que solo declaró los lunes no puede con
una materia de cinco horas por mucho que le sobren horas ese día. El diálogo de
asignación lo dice en el momento de elegir —*"declara 1 día de matutino y la
materia necesita 3"*— en vez de dejar que aparezca después como veinte horas
imposibles en el diagnóstico.

**Contraseña olvidada.** El departamento pone una provisional desde la tabla de
cuentas. No se genera ni se muestra ninguna: la dicta quien la pone, y la cuenta
queda obligada a cambiarla en su siguiente entrada, así que el paso por manos
ajenas dura eso. Se cierran sus sesiones abiertas: si la olvidó porque alguien
más la tenía, dejarlas vivas no arregla nada.

**Contraseña de arranque.** Una cuenta nace obligada a cambiarla: hasta que lo
haga, la conocen dos personas —quien la creó y quien la usa—. El bloqueo está en
el servidor y no solo en la pantalla; con la obligación puesta, lo único que
responde es cerrar sesión y cambiarla. Tampoco vale "cambiarla" por la misma.

**Ninguna carrera se queda sin coordinador.** Retirar a quien la lleva sola, o
quitársela por reasignación, devuelve `409`. Una carrera huérfana no falla en
ninguna parte —simplemente nadie puede abrirla— y solo se notaría mirando la
tabla.

| Método | Ruta | |
|---|---|---|
| `GET` | `/api/salud` | Estado propio y del motor |
| `GET`/`POST`/`DELETE` | `/api/sesion` | Quién soy, entrar, salir |
| `GET` | `/api/carreras` | |
| `POST` | `/api/sesion/clave` | Cambiar la contraseña propia |
| `GET`/`POST` | `/api/usuarios` | Cuentas. Solo departamento |
| `PUT` | `/api/usuarios/:id/carreras` | Qué carreras lleva |
| `POST` | `/api/usuarios/:id/clave` | Reiniciar la de quien la olvidó |
| `DELETE` | `/api/usuarios/:id` | Retirar |
| `GET` | `/api/docentes` | Plantilla del instituto |
| `PUT` | `/api/docentes` | Administrarla entera: alta masiva y baja. Solo departamento |
| `PUT` | `/api/docentes/:id` | Un nombramiento. Lo que no va en el cuerpo no se toca |
| `POST` | `/api/saturacion` | Hoja de horas catedrático de todos los docentes |
| `POST` | `/api/saturacion/aulas` | La misma hoja, por espacio: qué carrera tiene cada hora |
| `POST` | `/api/saturacion/historial` | Quién apartó, soltó o cedió cada hora |
| `GET`/`PUT`/`DELETE` | `/api/carreras/:carrera/escenarios/:id/reserva` | El horario apartado; apartar; soltar |
| `GET` | `/api/carreras/:carrera/aulas` | Los espacios del plantel, para esta carrera |
| `GET`/`PUT` | `/api/plantel/aulas` | Administrarlos. Escritura solo departamento |
| `GET` | `/api/plantel/catalogo` | Resumen por carrera: clases y cuántas sin asignar |
| `GET` | `/api/plantel/catalogo/:carrera` | Una fila por materia y grupo, con quién la imparte. El coordinador lee la suya |
| `GET`/`POST` | `/api/cambios` | Peticiones de cambio de docente; pedir una |
| `POST` | `/api/cambios/:id/responder` | El departamento acepta —y reasigna— o rechaza |
| `DELETE` | `/api/cambios/:id` | Retirar una petición propia que sigue pendiente |
| `GET` | `/api/mi-horario/:token` | El horario del docente, de todas las carreras, por su enlace |
| `PUT` | `/api/plantel/asignaciones` | Quién imparte una materia a un grupo. Nulo la deja sin asignar |
| `PUT` | `/api/carreras/:c/escenarios/:id/base` | Cuál escenario va a producción: contra él reparte el departamento |
| `POST` | `/api/plantel/asignaciones/materia` | La misma persona en todos los grupos de una materia |
| `POST` | `/api/plantel/asignaciones/historial` | Quién ha tenido cada clase antes de quien la tiene |
| `DELETE` | `/api/plantel/asignaciones/:carrera` | Vaciar el reparto de una carrera |
| `GET` | `/api/plantel/carga` | Lo que cada docente junta en todo el instituto |
| `GET` | `/api/plantel/necesidades` | Lo que el plantel no cubre con su plantilla |
| `GET` | `/api/plantel/normativa` | Las reglas del reglamento y a quién no le cuadran |
| `GET`/`PUT` | `/api/carreras/:carrera/prioridades` | Prioridad docente en esta carrera |
| `GET`/`PUT` | `/api/carreras/:c/escenarios/:id/config` | Paridad, grupos y fusiones elegidos |
| `POST` | `/api/conflictos/propio` | Resolver un choque entre dos carreras propias |
| `GET`/`POST` | `/api/plantel/carreras` | Todas las del plantel; abrir una. Alta solo departamento |
| `DELETE` | `/api/plantel/carreras/:codigo` | Cerrarla. Se niega si tiene horas apartadas |
| `GET`/`POST` | `/api/invitaciones` | Permisos para programar en conjunto |
| `POST` | `/api/invitaciones/:id/responder` | Aceptar o rechazar |
| `DELETE` | `/api/invitaciones/:id` | Retirar el permiso |

El horario conjunto se pide con `invitadas: [{carrera, escenarioId, grupos}]` en
la misma ruta de generación, y la validación devuelve entonces
`fusionesEntreCarreras` además de las de dentro de la carrera.
| `GET`/`POST` | `/api/carreras/:carrera/escenarios` | Listar / crear |
| `GET`/`PUT`/`DELETE` | `/api/carreras/:carrera/escenarios/:id` | |
| `POST` | `/api/carreras/:carrera/escenarios/:id/horario/validacion` | Qué falta para poder generar |
| `POST` | `/api/carreras/:carrera/escenarios/:id/horario` | Genera un horario |
| `POST` | `/api/carreras/:c/escenarios/:id/horario/ajuste` | Reevalúa uno movido a mano |

```bash
cd backend && npm test         # 150 pruebas
```

Herramientas de datos en `backend/herramientas/`. Las migraciones tienen modo
simulación: sin `--escribir` solo muestran lo que harían.

Para correr el piloto de disponibilidad sin esperar a que treinta personas
contesten, `simular-disponibilidad.js` contesta el formulario en su nombre —por
el enlace personal de cada quien, el mismo camino que una persona— con un modelo
escrito en la cabecera del archivo y una semilla que lo hace repetible. Sin
`--aplicar` solo enseña lo que declararía; al aplicar guarda lo que había y
`--restaurar` lo devuelve, incluida la marca de quién había contestado:

```bash
node herramientas/simular-disponibilidad.js                     # solo enseña
node herramientas/simular-disponibilidad.js --aplicar --faltan=4
node herramientas/simular-disponibilidad.js --restaurar=data/respaldos/disponibilidad-….json
```

**Es una simulación y la disponibilidad real solo la da cada persona.** Sirve
para medir: lo primero que midió es que una declaración realista deja el problema
**más apretado** que el banco sembrado, no menos.

Las de verificación entran con cada cuenta y, como el sistema obliga a estrenar
contraseña, cada pasada deja la suya. Para volver a la de arranque después de
correrlas:

```bash
docker compose exec backend node herramientas/restablecer-acceso.js [clave]
```

Es para el despliegue de demostración, no para el instituto: deja todas las
cuentas con la misma contraseña y sin la obligación de cambiarla.

### El horario apartado se recupera

Generar produce un horario; **apartar** lo hace oficial frente a las demás
carreras y lo guarda. Antes solo se guardaba lo segundo: el coordinador cerraba
la pestaña y perdía el horario, aunque las horas siguieran tomadas. Regenerar no
lo recupera — otra semilla da otro horario, y el apartado es el viejo.

La tabla `horario` guarda la respuesta del motor tal cual, que es lo que la
interfaz dibuja. No se reparte en columnas porque la vista consultable ya existe
en `saturacion`; repetirla campo por campo daría dos verdades que se separan.

Junto al horario se guarda también **lo que se eligió antes de generar**:
paridad, cuántos grupos abre cada semestre y qué materias se fusionan. Guardar
el resultado sin guardar las entradas era media solución — al volver, el horario
apartado aparecía pero las casillas de fusión estaban en cero, así que pulsar
"Generar" daba algo distinto sin avisar.

Los dos **sí** se separan al ceder horas en una conciliación: las filas de
`saturacion` desaparecen y el documento sigue mostrando esa clase. Reacomodarlo
es trabajo del motor, así que al abrir el panel se comparan hora por hora y se
nombran las clases que perdieron su lugar. Perder una hora de un bloque de dos
ya lo rompe.

### Ajuste a mano

El motor entrega un horario correcto según lo que sabe, pero siempre hay algo
que no sabe: un docente que avisó tarde, un evento. Pulsando una clase se cambia
su día, hora, docente o espacio.

**Lo comprueba el motor, no la interfaz.** El horario editado vuelve a
`POST /…/horario/ajuste`, que reconstruye el mismo problema y llama a
`/api/evaluar` del motor: reevalúa sin buscar y devuelve el diagnóstico con las
mismas reglas que lo armaron. Escribir esa comprobación en el navegador sería
tener las reglas dos veces, y la segunda copia envejece hasta decir que un
horario está bien cuando no lo está.

Mover al viernes una clase de 1A devuelve, por ejemplo: *hora que el docente no
tiene: 2 · empalmes de grupo: 1 · empalmes de aula: 1 · materia repetida en el
día: 1*. El ajuste no se rechaza —el coordinador decide— pero queda como
**propuesta sin apartar** hasta que vuelva a apartarla.

Cada sesión lleva un `indice` para poder señalarla; el motor rechaza un horario
incompleto en vez de rellenar los huecos con basura, y comprueba que el bloque
quepa entero en el turno antes de evaluarlo.

### Impresión

El producto del trabajo de un coordinador se reparte: los alumnos reciben el
horario de su grupo y los docentes el suyo. **Imprimir** genera los dos, todos
los grupos y todos los docentes de una pasada, uno por página.

La hoja del docente no es la del grupo con otro filtro. Cambia lo que se nombra
en cada bloque —el docente es siempre el mismo y sobra; el grupo y el aula
cambian en cada clase— y la rejilla se acota a las horas que de verdad ocupa: un
docente de tarde con una rejilla de 07:00 a 22:00 recibiría nueve filas vacías, y
además no cabría en una página.

El PDF lo hace el navegador con `window.print()`, que ya exporta a PDF en los
tres sistemas. Generarlo en la app significaría embarcar cientos de kilobytes
para hacer peor lo que el navegador hace bien.

### Carreras y coordinaciones

Las trece de la oferta escolarizada del campus, con sus nombres y siglas reales:

| Coordinación | Carreras |
|---|---|
| Sistemas y TI | ISIC · ITIC · IDAP |
| Administración | LADM · IADM · IGEM |
| Contaduría | CPUB |
| Biología | LBIO |
| Construcción | ARQU · ICIV |
| Eléctrica y Electromecánica | IELE · IEME |
| Turismo | LTUR |

Una coordinación lleva las carreras de su área: la de administración lleva la
licenciatura, la ingeniería y gestión empresarial. Ese reparto no está en el
código —es un dato, y se cambia marcando casillas en la pantalla del
departamento—; `herramientas/sembrar-plantel.js` lo deja puesto de inicio.

**Los datos académicos de las once carreras nuevas son mínimos y sintéticos**:
solo el tronco común de primer semestre, con claves que ya existen en el plantel.
No es su retícula; es lo justo para que la hoja de saturación tenga trece
carreras compitiendo por los mismos treinta docentes, que es el problema que el
sistema resuelve. Medido con las siete coordinaciones apartando: **299 horas
tomadas de 1 108 declaradas**, con un docente en 33 de sus 35 horas.

### La pantalla del departamento

Cinco trabajos distintos, no una página larga: **Periodos · Carreras · Cuentas ·
Espacios · Plantilla docente**, con la barra lateral que ya usa el coordinador. Antes iban
apilados en un solo desplazamiento y la barra estaba vacía; con trece carreras y
treinta docentes eso son varios metros de página.

**Carreras** no existía como sección aunque es lo que todo lo demás organiza.
Ahora se ven las trece con su nombre y quién las coordina, se abre una nueva y se
cierra otra. Cerrar se niega mientras tenga horas apartadas o coordinación: una
carrera que desaparece dejaría a las demás creyendo libres unas horas que no lo
están.

Las carreras de una cuenta se editan en un **diálogo**, no con trece botones en
cada fila. Con todas las del plantel pintadas siempre —once cuentas por trece
carreras son ciento cuarenta y tres— las dos o tres activas se perdían entre las
apagadas. En la tabla salen solo las suyas; el diálogo las muestra con clave y
nombre, que es como se reconocen.

Una cuenta **retirada** se apaga en vez de esconderse: existe para que su
historial tenga autor, y el departamento necesita saber que está ahí.

### Cuentas

Las crea el **departamento académico** desde su pantalla: nombre, usuario,
contraseña y las carreras que lleva, que se alternan pulsando. Un coordinador
puede llevar varias.

Cada quien cambia su contraseña desde su sesión, dando la actual: una sesión
abierta en una máquina prestada no debe bastar para quedarse con la cuenta. Al
cambiarla se cierran **todas** las sesiones, incluida la propia — si se cambia
porque alguien más la sabía, dejar viva su sesión vaciaría el cambio de sentido.

**Retirar no borra la cuenta.** El historial de saturación y las solicitudes
apuntan a quién hizo cada cosa, y borrar al autor dejaría la historia sin dueño.
Se le quitan las carreras y se cierran sus sesiones, que es lo que significa "ya
no coordina". La última cuenta de departamento no se puede retirar: quedaría
nadie para dar de alta ni cerrar periodos.

### Respaldo

### Volver a un respaldo

```bash
node backend/herramientas/restaurar.js                  # lista lo que hay
node backend/herramientas/restaurar.js --ver <archivo>  # qué trae dentro
node backend/herramientas/restaurar.js --archivo <f> --escribir
```

Los respaldos existían desde hacía días y nadie había restaurado ninguno, que es
la forma habitual de descubrir en el peor momento que no servían.

Antes de tocar nada **comprueba el respaldo**: integridad, que sea una base de
este sistema y no otra cosa, y cuántas filas trae de cada tabla, junto a las de
la base vigente. Restaurar es aceptar una pérdida deliberada, y hay que poder
verla: *"asignacion 10"* contra *"asignacion 20"* es la diferencia entre volver
una hora atrás y volver una semana.

**Aparta la base que reemplaza**, en `antes-de-restaurar-<marca>.db`. Una
restauración equivocada —archivo confundido, fecha mal leída— es tan posible como
la pérdida que la motivó, y volver atrás tiene que seguir siendo posible.
Probado: ida y vuelta, con el sistema vivo comprobando cada extremo.

**Borra el `-wal` y el `-shm`.** Son el diario de la base anterior; dejarlos
junto a un archivo nuevo mezcla dos historias y la corrompe. Es el error clásico
al restaurar SQLite copiando solo el `.db`.

**Y exige que el servicio esté parado**, porque mientras corre tiene la base
abierta:

```bash
docker compose stop backend
docker compose run --rm backend node herramientas/restaurar.js --archivo … --escribir
docker compose start backend
```

La comprobación obvia no sirve y conviene saberlo: **`BEGIN EXCLUSIVE` pasa
aunque el backend esté arriba**. En modo WAL varias conexiones conviven y una
inactiva no retiene candados, así que el bloqueo se concede mientras el servicio
atiende peticiones; los archivos `-wal` y `-shm` tampoco valen, porque
sobreviven a un contenedor detenido. Lo único fiable es preguntarle al servicio:
si `/api/salud` contesta, está vivo.

**Corre solo**: al arrancar y cada `HORAS_ENTRE_RESPALDOS` (12 por omisión; 0 lo
apaga). Va dentro del servicio y no en un cron del sistema porque el `.db` vive
en un volumen del contenedor, que el cron del anfitrión no alcanza sin montarlo
otra vez — y quien despliega con `docker compose up` no va a configurar nada
más. A mano:

```bash
docker compose exec backend node herramientas/respaldar.js
```

Escribe en `data/respaldos/` y conserva los catorce últimos. Usa `VACUUM INTO`
y no `cp`: copiar el archivo mientras alguien escribe deja un respaldo roto sin
avisar, porque en modo WAL los cambios recientes viven en otro archivo. Las
pruebas comprueban que la copia pasa `integrity_check` y trae el esquema y las
filas completas.

Cuando los datos eran JSON el respaldo era el historial de git. Ahora son un
binario en un volumen: sin esto, perderlo es perder los escenarios, la plantilla
docente, la saturación y los horarios de todas las carreras.

### frontend — interfaz

Vue 3 con `<script setup>`, sin router ni librería de estado: son dos vistas y
un objeto `reactive`. Editar es local y guardar es explícito, de modo que se
puede probar un cambio y descartarlo recargando.

La marca son cinco franjas horarias sobre una rejilla de tres columnas: de cerca
un horario semanal, de lejos la S de Schedul. Vive en
`src/componentes/LogoMarca.vue` y se simplifica sola por debajo de 22 px, donde
las franjas segmentadas se ensucian. Los archivos sueltos están en
`frontend/public/` (`logo.svg` y `favicon.svg`).

Estructura de panel de trabajo: barra lateral fija con el escenario abierto, su
cobertura y las secciones (**Docentes · Materias · Especialidades · Aulas ·
Generar horario**); cabecera fija con las acciones; y una sola zona que se
desplaza, con el buscador y los encabezados de tabla pegados arriba.

El horario se dibuja como rejilla semanal por grupo, con una hora por fila, los
bloques de dos horas fusionados y un color por especialidad.

**Conciliación** lleva un contador de solicitudes pendientes en la barra lateral:
una petición de horas que solo se ve entrando a la sección no se contesta. Se
recalcula al abrir el escenario y al responder, sin sondeo periódico: quien pide
horas espera una respuesta en días, no en segundos, y un `setInterval` costaría
una consulta por minuto y por pestaña para enterarse antes de nada.

## Modelo de datos

Los archivos de `backend/data/<carrera>/` son la fuente de verdad.

| Entidad | Campos |
|---|---|
| **Materia** | `id`, `clave`, `nombre`, `semestre`, `horasSemana`, `creditos`, `carrera`, `especialidadId`, `requiereLaboratorio` |
| **Docente** | `id`, `nombre`, `categoria`, `nivel`, `horasMin`, `horasMax`, `maxMaterias`, `maxGrupos`, `antiguedad`, `carreraBase`, `esDeOtraArea`, `disponibilidad`, `descargas`, `materiasCapacitadas` |
| **Especialidad** | `id`, `nombre` |
| **Semestre** | `id`, `periodo`, `carrera`, `semanas`, `turnos`, `estado` |
| **Aula** | `id`, `clave`, `tipo`, `capacidad` |

- `Materia.especialidadId` es la única fuente de verdad de la relación; `null` es
  tronco común. Eliminar una especialidad no borra sus materias: vuelven a
  tronco común.
- `Docente.materiasCapacitadas` describe capacidad, no asignación: puede exceder
  `maxMaterias`. Quién imparte de verdad cada clase vive en `asignacion`, con
  clave `(carrera, materia, grupo)` — **sin escenario**: el departamento reparte
  para el periodo, y con el escenario dentro una asignación hecha en el base no
  la veía el coordinador que trabajaba en una variante.
- Guardar la plantilla docente **no borra y reinserta**: `asignacion` y
  `docente_prioridad` cuelgan de `docentes(id)` con `ON DELETE CASCADE` y no
  viajan en ese documento. Se hace upsert por docente y solo se da de baja a
  quien ya no viene.
- Y **esa baja se niega si deja a alguien colgado**. Como la plantilla se guarda
  entera, dar de baja es guardar la lista sin esa persona; medido sobre el
  plantel completo, quitar a una borraba 89 horas apartadas de once carreras y
  tres clases del reparto con un `200` y sin decir nada. Ahora responde `409`
  nombrando cuántas horas son, de quiénes y cuántas clases: se sueltan primero y
  se da de baja después, igual que al cerrar una carrera. Lo mismo con un salón
  que otra carrera tiene apartado.
- **El docente es del instituto, no del escenario**, y lo administra el
  **departamento**. `PUT /api/docentes` reemplaza la plantilla entera, así que
  mientras estuvo abierta a las coordinaciones cualquiera podía reescribir quién
  imparte qué —lo que el departamento decide— o borrar docentes de las demás
  carreras sin querer. El coordinador la lee y le pone prioridad; nada más. La misma persona da clase en varias
  carreras; tener una copia por escenario significaba tener varias versiones de
  ella.
- `Docente.disponibilidad` son bloques `{dia, inicio, fin}` **declarados** por el
  docente, más los que prefiere evitar. El motor recibe la máscara resultante con
  las descargas ya descontadas.
- `Docente.descargas` son horas de comisión administrativa. Las carga el
  **departamento académico**: ni el coordinador ni el docente las editan, y sobre
  ellas no se puede programar clase.
- `Docente.categoria` incluye `Asignatura`, para quien cobra por hora impartida.
  Esos docentes llevan `horasMin: 0`: no tienen carga garantizada.
- `horasMin` y `horasMax` son la carga **en esta carrera**, no la institucional.
  Un titular tiene 20-24 h en el tecnológico pero las reparte entre varias
  carreras; exigirlas aquí dejaría la aptitud con un piso que ningún horario de
  una sola carrera puede bajar.
- **Las aulas son del plantel** y las administra el **departamento**, no una
  coordinación. Guardarlas reemplaza la lista entera, así que mientras la ruta
  fue `PUT /api/carreras/:c/aulas` cualquier coordinador podía dejar al resto sin
  ninguna: guardar un aula borraba las otras veinte. Un recurso compartido no lo
  edita quien compite por él. Al repartirlas se saltan las
  que otra carrera ya usa en ese turno, y `capacidad` permite comprobar que los
  grupos quepan — sobre todo al fusionar, donde dos grupos suman.

### Periodo y grupos

Un periodo escolar **no imparte los nueve semestres a la vez**: agosto-diciembre
da los impares y enero-junio los pares. Cada generación de horario se pide para
una de las dos paridades, y solo se programan esos semestres. La paridad
preseleccionada se deduce del nombre del periodo del escenario.

Un **grupo pertenece a una especialidad** y cursa el tronco común de su semestre
más las materias de su módulo, nunca las de otro: en séptimo, el grupo 7A de
Desarrollo Web y el 7B de Negocios Digitales comparten el tronco común y
difieren en el resto.

Un mismo semestre puede **abrir grupos en varios turnos a la vez**: la
configuración lleva una cantidad por turno, no un turno único, así que primero
puede tener dos grupos matutinos y uno vespertino. Las letras se reparten por
semestre siguiendo el orden de la rejilla, de modo que los matutinos van
primero: 1A y 1B por la mañana, 1C por la tarde.

Cada grupo tiene **un aula fija**: los alumnos no cambian de salón, el docente
es quien rota. Solo las materias que piden laboratorio sacan al grupo de su
aula. El reparto lo hace el backend y no el algoritmo — es una decisión de la
coordinación con solución directa, y dejarla al motor solo agrandaría el espacio
de búsqueda. El contador se reinicia en cada turno, así que **un aula se
reutiliza entre turnos**: la que ocupa 1A por la mañana queda libre por la
tarde, y por eso doce aulas alcanzan para más de doce grupos.

La rejilla de tiempo y el número de grupos **no** se guardan: viajan en la
petición. La rejilla se deduce de los turnos del escenario (matutino
07:00-13:00, vespertino 13:00-22:00, lunes a viernes, bloques de 2 h) y los
grupos se sugieren a uno por semestre y módulo —matutino hasta segundo,
vespertino de tercero en adelante—, ajustables antes de generar.

Está así a propósito: el número de grupos depende de la matrícula y la paridad
depende del periodo, y ninguna de las dos pertenece a la definición de un
escenario.

### Disponibilidad declarada por el docente

Cada docente tiene un **enlace personal** (`?disponibilidad=TOKEN`) con el que
declara su horario sin cuenta ni contraseña. El token es la credencial y solo
abre su propia hoja.

Para cargas masivas hay **importación CSV**: una fila por docente y una columna
por día, que es la forma que sale de un formulario. Reconoce al docente por id o
por nombre, acepta `7-14`, `07:00-14:00` o `7 a 14`, y reporta lo que ignoró.

Las **descargas administrativas** solo las carga el rol `departamento`.

| `GET` | `/api/enlaces` | Enlaces personales para repartir |
| `GET`/`PUT` | `/api/disponibilidad/:token` | Formulario del docente, sin sesión |
| `POST` | `/api/docentes/importar` | Carga masiva desde CSV |
| `PUT` | `/api/docentes/:id/descargas` | Solo departamento académico |

### Conciliación entre carreras

Nadie bloquea a nadie: varias carreras pueden pretender las mismas horas de un
docente. El motor prefiere las libres, y solo si no alcanzan toma una disputada
—que pesa, pero **no vuelve infactible** el horario: se puede aplicar si el otro
coordinador cede—.

Donde dos carreras coinciden hay un **conflicto**. De ahí sale una solicitud con
motivo, y quien tiene las horas cede o rechaza desde su bandeja. Aceptar libera
de verdad los bloques que se solapan.

**Salvo que las dos carreras sean suyas.** Un coordinador puede llevar varias y
chocar consigo mismo; entonces no hay nada que negociar y el conflicto sale
marcado como propio, con un botón que suelta las horas del otro lado sin pasar
por una solicitud. Sin eso, la bandeja decía *"te piden horas"* por una petición
que escribió quien la lee, y la misma solicitud salía en enviadas y en
recibidas.

| `POST` | `/api/carreras/:c/escenarios/:id/conflictos` | Choques con otras carreras |
| `GET`/`POST` | `/api/solicitudes` | Peticiones de horas entre coordinaciones: de un docente o de un salón |
| `POST` | `/api/solicitudes/:id/responder` | Ceder o rechazar |
| `GET` | `/api/periodos` | Estado de cada paridad |
| `POST`/`DELETE` | `/api/periodos/:paridad/cerrar` | Cerrar o reabrir. Solo departamento |

### Saturación: el recurso compartido

La plantilla docente es del instituto, así que **las carreras compiten por sus
horas**. `data/saturacion.json` registra quién apartó qué hora de qué docente.

Al armar un horario se descuentan las horas que **otros** escenarios ya
pretenden; las propias no, porque se están reemplazando. Quien programa después
ve menos huecos libres, igual que hoy con la hoja que circula por correo.

La sección **Saturación docente** muestra la rejilla de cada docente con cuatro
estados: no declarada, descarga administrativa, libre y apartada —con la carrera
y el grupo que la tomó—.

Debajo va el **historial**: quién apartó, soltó o cedió cada hora y cuándo. Saber
quién tiene una hora no basta para resolver un "yo tenía esa hora"; hace falta
saber quién la tuvo antes y por qué la soltó. Se registra al apartar (incluidas
las que se reemplazan, marcadas como tales), al soltar y al ceder en una
conciliación, con el motivo acordado.

### No se genera con datos incompletos

La generación se rechaza con `422` si algo falta. Los bloqueos actuales:

- Materias que no caben en la semana: con tres horas por día, más de quince
  horas semanales necesitan más días de los que hay.
- Más grupos en un turno que aulas disponibles.
- Escenario sin materias en la paridad elegida, sin docentes o sin grupos.
- Carrera sin espacios, o sin laboratorios habiendo materias que los requieren.
- Un grupo con más horas de las que caben en su turno.
- Clases fijadas en alguien que no está autorizado para esa materia: el motor
  respeta lo que el departamento fija y no lo puede cambiar, así que el horario
  saldría sin poder aplicarse.
- Ninguna materia del periodo con quien la dé: no queda nada que programar.

La interfaz consulta el mismo endpoint de validación y mantiene el botón
deshabilitado, nombrando qué falta y llevando a la sección donde se arregla. El
backend vuelve a validar al generar: la interfaz guía, pero es el servidor el
que garantiza.

Antes esto eran advertencias y el motor entregaba un horario imposible
explicando por qué. Es peor que no entregar nada: un horario con materias sin
docente parece un resultado y no lo es, y quien lo revisa busca el error en la
propuesta en vez de en los datos.

### Lo que falta no es un dato: es gente

Dos cosas que antes bloqueaban no se arreglan capturando. Que ninguna persona
esté autorizada para una materia, y que la carga pase de lo que la plantilla
puede dar. Son **necesidades de contratación**, y el mapeo del problema que
entregó el departamento las trata así: *"en caso de que no haya maestro para
cubrir alguna materia por esta razón u otra, se deja esa materia para contratar a
una persona por horas. Entonces se marca como una necesidad"*.

El horario se genera con lo que sí se puede cubrir. La materia que nadie puede
dar se aparta del problema que va al motor —colocarla obligaría a asignársela a
alguien sin autorización, y eso la vuelve infactible por construcción— y sale
reportada con su clave, su nombre y sus horas. Sus horas siguen contando para el
presupuesto del aula del grupo: cuando se contrate, la clase irá a ese salón. El
déficit de capacidad se mide contra lo que queda por programar, no contra la
carga entera, para no contar dos veces las mismas horas.

Con los números del propio mapeo la cuenta no es un caso raro: 616 horas de clase
contra 516 de capacidad frente a grupo, **100 horas de déficit**, parejo entre las
cuatro áreas. Bloquear ahí dejaba sin horario justo al plantel que tiene el
problema.

Las **advertencias** siguen existiendo para lo que no bloquea ni hay que
contratar: una especialidad con cero grupos cuyas materias no se programarán,
materias con un único docente capacitado, o un reparto que le fija a alguien más
materias de las que su nombramiento permite — eso último sale con nombre y
claves, porque el motor respeta lo fijado y el exceso aparecería en todas las
corridas.

## Escala

El motor no tiene un muro: la calidad mejora con el esfuerzo. Lo que crece es el
costo. Medido con un instituto sintético de nueve semestres por carrera, sobre
un i3-1115G4:

| Carreras en una corrida | Grupos | Bloques | Parámetros | Tiempo | Resultado |
|---|---|---|---|---|---|
| 1 | 5 | 75 | 2 000 gen · 4 islas | 6 s | Factible |
| 2 | 10 | 150 | 3 000 gen · 6 islas | 22 s | Factible |
| 3 | 15 | 225 | 4 000 gen · 8 islas | 53 s | Factible |
| 13 | 65 | 975 | 4 000 gen · 8 islas | 161 s | 9 restricciones duras |

**Una coordinación lleva de una a tres carreras**, así que la corrida real es la
de las tres primeras filas: menos de un minuto y factible. Las trece a la vez no
ocurren —el diseño lo impide sin invitación de cada coordinación— y a esa escala
haría falta mucho más tiempo del que alguien espera frente a una pantalla.

Con parámetros fijos la calidad sí se degrada al crecer: 1 200 generaciones sobre
975 bloques es proporcionalmente mucha menos búsqueda que sobre 75. El esfuerzo
hay que subirlo con el tamaño.

## Limitaciones conocidas

- **No hay matrícula**, así que el número de grupos y los alumnos de cada uno se
  capturan a mano. Sin alumnos, la comprobación de capacidad de aula no compara
  nada; la validación lo advierte nombrando los grupos a los que les falta.
- **`nivel`, `creditos` y `carreraBase` no los lee el motor.** Se muestran en las
  tablas como referencia para quien coordina, que es su único propósito.
- **No hay HTTPS activo.** `frontend/nginx.conf.template` trae el bloque `443`
  comentado y `docker-compose.yml` los puntos de montaje; falta el certificado
  de la institución y encender `CON_TLS=1`.
- **Las cuentas sembradas comparten contraseña** y nada obliga a cambiarla al
  entrar por primera vez.
- **Los datos de prueba son sintéticos.** Los 30 docentes de
  `especialidades-2026` están diseñados para que el escenario sirva de banco de
  pruebas: traslape variable por área de conocimiento, mezcla de plaza y
  asignatura, y turnos repartidos. La retícula de ITIC tiene el tamaño y la
  forma de una real —49 materias en nueve semestres, 39 compartidas con ISIC—
  para que la contención entre carreras se mida con volumen realista, pero no es
  el plan de estudios oficial. Ninguno de los dos es dato del departamento.

El motor conserva sus propias advertencias (`avisosDelMotor` en la respuesta)
como red de seguridad, aunque con la validación del backend no deberían
dispararse.
