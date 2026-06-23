try {
  doRiskyThing();
} catch (error) {
  throw error;
}

declare function doRiskyThing(): void;
