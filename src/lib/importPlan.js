// Works out what an import of units (+ armies) from another person does to
// the current library, without touching any state.
//
// - A unit identical to one already in the library (same content, ids ignored)
//   is skipped, and armies that referenced it point at the existing copy.
// - Every unit that is added gets a fresh id, so two people's libraries can
//   never end up with two different units sharing an id.
// - Armies whose name already exists are left alone; the rest are added with
//   their unit ids remapped (an army that ends up with no units is dropped).
export function planImport(current, incoming, signatureOf, newId = () => crypto.randomUUID()) {
  const sigToId = new Map(current.library.map((u) => [signatureOf(u), u.id]));
  const idMap = new Map(); // id in the incoming data -> id in the library afterwards
  const units = [];
  let skipped = 0;
  incoming.units.forEach((u) => {
    const sig = signatureOf(u);
    const existing = sigToId.get(sig);
    if (existing) {
      skipped += 1;
      idMap.set(u.id, existing);
      return;
    }
    const id = newId();
    sigToId.set(sig, id);
    idMap.set(u.id, id);
    units.push({ ...u, id });
  });

  const taken = new Set(current.armies.map((a) => a.name));
  const armies = [];
  (incoming.armies || []).forEach((a) => {
    if (!a || !a.name || taken.has(a.name)) return;
    const unitIds = (a.unitIds || []).map((id) => idMap.get(id)).filter(Boolean);
    if (unitIds.length === 0) return;
    taken.add(a.name);
    armies.push({ ...a, id: newId(), unitIds });
  });

  return { units, armies, skipped };
}
