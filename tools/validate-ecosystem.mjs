#!/usr/bin/env node
/**
 * Validador del ecosistema.
 *
 * Comprueba que el runtime de opencode y el codigo del proyecto cuentan la
 * MISMA historia. Es el unico sitio donde se puede comprobar, porque los dos
 * lados viven en ficheros distintos y con formatos distintos:
 *
 *   src/ecosystem/manifest.js   -> topologia que usa el codigo (JS)
 *   .opencode/agents/*.md       -> comportamiento que usa opencode (frontmatter)
 *   .opencode/commands/*.md     -> comandos que ve el usuario
 *   .opencode/skills/<nombre>/SKILL.md -> skills que el modelo puede cargar
 *   opencode.json               -> configuracion del proyecto
 *
 * Sin este validador, cambiar un handoff en el manifiesto deja los ficheros de
 * agente diciendo lo contrario, y el fallo aparece en produccion como "el agente
 * hizo algo que no deberia". Documentado no es lo mismo que garantizado.
 *
 * Uso:  node tools/validate-ecosystem.mjs [--json]
 * Sale con codigo 1 si hay errores.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENTS, HANDOFFS, validateManifest } from "../src/ecosystem/manifest.js";
import { TYPOLOGIES, CATEGORIES } from "../src/knowledge/taxonomy.js";
import { PLAYBOOKS } from "../src/remediation/playbooks.js";
import { ESCALATION_REASONS } from "../src/escalation/index.js";
import { MAX_HANDOFFS } from "../src/domain/lifecycle.js";
import { COMMANDS as CLI_COMMANDS } from "../src/cli.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warnings = [];

const fail = (where, message) => errors.push(`${where}: ${message}`);
const warn = (where, message) => warnings.push(`${where}: ${message}`);

/** Comandos que son de una persona, no de un agente. */
const OPERATOR_OWNED = new Set(["close", "cancel", "accept"]);

/** Palabras vacias que no sirven como senal de cobertura en prosa. */
const STOPWORDS = new Set([
  "con", "para", "sin", "sobre", "entre", "cuando", "donde", "mientras",
  "antes", "despues", "otro", "nunca", "mismo", "misma", "durante", "hacer",
]);

/** Minusculas sin tildes, para comparar prosa con reglas. */
function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Forma singular aproximada, para que "contrasenas" encuentre "contrasena". */
function stem(word) {
  return word.endsWith("s") && word.length > 5 ? word.slice(0, -1) : word;
}

/* ------------------------------------------------------------------ *
 * 1. Manifiesto
 * ------------------------------------------------------------------ */
const manifest = validateManifest();
for (const error of manifest.errors) fail("manifest", error);

/* ------------------------------------------------------------------ *
 * 2. Taxonomia y catalogos referenciados
 * ------------------------------------------------------------------ */
const categoryIds = new Set(CATEGORIES.map((c) => c.id));
const typologyValues = new Set(Object.values(TYPOLOGIES));
const queues = new Set(CATEGORIES.map((c) => c.queue));

for (const agent of AGENTS) {
  for (const category of agent.categories) {
    if (!categoryIds.has(category)) fail(agent.id, `categoria "${category}" no existe en la taxonomia`);
  }
  for (const typology of agent.typologies) {
    if (!typologyValues.has(typology)) fail(agent.id, `tipologia "${typology}" no existe en la taxonomia`);
  }
}

// El destino por defecto del manifiesto tiene que existir como agente.
if (!queues.has("escalation-desk")) warn("taxonomia", 'la cola por defecto "escalation-desk" no existe');

// Ninguna categoria puede quedarse sin dueno: si nadie la declara, el ticket
// acaba en la mesa humana sin que nadie lo haya decidido.
for (const categoryId of categoryIds) {
  if (categoryId === "unclassified") continue;
  const duenos = AGENTS.filter((a) => a.categories.includes(categoryId));
  if (duenos.length === 0) fail("taxonomia", `la categoria "${categoryId}" no la declara ningun agente`);
  if (duenos.length > 1) {
    fail("taxonomia", `la categoria "${categoryId}" la declaran varios agentes: ${duenos.map((a) => a.id).join(", ")}`);
  }
}

/* ------------------------------------------------------------------ *
 * 2b. Lector de frontmatter sin dependencias
 *
 * Se parsea a mano, y no con la libreria `yaml`, a proposito: `npm install` no
 * tiene por que haberse ejecutado para validar la documentacion. El subconjunto
 * soportado es el que usan estos ficheros: escalares, mapas anidados por
 * indentacion y listas de escalares o de mapas. Cualquier otra cosa se avisa
 * en vez de interpretarse a medias, que es peor que no entenderla.
 * ------------------------------------------------------------------ */
function readFrontmatter(file) {
  const raw = fs.readFileSync(file, "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: null, body: raw, error: "sin frontmatter" };

  try {
    const data = parseYamlSubset(match[1]);
    return { data, body: raw.slice(match[0].length) };
  } catch (error) {
    return { data: null, body: raw, error: `frontmatter ilegible: ${error.message}` };
  }
}

function parseYamlSubset(source) {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, "  "))
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"));

  const { value } = parseBlock(lines, 0, indentOf(lines[0] ?? ""));
  return value;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Lee un bloque homogeneo a partir de `index`. `indent` es la sangria esperada
 * de las lineas de este bloque; todo lo mas sangrado es hijo suyo.
 */
function parseBlock(lines, index, indent) {
  if (index >= lines.length) return { value: null, index };

  if (lines[index].trimStart().startsWith("- ") || lines[index].trim() === "-") {
    const list = [];
    let i = index;
    while (i < lines.length) {
      const line = lines[i];
      const lineIndent = indentOf(line);
      if (lineIndent < indent) break;
      if (lineIndent > indent) throw new Error(`sangria inesperada en "${line.trim()}"`);
      if (!line.trimStart().startsWith("-")) break;
      const rest = line.trimStart().slice(1).trim();
      if (rest === "") {
        const child = parseBlock(lines, i + 1, indentOf(lines[i + 1] ?? ""));
        list.push(child.value);
        i = child.index;
      } else if (isMapEntry(rest)) {
        // Lista de mapas: cada elemento empieza con `clave: valor` y puede
        // continuar en lineas mas sangradas que el guion. Se reconstruye el
        // elemento sin el guion y con la sangria del propio bloque, que es lo
        // que espera el parser recursivo.
        const sub = [rest];
        let j = i + 1;
        while (j < lines.length && indentOf(lines[j]) > indent) {
          sub.push(lines[j]);
          j += 1;
        }
        list.push(parseBlock(sub, 0, 0).value);
        i = j;
      } else {
        list.push(parseScalar(rest));
        i += 1;
      }
    }
    return { value: list, index: i };
  }

  const map = {};
  let i = index;
  while (i < lines.length) {
    const line = lines[i];
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) throw new Error(`sangria inesperada en "${line.trim()}"`);
    const entry = line.trimStart().match(/^(?:"([^"]*)"|'([^']*)'|([\w.-]+)):\s*(.*)$/);
    if (!entry) throw new Error(`no se entiende la linea "${line.trim()}"`);
    // Las claves pueden venir entrecomilladas, y en los permisos hace falta:
    // el patron general se escribe "*", y sin comillas el asterisco es un
    // alias de YAML, no una clave.
    const [, dq, sq, bare] = entry;
    const key = dq ?? sq ?? bare;
    if (key === undefined || key === "") {
      throw new Error(`clave vacia en "${line.trim()}"`);
    }
    const rawValue = entry[4];
    if (rawValue === "") {
      const next = lines[i + 1];
      const nextIndent = next ? indentOf(next) : -1;
      if (next && nextIndent > lineIndent) {
        const child = parseBlock(lines, i + 1, nextIndent);
        map[key] = child.value;
        i = child.index;
        continue;
      }
      map[key] = null;
    } else {
      map[key] = parseScalar(rawValue);
    }
    i += 1;
  }
  return { value: map, index: i };
}

function isMapEntry(text) {
  return /^(?:"[^"]*"|'[^']*'|[\w.-]+):(\s|$)/.test(text);
}

function parseScalar(value) {
  const unquoted = value.replace(/^["'](.*)["']$/, "$1");
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (unquoted === "null" || unquoted === "~") return null;
  if (/^-?\d+$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

/** Reglas de bash: se evaluate la ultima que coincide, igual que opencode. */
function evaluateBash(rules, command) {
  if (typeof rules === "string") return rules;
  let decision = "deny";
  for (const [pattern, action] of Object.entries(rules ?? {})) {
    if (globToRegExp(pattern).test(command)) decision = action;
  }
  return decision;
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Acciones validas segun el esquema de configuracion de opencode. */
const ACTIONS = new Set(["ask", "allow", "deny"]);

/**
 * Comprueba la FORMA de un valor de `permission`.
 *
 * El esquema admite una accion suelta ("deny") o un mapa patron -> accion. No
 * admite listas. Una lista de `"- patron": accion` se parece mucho a la forma
 * correcta y opencode la ignora en silencio: el agente se queda sin Bash y no
 * dice nada, que es la peor forma de fallar. Se comprueba aqui porque el resto
 * de validaciones de permisos seguirian dando el visto bueno: sin reglas, el
 * evaluador devuelve "deny" y "deny" es justo lo que deben dar.
 */
function checkPermissionShape(where, tool, value) {
  if (ACTIONS.has(value)) return;
  if (Array.isArray(value)) {
    fail(where, `permission.${tool} es una lista; el esquema pide un mapa patron -> accion ("${tool}": { "*": "deny", "git *": "allow" })`);
    return;
  }
  if (value === null || typeof value !== "object") {
    fail(where, `permission.${tool} tiene un valor invalido: ${JSON.stringify(value)}`);
    return;
  }
  for (const [pattern, action] of Object.entries(value)) {
    if (!ACTIONS.has(action)) {
      fail(where, `permission.${tool}["${pattern}"] = ${JSON.stringify(action)} no es "ask", "allow" ni "deny"`);
    }
  }
  // Gana la ultima regla que coincide: el patron general tiene que ir PRIMERO,
  // o se come los `allow` concretos que van despues.
  const keys = Object.keys(value);
  const general = keys.indexOf("*");
  if (general > 0) {
    fail(where, `permission.${tool}: "*" tiene que ser la PRIMERA clave (gana la ultima regla que casa; ahora "*" se come los "allow" posteriores)`);
  }
}

/* ------------------------------------------------------------------ *
 * 4. Ficheros de agente
 * ------------------------------------------------------------------ */
const AGENT_DIR = path.join(ROOT, ".opencode/agents");
const declaredFiles = new Set();

for (const agent of AGENTS) {
  const file = path.join(ROOT, agent.file);
  declaredFiles.add(path.basename(agent.file));
  if (!fs.existsSync(file)) {
    fail(agent.file, "el manifiesto declara este fichero pero no existe");
    continue;
  }

  const { data, body, error } = readFrontmatter(file);
  if (error) {
    fail(agent.file, error);
    continue;
  }

  if (!data.description) fail(agent.file, "falta `description` en el frontmatter");
  else if (data.description !== agent.description) {
    fail(agent.file, "la `description` no coincide con el manifiesto (el runtime y el codigo deben contarlo igual)");
  }
  if (data.mode !== agent.mode) fail(agent.file, `modo "${data.mode}" distinto del declarado "${agent.mode}"`);

  // Reglas no negociables del sistema, comprobadas contra lo que el runtime
  // va a leer de verdad: si el fichero dijera otra cosa, mandaria el fichero.
  if (data.permission?.edit !== "deny") {
    fail(agent.file, '`edit` debe ser "deny": un agente de soporte no modifica el codigo que ejecuta');
  }
  if (evaluateBash(data.permission?.bash, "rm -rf /") !== "deny") {
    fail(agent.file, 'la regla bash "*" debe ser "deny"');
  }
  if (data.permission?.webfetch !== "deny" || data.permission?.websearch !== "deny") {
    fail(agent.file, "webfetch/websearch deben ser \"deny\": salir a la red es opaco y no auditable");
  }

  // Forma de todo el bloque de permisos. Sin esto, un `bash` escrito como lista
  // pasaria el filtro de arriba (sin reglas, todo denied) y dejaria al agente
  // sin ability de ejecutar nada, sin que nada lo dijera.
  for (const [tool, value] of Object.entries(data.permission ?? {})) {
    checkPermissionShape(agent.file, tool, value);
  }
  if (data.tools !== undefined) {
    fail(agent.file, '`tools` esta obsoleto: usa `permission` (opencode lo ignora a partir de v1.1.1)');
  }

  // Y la comprobacion positiva: si el agente declara reglas de bash, tiene que
  // haber ALGO que se pueda ejecutar. Un agente al que no le queda ningun
  // comando permitido no puede cumplir su trabajo, y es un fallo silencioso.
  const bashRules = data.permission?.bash;
  if (bashRules && typeof bashRules === "object" && !Array.isArray(bashRules)) {
    const patterns = Object.keys(bashRules);
    if (!patterns.some((p) => bashRules[p] === "allow")) {
      fail(agent.file, "declara reglas de bash pero ninguna deja pasar un comando: el agente no podria trabajar");
    }
    for (const pattern of patterns) {
      if (bashRules[pattern] === "allow" && pattern === "*") {
        fail(agent.file, 'bash "*" no puede ser "allow": abriria el shell entero para ejecutar el codigo que ejecuta las acciones');
      }
    }

    // Y que el comando permitido exista. Un permiso sobre `node src/cli.js
    // identidad *` cuando no hay comando `identity` no rompe nada: el agente
    // simplemente no puede hacer su trabajo y no dice por que. Es el mismo
    // fallo silencioso que la forma de lista, en la capa de arriba.
    for (const pattern of patterns) {
      const command = /^node src\/cli\.js (\w+)/.exec(pattern)?.[1];
      if (!command) continue;
      if (!CLI_COMMANDS[command]) {
        fail(
          agent.file,
          `bash menciona "${pattern}", pero el comando "${command}" no existe en la CLI (hay: ${Object.keys(CLI_COMMANDS).join(", ")})`,
        );
      }
      if (bashRules[pattern] === "allow" && OPERATOR_OWNED.has(command)) {
        fail(
          agent.file,
          `bash deja ejecutar "${pattern}", pero "${command}" es de una persona: cerrar, cancelar y aceptar son de un operador, no de un agente`,
        );
      }
    }
  }

  // El cuerpo es el prompt: tiene que explicar la politica, no ser una linea.
  if (body.trim().length < 300) warn(agent.file, "prompt muy corto: conviene explicar la politica, no solo el nombre");

  // Cada prohibicion del manifiesto deberia tener reflejo en el prompt. La
  // comprobacion es deliberadamente laxa (una palabra significativa en comun)
  // porque el prompt es prosa: no se puede exigir una formula, pero si delata
  // un tema que el fichero no menciona ni de pasada.
  for (const rule of agent.forbidden) {
    const haystack = normalize(body);
    const covered = rule
      .split(/\s+/)
      .filter((word) => word.length > 5 && !STOPWORDS.has(normalize(word)))
      .some((word) => haystack.includes(normalize(word)) || haystack.includes(normalize(stem(word))));
    if (!covered) warn(agent.file, `la prohibicion "${rule}" no parece estar explicada en el prompt`);
  }
}

/* ------------------------------------------------------------------ *
 * 5. Comandos
 * ------------------------------------------------------------------ */
const COMMAND_DIR = path.join(ROOT, ".opencode/commands");
const agentIds = new Set(AGENTS.map((a) => a.id));

if (!fs.existsSync(COMMAND_DIR)) {
  fail(".opencode/commands", "no existe");
} else {
  for (const entry of fs.readdirSync(COMMAND_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const rel = path.join(".opencode/commands", entry);
    const { data, body, error } = readFrontmatter(path.join(ROOT, rel));
    if (error) {
      fail(rel, error);
      continue;
    }
    if (!data.description) fail(rel, "falta `description`");
    if (!data.agent) fail(rel, "falta `agent`: el comando debe declarar quien lo ejecuta");
    else if (!agentIds.has(data.agent)) fail(rel, `el agente "${data.agent}" no existe en el manifiesto`);
    if (body.trim().length < 50) fail(rel, "el cuerpo del comando esta vacio");
    if (data.template !== undefined) fail(rel, 'no pongas "template" en el frontmatter: el cuerpo ES el template');
  }
}

/* ------------------------------------------------------------------ *
 * 6. Skills
 * ------------------------------------------------------------------ */
const SKILL_DIR = path.join(ROOT, ".opencode/skills");
if (!fs.existsSync(SKILL_DIR)) {
  fail(".opencode/skills", "no existe");
} else {
  for (const name of fs.readdirSync(SKILL_DIR)) {
    const rel = path.join(".opencode/skills", name, "SKILL.md");
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) {
      fail(path.join(".opencode/skills", name), "falta SKILL.md");
      continue;
    }
    const { data, body, error } = readFrontmatter(full);
    if (error) {
      fail(rel, error);
      continue;
    }
    if (data.name !== name) fail(rel, `name "${data.name}" no coincide con la carpeta "${name}"`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(data.name ?? "")) {
      fail(rel, `name "${data.name}" no es kebab-case valido`);
    }
    if ((data.name ?? "").length > 64) fail(rel, "name supera los 64 caracteres");
    if (!data.description) fail(rel, "falta `description` (sin ella la skill no se carga nunca)");
    else if (data.description.length < 40) warn(rel, "description corta: conviene incluir cuando usarla, no solo que hace");
    if (body.trim().length < 300) warn(rel, "cuerpo muy corto para ser util");

    // Recurso auxiliar declarado. Una skill que dice consumir un script tiene que
    // consumir uno que exista: si el fichero desaparece, la skill sigue leyendose
    // igual de bien y el agente se queda sin herramienta sin que nada se queje.
    // Por eso se comprueba la EXISTENCIA del fichero, no que este mentioned.
    const declared = [...body.matchAll(/`(tools\/[\w.-]+\.mjs)`/g)].map((m) => m[1]);
    for (const resource of new Set(declared)) {
      if (!fs.existsSync(path.join(ROOT, resource))) {
        fail(rel, `declara el recurso auxiliar "${resource}", que no existe en el repositorio`);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 7. opencode.json
 * ------------------------------------------------------------------ */
const configPath = path.join(ROOT, "opencode.json");
if (!fs.existsSync(configPath)) {
  fail("opencode.json", "no existe");
} else {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    fail("opencode.json", `JSON invalido: ${error.message}`);
  }
  if (config) {
    if (config.$schema !== "https://opencode.ai/config.json") {
      fail("opencode.json", 'falta "$schema": "https://opencode.ai/config.json"');
    }
    if (config.default_agent) {
      if (!agentIds.has(config.default_agent)) {
        fail("opencode.json", `default_agent "${config.default_agent}" no existe`);
      }
      const def = AGENTS.find((a) => a.id === config.default_agent);
      if (def && def.mode !== "primary") {
        fail("opencode.json", `default_agent debe ser "primary" (${def.id} es ${def.mode})`);
      }
    }
    for (const instruction of config.instructions ?? []) {
      if (!fs.existsSync(path.join(ROOT, instruction))) {
        fail("opencode.json", `instructions apunta a "${instruction}", que no existe`);
      }
    }
    if (config.permission?.webfetch !== "deny" || config.permission?.websearch !== "deny") {
      warn("opencode.json", 'conviene denegar webfetch/websearch: el diagnostico de red lo controla el codigo, no el agente');
    }

    // El bloque global de permisos se comprueba con la misma regla que el de los
    // agentes. Un `permission` mal formado aqui no da error en ningun sitio: se
    // aplica silenciosamente y el proyecto se queda sin las restricciones que
    // cree tener.
    for (const [tool, value] of Object.entries(config.permission ?? {})) {
      checkPermissionShape("opencode.json", tool, value);
    }
    if (config.permission?.edit !== "deny") {
      fail("opencode.json", '`edit` debe ser "deny": ninguna parte de este servicio escribe codigo');
    }
    if (config.subagent_depth !== undefined) {
      if (!Number.isInteger(config.subagent_depth) || config.subagent_depth < 1) {
        fail("opencode.json", `subagent_depth debe ser un entero >= 1 (vale ${JSON.stringify(config.subagent_depth)})`);
      }
    }
    // `primary_tools` deja herramientas solo a los agentes primarios. Si
    // `task` o `skill` aparecen ahi, los subagentes pierden la capacidad de
    // traspasar y de cargar skills, que es justo de donde sale el trabajo.
    for (const tool of config.experimental?.primary_tools ?? []) {
      if (tool === "task" || tool === "skill") {
        fail(
          "opencode.json",
          `experimental.primary_tools incluye "${tool}": dejaria a los subagentes sin traspasar ni cargar skills, que es de donde sale el trabajo`,
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 8. Coherencia del dominio
 * ------------------------------------------------------------------ */
// Los playbooks no pueden apuntar a categorias inexistentes: un playbook
// huerfano no lo encontraria nadie.
for (const playbook of PLAYBOOKS) {
  for (const category of playbook.categories) {
    if (!categoryIds.has(category)) fail(playbook.id, `categoria "${category}" no existe`);
  }
  if (!typologyValues.has(playbook.typology)) fail(playbook.id, `tipologia "${playbook.typology}" no existe`);
  if (playbook.rollback === "") fail(playbook.id, "un playbook sin rollback no se puede revertir a mano");
}

// Los motivos de escalado deben ser referenciables: los handoffs los citan por
// nombre en su condicion.
const reasons = new Set(Object.keys(ESCALATION_REASONS));
for (const handoff of HANDOFFS) {
  for (const signal of handoff.when.any ?? []) {
    if (signal === "riesgo_destructivo") continue; // alias en camel, mapeado abajo
    if (!reasons.has(signal) && !["ambigua", "alcance_empresarial", "fuera_de_alcance", "sin_diagnostico", "sin_permiso", "sin_recurso", "aprobacion_pendiente"].includes(signal)) {
      warn(`${handoff.from} -> ${handoff.to}`, `condicion "${signal}" sin equivalente en ESCALATION_REASONS`);
    }
  }
}

// El tope de traspasos del ciclo de vida tiene que ser el que usa el manifiesto.
if (MAX_HANDOFFS !== 3) warn("lifecycle", `MAX_HANDOFFS es ${MAX_HANDOFFS}; el manifiesto asume 3`);

/* ------------------------------------------------------------------ *
 * Informe
 * ------------------------------------------------------------------ */
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings }, null, 2));
} else {
  for (const warning of warnings) console.warn(`  aviso  ${warning}`);
  for (const error of errors) console.error(`  ERROR  ${error}`);
  if (errors.length === 0) {
    console.log(
      `Ecosistema coherente: ${AGENTS.length} agentes, ${HANDOFFS.length} traspasos, ` +
        `${fs.readdirSync(COMMAND_DIR).filter((f) => f.endsWith(".md")).length} comandos, ` +
        `${fs.readdirSync(SKILL_DIR).length} skills.${warnings.length ? ` ${warnings.length} avisos.` : ""}`,
    );
  } else {
    console.error(`\n${errors.length} error(es) en el ecosistema.`);
  }
}

process.exit(errors.length === 0 ? 0 : 1);
