import { describe, expect, test } from "bun:test";
import { detectLanguagePreset, languageFieldsForSave } from "../../src/wizard/language-presets";

describe("language selection", () => {
  test("keeps implicit defaults and explicit partial values unchanged", () => {
    expect(detectLanguagePreset({})).toBe("en-US");
    expect(languageFieldsForSave({}, "en-US")).toEqual({});
    expect(languageFieldsForSave({ codepage: 1252 }, "en-US")).toEqual({ codepage: 1252 });
  });
  test("preserves custom and OEM-only settings on unrelated saves", () => {
    const custom = { codepage: 1251, lcid: 0x419, oemCodepage: 437 };
    expect(detectLanguagePreset(custom)).toBe("");
    expect(languageFieldsForSave(custom, "")).toEqual(custom);
    expect(languageFieldsForSave({ oemCodepage: 850 }, "")).toEqual({ oemCodepage: 850 });
  });
  test("changing language writes all three fields, including when reverting to English", () => {
    expect(languageFieldsForSave({ codepage: 1251, lcid: 0x419 }, "en-US")).toEqual({ codepage: 1252, oemCodepage: 437, lcid: 0x409 });
    expect(languageFieldsForSave({}, "lt-LT")).toEqual({ codepage: 1257, oemCodepage: 775, lcid: 0x427 });
  });
});
