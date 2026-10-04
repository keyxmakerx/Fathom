// A device's ports in the order a person reads them: by port number, naturally ("2" before "10"),
// and a patch panel's front and rear of the same number side by side. Pure.

const FACE_ORDER: Readonly<Record<string, number>> = { front: 0, rear: 1 };

export function inPortOrder<T extends { label: string; face: string }>(ports: readonly T[]): T[] {
  return [...ports].sort(
    (a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }) ||
      (FACE_ORDER[a.face] ?? 2) - (FACE_ORDER[b.face] ?? 2),
  );
}
