import { describe, expect, it } from "vite-plus/test";
import { detectedSectorName, sectorName } from "./sector-name";

describe("sector names (TB-221)", () => {
  it("names a detected sector by its first root and the other roots", () => {
    expect(detectedSectorName("Ошибка: повтор загрузки вкладки", 2)).toBe(
      "Ошибка: повтор загрузки вкладки +1",
    );
    expect(detectedSectorName("Release", 5)).toBe("Release +4");
  });

  it("does not put the UI prefix into the stored name", () => {
    expect(detectedSectorName("Release", 2)).not.toMatch(/^Sector/);
  });

  it("drops the legacy English prefix of names stored before TB-221", () => {
    expect(sectorName("Sector: Ошибка: повтор загрузки вкладки +1")).toBe(
      "Ошибка: повтор загрузки вкладки +1",
    );
  });

  it("keeps new names and names without the exact prefix", () => {
    expect(sectorName("Release +4")).toBe("Release +4");
    expect(sectorName("Sectors of Q4 +1")).toBe("Sectors of Q4 +1");
    expect(sectorName("sector: lower case +1")).toBe("sector: lower case +1");
  });
});
