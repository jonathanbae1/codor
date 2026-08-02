// Per-tab ownership for state whose wire ids are only unique within one computer.
// Service workers never set this module value, so they cannot guess a hosted
// archive owner from the shared IndexedDB active marker.
let activeComputer: string | undefined;

export function setActiveComputer(id: string | undefined): void {
  activeComputer = id;
}

export function activeComputerId(): string | undefined {
  return activeComputer;
}

export function activeComputerNamespace(): string {
  return activeComputer === undefined ? 'direct' : `computer:${activeComputer}`;
}

export type RoomKeyPersistenceOwner =
  | { kind: 'computer'; id: string }
  | { kind: 'direct' }
  | undefined;

export function roomKeyPersistenceOwner(hostedIndexExists: boolean): RoomKeyPersistenceOwner {
  if (activeComputer !== undefined) return { kind: 'computer', id: activeComputer };
  return hostedIndexExists ? undefined : { kind: 'direct' };
}

export function resetActiveComputerForTest(): void {
  activeComputer = undefined;
}
