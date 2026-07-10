import { describe, expect, test } from "bun:test";
import { scanAnnouncements } from "./announcement-state";
import type { Announcement } from "./types";

const announcement = (id: number) => ({ id }) as Announcement;

describe("scanAnnouncements", () => {
  test("only IDs above the high-water mark count as new", () => {
    expect(scanAnnouncements(0, [announcement(2), announcement(1)])).toEqual({ hasNew: true, highestSeen: 2 });
    expect(scanAnnouncements(2, [announcement(1)])).toEqual({ hasNew: false, highestSeen: 2 });
    expect(scanAnnouncements(2, [announcement(3), announcement(1)])).toEqual({ hasNew: true, highestSeen: 3 });
  });
});
