import { nodeRect } from './geometry.js';
import { uid } from './state.js';
import { tr } from './i18n.js';

// Step views are stored as WORLD-SPACE centers ({cx, cy, zoom}) so a journey
// frames the same content on any screen size, panel state, or present mode.
export function addStep(store, view, label) {
  const id = uid('j');
  store.apply((doc) => {
    if (!doc.journey) doc.journey = [];
    doc.journey.push({
      id,
      label: label || tr('Step {n}', { n: doc.journey.length + 1 }),
      view: { cx: view.cx, cy: view.cy, zoom: view.zoom },
      caption: '',
    });
  });
  return id;
}

export function updateStep(store, id, props) {
  store.apply((doc) => {
    const step = (doc.journey || []).find((s) => s.id === id);
    if (!step) return;
    if (props.view) step.view = { cx: props.view.cx, cy: props.view.cy, zoom: props.view.zoom };
    if (props.targets !== undefined) {
      const targets = normalizeTargets(props.targets);
      if (targets) step.targets = targets; else delete step.targets;
    }
    if (props.label !== undefined) step.label = props.label;
    if (props.caption !== undefined) step.caption = props.caption;
  });
}

export function removeStep(store, id) {
  store.apply((doc) => {
    doc.journey = (doc.journey || []).filter((s) => s.id !== id);
  });
}

export function moveStep(store, id, delta) {
  store.apply((doc) => {
    const arr = doc.journey || [];
    const i = arr.findIndex((s) => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= arr.length) return;
    const [step] = arr.splice(i, 1);
    arr.splice(j, 0, step);
  });
}

export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

export function tweenView(from, to, t) {
  const e = easeInOutCubic(Math.min(1, Math.max(0, t)));
  return {
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e,
    zoom: from.zoom + (to.zoom - from.zoom) * e,
  };
}

// Additive optional targets keep legacy camera-only steps readable. Retain
// missing IDs so deletion is visible and undo can restore the original tour.
export function normalizeTargets(value) {
  if (!value || typeof value !== 'object') return null;
  const clean = (ids) => Array.isArray(ids)
    ? [...new Set(ids.filter((id) => typeof id === 'string' && id.length && id.length <= 200))].slice(0, 500) : [];
  const targets = { nodes: clean(value.nodes), wires: clean(value.wires) };
  return targets.nodes.length || targets.wires.length ? targets : null;
}

export function selectedTargets(doc, selection) {
  return normalizeTargets({ nodes: doc.nodes.filter(n => selection.has(n.id)).map(n => n.id),
    wires: doc.wires.filter(w => selection.has(w.id)).map(w => w.id) });
}

export function resolveStep(doc, step, viewport = { width: 1000, height: 700 }) {
  const targets = normalizeTargets(step.targets);
  const ids = new Set();
  const nodes = new Map(doc.nodes.map(n => [n.id, n]));
  const wires = new Map(doc.wires.map(w => [w.id, w]));
  let missing = 0;
  for (const id of targets?.nodes || []) {
    if (nodes.has(id)) ids.add(id); else missing++;
  }
  for (const id of targets?.wires || []) {
    const wire = wires.get(id);
    if (!wire || !nodes.has(wire.from.node) || !nodes.has(wire.to.node)) { missing++; continue; }
    ids.add(id); ids.add(wire.from.node); ids.add(wire.to.node);
  }
  const rects = [...ids].filter(id => nodes.has(id)).map(id => nodeRect(nodes.get(id)));
  if (!rects.length) return { view: { ...step.view }, ids, missing };
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  const w = Math.max(...rects.map(r => r.x + r.w)) - x;
  const h = Math.max(...rects.map(r => r.y + r.h)) - y;
  const zoom = Math.max(0.2, Math.min(1.5, (viewport.width - 120) / Math.max(1, w), (viewport.height - 160) / Math.max(1, h)));
  return { view: { cx: x + w / 2, cy: y + h / 2, zoom }, ids, missing };
}
