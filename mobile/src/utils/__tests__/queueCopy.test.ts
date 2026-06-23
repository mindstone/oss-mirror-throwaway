import { QUEUE_FULL_USER_MESSAGE as CLOUD_QUEUE_FULL_USER_MESSAGE } from "@core/services/cloudErrorCatalog";
import { QUEUE_FULL_USER_MESSAGE } from "../queueCopy";

describe("queueCopy catalog bridge", () => {
  it("sources the queue-full user message from CloudErrorCatalog", () => {
    expect(QUEUE_FULL_USER_MESSAGE).toBe(CLOUD_QUEUE_FULL_USER_MESSAGE);
    expect(QUEUE_FULL_USER_MESSAGE).toBe(
      "Queue's full (200 items). Keep me online for a minute so I can clear space.",
    );
  });
});
