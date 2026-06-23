export interface BarFactory {
  ready: boolean;
}

// `setBarFactory` ends in a `Factory` suffix matched ONLY by the widened
// discovery regex (260607). This fixture therefore proves the widening forces
// classification of a new boundary-shaped setter end-to-end — not just the
// pre-widening Provider|Service|Reporter shapes.
export function setBarFactory(factory: BarFactory): void {
  void factory;
}
