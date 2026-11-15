import { describe, expect, it } from "vitest";
import { postDateFromUrl } from "../src/lib/social.ts";

describe("post dates from ids", () => {
  it("decodes X, LinkedIn and Bluesky ids", () => {
    expect(postDateFromUrl("https://x.com/tshokama/status/2095804084812968136")?.slice(0, 10)).toBe("2026-09-04");
    expect(postDateFromUrl("https://www.linkedin.com/posts/leonardogrig_x-activity-7511759142798336000-fUN7")?.slice(0, 10)).toBe("2026-10-02");
    expect(postDateFromUrl("https://bsky.app/profile/a.bsky.social/post/3l3qo2vutsw2b")?.slice(0, 4)).toMatch(/^202[0-9]$/);
    expect(postDateFromUrl("https://www.linkedin.com/feed/update/urn:li:activity:abc")).toBeUndefined();
  });
});
