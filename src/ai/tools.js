// The six tools the model may call, and an executor that runs them over a
// two-method interface: getDoc() reads the document, commit(fn) mutates it.
// The browser passes the store (commit = store.mutate inside a batch); tests
// and a future MCP server pass a plain document.
import { filterParts } from '../search.js';
import { PARTS } from '../palette.js';
import { presetsFor } from '../presets.js';
import { checkDoc } from '../drc.js';
import { applyEdits, EDIT_SCHEMA, MAX_OPS } from './ops.js';
import { placeNew, arrangeAll } from './layout.js';
import { boardText, partLine } from './context.js';

const EMPTY = { type: 'object', properties: {}, additionalProperties: false };

export const TOOLS = [
  {
    name: 'search_parts',
    description: 'Find palette kinds by words in their name, category, port names, buses, or vendor presets. Returns up to 20 kinds with their ports.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'get_board',
    description: 'The current board as text: zones, nodes, wires, notes, the selection, and the check findings.',
    input_schema: EMPTY,
    strict: true,
  },
  {
    name: 'run_checks',
    description: 'Run the design-rule checks on the current board: I2C address conflicts, unconnected power pins, floating parts, bus mismatches, lifecycle risks. Returns findings with the ids involved.',
    input_schema: EMPTY,
    strict: true,
  },
  {
    name: 'list_presets',
    description: 'Vendor presets (real products) for a palette kind: name, part number, rail, and a spec note. Use them to fill part numbers.',
    input_schema: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'apply_edits',
    description: `Apply up to ${MAX_OPS} edit operations as one atomic batch: add_part, update_part, replace_part, remove, connect, update_wire, add_zone, update_zone, add_note, update_note, set_title. New items carry a ref you choose that later ops may use as an id. Connect by bus; ports are picked for you. Nothing is applied if any operation fails; the errors say which and why.`,
    input_schema: EDIT_SCHEMA,
  },
  {
    name: 'arrange',
    description: 'Lay the whole board out again from scratch. Moves every card; use only when the user asks to tidy or rearrange.',
    input_schema: EMPTY,
    strict: true,
  },
];

export function statusLine(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'search_parts': return `searching parts: ${i.query ?? ''}`;
    case 'get_board': return 'reading the board';
    case 'run_checks': return 'running checks';
    case 'list_presets': return `presets for ${i.kind ?? ''}`;
    case 'apply_edits': return `applying ${Array.isArray(i.ops) ? i.ops.length : 0} edits`;
    case 'arrange': return 'arranging the board';
    default: return name;
  }
}

const findingLine = (f) => `${f.level} ${f.rule} "${f.message}" ids: ${f.ids.join(' ')}`;

export function createExecutor({ getDoc, commit, selection = () => [] }) {
  const touched = new Set();
  const ok = (text) => ({ text, isError: false });
  const err = (text) => ({ text, isError: true });

  const handlers = {
    search_parts(input) {
      const query = String(input.query ?? '');
      const kinds = [...filterParts(query)].slice(0, 20);
      if (!kinds.length) return ok(`No kinds match "${query}". Try broader words, a bus name, or a category.`);
      return ok(kinds.map((k) => partLine(PARTS[k])).join('\n'));
    },
    get_board() {
      const doc = getDoc();
      return ok(boardText(doc, { selection: selection(), findings: checkDoc(doc) }));
    },
    run_checks() {
      const findings = checkDoc(getDoc());
      if (!findings.length) return ok('No findings: the board passes every check.');
      return ok(findings.map(findingLine).join('\n'));
    },
    list_presets(input) {
      const kind = String(input.kind ?? '');
      if (!PARTS[kind]) return err(`unknown kind "${kind}"`);
      const list = presetsFor(kind);
      if (!list.length) return ok(`No presets for ${kind}; choose a part number yourself.`);
      return ok(list.map((p) => `${p.name} | pn=${p.sublabel} | rail=${p.rail || '-'} | ${p.notes}`).join('\n'));
    },
    apply_edits(input) {
      if (!Array.isArray(input.ops)) return err('apply_edits needs an ops array');
      let res;
      commit((doc) => {
        res = applyEdits(doc, input.ops);
        if (res.ok) placeNew(doc, res.layout);
      });
      if (!res.ok) {
        return err(`Batch rejected, nothing applied:\n${res.errors.map((e) => `#${e.index}: ${e.message}`).join('\n')}`);
      }
      for (const id of res.touched) touched.add(id);
      const refs = Object.entries(res.refs).map(([r, id]) => `${r}=${id}`).join(' ');
      let text = `Applied ${res.changes.length} change(s).`;
      if (refs) text += `\nrefs: ${refs}`;
      text += `\n${res.changes.join('\n')}`;
      if (res.warnings.length) text += `\nwarnings:\n${res.warnings.join('\n')}`;
      return ok(text);
    },
    arrange() {
      const doc = getDoc();
      if (doc.zones.some((z) => z.kind === 'swimlane')) return err('This board has swimlanes; arrange is not available on it.');
      commit((d) => arrangeAll(d));
      for (const n of getDoc().nodes) touched.add(n.id);
      return ok('Arranged the whole board.');
    },
  };

  function run(name, input = {}) {
    const handler = handlers[name];
    if (!handler) return err(`unknown tool "${name}"`);
    return handler(input && typeof input === 'object' ? input : {});
  }

  return { run, touched, resetTouched: () => touched.clear() };
}
