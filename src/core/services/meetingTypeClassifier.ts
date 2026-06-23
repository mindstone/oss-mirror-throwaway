export type MeetingType = "solo" | "internal" | "external";

export function extractDomainFromCalendarSource(
  calendarSource?: string,
): string | undefined {
  if (!calendarSource) {
    return undefined;
  }

  const emailPart = calendarSource.split(":")[1];
  if (!emailPart) {
    return undefined;
  }

  return emailPart.split("@")[1]?.toLowerCase();
}

export function classifyMeetingType(
  meeting: { participantEmails?: string[]; calendarSource?: string },
  userDomain?: string,
): MeetingType {
  if (!meeting.participantEmails || meeting.participantEmails.length === 0) {
    return "solo";
  }

  const domain =
    userDomain ?? extractDomainFromCalendarSource(meeting.calendarSource);
  if (!domain) {
    return "external";
  }

  const allInternal = meeting.participantEmails.every((email) => {
    const emailDomain = email.split("@")[1]?.toLowerCase();
    return emailDomain === domain;
  });

  return allInternal ? "internal" : "external";
}
