import type { Announcement } from "./types";

/**
 * 公告 ID 由数据库单调递增；用高水位判断“新增”，避免删除最新公告时把旧公告
 * 误判成新公告并重新弹出已经关闭的横幅。
 */
export function scanAnnouncements(highestSeen: number, announcements: Announcement[]) {
  const currentMax = announcements.reduce((max, announcement) => Math.max(max, announcement.id), 0);
  return {
    hasNew: currentMax > highestSeen,
    highestSeen: Math.max(highestSeen, currentMax),
  };
}
