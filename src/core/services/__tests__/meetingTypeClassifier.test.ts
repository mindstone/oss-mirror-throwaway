import { describe, expect, it } from "vitest";

import {
  classifyMeetingType,
  extractDomainFromCalendarSource,
} from "../meetingTypeClassifier";

describe("extractDomainFromCalendarSource", () => {
  it("extracts the email domain from a calendar source string", () => {
    expect(extractDomainFromCalendarSource("google:[external-email]")).toBe(
      "company.com",
    );
    expect(extractDomainFromCalendarSource("microsoft:[external-email]")).toBe(
      "gmail.com",
    );
  });

  it("returns undefined when calendar source is missing or malformed", () => {
    expect(extractDomainFromCalendarSource()).toBeUndefined();
    expect(extractDomainFromCalendarSource("google")).toBeUndefined();
  });
});

describe("classifyMeetingType", () => {
  it("returns solo when participantEmails is undefined", () => {
    expect(
      classifyMeetingType({ calendarSource: "google:[external-email]" }),
    ).toBe("solo");
  });

  it("returns solo when participantEmails is empty", () => {
    expect(
      classifyMeetingType({
        participantEmails: [],
        calendarSource: "google:[external-email]",
      }),
    ).toBe("solo");
  });

  it("returns internal when all participants match the user domain", () => {
    expect(
      classifyMeetingType({
        participantEmails: ["[external-email]", "[external-email]"],
        calendarSource: "google:[external-email]",
      }),
    ).toBe("internal");
  });

  it("returns external when any participant uses a different domain", () => {
    expect(
      classifyMeetingType({
        participantEmails: ["[external-email]", "[external-email]"],
        calendarSource: "google:[external-email]",
      }),
    ).toBe("external");
  });

  it("returns external when it cannot derive a user domain", () => {
    expect(
      classifyMeetingType({
        participantEmails: ["[external-email]"],
      }),
    ).toBe("external");
  });

  it("supports personal email domains when they match the calendar owner", () => {
    expect(
      classifyMeetingType({
        participantEmails: ["[external-email]", "[external-email]"],
        calendarSource: "google:[external-email]",
      }),
    ).toBe("internal");
  });
});
