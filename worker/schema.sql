-- Tabla de rankings del ESCÁNER DE AURA.
--
-- Se guarda UNA FILA POR PARTIDA, no una por jugador. El "mejor puntaje por
-- alias" sale con MAX() + GROUP BY en la consulta, no pisando filas al
-- escribir. Es a proposito: con una fila por alias habria que decidir en el
-- INSERT a que tabla pertenece (dia/semana/historico) y una partida de hoy
-- que no supera tu record historico igual tiene que poder ganar el ranking
-- del dia. Guardando todo, las tres tablas son la MISMA consulta con otro
-- WHERE.
--
-- `dia` y `semana` se calculan en el worker y se guardan como texto, no se
-- derivan de `ts` en la consulta: SQLite tendria que recorrer toda la tabla
-- convirtiendo fechas y no podria usar el indice.
CREATE TABLE IF NOT EXISTS runs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  alias     TEXT    NOT NULL,          -- como lo escribio el jugador
  alias_key TEXT    NOT NULL,          -- normalizado, es por el que se agrupa
  aura      INTEGER NOT NULL,
  pais      TEXT    NOT NULL DEFAULT 'XX',   -- ISO-2 de Cloudflare
  region    TEXT    NOT NULL DEFAULT '',     -- departamento/estado de Cloudflare
  moves     TEXT    NOT NULL DEFAULT '',     -- gestos reconocidos, separados por coma
  dia       TEXT    NOT NULL,          -- YYYY-MM-DD (UTC)
  semana    TEXT    NOT NULL,          -- YYYY-Www (UTC, ISO)
  ts        INTEGER NOT NULL           -- epoch ms
);

-- El orden de las columnas importa: primero por lo que se FILTRA y despues
-- por lo que se ORDENA, para que el indice sirva de punta a punta.
CREATE INDEX IF NOT EXISTS ix_hist   ON runs (aura DESC);
CREATE INDEX IF NOT EXISTS ix_dia    ON runs (dia, aura DESC);
CREATE INDEX IF NOT EXISTS ix_semana ON runs (semana, aura DESC);
CREATE INDEX IF NOT EXISTS ix_pais   ON runs (pais, aura DESC);
CREATE INDEX IF NOT EXISTS ix_region ON runs (pais, region, aura DESC);
CREATE INDEX IF NOT EXISTS ix_alias  ON runs (alias_key, ts DESC);

-- Analitica. Una fila por cosa que hizo alguien: entro, escaneo, bajo el clip,
-- entro a una sala. `runs` ya cuenta el torneo, pero solo ve al que ESCRIBE su
-- nombre y sube el puntaje —una minoria—, asi que no sirve para saber cuanta
-- gente entra.
--
-- QUIEN ES CADA UNO. `visitante` es SHA-256 de (sal secreta + dia + IP + user
-- agent), cortado a 24 hex. No se guarda la IP en ninguna parte y el hash no
-- se puede volver atras sin la sal. Como el dia entra en la mezcla, el hash
-- CAMBIA cada medianoche UTC: se puede contar cuanta gente distinta hubo hoy,
-- pero no seguir a la misma persona de un dia para el otro. Es a proposito.
CREATE TABLE IF NOT EXISTS eventos (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo      TEXT    NOT NULL,          -- visita | escaneo | clip | sala
  visitante TEXT    NOT NULL,          -- hash del dia, ver arriba
  pais      TEXT    NOT NULL DEFAULT 'XX',
  region    TEXT    NOT NULL DEFAULT '',
  ref       TEXT    NOT NULL DEFAULT 'directo',   -- de donde vino (host o ?ref=)
  dia       TEXT    NOT NULL,          -- YYYY-MM-DD (UTC)
  semana    TEXT    NOT NULL,          -- YYYY-Www (UTC, ISO)
  ts        INTEGER NOT NULL           -- epoch ms
);

-- Mismo criterio que arriba: primero lo que filtra, despues lo que agrupa.
-- `ix_ev_ts` es el de "cuanta gente hay ahora", que corre cada pocos segundos
-- y solo mira los ultimos diez minutos.
CREATE INDEX IF NOT EXISTS ix_ev_dia   ON eventos (dia, tipo);
CREATE INDEX IF NOT EXISTS ix_ev_ts    ON eventos (ts);
CREATE INDEX IF NOT EXISTS ix_ev_quien ON eventos (dia, visitante);

-- ============================================================================
-- TORNEOS PRIVADOS (streamers / comunidades)
--
-- POR QUE NO SON DURABLE OBJECTS, COMO LAS SALAS. Una sala es EN VIVO: seis
-- personas mirandose la cara al mismo tiempo, y eso necesita un objeto con
-- estado que empuje mensajes. Un torneo no: entras con el codigo, farmeas
-- cuando se te da la gana, subis tu puntaje y te vas. Nadie espera a nadie.
-- Metido en un Durable Object seria un objeto prendido durante DIAS por cada
-- torneo abierto, y el plan gratis da 13.000 GB-s al dia: dos torneos de una
-- semana se comen la cuota y —esto ya paso— cuando se acaba, las salas y la
-- cola contestan 500 TAMBIEN, porque comparten la misma bolsa. Un torneo de
-- streamer es justo el caso que mas gente mete, asi que va en D1, que cobra
-- por consulta y no por segundo.
--
-- UNA FILA POR PERSONA, y aca SI se pisa al mejorar. Es al reves que `runs`,
-- donde se guarda una fila por partida a proposito (ver arriba). La diferencia
-- no es capricho: en `runs` hay tres periodos (dia/semana/historico) y una
-- partida floja de hoy igual puede ganar el ranking del dia, asi que hay que
-- conservarlas todas. Un torneo es UN periodo —el que definio el organizador—
-- y encima cada fila puede tener un video de 14MB colgando. Guardar todos los
-- intentos serian mil videos por torneo para mostrar diez.
CREATE TABLE IF NOT EXISTS torneos (
  codigo      TEXT PRIMARY KEY,           -- 6 caracteres; las salas usan 4, ver abajo
  nombre      TEXT NOT NULL,              -- "El torneo de Fulano"
  organizador TEXT NOT NULL,              -- quien lo armo, se muestra
  clave       TEXT NOT NULL,              -- secreto del organizador: moderar y cerrar
  clips       INTEGER NOT NULL DEFAULT 0, -- 0/1, el opt-in de guardar los videos
  tope_clips  INTEGER NOT NULL DEFAULT 10,-- cuantos videos se conservan (los mejores)
  arranca     INTEGER NOT NULL,           -- epoch ms
  termina     INTEGER NOT NULL,           -- epoch ms, lo elige el organizador
  purga       INTEGER NOT NULL,           -- termina + 7 dias: cuando se borran los videos
  pais        TEXT NOT NULL DEFAULT 'XX',
  ts          INTEGER NOT NULL
);

-- `clip` es la llave en R2, o NULL. NULL no significa "no jugo": significa
-- "no quedo entre los mejores" o "el torneo no guarda videos" o "la subida se
-- corto". El puesto NUNCA depende del video —el puntaje se anota al instante y
-- el archivo va despues, por atras— porque una subida de 14MB en datos moviles
-- no puede costarte el puesto.
CREATE TABLE IF NOT EXISTS torneo_runs (
  codigo    TEXT    NOT NULL,
  alias_key TEXT    NOT NULL,          -- normalizado, igual que en `runs`
  alias     TEXT    NOT NULL,          -- como lo escribio
  aura      INTEGER NOT NULL,          -- su RECORD en este torneo
  moves     TEXT    NOT NULL DEFAULT '',
  pais      TEXT    NOT NULL DEFAULT 'XX',
  clip      TEXT,                      -- llave en R2 del video de esa marca, o NULL
  intentos  INTEGER NOT NULL DEFAULT 1,
  ts        INTEGER NOT NULL,          -- cuando hizo su record
  PRIMARY KEY (codigo, alias_key)
);

-- El de la tabla del torneo. `codigo` primero porque es por lo que se filtra
-- SIEMPRE, y despues el aura para que el ORDER BY salga del mismo indice.
CREATE INDEX IF NOT EXISTS ix_t_rank  ON torneo_runs (codigo, aura DESC);
-- Para el barrido que borra los videos vencidos, que mira solo la fecha.
CREATE INDEX IF NOT EXISTS ix_t_purga ON torneos (purga);
