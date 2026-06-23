import type { ConcreteTemporalGroup } from '@rebel/cloud-client';

export function isToday(epochMs: number): boolean {
  const d = new Date(epochMs);
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
}

export function getEndOfWeekDueBy(now = new Date()): number {
  const dueBy = new Date(now);
  const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
  dueBy.setDate(now.getDate() + daysUntilSunday);
  dueBy.setHours(23, 59, 59, 999);
  return dueBy.getTime();
}

export function getNextMondayDueBy(now = new Date()): number {
  const dueBy = new Date(now);
  const daysUntilNextMonday = ((8 - now.getDay()) % 7) || 7;
  dueBy.setDate(now.getDate() + daysUntilNextMonday);
  dueBy.setHours(0, 0, 0, 0);
  return dueBy.getTime();
}

export function getSnoozeDueBy(group: ConcreteTemporalGroup): number | null {
  if (group === 'due-today') {
    return getEndOfWeekDueBy();
  }
  if (group === 'due-this-week') {
    return getNextMondayDueBy();
  }
  return null;
}
