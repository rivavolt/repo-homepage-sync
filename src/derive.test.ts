import { expect, test, describe } from "bun:test";
import { parseRepoURL, isInfraRepo, canonicalUrl, shouldUpdate } from "./derive.ts";

describe("parseRepoURL", () => {
  test("https with .git", () => {
    expect(parseRepoURL("https://github.com/rivavolt/alimcompta.git")).toEqual({
      owner: "rivavolt",
      repo: "alimcompta",
    });
  });
  test("https without .git", () => {
    expect(parseRepoURL("https://github.com/rivavolt/alimcompta")).toEqual({
      owner: "rivavolt",
      repo: "alimcompta",
    });
  });
  test("trailing slash", () => {
    expect(parseRepoURL("https://github.com/andreivolt/foo/")).toEqual({
      owner: "andreivolt",
      repo: "foo",
    });
  });
  test("rejects non-owned org", () => {
    expect(parseRepoURL("https://github.com/some-other/repo")).toBeNull();
  });
  test("rejects helm/non-github", () => {
    expect(parseRepoURL("https://isindir.github.io/sops-secrets-operator")).toBeNull();
    expect(parseRepoURL(undefined)).toBeNull();
    expect(parseRepoURL("")).toBeNull();
  });
});

describe("isInfraRepo", () => {
  test("cluster repo is infra", () => {
    expect(isInfraRepo({ owner: "rivavolt", repo: "cluster" })).toBe(true);
  });
  test("app repo is not infra", () => {
    expect(isInfraRepo({ owner: "rivavolt", repo: "alimcompta" })).toBe(false);
  });
});

describe("canonicalUrl", () => {
  test("prefers public domain over tailnet", () => {
    expect(canonicalUrl(["youtube-transcripts.volt.tail.avolt.net", "alimcompta.fr"])).toBe(
      "https://alimcompta.fr",
    );
  });
  test("prefers v.avolt.net over tailnet", () => {
    expect(canonicalUrl(["x.volt.tail.avolt.net", "webhooks.v.avolt.net"])).toBe(
      "https://webhooks.v.avolt.net",
    );
  });
  test("shortest among same class", () => {
    expect(canonicalUrl(["admin.test.alimcompta.fr", "test.alimcompta.fr"])).toBe(
      "https://test.alimcompta.fr",
    );
  });
  test("pure tailnet host still yields a url", () => {
    expect(canonicalUrl(["youtube-transcripts.volt.tail.avolt.net"])).toBe(
      "https://youtube-transcripts.volt.tail.avolt.net",
    );
  });
  test("empty set yields empty", () => {
    expect(canonicalUrl([])).toBe("");
  });
});

describe("shouldUpdate", () => {
  test("writes when empty", () => {
    expect(shouldUpdate("", "https://x.avolt.net")).toBe(true);
    expect(shouldUpdate(null, "https://x.avolt.net")).toBe(true);
  });
  test("no-op when equal", () => {
    expect(shouldUpdate("https://x.avolt.net", "https://x.avolt.net")).toBe(false);
  });
  test("corrects a stale avolt.net url", () => {
    expect(shouldUpdate("https://old.tail.avolt.net", "https://new.avolt.net")).toBe(true);
  });
  test("never clobbers a deliberate external homepage", () => {
    expect(shouldUpdate("https://docs.example.com", "https://x.avolt.net")).toBe(false);
  });
  test("never writes an empty desired", () => {
    expect(shouldUpdate("", "")).toBe(false);
  });
});
