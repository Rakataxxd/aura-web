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
