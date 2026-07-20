import { describe, expect, it } from "vitest";
import { allowsLocalDevelopmentFundedAi } from "../deployment-funded-ai";

describe("deployment-funded AI runtime boundary", () => {
  it.each([
    ["production ignores opt-in", {
      NODE_ENV: "production",
      ALLOW_DEV_DEPLOYMENT_FUNDED_AI: "true",
      PUBLIC_ORIGIN: "http://localhost:3000",
    }, false],
    ["missing opt-in", {
      NODE_ENV: "development",
      PUBLIC_ORIGIN: "http://localhost:3000",
    }, false],
    ["non-exact opt-in", {
      NODE_ENV: "development",
      ALLOW_DEV_DEPLOYMENT_FUNDED_AI: "TRUE",
      PUBLIC_ORIGIN: "http://localhost:3000",
    }, false],
    ["public development origin", {
      NODE_ENV: "development",
      ALLOW_DEV_DEPLOYMENT_FUNDED_AI: "true",
      PUBLIC_ORIGIN: "https://preview.example.test",
    }, false],
    ["HTTPS loopback typo", {
      NODE_ENV: "development",
      ALLOW_DEV_DEPLOYMENT_FUNDED_AI: "true",
      PUBLIC_ORIGIN: "https://localhost:3000",
    }, false],
    ["localhost", {
      NODE_ENV: "development",
      ALLOW_DEV_DEPLOYMENT_FUNDED_AI: "true",
      PUBLIC_ORIGIN: "http://localhost:3000",
    }, true],
    ["IPv4 loopback", {
      NODE_ENV: "development",
      ALLOW_DEV_DEPLOYMENT_FUNDED_AI: "true",
      PUBLIC_ORIGIN: "http://127.0.0.1:3000",
    }, true],
    ["IPv6 loopback", {
      NODE_ENV: "test",
      ALLOW_DEV_DEPLOYMENT_FUNDED_AI: "true",
      PUBLIC_ORIGIN: "http://[::1]:3000",
    }, true],
  ] as const)("%s", (_label, env, expected) => {
    expect(allowsLocalDevelopmentFundedAi(env)).toBe(expected);
  });
});
