const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const PEAK_START_HOUR_PT = 5;
const PEAK_END_HOUR_PT = 11;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type PeakHourStatus = {
  active: boolean;
  startLocal: string;
  endLocal: string;
  nextStartLocal: string;
};

function getPacificHour(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "0";
  return Number.parseInt(hour, 10);
}

function getPacificYMD(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = Number.parseInt(parts.find((part) => part.type === "year")?.value ?? "0", 10);
  const month = Number.parseInt(parts.find((part) => part.type === "month")?.value ?? "0", 10);
  const day = Number.parseInt(parts.find((part) => part.type === "day")?.value ?? "0", 10);
  return { year, month, day };
}

function pacificWallClockAsUtc(year: number, month: number, day: number, hour: number): Date {
  for (const offsetHours of [7, 8]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, hour + offsetHours, 0, 0));
    const ymd = getPacificYMD(candidate);
    if (
      ymd.year === year
      && ymd.month === month
      && ymd.day === day
      && getPacificHour(candidate) === hour
    ) {
      return candidate;
    }
  }
  return new Date(Date.UTC(year, month - 1, day, hour + 8, 0, 0));
}

function formatLocalHour(date: Date): string {
  const formatted = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return formatted.replace(":00", "");
}

export function getPeakHourStatus(now: Date = new Date()): PeakHourStatus {
  const ptHour = getPacificHour(now);
  const active = ptHour >= PEAK_START_HOUR_PT && ptHour < PEAK_END_HOUR_PT;

  const today = getPacificYMD(now);
  const startToday = pacificWallClockAsUtc(today.year, today.month, today.day, PEAK_START_HOUR_PT);
  const endToday = pacificWallClockAsUtc(today.year, today.month, today.day, PEAK_END_HOUR_PT);

  let nextStart = startToday;
  if (ptHour >= PEAK_END_HOUR_PT) {
    const tomorrow = getPacificYMD(new Date(now.getTime() + MS_PER_DAY));
    nextStart = pacificWallClockAsUtc(tomorrow.year, tomorrow.month, tomorrow.day, PEAK_START_HOUR_PT);
  }

  return {
    active,
    startLocal: formatLocalHour(startToday),
    endLocal: formatLocalHour(endToday),
    nextStartLocal: formatLocalHour(nextStart),
  };
}
