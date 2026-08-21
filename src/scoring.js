// Nivel 1: metricas REALES sobre landmarks. Baratas, sin entrenamiento.
// Falsa precision en el texto = ok. Falsa reactividad = jamas.

import { moveName, pick, ROAST_HYPE, ROAST_LOW, ROAST_HOLD, CRIT_LINES } from './roasts.js';
import { MoveDetector } from './moves.js';
import { NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN } from './landmarks.js';

export * from './landmarks.js';

// lo que la gente mueve para lucirse
const TRACKED = [NOSE, L_EL, R_EL, L_WR, R_WR, L_KN, R_KN, L_AN, R_AN];

// Debajo de IDLE (torsos/segundo) no cuenta como movimiento: es respirar,
// acomodarse y el ruido propio del modelo. Ahi el aura drena en vez de subir.
const IDLE = 0.45;
const DRAIN = 700;   // aura por segundo quieto

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Player {
  constructor(id) {
    this.id = id;
    this.prev = null;
    this.prevT = 0;
    this.energy = 0;        // torsos por segundo (normalizado -> la distancia a la camara no importa)
    this.amplitude = 0;     // extension de extremidades
    this.aura = 0;
    this.peakEnergy = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.hotTimer = 0;      // cuanto lleva en energia alta
    this.sinceHot = 99;     // tiempo desde la ultima explosion
    this.holdTimer = 0;
    this.critCooldown = 0;
    this.lineCooldown = 0;
    this.moveCooldown = 0;
    this.events = [];
    this.lost = 0;
    this.draining = false;
    this.moves = new MoveDetector();
    this.landed = [];      // moves con nombre acertados en la ronda
    this.veces = {};       // cuantas veces cayo cada uno (rinde decreciente)
  }

  emit(kind, text, value = 0) {
    this.events.push({ kind, text, value, player: this.id });
  }

  /**
   * lm  = 33 landmarks CRUDOS de MediaPipe {x,y,visibility} en 0..1, o null.
   * met = los mismos en espacio metrico (toMetric), o null.
   *
   * La energia se queda con los crudos A PROPOSITO: es un numero de sensacion,
   * ya calibrado contra video real (IDLE, umbral de crit, de hype). Pasarla a
   * metrico la escalaria ~1.4x en apaisado y ~0.8x en vertical y habria que
   * recalibrar toda la economia de aura para no ganar nada. La GEOMETRIA de
   * los moves si necesita metrico, porque ahi los umbrales son distancias
   * reales del cuerpo.
   */
  update(lm, t, met = null) {
    const dt = clamp(t - (this.prevT || t), 1 / 120, 0.2);
    this.prevT = t;

    if (!lm) {
      this.lost += dt;
      this.energy += (0 - this.energy) * 0.12;
      this.prev = null;
      this.moves.feed(null, dt);
      return this;
    }
    this.lost = 0;

    // --- moves con nombre (Nivel 2): bonus fuerte + callout dorado ---
    for (const m of this.moves.feed(met || lm, dt)) {
      // Repetir el MISMO move rinde cada vez menos.
      //
      // El detector ahora deja repetir un gesto apenas lo soltas (antes habia
      // un cooldown de 5s que se sentia como "no me lo detecta"). Sin esto,
      // hacer mewing diez veces seguidas ganaria la ronda sola. Asi repetir
      // siempre RESPONDE —se ve el callout, cuenta— pero deja de pagar.
      const veces = (this.veces[m.id] = (this.veces[m.id] ?? 0) + 1);
      const bonus = Math.round(m.bonus * Math.max(0.25, Math.pow(0.6, veces - 1)));
      this.aura += bonus;
      this.landed.push(m.name);
      this.emit('signature', m.name, bonus);
      this.moveCooldown = 2.5;   // que un nombre inventado no le pise el momento
      if (m.line) { this.lineCooldown = 2.6; this.emit('line', m.line); }
    }

    const shoulder = mid(lm[L_SH], lm[R_SH]);
    const hip = mid(lm[L_HIP], lm[R_HIP]);
    const torso = dist(shoulder, hip);

    // torso muy chico = persona lejisimos o deteccion mala -> no puntear basura
    if (!(torso > 0.02)) { this.prev = null; return this; }

    // --- energia real ---
    let raw = 0;
    if (this.prev) {
      let sum = 0, n = 0, salto = 0;
      for (const i of TRACKED) {
        const vis = lm[i].visibility ?? 1;
        if (vis < 0.5) continue;
        const d = dist(lm[i], this.prev[i]) / torso;
        salto = Math.max(salto, d);
        sum += d;
        n++;
      }
      // Un cuerpo no se mueve un torso entero en un frame. Cuando pasa es
      // que el tracker se perdio y volvio, o salto a otra persona. Medido en
      // video real: producia picos de energia de 18 que inflaban el aura.
      if (n && salto < 1.0) raw = sum / n / dt;
    }
    this.prev = lm.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility }));

    // ataque rapido, caida lenta -> se siente mejor en pantalla
    this.energy += (raw > this.energy ? 0.55 : 0.12) * (raw - this.energy);
    this.energy = clamp(this.energy, 0, 40);
    this.peakEnergy = Math.max(this.peakEnergy, this.energy);

    // --- amplitud: que tan extendido esta el cuerpo ---
    const reach = Math.max(
      dist(lm[L_WR], hip), dist(lm[R_WR], hip),
      dist(lm[L_AN], shoulder), dist(lm[R_AN], shoulder),
      dist(lm[L_WR], lm[R_WR])
    ) / torso;
    this.amplitude += 0.2 * (clamp(reach / 3.2, 0, 1.6) - this.amplitude);

    // --- aura acumulada ---
    const hot = this.energy > 1.6;

    // Zona muerta: debajo de IDLE no estas haciendo nada y el aura DRENA.
    // Antes la amplitud sumaba sola — pero amplitud mide que tan extendido
    // esta el cuerpo, no cuanto se mueve: parado con los brazos abiertos
    // acumulabas aura para siempre. Ahora la amplitud solo cuenta
    // multiplicada por movimiento real.
    const over = this.energy - IDLE;
    let gain;
    if (over <= 0) {
      // proporcional a lo quieto que estas: 0 justo en el umbral, maximo
      // congelado. Un drenaje plano creaba un acantilado y moverse suave
      // valia lo mismo que no moverse.
      gain = -DRAIN * (1 - this.energy / IDLE) * dt;
      this.draining = this.aura > 0 && this.energy < IDLE * 0.6;
    } else {
      gain = (Math.pow(over, 1.25) * 75 + this.amplitude * over * 28) * dt
        * (1 + Math.min(this.combo, 12) * 0.08);
      this.draining = false;
    }
    this.aura = Math.max(0, this.aura + gain);

    // --- combo ---
    if (hot) {
      this.comboTimer = 0.9;
      this.hotTimer += dt;
      this.sinceHot = 0;
      if (this.hotTimer > 0.45) { this.hotTimer = 0; this.combo++; this.emit('combo', '', this.combo); }
    } else {
      this.hotTimer = 0;
      this.sinceHot += dt;
      this.comboTimer -= dt;
      if (this.comboTimer <= 0 && this.combo) { this.combo = 0; }
    }

    // --- cooldowns ---
    this.critCooldown -= dt;
    this.lineCooldown -= dt;
    this.moveCooldown -= dt;

    // --- nombre de move al detectar pico ---
    // Umbral alto: en video real la energia promedio de una persona
    // bailando ya es ~3.6, asi que a 3.0 esto disparaba sin parar.
    if (this.energy > 6.5 && this.moveCooldown <= 0) {
      this.moveCooldown = 3.0;
      this.emit('move', moveName(), Math.round(gain * 9));
    }

    // --- critico: tragamonedas ponderada por energia ---
    if (this.critCooldown <= 0 && this.energy > 2.4) {
      const p = clamp((this.energy - 2.4) * 0.09, 0, 0.5) * dt * 6;
      if (Math.random() < p) {
        this.critCooldown = 4.2;
        const mult = 2 + ((Math.random() * 3) | 0);
        this.aura += 4200 * mult;
        this.emit('crit', pick(CRIT_LINES), mult);
      }
    }

    // --- HOLD: se congelo despues de explotar ---
    if (this.sinceHot > 0.35 && this.sinceHot < 1.6 && this.energy < 0.5) {
      this.holdTimer += dt;
      if (this.holdTimer > 0.4 && this.lineCooldown <= 0) {
        this.holdTimer = 0; this.lineCooldown = 2.4;
        this.aura += 2400;
        this.emit('line', pick(ROAST_HOLD));
      }
    } else this.holdTimer = 0;

    // --- comentario del narrador ---
    if (this.lineCooldown <= 0) {
      if (this.energy > 3.6) { this.lineCooldown = 2.5; this.emit('line', pick(ROAST_HYPE)); }
      else if (this.energy < 0.25 && this.sinceHot > 3) { this.lineCooldown = 4.0; this.emit('line', pick(ROAST_LOW)); }
    }

    return this;
  }

  drain() { const e = this.events; this.events = []; return e; }
}
