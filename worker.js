// Runs the generator off the main thread; big groups can take most of a second.
importScripts('oredict.js');

let index = null;
const ready = fetch('data/items.json').then(r => r.json()).then(d => { index = new Oredict.Index(d); });

onmessage = async e => {
  const { id, targets, deny, wild, loose } = e.data;
  await ready;
  const r = Oredict.generate(index, targets, { wild, deny, loose });
  postMessage({ id, string: r.string, extras: r.extras, missing: r.missing, twins: r.twins });
};
