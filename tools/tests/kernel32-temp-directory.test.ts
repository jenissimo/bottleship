/**
 * GetTempPath's directory exists on every Windows install. A program that validates a
 * name by creating a folder under it, without creating the temp folder first, rejects
 * every name when it is missing.
 */
import { expect, test } from "bun:test";
import { ensureTempDirectories } from "../../src/worker/modules/kernel32/file-io-path";

test("the TMP and TEMP directories are created, parents first", () => {
    const made: string[] = [];
    const env = new Map([["TEMP", "C:\\WINDOWS\\TEMP"], ["TMP", "C:\\TMP"], ["PATH", "C:\\WINDOWS"]]);
    ensureTempDirectories(env, { ensureDirTreeSync: (dir: string) => { made.push(dir); } });
    expect(made).toEqual(["C:\\TMP", "C:\\WINDOWS\\TEMP"]);
});
