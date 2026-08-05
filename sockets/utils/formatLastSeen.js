export function formatLastSeen(lastSeen) {
  if (!lastSeen) return "Offline";

  const date = new Date(lastSeen);
  const now = new Date();

  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear();

  const time = date.toLocaleTimeString("en-PK", {
    hour: "numeric",
    minute: "2-digit",
  });

  if (isToday) {
    return `Last seen today at ${time}`;
  }

  if (isYesterday) {
    return `Last seen yesterday at ${time}`;
  }

  const dateText = date.toLocaleDateString("en-PK", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return `Last seen ${dateText} at ${time}`;
}