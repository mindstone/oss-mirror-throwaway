declare module 'rtf.js' {
  export class RTFJS {
    static loggingEnabled(enabled: boolean): void;
    static Document: typeof Document;
  }

  export class Document {
    constructor(arrayBuffer: ArrayBuffer);
    metadata(): Record<string, unknown>;
    render(): Promise<HTMLElement[]>;
  }

  export class WMFJS {
    static loggingEnabled(enabled: boolean): void;
  }

  export class EMFJS {
    static loggingEnabled(enabled: boolean): void;
  }
}
