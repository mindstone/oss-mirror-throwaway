try {
  doRiskyThing();
} catch (error) {
  console.warn(error);
}

declare function doRiskyThing(): void;
