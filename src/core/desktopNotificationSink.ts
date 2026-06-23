export interface DesktopNotificationParams {
  title: string;
  body: string;
  sessionId?: string;
  filePath?: string;
}

export interface DesktopNotificationSink {
  showDesktopNotification(params: DesktopNotificationParams): void;
}

export type DesktopNotificationSinkFactory = () => DesktopNotificationSink;

let _factory: DesktopNotificationSinkFactory | undefined;
let _instance: DesktopNotificationSink | undefined;

export function setDesktopNotificationSinkFactory(factory: DesktopNotificationSinkFactory): void {
  _factory = factory;
  _instance = undefined;
}

export function getDesktopNotificationSink(): DesktopNotificationSink {
  if (_instance) return _instance;
  if (!_factory) {
    throw new Error(
      'DesktopNotificationSink not initialized. Call setDesktopNotificationSinkFactory() before use.',
    );
  }
  _instance = _factory();
  return _instance;
}
