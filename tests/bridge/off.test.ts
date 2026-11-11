import { expect, it } from "vitest";
import { bridgeDisabled, ENV_SWITCH } from "../../src/bridge/index";

it("CONTROL-8：只认 off（忽略大小写和首尾空白），其它写法都当没设", () => {
  expect(ENV_SWITCH).toBe("AGENT_SITE_BRIDGE");
  for (const value of ["off", "OFF", "Off", " off ", "\toff\n"]) {
    expect(bridgeDisabled({ [ENV_SWITCH]: value })).toBe(true);
  }
  for (const value of ["on", "0", "false", "no", "", "offf"]) {
    expect(bridgeDisabled({ [ENV_SWITCH]: value })).toBe(false);
  }
  expect(bridgeDisabled({})).toBe(false);
});
