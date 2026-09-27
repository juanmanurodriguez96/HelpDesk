/**
 * Clasificador de incidencias.
 *
 * Determinista y explicable: no hay modelo, hay una tabla de terminos ponderada.
 * Para una mesa de soporte esto es una ventaja, no una limitacion: la misma
 * entrada produce siempre la misma categoria, y cada decision lleva el termino
 * concreto que la justifico. Un clasificador estadistico ocultaria el "por que",
 * que es justo lo que se necesita para responder al usuario y para auditar.
 *
 * Se combinan pesos y umbrales de forma que "urgente" no arrastre un ticket de
 * licencea al frente de una caida de produccion: el peso refleja cuan
 * discriminante es el termino, no cuanto suena a urgencia.
 */

import { normalize } from "../core/text.js";
import { CATEGORIES, categoryById, TYPOLOGIES } from "../knowledge/taxonomy.js";

/** Confianza por debajo de la cual se considera que hay ambiguedad. */
export const AMBIGUITY_MARGIN = 0.18;

/** Confianza minima para poder pasar a `triaged`. */
export const MIN_ACTIONABLE_CONFIDENCE = 0.4;

/**
 * @typedef {object} Classification
 * @property {string}  category
 * @property {string}  typology
 * @property {number}  confidence    0..1
 * @property {boolean} ambiguous
 * @property {Array<{category: string, score: number, matched: string[]}>} alternatives
 * @property {string[]} matchedTerms  Justificacion literal de la decision.
 */

/**
 * Clasifica el texto de una incidencia.
 *
 * @param {string} text Texto ya normalizado o sin normalizar (se normaliza aqui).
 * @returns {Classification}
 */
export function classify(text) {
  const haystack = normalize(text);
  const scored = [];

  for (const category of CATEGORIES) {
    if (category.id === "unclassified") continue;
    const matched = [];
    let score = 0;
    for (const { term, weight } of category.terms) {
      if (containsTerm(haystack, normalize(term))) {
        matched.push(term);
        score += weight;
      }
    }
    if (score > 0) {
      scored.push({ category: category.id, score, matched });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));

  const top = scored[0];
  if (!top) {
    return {
      category: "unclassified",
      typology: TYPOLOGIES.SIN_CLASIFICAR,
      confidence: 0,
      ambiguous: true,
      alternatives: [],
      matchedTerms: [],
    };
  }

  const runnerUp = scored[1];
  const total = scored.reduce((sum, s) => sum + s.score, 0);
  // Confianza = cuanto pesa la mejor categoria sobre el total. Complementarla con
  // el margen sobre la segunda evita que dos categorias empatadas den una
  // confianza alta por el mero hecho de que ambas sean pequenas.
  const share = top.score / total;
  const margin = runnerUp ? (top.score - runnerUp.score) / top.score : 1;
  const confidence = round2(share * 0.6 + margin * 0.4);
  const ambiguous = margin < AMBIGUITY_MARGIN;

  return {
    category: ambiguous ? "unclassified" : top.category,
    typology: (categoryById(ambiguous ? "unclassified" : top.category)).typology,
    confidence: ambiguous ? Math.min(confidence, 0.35) : confidence,
    ambiguous,
    alternatives: scored.slice(1, 4),
    matchedTerms: top.matched,
  };
}

/**
 * Busca un termino como palabra completa.
 *
 * La comparacion por palabras evita el fallo clasico de "vpn" dentro de
 * "vpnserverbackup" o "sso" dentro de "assoleido", que en lenguaje real
 * abunda. Las expresiones con espacios o signos se buscan como subcadena.
 */
function containsTerm(haystack, term) {
  if (!term) return false;
  if (/\s/.test(term) || /[.-]/.test(term)) {
    return haystack.includes(term);
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(haystack);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
