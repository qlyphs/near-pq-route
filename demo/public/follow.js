// Which state the page shows for the operation it follows. The followed proposal never changes on its own: another
// visitor's operation becoming active does not replace it, and a result that is no longer readable is reported as
// unavailable rather than borrowed from another operation.
export function followed(hash, guardian) {
  if (!hash) return { mode: 'none' };
  if (guardian?.active?.proposal_hash === hash) return { mode: 'active', op: guardian.active, status: guardian.active.status };
  if (guardian?.last?.proposal_hash === hash) return { mode: 'terminal', status: guardian.last.status };
  return { mode: 'unavailable', status: 'unavailable' };
}
