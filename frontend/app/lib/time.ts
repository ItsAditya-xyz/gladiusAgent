const IST_OFFSET_MINUTES = 330;

export const istWindow = (startDaysOffset: number, daysSpan: number) => {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const istMs = utcMs + IST_OFFSET_MINUTES * 60000;
  const istNow = new Date(istMs);

  const start = new Date(istNow);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() + startDaysOffset);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + daysSpan);

  return { start: start.toISOString(), end: end.toISOString() };
};
