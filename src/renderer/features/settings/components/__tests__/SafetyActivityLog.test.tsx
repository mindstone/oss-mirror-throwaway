// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SafetyActivityEntry,
  type ActivityLogEntry,
} from "../SafetyActivityEntry";
import { SafetyActivityLog } from "../SafetyActivityLog";
import type { SafetyActivityLogCloudSyncState } from "@shared/ipc/channels/safetyActivityLog";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

let mounted: Mounted[] = [];

const cloudAllowedEntry: ActivityLogEntry = {
  id: "cloud-allowed-1",
  timestamp: Date.now(),
  type: "evaluation",
  executionSurface: "cloud",
  toolDisplayName: "Send message",
  toolId: "slack_send_message",
  actionSummary: "Send a note",
  decision: "allowed",
  reason: "Allowed by the current safety rules",
  sessionType: "interactive",
  source: "safety-prompt",
  flagged: false,
};

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  });
}

function installSafetyActivityLogApi(options: {
  getEntries: ActivityLogEntry[][];
  cloudSyncState?: SafetyActivityLogCloudSyncState;
  syncCloudPromise?: Promise<{
    cloudSyncState: SafetyActivityLogCloudSyncState;
  }>;
}) {
  const get = vi.fn();
  for (const entries of options.getEntries) {
    get.mockResolvedValueOnce({ entries });
  }
  get.mockResolvedValue({ entries: options.getEntries.at(-1) ?? [] });

  const syncCloud = vi.fn(
    () =>
      options.syncCloudPromise ??
      Promise.resolve({ cloudSyncState: options.cloudSyncState ?? "success" }),
  );
  const unsubscribe = vi.fn();
  const onSafetyActivityLogUpdated = vi.fn(() => unsubscribe);

  Object.assign(window, {
    safetyActivityLogApi: {
      get,
      syncCloud,
      flag: vi.fn().mockResolvedValue({ success: true }),
      unflag: vi.fn().mockResolvedValue({ success: true }),
    },
    safetyActivityLogSubscriptions: {
      onSafetyActivityLogUpdated,
    },
  });

  return { get, syncCloud, onSafetyActivityLogUpdated, unsubscribe };
}

describe("SafetyActivityEntry", () => {
  afterEach(() => {
    for (const instance of mounted) {
      instance.unmount();
    }
    mounted = [];
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders a muted Cloud marker without removing the flag affordance", () => {
    const onFlag = vi.fn();
    const view = mount(
      <SafetyActivityEntry entry={cloudAllowedEntry} onFlag={onFlag} />,
    );
    mounted.push(view);

    const cloudMarker = view.container.querySelector(
      '[data-testid="safety-activity-cloud-marker"]',
    );
    expect(cloudMarker?.textContent).toBe("Cloud");
    expect(cloudMarker?.getAttribute("title")).toBe("Ran in the cloud");
    expect(cloudMarker?.getAttribute("aria-label")).toBe("Ran in the cloud");

    const flagButton =
      view.container.querySelector<HTMLButtonElement>("button");
    expect(flagButton?.textContent).toContain("This wasn\u2019t OK");

    act(() => {
      flagButton?.click();
    });
    expect(onFlag).toHaveBeenCalledWith("cloud-allowed-1");
  });

  it("does not render provenance for desktop or legacy entries", () => {
    const view = mount(
      <SafetyActivityEntry
        entry={{
          ...cloudAllowedEntry,
          id: "desktop-allowed-1",
          executionSurface: "desktop",
        }}
        onFlag={vi.fn()}
      />,
    );
    mounted.push(view);

    expect(
      view.container.querySelector(
        '[data-testid="safety-activity-cloud-marker"]',
      ),
    ).toBeNull();
  });
});

describe("SafetyActivityLog cloud sync state", () => {
  afterEach(() => {
    for (const instance of mounted) {
      instance.unmount();
    }
    mounted = [];
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("holds the loading state instead of showing empty copy while cloud sync is still pending", async () => {
    installSafetyActivityLogApi({
      getEntries: [[]],
      syncCloudPromise: new Promise(() => undefined),
    });

    const view = mount(<SafetyActivityLog />);
    mounted.push(view);

    await flushAsync();

    expect(
      view.container.querySelector('[role="status"][aria-label="Loading"]'),
    ).not.toBeNull();
    expect(view.container.textContent).not.toContain("No actions taken yet");
  });

  it("shows the cloud sync note instead of the empty state when cloud sync fails", async () => {
    installSafetyActivityLogApi({ getEntries: [[]], cloudSyncState: "failed" });

    const view = mount(<SafetyActivityLog />);
    mounted.push(view);

    await flushAsync();

    expect(
      view.container.querySelector(
        '[data-testid="safety-activity-cloud-sync-note"]',
      )?.textContent,
    ).toBe("Cloud activity hasn't synced yet. Showing this device's history.");
    expect(view.container.textContent).not.toContain("No actions taken yet");
  });

  it("shows the cloud sync note instead of the empty state when cloud sync is offline", async () => {
    installSafetyActivityLogApi({
      getEntries: [[]],
      cloudSyncState: "offline",
    });

    const view = mount(<SafetyActivityLog />);
    mounted.push(view);

    await flushAsync();

    expect(
      view.container.querySelector(
        '[data-testid="safety-activity-cloud-sync-note"]',
      )?.textContent,
    ).toBe("Cloud activity hasn't synced yet. Showing this device's history.");
    expect(view.container.textContent).not.toContain("No actions taken yet");
  });

  it("shows the pending 'checking' note alongside local entries while cloud sync is still in flight", async () => {
    installSafetyActivityLogApi({
      getEntries: [[cloudAllowedEntry]],
      syncCloudPromise: new Promise(() => undefined),
    });

    const view = mount(<SafetyActivityLog />);
    mounted.push(view);

    await flushAsync();

    // The "checking" note is shown — not the failed/offline copy, not the empty state.
    expect(
      view.container.querySelector(
        '[data-testid="safety-activity-cloud-sync-note"]',
      )?.textContent,
    ).toBe("Checking for cloud activity…");
    expect(view.container.textContent).not.toContain("No actions taken yet");
    expect(view.container.textContent).not.toContain(
      "Cloud activity hasn't synced yet",
    );

    // The list still renders — never a bare complete-looking view.
    expect(
      view.container.querySelector('[data-testid="safety-activity-cloud-marker"]')
        ?.textContent,
    ).toBe("Cloud");
  });

  it("shows the 'hasn't synced' note alongside local entries when cloud sync fails", async () => {
    installSafetyActivityLogApi({
      getEntries: [[cloudAllowedEntry]],
      cloudSyncState: "failed",
    });

    const view = mount(<SafetyActivityLog />);
    mounted.push(view);

    await flushAsync();

    expect(
      view.container.querySelector(
        '[data-testid="safety-activity-cloud-sync-note"]',
      )?.textContent,
    ).toBe("Cloud activity hasn't synced yet. Showing this device's history.");
    expect(
      view.container.querySelector('[data-testid="safety-activity-cloud-marker"]')
        ?.textContent,
    ).toBe("Cloud");
    expect(view.container.textContent).not.toContain("No actions taken yet");
  });

  it("clears the note and refetches merged rows after a successful cloud sync", async () => {
    const api = installSafetyActivityLogApi({
      getEntries: [[], [cloudAllowedEntry]],
      cloudSyncState: "success",
    });

    const view = mount(<SafetyActivityLog />);
    mounted.push(view);

    await flushAsync();

    expect(api.syncCloud).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(
      view.container.querySelector(
        '[data-testid="safety-activity-cloud-sync-note"]',
      ),
    ).toBeNull();
    expect(
      view.container.querySelector(
        '[data-testid="safety-activity-cloud-marker"]',
      )?.textContent,
    ).toBe("Cloud");
  });

  it("keeps the ordinary empty state for desktop-only users", async () => {
    installSafetyActivityLogApi({
      getEntries: [[]],
      cloudSyncState: "not-configured",
    });

    const view = mount(<SafetyActivityLog />);
    mounted.push(view);

    await flushAsync();

    expect(
      view.container.querySelector(
        '[data-testid="safety-activity-cloud-sync-note"]',
      ),
    ).toBeNull();
    expect(view.container.textContent).toContain("No actions taken yet");
  });
});
